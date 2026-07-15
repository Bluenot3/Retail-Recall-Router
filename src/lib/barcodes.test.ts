import { describe, expect, it } from "vitest";
import { testRecallRows } from "../test/fixtures";
import {
  barcodesMatch,
  calculateCheckDigit,
  evaluateBarcode,
  normalizeBarcode,
  toGtin14,
  validateBarcode,
} from "./barcodes";

describe("GS1 barcode handling", () => {
  it("validates every synthetic recall identifier", () => {
    expect(testRecallRows).toHaveLength(3);
    for (const frame of testRecallRows) {
      expect(validateBarcode(frame.barcode)).toMatchObject({ normalized: frame.barcode, valid: true });
    }
  });

  it("supports every retail GTIN length", () => {
    for (const body of ["1234567", "12345678901", "400638133393", "1001234500001"]) {
      const barcode = `${body}${calculateCheckDigit(body)}`;
      expect(validateBarcode(barcode).valid).toBe(true);
    }
  });

  it("canonicalizes equivalent UPC-A, EAN-13 and GTIN-14 values", () => {
    const upc = "036000291452";
    expect(toGtin14(upc)).toBe("00036000291452");
    expect(barcodesMatch(upc, `0${upc}`)).toBe(true);
    expect(barcodesMatch(upc, `00${upc}`)).toBe(true);
  });

  it("accepts known scanner and spreadsheet wrappers without losing zeroes", () => {
    expect(normalizeBarcode('="0036000291452"')).toBe("0036000291452");
    expect(normalizeBarcode("]E0036000291452\r\n")).toBe("036000291452");
    expect(normalizeBarcode("]C10100036000291452")).toBe("00036000291452");
    expect(validateBarcode("0360 0029-1452").valid).toBe(true);
  });

  it("marks malformed values invalid so the UI can show amber", () => {
    expect(evaluateBarcode("ABC036000291452")).toMatchObject({
      outcome: "invalid",
      reason: "non-numeric",
    });
    expect(evaluateBarcode("03600029145")).toMatchObject({
      outcome: "invalid",
      reason: "unsupported-length",
    });
    expect(evaluateBarcode("036000291453")).toMatchObject({
      outcome: "invalid",
      reason: "bad-check-digit",
    });
    expect(evaluateBarcode(" ")).toMatchObject({ outcome: "invalid", reason: "empty" });
  });
});
