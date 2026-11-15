"""Writes synthetic xStation history reports (XLSX) used by the tests.

Same sheet names, headers and quirks as real exports (Open Positions of an IKE report carries
the main account's number, Cash Operations comments with partial fills), with made-up data.
Run: python3 test/fixtures/make_xtb_fixtures.py
"""
import datetime
import pathlib
import zipfile
from xml.sax.saxutils import escape

HERE = pathlib.Path(__file__).parent


def serial(iso):  # Excel serial date, UTC
    t = datetime.datetime.fromisoformat(iso).replace(tzinfo=datetime.timezone.utc)
    return (t - datetime.datetime(1899, 12, 30, tzinfo=datetime.timezone.utc)).total_seconds() / 86400


def col(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def write_xlsx(path, sheets):
    strings, index = [], {}

    def sid(s):
        if s not in index:
            index[s] = len(strings)
            strings.append(s)
        return index[s]

    sheet_xml = []
    for _, rows in sheets:
        out = []
        for r, row in enumerate(rows, 1):
            if row is None:
                continue
            cells = []
            for c, v in enumerate(row):
                ref = f"{col(c)}{r}"
                if v is None or v == "":
                    continue
                if isinstance(v, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{v!r}</v></c>')
                else:
                    cells.append(f'<c r="{ref}" t="s"><v>{sid(v)}</v></c>')
            out.append(f'<row r="{r}">{"".join(cells)}</row>')
        sheet_xml.append('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                         f'<sheetData>{"".join(out)}</sheetData></worksheet>')

    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    workbook = f'<?xml version="1.0" encoding="UTF-8"?><workbook {ns}><sheets>' + "".join(
        f'<sheet name="{escape(name)}" sheetId="{i + 1}" r:id="rId{i + 3}"/>' for i, (name, _) in enumerate(sheets)) + "</sheets></workbook>"
    rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(
        f'<Relationship Id="rId{i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
        for i in range(len(sheets))) + "</Relationships>"
    shared = ('<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings) + "</sst>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", rels)
        z.writestr("xl/sharedStrings.xml", shared)
        for i, x in enumerate(sheet_xml):
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", x)


def head(name, account):
    return [["Account number", account], [name], ["Date from (UTC)", serial("2025-12-31T23:00:00")],
            ["Date to (UTC)", serial("2026-11-15T09:39:00")]]


CLOSED_HEADER = ["Instrument", "Ticker", "Category", "Type", "Volume", "Open Price", "Open Time (UTC)", "Close Price",
                 "Close Time (UTC)", "Product", "Profit/Loss", "Gross Profit", "Purchase Value", "Sale Value", "Stop Loss",
                 "Take Profit", "Commission", "Margin", "Swap", "Rollover", "Open Conversion Rate",
                 "Close Conversion Rate", "Close Origin", "Position ID", "Comment"]
CASH_HEADER = ["Type", "Instrument", "Ticker", "Category", "Time", "Amount", "ID", "Comment", "Product", "Position ID"]
OPEN_HEADER = ["Product", "Instrument/Position", "Ticker", "Category", "Type", "Volume", "Value", "Current price",
               "Open price", "Open time (UTC)", "Stop Loss", "Take Profit", "Net Profit %", "Net Profit", "Gross Profit",
               "Margin", "Open Commission", "Swap", "Rollover"]


def closed(r):
    row = dict.fromkeys(CLOSED_HEADER, "")
    row.update(r)
    return [row[h] for h in CLOSED_HEADER]


# IKE (PLN account): one EUR ETF bought in two fills, one earlier position bought and sold.
write_xlsx(HERE / "IKE_11111111_2026-01-01_2026-11-15.xlsx", [
    ("Closed Positions", head("Closed Positions", "11111111") + [
        CLOSED_HEADER,
        closed({"Instrument": "FTSE All-World", "Ticker": "VWCE.DE", "Category": "ETF", "Type": "BUY", "Volume": 2,
                "Open Price": 100.0, "Open Time (UTC)": serial("2026-02-02T10:00:00"), "Close Price": 120.0,
                "Close Time (UTC)": serial("2026-06-01T12:00:00"), "Product": "IKE", "Commission": -1.5,
                "Position ID": "900"}),
        ["Profit/loss", "", "", "", "", "", "", "", "", "", 40],
    ]),
    ("Cash Operations", head("Cash Operations", "11111111") + [
        CASH_HEADER,
        ["Stock purchase", "FTSE All-World", "VWCE.DE", "ETF", serial("2026-09-25T09:30:00"), -1452.0, "2",
         "OPEN BUY 3/4 @ 110.00", "IKE", "500"],
        ["Stock purchase", "FTSE All-World", "VWCE.DE", "ETF", serial("2026-09-25T09:30:00"), -484.0, "3",
         "OPEN BUY 1/4 @ 110.00", "IKE", "500"],
        ["IKE deposit", "", "", "", serial("2026-09-25T09:00:00"), 2000.0, "1", "Transfer in & przelew", "IKE", ""],
        ["Total", "", "", "", "", 64.0],
    ]),
    ("Open Positions", [["Account number", "99999999"], ["Open Positions"],
                        ["Data as of report generated", serial("2026-11-15T09:39:00")],
                        ["Product", "Metric", "Amount", "Currency"], ["IKE", "Open position value", 2112.0, ""],
                        ["IKE", "Open position profit", 176.0, ""], None,
                        ["Note", "Summary values and open positions are shown as of the report generation time"],
                        OPEN_HEADER,
                        ["IKE", "FTSE All-World", "VWCE.DE", "ETF", "", 4, 2112.0, "", 110.0],
                        ["IKE", "500", "VWCE.DE", "", "BUY", 4, 2112.0, 120.0, 110.0, serial("2026-09-25T09:30:00")]]),
])

# EUR account: EUR deposits, one EUR ETF.
write_xlsx(HERE / "EUR_22222222_2026-01-01_2026-11-15.xlsx", [
    ("Closed Positions", head("Closed Positions", "22222222") + [CLOSED_HEADER, ["Profit/loss"]]),
    ("Cash Operations", head("Cash Operations", "22222222") + [
        CASH_HEADER,
        ["Stock purchase", "MSCI World", "EUNL.DE", "ETF", serial("2026-03-10T14:00:00"), -900.0, "5",
         "OPEN BUY 10 @ 90.00", "My Trades", "700"],
        ["Deposit", "", "", "", serial("2026-03-10T13:00:00"), 1000.0, "4", "Bank deposit", "My Trades", ""],
        ["Total", "", "", "", "", 100.0],
    ]),
    ("Open Positions", [["Account number", "22222222"], ["Open Positions"],
                        ["Data as of report generated", serial("2026-11-15T09:39:00")],
                        ["Product", "Metric", "Amount", "Currency"], ["My Trades", "Open position value", 1000.0, "EUR"],
                        ["My Trades", "Open position profit", 100.0, "EUR"], None, ["Note", "..."],
                        OPEN_HEADER,
                        ["My Trades", "MSCI World", "EUNL.DE", "ETF", "", 10, 1000.0, "", 90.0],
                        ["My Trades", "700", "EUNL.DE", "", "BUY", 10, 1000.0, 100.0, 90.0, serial("2026-03-10T14:00:00"),
                         "", "", 11.1, 100.0, 100.0, "", -2.0]]),
])

# Reader edge cases: stored (uncompressed) entries, inline strings, formula strings, booleans,
# entities, an absolute relationship target and no shared strings part.
with zipfile.ZipFile(HERE / "edge-cases.xlsx", "w", zipfile.ZIP_STORED) as z:
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    z.writestr("xl/workbook.xml", f'<workbook {ns}><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>')
    z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData>'
               '<row r="1"><c r="A1" t="inlineStr"><is><t>Zażółć &lt;gęślą&gt;</t></is></c><c r="C1" t="str"><f>A1</f><v>wynik</v></c></row>'
               '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3"><v>-12.5</v></c><c r="AA3" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c></row>'
               '</sheetData></worksheet>')
