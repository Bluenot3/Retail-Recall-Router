import type {
  ColumnInference,
  ImportResult,
  ImportedRecallRow,
  RecallColumnMapping,
  RejectedRecallRow,
} from "../types";
import { validateBarcode } from "./barcodes";

export interface RecallFileSource {
  name: string;
  type?: string;
  data: string | ArrayBuffer | Uint8Array;
}

export interface RecallImportOptions {
  mapping?: RecallColumnMapping;
  headerRowIndex?: number | null;
  delimiter?: string;
  sheetName?: string;
}

const HEADER_ALIASES: Record<Exclude<keyof RecallColumnMapping, "barcode"> | "barcode", string[]> = {
  barcode: ["barcode", "bar code", "upc", "upc a", "gtin", "gtin 8", "gtin 12", "gtin 13", "gtin 14", "ean", "ean 13"],
  description: ["description", "product description", "frame description", "frame", "product", "product name", "frame name", "item description", "name"],
  brand: ["brand", "manufacturer", "vendor", "maker"],
  model: ["model", "model name", "frame model"],
  style: ["style", "style number", "style no", "frame number", "frame no"],
  color: ["color", "colour", "color code", "colour code"],
  sku: ["sku", "item", "item number", "item no", "product code", "material number"],
  quantity: ["quantity", "qty", "units", "count", "recall quantity"],
  notes: ["notes", "note", "comments", "comment", "reason"],
};

function normalizedHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[_/\\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ");
}

function headerField(value: string): keyof RecallColumnMapping | undefined {
  const normalized = normalizedHeader(value);
  return (Object.keys(HEADER_ALIASES) as Array<keyof RecallColumnMapping>).find(
    (key) => HEADER_ALIASES[key].includes(normalized),
  );
}

function mappingFromHeader(row: string[]): RecallColumnMapping | null {
  const result: Partial<RecallColumnMapping> = {};
  row.forEach((value, index) => {
    const field = headerField(value);
    if (field && result[field] === undefined) result[field] = index;
  });
  return result.barcode === undefined ? null : (result as RecallColumnMapping);
}

function countMappedColumns(mapping: RecallColumnMapping): number {
  return Object.values(mapping).filter((value) => value !== undefined).length;
}

export function inferRecallColumns(table: string[][]): ColumnInference {
  const indexedRows = table
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.some((cell) => String(cell).trim()));
  const rows = indexedRows.map(({ row }) => row);
  let bestHeader:
    | { index: number; mapping: RecallColumnMapping; score: number; headers: string[] }
    | undefined;

  indexedRows.slice(0, 12).forEach(({ row, index }) => {
    const mapping = mappingFromHeader(row);
    if (!mapping) return;
    const score = countMappedColumns(mapping);
    if (!bestHeader || score > bestHeader.score) {
      bestHeader = { index, mapping, score, headers: row.map(String) };
    }
  });

  if (bestHeader) {
    return {
      mapping: bestHeader.mapping,
      headerRowIndex: bestHeader.index,
      confidence: bestHeader.score >= 2 ? "high" : "medium",
      headers: bestHeader.headers,
    };
  }

  const width = Math.max(0, ...rows.map((row) => row.length));
  const candidates = Array.from({ length: width }, (_, column) => {
    const values = rows
      .slice(0, 100)
      .map((row) => String(row[column] ?? "").trim())
      .filter(Boolean);
    const validCount = values.filter((value) => validateBarcode(value).valid).length;
    return {
      column,
      nonEmpty: values.length,
      validCount,
      ratio: values.length ? validCount / values.length : 0,
    };
  }).sort((a, b) => b.ratio - a.ratio || b.validCount - a.validCount);

  const barcodeCandidate = candidates[0] ?? {
    column: 0,
    nonEmpty: 0,
    validCount: 0,
    ratio: 0,
  };

  const textCandidates = Array.from({ length: width }, (_, column) => {
    if (column === barcodeCandidate.column) return { column, score: -1 };
    const values = rows
      .slice(0, 100)
      .map((row) => String(row[column] ?? "").trim())
      .filter(Boolean);
    const averageLength = values.length
      ? values.reduce((total, value) => total + value.length, 0) / values.length
      : 0;
    const alphaRatio = values.length
      ? values.filter((value) => /[A-Za-z]/.test(value)).length / values.length
      : 0;
    return { column, score: averageLength * alphaRatio };
  }).sort((a, b) => b.score - a.score);

  const mapping: RecallColumnMapping = { barcode: barcodeCandidate.column };
  if (textCandidates[0]?.score > 0) mapping.description = textCandidates[0].column;

  return {
    mapping,
    headerRowIndex: null,
    confidence:
      barcodeCandidate.ratio >= 0.8 && barcodeCandidate.validCount >= 2
        ? "medium"
        : "low",
    headers: [],
  };
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 32_000);
  const candidates = [",", "\t", ";", "|"];
  let best = { delimiter: ",", columns: 1, consistency: 0 };

  for (const delimiter of candidates) {
    const rows = parseDelimitedRows(sample, delimiter).slice(0, 20);
    const widths = rows.filter((row) => row.some(Boolean)).map((row) => row.length);
    if (!widths.length) continue;
    const frequency = new Map<number, number>();
    widths.forEach((width) => frequency.set(width, (frequency.get(width) ?? 0) + 1));
    const [columns, count] = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0];
    const consistency = count / widths.length;
    if (columns > best.columns || (columns === best.columns && consistency > best.consistency)) {
      best = { delimiter, columns, consistency };
    }
  }

  return best.delimiter;
}

