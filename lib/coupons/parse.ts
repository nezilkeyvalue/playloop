// lib/coupons/parse.ts
//
// Decodes an uploaded coupon list into a flat array of raw code strings.
// Normalisation and de-duplication are NOT done here — that's
// normalizeCodeBatch() in ./codes.ts, so a textarea paste and a spreadsheet
// upload go through exactly the same cleaning rules.
//
// Supports CSV/TSV (parsed here, no dependency) and XLSX (exceljs).
//
// A note on why this is more than `split("\n")`: real merchant exports are
// full-width spreadsheets — a "Discount code" column sitting next to "Type",
// "Value", "Starts at", "Times used". Grabbing column 0 of such a file
// imports the wrong column silently, which is the worst possible failure for
// something that hands out money. So the column is FOUND by header name, and
// only falls back to "first column" when there is no recognisable header.

import type { Buffer } from "node:buffer";

export type CouponFileFormat = "csv" | "xlsx";

export interface ParsedCouponFile {
  /** Raw cell values, uncleaned. */
  raw: string[];
  format: CouponFileFormat;
  /** Data rows considered (excludes a detected header row). */
  rowsScanned: number;
  /** Header label the code column was taken from, when one was detected. */
  columnHeader?: string;
  /** Zero-based index of the column the codes came from. */
  columnIndex: number;
}

/** Header cells that mean "this column holds the coupon code". */
const CODE_HEADER_PATTERNS = [
  /^discount\s*code$/i,
  /^coupon\s*code$/i,
  /^promo(tion)?\s*code$/i,
  /^voucher\s*code$/i,
  /^gift\s*card\s*code$/i,
  /^code$/i,
  /^coupon$/i,
  /^voucher$/i,
  /^promo$/i,
];

const MAX_ROWS = 100_000;

function looksLikeCodeHeader(cell: string): boolean {
  const v = cell.trim();
  return CODE_HEADER_PATTERNS.some((re) => re.test(v));
}

/**
 * True when a row of cells reads as column titles rather than data. Only
 * consulted for the first row.
 */
function detectHeaderColumn(firstRow: string[]): { index: number; header: string } | null {
  for (let i = 0; i < firstRow.length; i++) {
    const cell = firstRow[i] ?? "";
    if (looksLikeCodeHeader(cell)) return { index: i, header: cell.trim() };
  }
  return null;
}

export function detectFormat(filename: string, contentType?: string): CouponFileFormat | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt")) return "csv";
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return "xlsx";

  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("spreadsheetml")) return "xlsx";
  if (ct.includes("csv") || ct.startsWith("text/")) return "csv";

  // .xls (the pre-2007 binary format) is deliberately NOT accepted rather
  // than silently mis-parsed: exceljs cannot read it, and letting it through
  // would surface as "0 codes imported" with no explanation.
  return null;
}

/**
 * Minimal RFC-4180 CSV row splitter: handles quoted fields, escaped quotes
 * ("" inside a quoted field), and embedded newlines/delimiters.
 *
 * Hand-rolled rather than pulling in a parser because the requirement is one
 * column of short codes — but it does have to respect quoting, because a
 * quoted field containing a comma would otherwise shift every later column
 * and import the wrong one.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM — Excel writes one on "CSV UTF-8" export, and it would
  // otherwise become part of the first header cell and defeat header
  // detection.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else if (ch === "\r") {
      // Swallow CR; the LF that follows ends the row (CRLF files).
    } else {
      field += ch;
    }
  }

  // Trailing field/row with no terminating newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Picks the delimiter by counting candidates in the first line. */
function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [
    [",", (firstLine.match(/,/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const best = counts[0]!;
  // No delimiter at all means one code per line — comma is a safe no-op.
  return best[1] > 0 ? best[0] : ",";
}

function collectColumn(rows: string[][]): Omit<ParsedCouponFile, "format"> {
  if (rows.length === 0) return { raw: [], rowsScanned: 0, columnIndex: 0 };

  const header = detectHeaderColumn(rows[0] ?? []);
  const startRow = header ? 1 : 0;
  const columnIndex = header ? header.index : 0;

  const raw: string[] = [];
  for (let r = startRow; r < rows.length; r++) {
    const cell = rows[r]?.[columnIndex];
    if (cell !== undefined) raw.push(cell);
  }

  const result: Omit<ParsedCouponFile, "format"> = {
    raw,
    rowsScanned: Math.max(0, rows.length - startRow),
    columnIndex,
  };
  if (header) result.columnHeader = header.header;
  return result;
}

export function parseCsv(text: string): Omit<ParsedCouponFile, "format"> {
  return collectColumn(parseDelimited(text, sniffDelimiter(text)));
}

export async function parseXlsx(buffer: Buffer): Promise<Omit<ParsedCouponFile, "format">> {
  // Dynamic import: exceljs is a heavy dependency pulled in only by this one
  // route, and a static import would put it in the bundle of every route that
  // transitively touches this module.
  // exceljs is CommonJS, so `await import()` hands back a module namespace
  // whose real exports sit under `.default`. Reaching for `.Workbook`
  // directly gives "ExcelJS.Workbook is not a constructor" — confirmed, not
  // theoretical. The `?? mod` keeps working if it ever ships real ESM.
  const mod = await import("exceljs");
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod);
  const workbook = new ExcelJS.Workbook();
  // `as never`: exceljs's Node typings want its own Buffer overload, which
  // doesn't line up with the global Buffer type under this tsconfig.
  await workbook.xlsx.load(buffer as never);

  const sheet = workbook.worksheets[0];
  if (!sheet) return { raw: [], rowsScanned: 0, columnIndex: 0 };

  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length > MAX_ROWS) return;
    const cells: string[] = [];
    // row.values is 1-based with a leading hole; slice(1) realigns to 0-based.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const v of values) cells.push(cellToString(v));
    rows.push(cells);
  });

  return collectColumn(rows);
}

/**
 * Flattens whatever exceljs hands back for a cell into a plain string.
 *
 * Codes that look numeric ("100200300") come back as numbers, and a formula
 * cell comes back as an object carrying its computed `result` — both would
 * stringify to junk ("[object Object]") without this.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("result" in obj) return cellToString(obj.result);
    if ("text" in obj) return cellToString(obj.text);
    // A rich-text cell is { richText: [{ text }, …] }.
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => cellToString((part as { text?: unknown }).text)).join("");
    }
    if ("hyperlink" in obj && "text" in obj) return cellToString(obj.text);
  }
  return "";
}

export async function parseCouponFile(
  buffer: Buffer,
  filename: string,
  contentType?: string,
): Promise<ParsedCouponFile> {
  const format = detectFormat(filename, contentType);
  if (!format) {
    throw new Error(
      "Unsupported file type. Upload a .csv or .xlsx file (the old .xls binary format isn't supported — re-save it as .xlsx).",
    );
  }

  if (format === "csv") {
    return { ...parseCsv(buffer.toString("utf8")), format };
  }
  return { ...(await parseXlsx(buffer)), format };
}
