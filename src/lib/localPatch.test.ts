import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RetailRecallDatabase,
  createCampaignWithItems,
  getCampaignSnapshot,
  recordScan,
} from "../db";
import type { ImportedRecallRow } from "../types";
import { TEST_CAMPAIGN_ID, testCampaign, testRecallRows } from "../test/fixtures";
import { applyOptionalLocalPatch } from "./localPatch";

const SEVEN_ADDITIONAL_ROWS: ImportedRecallRow[] = [
  { barcode: "9780201379624", description: "Additional Frame 1" },
  { barcode: "9780306406157", description: "Additional Frame 2" },
  { barcode: "012345678905", description: "Additional Frame 3" },
  { barcode: "1234567890128", description: "Additional Frame 4" },
  { barcode: "4006381333900", description: "Additional Frame 5" },
  { barcode: "5012345678900", description: "Additional Frame 6" },
  { barcode: "9501234600000", description: "Additional Frame 7" },
];

let database: RetailRecallDatabase;

beforeEach(() => {
  localStorage.clear();
  database = new RetailRecallDatabase(`local-patch-test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  database.close();
  await database.delete();
});

function fetchResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-length": String(text.length) }),
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
}

function failedFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
}

function patch(items: ImportedRecallRow[], legacy?: Record<string, string>) {
  return {
    kind: "retail-recall-router-local-patch",
    version: 1,
    patchId: "test-local-patch-v1",
    campaign: testCampaign,
    items,
    legacy,
  };
}

describe("optional local recall patch", () => {
  it("is a complete no-op when the optional file is not present", async () => {
    const result = await applyOptionalLocalPatch({
      database,
      fetchImpl: fetchResponse("", 404),
      storage: localStorage,
    });

    expect(result).toMatchObject({
      found: false,
      campaignCreated: false,
      itemsAdded: 0,
      legacyMigrated: false,
    });
    expect(await database.campaigns.count()).toBe(0);
    expect(await database.items.count()).toBe(0);
    expect(await database.scans.count()).toBe(0);
    expect(await database.settings.count()).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("keeps the public app usable when the optional patch cannot be fetched offline", async () => {
    await createCampaignWithItems(testCampaign, testRecallRows, database);

    const result = await applyOptionalLocalPatch({
      database,
      fetchImpl: failedFetch(),
      storage: localStorage,
    });

    expect(result.found).toBe(false);
    expect(await database.campaigns.count()).toBe(1);
    expect(await database.items.count()).toBe(testRecallRows.length);
  });

  it("adds seven unseen rows to an active campaign without changing progress or scans", async () => {
    await createCampaignWithItems(testCampaign, testRecallRows, database);
    await recordScan(TEST_CAMPAIGN_ID, testRecallRows[0].barcode, {}, database);
    await recordScan(TEST_CAMPAIGN_ID, "9780201379624", {}, database);
    const before = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);
    const matchedBefore = before.items.find(
      (item) => item.barcode === testRecallRows[0].barcode,
    )!;

    const result = await applyOptionalLocalPatch({
      database,
      fetchImpl: fetchResponse(patch([...testRecallRows, ...SEVEN_ADDITIONAL_ROWS])),
      storage: localStorage,
    });
    const after = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);

    expect(result).toMatchObject({
      found: true,
      campaignCreated: false,
      itemsAdded: 7,
      itemsAlreadyPresent: 3,
    });
    expect(after.items).toHaveLength(10);
    expect(after.scans).toEqual(before.scans);
    expect(after.items.find((item) => item.id === matchedBefore.id)).toMatchObject({
      quantityFound: matchedBefore.quantityFound,
      firstMatchedAt: matchedBefore.firstMatchedAt,
      lastMatchedAt: matchedBefore.lastMatchedAt,
    });
    expect(after.items.find((item) => item.barcode === "9780201379624")).toMatchObject({
      quantityFound: 0,
    });
  });

  it("migrates legacy progress once, preserves non-legacy scans, and leaves legacy storage intact", async () => {
    const pulledKey = "legacy:pulled";
    const scanCountKey = "legacy:scan-count";
    const soundKey = "legacy:sound";
    const migrationSettingKey = "migration:test-local-patch";
    localStorage.setItem(
      pulledKey,
      JSON.stringify([testRecallRows[0].barcode, testRecallRows[1].barcode]),
    );
    localStorage.setItem(scanCountKey, "5");
    localStorage.setItem(soundKey, "off");

    await createCampaignWithItems(testCampaign, testRecallRows, database);
    await recordScan(TEST_CAMPAIGN_ID, testRecallRows[0].barcode, {}, database);
    const normalScan = (await database.scans.toArray())[0];
    const localPatch = patch(testRecallRows, {
      pulledKey,
      scanCountKey,
      soundKey,
      migrationSettingKey,
    });

    const first = await applyOptionalLocalPatch({
      database,
      fetchImpl: fetchResponse(localPatch),
      storage: localStorage,
    });
    const afterFirst = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);

    expect(first).toMatchObject({
      legacyConfigured: true,
      legacyMigrated: true,
      legacyPulledCount: 2,
      legacyScanCount: 5,
      soundEnabled: false,
    });
    expect(afterFirst.scans).toHaveLength(6);
    expect(afterFirst.scans.filter((scan) => scan.source === "legacy")).toHaveLength(5);
    expect(
      afterFirst.scans.filter((scan) => scan.source === "legacy" && scan.outcome === "match"),
    ).toHaveLength(2);
    expect(await database.scans.get(normalScan.id)).toEqual(normalScan);
    expect(
      afterFirst.items.find((item) => item.barcode === testRecallRows[0].barcode),
    ).toMatchObject({ quantityFound: 1 });
    expect(
      afterFirst.items.find((item) => item.barcode === testRecallRows[1].barcode),
    ).toMatchObject({ quantityFound: 1 });
    expect(await database.settings.get("preferences:soundEnabled")).toMatchObject({
      value: false,
    });
    expect(localStorage.getItem("recall-router:sound")).toBe("off");
    expect(localStorage.getItem(pulledKey)).toBe(
      JSON.stringify([testRecallRows[0].barcode, testRecallRows[1].barcode]),
    );
    expect(localStorage.getItem(scanCountKey)).toBe("5");
    expect(localStorage.getItem(soundKey)).toBe("off");

    const second = await applyOptionalLocalPatch({
      database,
      fetchImpl: fetchResponse(localPatch),
      storage: localStorage,
    });
    const afterSecond = await getCampaignSnapshot(TEST_CAMPAIGN_ID, database);

    expect(second.legacyMigrated).toBe(false);
    expect(second.itemsAdded).toBe(0);
    expect(afterSecond.scans).toEqual(afterFirst.scans);
    expect(afterSecond.items).toEqual(afterFirst.items);
    expect(await database.settings.where("key").equals(migrationSettingKey).count()).toBe(1);
  });

  it("rejects duplicate or invalid patch rows before changing the database", async () => {
    const duplicateRows = [testRecallRows[0], { ...testRecallRows[0], description: "Duplicate" }];
    await expect(
      applyOptionalLocalPatch({
        database,
        fetchImpl: fetchResponse(patch(duplicateRows)),
        storage: localStorage,
      }),
    ).rejects.toThrow(/duplicate barcode/i);
    expect(await database.campaigns.count()).toBe(0);
    expect(await database.items.count()).toBe(0);
  });
});
