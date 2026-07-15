import Dexie, { type Table } from "dexie";
import { evaluateBarcode, validateBarcode } from "./lib/barcodes";
import type {
  AppSetting,
  Campaign,
  CampaignItemMergeCandidate,
  CampaignItemMergePreview,
  CampaignItemMergeResult,
  CampaignItemMutationOptions,
  CampaignSnapshot,
  CampaignStatus,
  CreateCampaignInput,
  ImportedRecallRow,
  NormalizedRecallRow,
  RecallItem,
  RecallItemUpdateInput,
  RecallItemUpdateOptions,
  RecordedScanResult,
  ScanRecord,
  ScanSource,
  UndoScanResult,
} from "./types";

export class RetailRecallDatabase extends Dexie {
  campaigns!: Table<Campaign, string>;
  items!: Table<RecallItem, string>;
  scans!: Table<ScanRecord, string>;
  settings!: Table<AppSetting, string>;

  constructor(name = "retail-recall-router") {
    super(name);
    this.version(1).stores({
      campaigns: "id,status,brand,locationName,createdAt,updatedAt,[status+updatedAt]",
      items: "id,campaignId,barcodeKey,[campaignId+barcodeKey],updatedAt",
      scans:
        "id,campaignId,barcodeKey,itemId,outcome,source,scannedAt,[campaignId+scannedAt]",
      settings: "key,updatedAt",
    });
  }
}

export const db = new RetailRecallDatabase();

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextIsoAfter(...values: Array<string | undefined>): string {
  const latest = values.reduce((maximum, value) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
  }, 0);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

function normalizeQuantity(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.floor(Number(value)))
    : 1;
}

function normalizeImportedRows(importedRows: ImportedRecallRow[]): NormalizedRecallRow[] {
  const combined = new Map<string, NormalizedRecallRow>();
  for (const row of importedRows) {
    const validation = validateBarcode(row.barcode);
    if (!validation.valid || !validation.barcodeKey) {
      throw new Error(
        `Recall item on row ${row.sourceRowNumber ?? "unknown"} has an invalid barcode.`,
      );
    }
    const existing = combined.get(validation.barcodeKey);
    if (existing) {
      existing.quantity += normalizeQuantity(row.quantity);
      continue;
    }
    combined.set(validation.barcodeKey, {
      ...row,
      barcode: validation.normalized,
      barcodeKey: validation.barcodeKey,
      description: row.description?.trim() || `Frame ${validation.normalized}`,
      quantity: normalizeQuantity(row.quantity),
    });
  }
  return [...combined.values()];
}

function indexItemsByBarcode(items: RecallItem[]): Map<string, RecallItem> {
  const byBarcode = new Map<string, RecallItem>();
  for (const item of items) {
    if (byBarcode.has(item.barcodeKey)) {
      throw new Error(
        `Campaign data contains duplicate recall item ${item.barcode}. Create a backup and resolve it before adding items.`,
      );
    }
    byBarcode.set(item.barcodeKey, item);
  }
  return byBarcode;
}

