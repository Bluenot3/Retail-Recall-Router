import { describe, expect, it } from "vitest";
import { calculateCheckDigit } from "./barcodes";
import {
  inferRecallColumns,
  parseDelimitedRecall,
  parseRecallFile,
} from "./importers";

describe("recall list import", () => {
  it("infers common columns, preserves quoted text and rejects malformed rows", () => {
    const csv = [
      "UPC,Frame Description,Brand,Qty",
      '036000291452,"Test Frame, Matte Black",Example Optical,2',
      "036000291453,Bad check digit,Example Optical,1",
    ].join("\r\n");
    const result = parseDelimitedRecall(csv, {}, "test.csv");

    expect(result.inference).toMatchObject({
      headerRowIndex: 0,
      confidence: "high",
      mapping: { barcode: 0, description: 1, brand: 2, quantity: 3 },
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        barcode: "036000291452",
        description: "Test Frame, Matte Black",
        brand: "Example Optical",
        quantity: 2,
      }),
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("bad-check-digit");
  });

  it("detects TSV and infers a headerless recall list", () => {
    const table = [
      ["036000291452", "Test Frame A"],
      ["4006381333931", "Test Frame B"],
    ];
    expect(inferRecallColumns(table)).toMatchObject({
      headerRowIndex: null,
      mapping: { barcode: 0, description: 1 },
    });

    const result = parseDelimitedRecall(
      "UPC\tProduct Name\n036000291452\tTest Frame A",
      {},
      "list.tsv",
    );
    expect(result.sourceType).toBe("tsv");
    expect(result.rows[0].description).toBe("Test Frame A");
  });

  it("combines duplicate GTIN rows into a required quantity", () => {
    const result = parseDelimitedRecall(
      "Barcode,Description,Qty\n036000291452,Test Frame A,1\n0036000291452,Test Frame A,2",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].quantity).toBe(3);
    expect(result.warnings.join(" ")).toContain("quantities were combined");
  });

  it("preserves a displayed leading zero from XLSX", async () => {
    const body = "012345678901";
    const ean = `${body}${calculateCheckDigit(body)}`;
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["GTIN", "Frame"],
      [Number(ean), "Leading Zero Frame"],
    ]);
    sheet.A2.z = "0000000000000";
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Recall");
    const data = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const result = await parseRecallFile({ name: "recall.xlsx", data });
    expect(result.rows[0].barcode).toBe(ean);
  });
});
