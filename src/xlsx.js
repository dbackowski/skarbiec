// Minimal XLSX reader: ZIP via the native DecompressionStream, XML via regex.
// Enough for XTB reports (plain cells, shared strings); no formulas, styles or dates.
// Works in the webview and in Node 18+, so it can be tested with `node --test`.

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns Map<path, Uint8Array> of all files in the ZIP.
export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("To nie jest plik XLSX (brak struktury ZIP)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Uszkodzony plik XLSX");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
    else throw new Error(`Nieobsługiwana kompresja w XLSX: ${method}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, e, dec, hex) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16))
    : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e]);

const textOf = (xml) => unescape([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

const colIndex = (ref) => [...ref.replace(/\d+$/, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Returns { [sheetName]: rows }, each row an array of string | number | undefined.
export async function readXlsx(buffer) {
  const files = await unzip(buffer);
  const text = (path) => {
    const f = files.get(path);
    if (!f) throw new Error(`Brak ${path} w pliku XLSX`);
    return new TextDecoder().decode(f);
  };
  const shared = files.has("xl/sharedStrings.xml")
    ? [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  const rels = Object.fromEntries([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)]
    .map(([tag]) => [tag.match(/Id="([^"]+)"/)[1], tag.match(/Target="([^"]+)"/)[1]]));
  const sheets = {};
  for (const [tag] of text("xl/workbook.xml").matchAll(/<sheet\s[^>]*>/g)) {
    const name = unescape(tag.match(/name="([^"]+)"/)[1]);
    const target = rels[tag.match(/r:id="([^"]+)"/)[1]].replace(/^\/?(xl\/)?/, "xl/");
    const rows = [];
    for (const row of text(target).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const [, attrs, body = ""] = c;
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const i = colIndex(attrs.match(/\br="([A-Z]+\d+)"/)[1]);
        if (type === "s") cells[i] = shared[+v];
        else if (type === "inlineStr") cells[i] = textOf(body);
        else if (type === "str" || type === "b" || type === "e") cells[i] = v === undefined ? undefined : unescape(v);
        else if (v !== undefined) cells[i] = Number(v);
      }
      rows[+row[0].match(/\br="(\d+)"/)?.[1] - 1 || rows.length] = cells;
    }
    sheets[name] = rows;
  }
  return sheets;
}
