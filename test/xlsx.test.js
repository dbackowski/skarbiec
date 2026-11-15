import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readXlsx, unzip } from "../src/xlsx.js";

const load = (name) => {
  const b = readFileSync(new URL(`fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

test("cell types, entities, sparse rows and columns, stored entries", async () => {
  const sheets = await readXlsx(load("edge-cases.xlsx"));
  assert.deepEqual(Object.keys(sheets), ["A & B"]);
  const rows = sheets["A & B"];
  assert.equal(rows[0][0], "Zażółć <gęślą>");
  assert.equal(rows[0][2], "wynik");
  assert.equal(rows[1], undefined); // missing row 2
  assert.equal(rows[2][0], "1");
  assert.equal(rows[2][1], -12.5);
  assert.equal(rows[2][26], "ab"); // column AA, rich text runs joined
});

test("deflated entries (as Excel and xStation write them)", async () => {
  const files = await unzip(load("IKE_11111111_2026-01-01_2026-11-15.xlsx"));
  assert.match(new TextDecoder().decode(files.get("xl/workbook.xml")), /Open Positions/);
});

test("not a ZIP, or a ZIP without a workbook", async () => {
  await assert.rejects(readXlsx(new TextEncoder().encode("hello").buffer), /To nie jest plik XLSX/);
  const files = await unzip(load("edge-cases.xlsx"));
  assert.ok(files.size === 3);
  // Same archive bytes but the workbook entry renamed: reading must fail clearly.
  const bytes = new Uint8Array(load("edge-cases.xlsx"));
  const renamed = new TextDecoder("latin1").decode(bytes).replaceAll("xl/workbook.xml", "xl/workbook.xmX");
  await assert.rejects(readXlsx(Uint8Array.from(renamed, (c) => c.charCodeAt(0)).buffer), /Brak xl\/workbook.xml/);
});

test("unsupported compression method is reported", async () => {
  const bytes = new Uint8Array(load("edge-cases.xlsx"));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint16(i + 10, 12, true); // bzip2
  }
  await assert.rejects(unzip(bytes.buffer), /Nieobsługiwana kompresja w XLSX: 12/);
});
