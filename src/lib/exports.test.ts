import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RetailRecallDatabase,
  createCampaignWithItems,
  getCampaignSnapshot,
  recordScan,
} from "../db";
import { TEST_CAMPAIGN_ID, testCampaign, testRecallRows } from "../test/fixtures";
import {
  campaignToCsv,
  createBackup,
  parseBackup,
  restoreBackup,
  safeFilename,
} from "./exports";

let source: RetailRecallDatabase;
let destination: RetailRecallDatabase;

beforeEach(() => {
  source = new RetailRecallDatabase(`export-source-${crypto.randomUUID()}`);
  destination = new RetailRecallDatabase(`export-destination-${crypto.randomUUID()}`);
});

afterEach(async () => {
  source.close();
  destination.close();
  await source.delete();
  await destination.delete();
});

async function createTestRecall(database: RetailRecallDatabase) {
  await createCampaignWithItems(testCampaign, testRecallRows, database);
}

describe("backup and exports", () => {
  it("round-trips a complete local archive", async () => {
    await createTestRecall(source);
    await recordScan(TEST_CAMPAIGN_ID, testRecallRows[0].barcode, {}, source);
    const backup = await createBackup(source);
    expect(parseBackup(JSON.stringify(backup))).toMatchObject({ version: 1 });

    await restoreBackup(backup, { mode: "replace" }, destination);
    const snapshot = await getCampaignSnapshot(TEST_CAMPAIGN_ID, destination);
    expect(snapshot).toMatchObject({
      summary: { totalItems: 3, foundItems: 1, totalScans: 1 },
    });
  });

  it("replaces a conflicting campaign snapshot without mixing newer local scans", async () => {
    await createTestRecall(source);
    const backup = await createBackup(source);
    await createTestRecall(destination);
    await recordScan(TEST_CAMPAIGN_ID, testRecallRows[0].barcode, {}, destination);

    await restoreBackup(backup, { mode: "merge" }, destination);
    const snapshot = await getCampaignSnapshot(TEST_CAMPAIGN_ID, destination);
    expect(snapshot.summary).toMatchObject({ foundItems: 0, totalScans: 0 });
  });

  it("exports Excel-safe barcodes and neutralizes description formulas", async () => {
    await createTestRecall(source);
    const snapshot = await getCampaignSnapshot(TEST_CAMPAIGN_ID, source);
    snapshot.items[0].description = "=DANGEROUS()";
    const exported = campaignToCsv(snapshot);
    expect(exported).toContain(`="${snapshot.items[0].barcode}"`);
    expect(exported).toContain("'=DANGEROUS()");
    snapshot.items[0].description = "\t=HIDDEN()";
    expect(campaignToCsv(snapshot)).toContain("'\t=HIDDEN()");
  });

  it("creates tidy download names and rejects unrelated JSON", () => {
    expect(safeFilename("  Example Optical / TEST-001  ")).toBe("example-optical-test-001");
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/not a supported/i);
  });

  it("rejects a crafted backup barcode before it reaches CSV export", async () => {
    await createTestRecall(source);
    const backup = await createBackup(source);
    backup.items[0].barcode = '=HYPERLINK("https://example.invalid")';
    expect(() => parseBackup(backup)).toThrow(/invalid recall item/i);
  });
});
