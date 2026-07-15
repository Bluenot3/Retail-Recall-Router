import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RetailRecallDatabase,
  addCampaignItem,
  createCampaignWithItems,
  getCampaignSnapshot,
  mergeCampaignItems,
  previewCampaignItemMerge,
  recordScan,
  setCampaignStatus,
  undoLastScan,
  updateCampaignItem,
} from "./db";
import { TEST_CAMPAIGN_ID, testCampaign, testRecallRows } from "./test/fixtures";

let database: RetailRecallDatabase;

beforeEach(() => {
  localStorage.clear();
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

  it("never undoes imported legacy progress", async () => {
    await createTestRecall();
    await database.scans.add({
      id: "legacy-summary",
      campaignId: TEST_CAMPAIGN_ID,
      rawValue: testRecallRows[0].barcode,
      outcome: "match",
      decision: "keep",
      isRepeatMatch: false,
      source: "legacy",
      scannedAt: "2099-01-01T00:00:00.000Z",
    });
    const normal = await recordScan(TEST_CAMPAIGN_ID, testRecallRows[1].barcode, {}, database);

    const undone = await undoLastScan(TEST_CAMPAIGN_ID, database);

    expect(undone?.scan.id).toBe(normal.scan.id);
    expect((await database.scans.get("legacy-summary"))?.undoneAt).toBeUndefined();
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

  it("adds only new UPCs to a paused campaign without changing scans or progress", async () => {
    await createTestRecall();
    await recordScan(TEST_CAMPAIGN_ID, testRecallRows[0].barcode, {}, database);
    await recordScan(TEST_CAMPAIGN_ID, "9780201379624", {}, database);
    await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);

    const scansBefore = await database.scans.toArray();
    const matchedBefore = (await getCampaignSnapshot(TEST_CAMPAIGN_ID, database)).items.find(
      (item) => item.barcode === testRecallRows[0].barcode,
    );
    const preview = await previewCampaignItemMerge(
      TEST_CAMPAIGN_ID,
      [
        testRecallRows[0],
        { barcode: "9780201379624", description: "Late recall addition", quantity: 1 },
      ],
      database,
    );

    expect(preview.additions).toHaveLength(1);
    expect(preview.existing).toHaveLength(1);
    expect(preview.additions[0]).toMatchObject({ barcode: "9780201379624", priorMissCount: 1 });

    const merged = await mergeCampaignItems(
      TEST_CAMPAIGN_ID,
      [
        testRecallRows[0],
        { barcode: "9780201379624", description: "Late recall addition", quantity: 1 },
      ],
      { expectedCampaignUpdatedAt: preview.campaignUpdatedAt },
      database,
    );
    const snapshot = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);

    expect(merged.addedItems).toHaveLength(1);
    expect(merged.skippedExistingItems).toHaveLength(1);
    expect(await database.scans.toArray()).toEqual(scansBefore);
    expect(snapshot.summary.totalScans).toBe(2);
    expect(snapshot.items.find((item) => item.id === matchedBefore?.id)).toMatchObject({
      quantityFound: matchedBefore?.quantityFound,
      firstMatchedAt: matchedBefore?.firstMatchedAt,
      lastMatchedAt: matchedBefore?.lastMatchedAt,
    });
    expect(snapshot.items.find((item) => item.barcode === "9780201379624")).toMatchObject({
      quantityFound: 0,
      quantityRequired: 1,
    });
    expect(snapshot.scans.find((scan) => scan.barcode === "9780201379624")?.outcome).toBe("miss");
  });

  it("is idempotent when the same addendum is merged more than once", async () => {
    await createTestRecall();
    await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);
    const addendum = [
      { barcode: "9780306406157", description: "New frame", quantity: 2 },
    ];

    const firstPreview = await previewCampaignItemMerge(TEST_CAMPAIGN_ID, addendum, database);
    const first = await mergeCampaignItems(
      TEST_CAMPAIGN_ID,
      addendum,
      { expectedCampaignUpdatedAt: firstPreview.campaignUpdatedAt },
      database,
    );
    const secondPreview = await previewCampaignItemMerge(TEST_CAMPAIGN_ID, addendum, database);
    const second = await mergeCampaignItems(
      TEST_CAMPAIGN_ID,
      addendum,
      { expectedCampaignUpdatedAt: secondPreview.campaignUpdatedAt },
      database,
    );

    expect(first.addedItems).toHaveLength(1);
    expect(second.addedItems).toHaveLength(0);
    expect(second.skippedExistingItems).toHaveLength(1);
    const items = await database.items.where("campaignId").equals(TEST_CAMPAIGN_ID).toArray();
    expect(items).toHaveLength(4);
    expect(items.find((item) => item.barcode === "9780306406157")?.quantityRequired).toBe(2);
  });

  it("rolls back the entire merge when any incoming barcode is invalid", async () => {
    await createTestRecall();
    const paused = await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);

    await expect(
      mergeCampaignItems(
        TEST_CAMPAIGN_ID,
        [
          { barcode: "9780306406157", description: "Would be valid" },
          { barcode: "036000291453", description: "Bad check digit" },
        ],
        { expectedCampaignUpdatedAt: paused.updatedAt },
        database,
      ),
    ).rejects.toThrow(/invalid barcode/i);

    expect(await database.items.where("campaignId").equals(TEST_CAMPAIGN_ID).count()).toBe(3);
  });

  it("rejects staff merges while active but permits an explicit internal active patch", async () => {
    await createTestRecall();
    const campaign = await database.campaigns.get(TEST_CAMPAIGN_ID);
    const addendum = [{ barcode: "9780306406157", description: "System-added frame" }];

    await expect(
      mergeCampaignItems(
        TEST_CAMPAIGN_ID,
        addendum,
        { expectedCampaignUpdatedAt: campaign!.updatedAt },
        database,
      ),
    ).rejects.toThrow(/pause/i);
    expect(await database.items.where("campaignId").equals(TEST_CAMPAIGN_ID).count()).toBe(3);

    const merged = await mergeCampaignItems(
      TEST_CAMPAIGN_ID,
      addendum,
      { expectedCampaignUpdatedAt: campaign!.updatedAt, allowActiveCampaign: true },
      database,
    );
    expect(merged.addedItems).toHaveLength(1);
  });

  it("rejects a stale merge without partial writes", async () => {
    await createTestRecall();
    const paused = await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);
    await database.campaigns.update(TEST_CAMPAIGN_ID, {
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    await expect(
      mergeCampaignItems(
        TEST_CAMPAIGN_ID,
        [{ barcode: "9780306406157", description: "Stale addition" }],
        { expectedCampaignUpdatedAt: paused.updatedAt },
        database,
      ),
    ).rejects.toThrow(/changed after it was opened/i);
    expect(await database.items.where("campaignId").equals(TEST_CAMPAIGN_ID).count()).toBe(3);
  });

  it("manually adds one item and leaves all localStorage values untouched", async () => {
    localStorage.setItem("maui-jim-med-1171-pulled-v1", '["036000291452"]');
    localStorage.setItem("maui-jim-med-1171-scan-count-v1", "17");
    localStorage.setItem("maui-jim-med-1171-sound-v1", "off");
    await createTestRecall();
    const paused = await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);

    const added = await addCampaignItem(
      TEST_CAMPAIGN_ID,
      { barcode: "9780306406157", description: "Manual frame" },
      { expectedCampaignUpdatedAt: paused.updatedAt },
      database,
    );

    expect(added).toMatchObject({ barcode: "9780306406157", quantityFound: 0 });
    expect(localStorage.getItem("maui-jim-med-1171-pulled-v1")).toBe('["036000291452"]');
    expect(localStorage.getItem("maui-jim-med-1171-scan-count-v1")).toBe("17");
    expect(localStorage.getItem("maui-jim-med-1171-sound-v1")).toBe("off");

    const currentCampaign = await database.campaigns.get(TEST_CAMPAIGN_ID);
    await expect(
      addCampaignItem(
        TEST_CAMPAIGN_ID,
        { barcode: "9780306406157", description: "Duplicate manual frame" },
        { expectedCampaignUpdatedAt: currentCampaign!.updatedAt },
        database,
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("edits metadata and required quantity without changing progress or scan history", async () => {
    await createTestRecall();
    await recordScan(TEST_CAMPAIGN_ID, testRecallRows[0].barcode, {}, database);
    await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);
    const campaign = await database.campaigns.get(TEST_CAMPAIGN_ID);
    const item = (await database.items.where("campaignId").equals(TEST_CAMPAIGN_ID).toArray()).find(
      (candidate) => candidate.barcode === testRecallRows[0].barcode,
    )!;
    const scansBefore = await database.scans.toArray();

    const updated = await updateCampaignItem(
      TEST_CAMPAIGN_ID,
      item.id,
      { description: "Updated frame description", model: null, quantityRequired: 3 },
      {
        expectedCampaignUpdatedAt: campaign!.updatedAt,
        expectedItemUpdatedAt: item.updatedAt,
      },
      database,
    );

    expect(updated).toMatchObject({
      description: "Updated frame description",
      model: undefined,
      quantityRequired: 3,
      quantityFound: item.quantityFound,
      createdAt: item.createdAt,
      firstMatchedAt: item.firstMatchedAt,
      lastMatchedAt: item.lastMatchedAt,
    });
    expect(await database.scans.toArray()).toEqual(scansBefore);

    const latestCampaign = await database.campaigns.get(TEST_CAMPAIGN_ID);
    await expect(
      updateCampaignItem(
        TEST_CAMPAIGN_ID,
        item.id,
        { description: "Stale edit" },
        {
          expectedCampaignUpdatedAt: latestCampaign!.updatedAt,
          expectedItemUpdatedAt: item.updatedAt,
        },
        database,
      ),
    ).rejects.toThrow(/item changed/i);
  });

  it("permits an unscanned barcode correction but rejects collisions and scanned barcode edits", async () => {
    await createTestRecall();
    await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);
    let campaign = await database.campaigns.get(TEST_CAMPAIGN_ID);
    const items = await database.items.where("campaignId").equals(TEST_CAMPAIGN_ID).toArray();
    const unscanned = items[0];

    await expect(
      updateCampaignItem(
        TEST_CAMPAIGN_ID,
        unscanned.id,
        { barcode: items[1].barcode },
        {
          expectedCampaignUpdatedAt: campaign!.updatedAt,
          expectedItemUpdatedAt: unscanned.updatedAt,
        },
        database,
      ),
    ).rejects.toThrow(/already exists/i);

    const corrected = await updateCampaignItem(
      TEST_CAMPAIGN_ID,
      unscanned.id,
      { barcode: "012345678905" },
      {
        expectedCampaignUpdatedAt: campaign!.updatedAt,
        expectedItemUpdatedAt: unscanned.updatedAt,
      },
      database,
    );
    expect(corrected).toMatchObject({ barcode: "012345678905" });

    campaign = await setCampaignStatus(TEST_CAMPAIGN_ID, "active", database);
    await recordScan(TEST_CAMPAIGN_ID, corrected.barcode, {}, database);
    campaign = await setCampaignStatus(TEST_CAMPAIGN_ID, "paused", database);
    const scanned = await database.items.get(corrected.id);
    await expect(
      updateCampaignItem(
        TEST_CAMPAIGN_ID,
        corrected.id,
        { barcode: "0012345678905" },
        {
          expectedCampaignUpdatedAt: campaign.updatedAt,
          expectedItemUpdatedAt: scanned!.updatedAt,
        },
        database,
      ),
    ).rejects.toThrow(/cannot change.*scanned/i);

    await expect(
      updateCampaignItem(
        TEST_CAMPAIGN_ID,
        corrected.id,
        { barcode: "9780306406157" },
        {
          expectedCampaignUpdatedAt: campaign.updatedAt,
          expectedItemUpdatedAt: scanned!.updatedAt,
        },
        database,
      ),
    ).rejects.toThrow(/cannot change.*scanned/i);
  });
});