export function parseDelimitedRows(text: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1) throw new Error("Delimiter must be one character.");
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === delimiter && !quoted) {
      row.push(field);
      field = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += character;
  }

  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function valueAt(row: string[], column: number | undefined): string | undefined {
  if (column === undefined) return undefined;
  const value = String(row[column] ?? "").trim();
  return value || undefined;
}

function positiveQuantity(value: string | undefined): number {
  if (!value) return 1;
  const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function mapRowsToRecall(
  table: string[][],
  inference: ColumnInference = inferRecallColumns(table),
): Pick<ImportResult, "rows" | "rejected" | "warnings"> {
  const rows: ImportedRecallRow[] = [];
  const rejected: RejectedRecallRow[] = [];
  const warnings: string[] = [];
  const start = inference.headerRowIndex === null ? 0 : inference.headerRowIndex + 1;
  const seen = new Map<string, ImportedRecallRow>();

  for (let index = start; index < table.length; index += 1) {
    const values = table[index].map((value) => String(value ?? ""));
    if (!values.some((value) => value.trim())) continue;
    const rawBarcode = valueAt(values, inference.mapping.barcode) ?? "";
    const validation = validateBarcode(rawBarcode);
    if (!validation.valid || !validation.barcodeKey) {
      rejected.push({
        rowNumber: index + 1,
        barcode: rawBarcode || undefined,
        reason: validation.reason ?? "Missing or invalid barcode",
        values,
      });
      continue;
    }

    const description =
      valueAt(values, inference.mapping.description) ??
      valueAt(values, inference.mapping.model) ??
      `Frame ${validation.normalized}`;
    const imported: ImportedRecallRow = {
      barcode: validation.normalized,
      description,
      brand: valueAt(values, inference.mapping.brand),
      model: valueAt(values, inference.mapping.model),
      style: valueAt(values, inference.mapping.style),
      color: valueAt(values, inference.mapping.color),
      sku: valueAt(values, inference.mapping.sku),
      notes: valueAt(values, inference.mapping.notes),
      quantity: positiveQuantity(valueAt(values, inference.mapping.quantity)),
      sourceRowNumber: index + 1,
    };

    const duplicate = seen.get(validation.barcodeKey);
    if (duplicate) {
      duplicate.quantity = (duplicate.quantity ?? 1) + (imported.quantity ?? 1);
      warnings.push(
        `Rows ${duplicate.sourceRowNumber} and ${imported.sourceRowNumber} share GTIN ${validation.normalized}; quantities were combined.`,
      );
    } else {
      seen.set(validation.barcodeKey, imported);
      rows.push(imported);
    }
  }

  if (!rows.length) warnings.push("No valid GTIN-8, UPC-A, EAN-13, or GTIN-14 rows were found.");
  if (rejected.length) warnings.push(`${rejected.length} row${rejected.length === 1 ? " was" : "s were"} skipped because the barcode was missing or invalid.`);

  return { rows, rejected, warnings };
}

export function parseDelimitedRecall(
  text: string,
  optionsOrSourceName: RecallImportOptions | string = {},
  sourceNameArgument = "recall-list.csv",
): ImportResult {
  const options =
    typeof optionsOrSourceName === "string" ? {} : optionsOrSourceName;
  const sourceName =
    typeof optionsOrSourceName === "string"
      ? optionsOrSourceName
      : sourceNameArgument;
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const table = parseDelimitedRows(text, delimiter);
  const inferred = inferRecallColumns(table);
  const inference: ColumnInference = {
    ...inferred,
    mapping: options.mapping ?? inferred.mapping,
    headerRowIndex:
      options.headerRowIndex === undefined
        ? inferred.headerRowIndex
        : options.headerRowIndex,
  };
  const mapped = mapRowsToRecall(table, inference);
  const extension = sourceName.toLowerCase().split(".").pop();

  return {
    sourceName,
    sourceType: delimiter === "\t" || extension === "tsv" ? "tsv" : extension === "txt" ? "text" : "csv",
    inference,
    ...mapped,
  };
}

function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] ?? "";
}

