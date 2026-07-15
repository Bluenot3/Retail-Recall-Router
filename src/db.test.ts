import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RetailRecallDatabase,
  createCampaignWithItems,
  getCampaignSnapshot,
  recordScan,
  undoLastScan,
} from "./db";
import { TEST_CAMPAIGN_ID, testCampaign, testRecallRows } from "./test/fixtures";

let database: RetailRecallDatabase;

beforeEach(() => {
  database = new RetailRecallDatabase(`recall-test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  database.close();
  await database.delete();
});

async function createTestRecall() {
  await createCampaignWithItems(testCampaign, testRecallRows, database);
}

describe("recall database", () => {
  it("creates a campaign from validated recall rows", async () => {
    await createTestRecall();
    const snapshot = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.summary).toMatchObject({
      totalItems: 3,
      foundItems: 0,
      remainingItems: 3,
      totalScans: 0,
    });
  });

  it("keeps repeated recalled UPCs green and does not inflate completed items", async () => {
    await createTestRecall();
    const barcode = testRecallRows[0].barcode;
    const first = await recordScan(TEST_CAMPAIGN_ID, barcode, {}, database);
    const second = await recordScan(TEST_CAMPAIGN_ID, barcode, {}, database);

    expect(first.scan).toMatchObject({ outcome: "match", decision: "keep", isRepeatMatch: false });
    expect(second.scan).toMatchObject({ outcome: "match", decision: "keep", isRepeatMatch: true });
    const snapshot = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);
    expect(snapshot.summary).toMatchObject({ foundItems: 1, remainingItems: 2, totalScans: 2 });
    expect(snapshot.items.find((item) => item.barcode === barcode)?.quantityFound).toBe(2);

    const undone = await undoLastScan(TEST_CAMPAIGN_ID, database);
    expect(undone?.item?.quantityFound).toBe(1);
    expect((await getCampaignSnapshot(TEST_CAMPAIGN_ID, database)).summary.totalScans).toBe(1);
  });

  it("records a valid non-recall as a miss and malformed input as invalid", async () => {
    await createTestRecall();
    expect(
      (await recordScan(TEST_CAMPAIGN_ID, "9780201379624", {}, database)).scan,
    ).toMatchObject({ outcome: "miss", decision: "leave" });
    expect(
      (await recordScan(TEST_CAMPAIGN_ID, "036000291453", {}, database)).scan,
    ).toMatchObject({ outcome: "invalid", decision: "retry", invalidReason: "bad-check-digit" });
  });
});
