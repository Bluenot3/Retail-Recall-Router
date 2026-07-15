import type {
  BarcodeFormat,
  BarcodeValidation,
  ScanEvaluation,
} from "../types";

const SUPPORTED_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * Removes only known scanner/worksheet wrappers and harmless visual separators.
 * Unexpected letters and punctuation are deliberately retained so a malformed
 * scan cannot be converted into a plausible (but wrong) GTIN.
 */
export function normalizeBarcode(value: unknown): string {
  if (value === null || value === undefined) return "";

  let candidate = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

  // Excel-safe CSV exports use ="012345678905" to preserve leading zeroes.
  const excelText = candidate.match(/^=\s*"(\d+)"$/);
  if (excelText) candidate = excelText[1];

  // A leading apostrophe is another common spreadsheet text marker.
  if (/^'\d+$/.test(candidate)) candidate = candidate.slice(1);

  // GS1 human-readable Application Identifier 01.
  const parenthesizedAi = candidate.match(/^\(01\)\s*(\d{14})$/);
  if (parenthesizedAi) return parenthesizedAi[1];

  // AIM symbology identifiers commonly emitted by USB scanners.
  const aimMatch = candidate.match(/^\]([A-Za-z])([0-9])(.*)$/);
  if (aimMatch) {
    const symbology = `${aimMatch[1].toUpperCase()}${aimMatch[2]}`;
    candidate = aimMatch[3].trim();
    // GS1-128 carries AI 01 before a 14-digit GTIN.
    if (symbology === "C1" && /^01\d{14}$/.test(candidate)) {
      candidate = candidate.slice(2);
    }
  }

  // Spaces and hyphens are accepted only when every remaining character is a
  // digit. This allows printed GTIN grouping without forgiving other typos.
  if (/^[\d\s-]+$/.test(candidate)) {
    candidate = candidate.replace(/[\s-]/g, "");
  }

  return candidate;
}

export function calculateCheckDigit(body: string): number | null {
  if (!/^\d+$/.test(body) || body.length < 1) return null;

  let sum = 0;
  let weight = 3;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }

  return (10 - (sum % 10)) % 10;
}

export function hasValidCheckDigit(barcode: string): boolean {
  if (!/^\d+$/.test(barcode) || barcode.length < 2) return false;
  const expected = calculateCheckDigit(barcode.slice(0, -1));
  return expected !== null && expected === Number(barcode.at(-1));
}

export function barcodeFormat(barcode: string): BarcodeFormat | undefined {
  switch (barcode.length) {
    case 8:
      return "GTIN-8";
    case 12:
      return "UPC-A";
    case 13:
      return "EAN-13";
    case 14:
      return "GTIN-14";
    default:
      return undefined;
  }
}

/** Canonical comparison key. A UPC-A and its zero-prefixed EAN/GTIN match. */
export function toGtin14(barcode: string): string | null {
  if (!/^\d+$/.test(barcode) || !SUPPORTED_LENGTHS.has(barcode.length)) {
    return null;
  }
  return barcode.padStart(14, "0");
}

export function validateBarcode(value: unknown): BarcodeValidation {
  const raw = value === null || value === undefined ? "" : String(value);
  const normalized = normalizeBarcode(value);

  if (!normalized) {
    return { raw, normalized, valid: false, reason: "empty" };
  }

  if (!/^\d+$/.test(normalized)) {
    return { raw, normalized, valid: false, reason: "non-numeric" };
  }

  const format = barcodeFormat(normalized);
  if (!format) {
    return { raw, normalized, valid: false, reason: "unsupported-length" };
  }

  if (!hasValidCheckDigit(normalized)) {
    return {
      raw,
      normalized,
      format,
      valid: false,
      reason: "bad-check-digit",
    };
  }

  return {
    raw,
    normalized,
    barcodeKey: toGtin14(normalized) ?? undefined,
    format,
    valid: true,
  };
}

/**
 * Scanner-facing validation. Invalid/malformed values are explicitly marked
 * invalid so callers can show amber SCAN AGAIN instead of a red false miss.
 */
export function evaluateBarcode(value: unknown): ScanEvaluation {
  const validation = validateBarcode(value);
  return {
    ...validation,
    outcome: validation.valid ? "valid" : "invalid",
  };
}

export function barcodesMatch(left: unknown, right: unknown): boolean {
  const a = validateBarcode(left);
  const b = validateBarcode(right);
  return Boolean(a.valid && b.valid && a.barcodeKey === b.barcodeKey);
}