function isFile(value: File | RecallFileSource): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

async function sourceText(source: File | RecallFileSource): Promise<string> {
  if (isFile(source)) return source.text();
  if (typeof source.data === "string") return source.data;
  const bytes = source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data);
  return new TextDecoder("utf-8").decode(bytes);
}

async function sourceBuffer(source: File | RecallFileSource): Promise<ArrayBuffer> {
  if (isFile(source)) return source.arrayBuffer();
  if (source.data instanceof ArrayBuffer) return source.data;
  if (source.data instanceof Uint8Array) {
    return source.data.buffer.slice(
      source.data.byteOffset,
      source.data.byteOffset + source.data.byteLength,
    ) as ArrayBuffer;
  }
  return new TextEncoder().encode(source.data).buffer;
}

export async function parseRecallFile(
  source: File | RecallFileSource,
  options: RecallImportOptions = {},
): Promise<ImportResult> {
  const extension = extensionOf(source.name);
  if (["csv", "tsv", "txt"].includes(extension)) {
    return parseDelimitedRecall(
      await sourceText(source),
      { ...options, delimiter: options.delimiter ?? (extension === "tsv" ? "\t" : undefined) },
      source.name,
    );
  }

  if (!["xlsx", "xls", "xlsm"].includes(extension)) {
    throw new Error("Unsupported recall list. Use CSV, TSV, XLSX, or XLS.");
  }

  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await sourceBuffer(source), {
    type: "array",
    cellDates: false,
    cellText: true,
  });
  const requestedSheet = options.sheetName;
  const sheetName =
    (requestedSheet && workbook.SheetNames.includes(requestedSheet)
      ? requestedSheet
      : workbook.SheetNames.find((name) => Boolean(workbook.Sheets[name]?.["!ref"]))) ??
    workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook does not contain a worksheet.");

  // raw:false uses the displayed cell text. A barcode formatted with leading
  // zeroes in Excel therefore remains intact instead of becoming a JS number.
  const table = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  }).map((row) => row.map((value) => String(value ?? "")));
  const inferred = inferRecallColumns(table);
  const inference: ColumnInference = {
    ...inferred,
    mapping: options.mapping ?? inferred.mapping,
    headerRowIndex:
      options.headerRowIndex === undefined
        ? inferred.headerRowIndex
        : options.headerRowIndex,
  };
  const mapped = mapRowsToRecall(table, inference);
  const warnings = [...mapped.warnings];
  if (workbook.SheetNames.length > 1 && !requestedSheet) {
    warnings.push(`Imported worksheet "${sheetName}". Other workbook tabs were left unchanged.`);
  }

  return {
    sourceName: source.name,
    sourceType: extension === "xls" ? "xls" : "xlsx",
    sheetName,
    inference,
    rows: mapped.rows,
    rejected: mapped.rejected,
    warnings,
  };
}