function createRecallItem(
  campaign: Campaign,
  row: NormalizedRecallRow,
  timestamp: string,
): RecallItem {
  return {
    id: id("item"),
    campaignId: campaign.id,
    barcode: row.barcode,
    barcodeKey: row.barcodeKey,
    description: row.description,
    brand: row.brand?.trim() || campaign.brand,
    model: row.model?.trim() || undefined,
    style: row.style?.trim() || undefined,
    color: row.color?.trim() || undefined,
    sku: row.sku?.trim() || undefined,
    notes: row.notes?.trim() || undefined,
    quantityRequired: row.quantity,
    quantityFound: 0,
    sourceRowNumber: row.sourceRowNumber,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assertCampaignItemMutationAllowed(
  campaign: Campaign,
  options: CampaignItemMutationOptions,
): void {
  if (campaign.status === "archived" || campaign.status === "completed") {
    throw new Error("Completed and archived campaigns are read-only.");
  }
  if (!options.allowActiveCampaign && campaign.status !== "paused") {
    throw new Error("Pause this recall before changing its recall list.");
  }
  if (campaign.updatedAt !== options.expectedCampaignUpdatedAt) {
    throw new Error("This recall changed after it was opened. Refresh and review the list again.");
  }
}

export async function createCampaignWithItems(
  input: CreateCampaignInput,
  importedRows: ImportedRecallRow[],
  database: RetailRecallDatabase = db,
): Promise<Campaign> {
  if (!input.name.trim()) throw new Error("Campaign name is required.");
  if (!input.brand.trim()) throw new Error("Brand is required.");
  if (!importedRows.length) throw new Error("A recall campaign needs at least one valid item.");

  const timestamp = nowIso();
  const campaignId = input.id ?? id("campaign");
  if (await database.campaigns.get(campaignId)) {
    throw new Error(`Campaign ${campaignId} already exists.`);
  }

  const campaign: Campaign = {
    id: campaignId,
    name: input.name.trim(),
    brand: input.brand.trim(),
    recallReference: input.recallReference?.trim() || undefined,
    locationName: input.locationName?.trim() || "Philadelphia, PA",
    locationCode: input.locationCode?.trim() || undefined,
    region: input.region?.trim() || "Philadelphia, PA",
    status: input.status ?? "draft",
    notes: input.notes?.trim() || undefined,
    sourceFileName: input.sourceFileName,
    sourceFileType: input.sourceFileType,
    importedAt: input.importedAt ?? timestamp,
    startedAt:
      input.startedAt ?? ((input.status ?? "draft") === "active" ? timestamp : undefined),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const items = normalizeImportedRows(importedRows).map((row) =>
    createRecallItem(campaign, row, timestamp),
  );

  await database.transaction("rw", database.campaigns, database.items, async () => {
    await database.campaigns.add(campaign);
    await database.items.bulkAdd(items);
  });
  return campaign;
}

export async function previewCampaignItemMerge(
  campaignId: string,
  importedRows: ImportedRecallRow[],
  database: RetailRecallDatabase = db,
): Promise<CampaignItemMergePreview> {
  const normalizedRows = normalizeImportedRows(importedRows);
  const [campaign, items, scans] = await Promise.all([
    database.campaigns.get(campaignId),
    database.items.where("campaignId").equals(campaignId).toArray(),
    database.scans.where("campaignId").equals(campaignId).toArray(),
  ]);
  if (!campaign) throw new Error(`Campaign ${campaignId} was not found.`);

  const byBarcode = indexItemsByBarcode(items);
  const missCounts = new Map<string, number>();
  for (const scan of scans) {
    if (scan.outcome !== "miss" || scan.undoneAt || !scan.barcodeKey) continue;
    missCounts.set(scan.barcodeKey, (missCounts.get(scan.barcodeKey) ?? 0) + 1);
  }

  const additions: CampaignItemMergeCandidate[] = [];
  const existing: CampaignItemMergeCandidate[] = [];
  for (const row of normalizedRows) {
    const existingItem = byBarcode.get(row.barcodeKey);
    const candidate: CampaignItemMergeCandidate = {
      ...row,
      priorMissCount: missCounts.get(row.barcodeKey) ?? 0,
      existingItemId: existingItem?.id,
    };
    (existingItem ? existing : additions).push(candidate);
  }

  return {
    campaignId,
    campaignUpdatedAt: campaign.updatedAt,
    additions,
    existing,
  };
}

export async function mergeCampaignItems(
  campaignId: string,
  importedRows: ImportedRecallRow[],
  options: CampaignItemMutationOptions,
  database: RetailRecallDatabase = db,
): Promise<CampaignItemMergeResult> {
  const normalizedRows = normalizeImportedRows(importedRows);
  let result!: CampaignItemMergeResult;

  await database.transaction("rw", database.campaigns, database.items, async () => {
    const campaign = await database.campaigns.get(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} was not found.`);
    assertCampaignItemMutationAllowed(campaign, options);

    const existingItems = await database.items.where("campaignId").equals(campaignId).toArray();
    const byBarcode = indexItemsByBarcode(existingItems);
    const additions = normalizedRows.filter((row) => !byBarcode.has(row.barcodeKey));
    const skippedExistingItems = normalizedRows
      .map((row) => byBarcode.get(row.barcodeKey))
      .filter((item): item is RecallItem => Boolean(item));

    if (!additions.length) {
      result = { campaign, addedItems: [], skippedExistingItems };
      return;
    }

    const timestamp = nextIsoAfter(campaign.updatedAt);
    const addedItems = additions.map((row) => createRecallItem(campaign, row, timestamp));
    await database.items.bulkAdd(addedItems);
    await database.campaigns.update(campaignId, { updatedAt: timestamp });
    result = {
      campaign: { ...campaign, updatedAt: timestamp },
      addedItems,
      skippedExistingItems,
    };
  });

  return result;
}

export async function addCampaignItem(
  campaignId: string,
  importedRow: ImportedRecallRow,
  options: CampaignItemMutationOptions,
  database: RetailRecallDatabase = db,
): Promise<RecallItem> {
  const result = await mergeCampaignItems(campaignId, [importedRow], options, database);
  const added = result.addedItems[0];
  if (!added) {
    throw new Error(`Recall item ${importedRow.barcode} already exists in this campaign.`);
  }
  return added;
}

function optionalText(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function requiredQuantity(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error("Required quantity must be a whole number between 1 and 1,000,000.");
  }
  return value;
}

export async function updateCampaignItem(
  campaignId: string,
  itemId: string,
  patch: RecallItemUpdateInput,
  options: RecallItemUpdateOptions,
  database: RetailRecallDatabase = db,
): Promise<RecallItem> {
  let result!: RecallItem;

  await database.transaction(
    "rw",
    database.campaigns,
    database.items,
    database.scans,
    async () => {
      const campaign = await database.campaigns.get(campaignId);
      if (!campaign) throw new Error(`Campaign ${campaignId} was not found.`);
      assertCampaignItemMutationAllowed(campaign, options);

      const current = await database.items.get(itemId);
      if (!current || current.campaignId !== campaignId) {
        throw new Error(`Recall item ${itemId} was not found in this campaign.`);
      }
      if (current.updatedAt !== options.expectedItemUpdatedAt) {
        throw new Error("This recall item changed after it was opened. Refresh and try again.");
      }

      const updated: RecallItem = { ...current };
      if (patch.barcode !== undefined) {
        const validation = validateBarcode(patch.barcode);
        if (!validation.valid || !validation.barcodeKey) {
          throw new Error("The replacement barcode is invalid.");
        }
        const collision = (
          await database.items
            .where("[campaignId+barcodeKey]")
            .equals([campaignId, validation.barcodeKey])
            .toArray()
        ).find((candidate) => candidate.id !== itemId);
        if (collision) {
          throw new Error(`Recall item ${validation.normalized} already exists in this campaign.`);
        }
        if (validation.normalized !== current.barcode) {
          const scanCount = await database.scans.where("itemId").equals(itemId).count();
          if (current.quantityFound > 0 || scanCount > 0) {
            throw new Error("The barcode cannot change after this recall item has been scanned.");
          }
        }
        updated.barcode = validation.normalized;
        updated.barcodeKey = validation.barcodeKey;
      }
      if (patch.description !== undefined) {
        const description = patch.description.trim();
        if (!description) throw new Error("Description is required.");
        updated.description = description;
      }
      if (patch.brand !== undefined) updated.brand = optionalText(patch.brand);
      if (patch.model !== undefined) updated.model = optionalText(patch.model);
      if (patch.style !== undefined) updated.style = optionalText(patch.style);
      if (patch.color !== undefined) updated.color = optionalText(patch.color);
      if (patch.sku !== undefined) updated.sku = optionalText(patch.sku);
      if (patch.notes !== undefined) updated.notes = optionalText(patch.notes);
      if (patch.quantityRequired !== undefined) {
        updated.quantityRequired = requiredQuantity(patch.quantityRequired);
      }

      const changed = (
        [
          "barcode",
          "barcodeKey",
          "description",
          "brand",
          "model",
          "style",
          "color",
          "sku",
          "notes",
          "quantityRequired",
        ] as const
      ).some((field) => updated[field] !== current[field]);
      if (!changed) {
        result = current;
        return;
      }

      const timestamp = nextIsoAfter(campaign.updatedAt, current.updatedAt);
      updated.updatedAt = timestamp;
      await database.items.put(updated);
      await database.campaigns.update(campaignId, { updatedAt: timestamp });
      result = updated;
    },
  );

  return result;
}

export interface RecordScanOptions {
  source?: ScanSource;
  scannedAt?: string;
  metadata?: Record<string, unknown>;
}

export async function recordScan(
  campaignId: string,
  rawValue: unknown,
  options: RecordScanOptions = {},
  database: RetailRecallDatabase = db,
): Promise<RecordedScanResult> {
  const campaign = await database.campaigns.get(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} was not found.`);
  if (campaign.status === "archived") {
    throw new Error("Archived campaigns are read-only. Restore or duplicate it before scanning.");
  }

  const evaluation = evaluateBarcode(rawValue);
  const scannedAt = options.scannedAt ?? nowIso();
  let item: RecallItem | undefined;
  let alreadyMatched = false;
  let scan!: ScanRecord;

  await database.transaction(
    "rw",
    database.campaigns,
    database.items,
    database.scans,
    async () => {
      if (!evaluation.valid || !evaluation.barcodeKey) {
        scan = {
          id: id("scan"),
          campaignId,
          rawValue: evaluation.raw,
          barcode: evaluation.normalized || undefined,
          outcome: "invalid",
          decision: "retry",
          isRepeatMatch: false,
          source: options.source ?? "scanner",
          invalidReason: evaluation.reason,
          scannedAt,
          metadata: options.metadata,
        };
      } else {
        const candidates = await database.items
          .where("[campaignId+barcodeKey]")
          .equals([campaignId, evaluation.barcodeKey])
          .toArray();
        item = candidates.find((candidate) => candidate.quantityFound < candidate.quantityRequired) ?? candidates[0];

        if (item) {
          alreadyMatched = item.quantityFound >= item.quantityRequired;
          const previousQuantity = item.quantityFound;
          item = {
            ...item,
            quantityFound: previousQuantity + 1,
            firstMatchedAt: item.firstMatchedAt ?? scannedAt,
            lastMatchedAt: scannedAt,
            updatedAt: scannedAt,
          };
          await database.items.put(item);
          scan = {
            id: id("scan"),
            campaignId,
            rawValue: evaluation.raw,
            barcode: evaluation.normalized,
            barcodeKey: evaluation.barcodeKey,
            itemId: item.id,
            itemDescription: item.description,
            outcome: "match",
            decision: "keep",
            isRepeatMatch: alreadyMatched,
            source: options.source ?? "scanner",
            scannedAt,
            metadata: options.metadata,
          };
        } else {
          scan = {
            id: id("scan"),
            campaignId,
            rawValue: evaluation.raw,
            barcode: evaluation.normalized,
            barcodeKey: evaluation.barcodeKey,
            outcome: "miss",
            decision: "leave",
            isRepeatMatch: false,
            source: options.source ?? "scanner",
            scannedAt,
            metadata: options.metadata,
          };
        }
      }

      await database.scans.add(scan);
      const activate = campaign.status === "draft" || campaign.status === "paused";
      await database.campaigns.update(campaignId, {
        status: activate ? "active" : campaign.status,
        startedAt: campaign.startedAt ?? scannedAt,
        pausedAt: activate ? undefined : campaign.pausedAt,
        updatedAt: scannedAt,
      });
    },
  );

  return { scan, item, evaluation, alreadyMatched };
}

export async function undoLastScan(
  campaignId: string,
  database: RetailRecallDatabase = db,
): Promise<UndoScanResult | null> {
  let scan: ScanRecord | undefined;
  let item: RecallItem | undefined;

  await database.transaction(
    "rw",
    database.campaigns,
    database.items,
    database.scans,
    async () => {
      const recent = await database.scans
        .where("campaignId")
        .equals(campaignId)
        .toArray();
      scan = recent
        .filter((candidate) => !candidate.undoneAt && candidate.source !== "legacy")
        .sort((left, right) => right.scannedAt.localeCompare(left.scannedAt))[0];
      if (!scan) return;

      const undoneAt = nowIso();
      scan = { ...scan, undoneAt };
      await database.scans.put(scan);

      if (scan.itemId && scan.outcome === "match") {
        const current = await database.items.get(scan.itemId);
        if (current) {
          const quantityFound = Math.max(0, current.quantityFound - 1);
          item = {
            ...current,
            quantityFound,
            firstMatchedAt: quantityFound ? current.firstMatchedAt : undefined,
            lastMatchedAt: quantityFound ? current.lastMatchedAt : undefined,
            updatedAt: undoneAt,
          };
          await database.items.put(item);
        }
      }
      await database.campaigns.update(campaignId, { updatedAt: undoneAt });
    },
  );

  return scan ? { scan, item } : null;
}

export async function getCampaignSnapshot(
  campaignId: string,
  database: RetailRecallDatabase = db,
): Promise<CampaignSnapshot> {
  const [campaign, items, allScans] = await Promise.all([
    database.campaigns.get(campaignId),
    database.items.where("campaignId").equals(campaignId).toArray(),
    database.scans.where("campaignId").equals(campaignId).toArray(),
  ]);
  if (!campaign) throw new Error(`Campaign ${campaignId} was not found.`);

  const scans = allScans
    .filter((scan) => !scan.undoneAt)
    .sort((left, right) => right.scannedAt.localeCompare(left.scannedAt));
  const sortedItems = items.sort((left, right) =>
    left.description.localeCompare(right.description),
  );
  const foundItems = items.filter(
    (item) => item.quantityFound >= item.quantityRequired,
  ).length;
  const requiredQuantity = items.reduce((sum, item) => sum + item.quantityRequired, 0);
  const foundQuantity = items.reduce(
    (sum, item) => sum + Math.min(item.quantityFound, item.quantityRequired),
    0,
  );

  return {
    campaign,
    items: sortedItems,
    scans,
    summary: {
      totalItems: items.length,
      foundItems,
      remainingItems: items.length - foundItems,
      requiredQuantity,
      foundQuantity,
      totalScans: scans.length,
      matchScans: scans.filter((scan) => scan.outcome === "match").length,
      repeatMatchScans: scans.filter(
        (scan) => scan.outcome === "match" && scan.isRepeatMatch,
      ).length,
      missScans: scans.filter((scan) => scan.outcome === "miss").length,
      invalidScans: scans.filter((scan) => scan.outcome === "invalid").length,
      legacyScans: scans.filter((scan) => scan.outcome === "legacy").length,
      percentComplete: requiredQuantity
        ? Math.round((foundQuantity / requiredQuantity) * 100)
        : 0,
    },
  };
}

export async function listCampaigns(
  database: RetailRecallDatabase = db,
): Promise<Campaign[]> {
  const campaigns = await database.campaigns.toArray();
  return campaigns.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function setCampaignStatus(
  campaignId: string,
  status: CampaignStatus,
  database: RetailRecallDatabase = db,
): Promise<Campaign> {
  const campaign = await database.campaigns.get(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} was not found.`);
  const timestamp = nowIso();
  const changes: Partial<Campaign> = { status, updatedAt: timestamp };
  if (status === "active") {
    changes.startedAt = campaign.startedAt ?? timestamp;
    changes.pausedAt = undefined;
  } else if (status === "paused") {
    changes.pausedAt = timestamp;
  } else if (status === "completed") {
    changes.completedAt = timestamp;
  } else if (status === "archived") {
    changes.archivedAt = timestamp;
  }
  await database.campaigns.update(campaignId, changes);
  return { ...campaign, ...changes };
}

export async function setSetting<T>(
  key: string,
  value: T,
  database: RetailRecallDatabase = db,
): Promise<AppSetting<T>> {
  const setting: AppSetting<T> = { key, value, updatedAt: nowIso() };
  await database.settings.put(setting);
  return setting;
}
