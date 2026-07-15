import Dexie, { type Table } from "dexie";
import { evaluateBarcode, validateBarcode } from "./lib/barcodes";
import type {
  AppSetting,
  Campaign,
  CampaignSnapshot,
  CampaignStatus,
  CreateCampaignInput,
  ImportedRecallRow,
  RecallItem,
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

function normalizeQuantity(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.floor(Number(value)))
    : 1;
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

  const combined = new Map<string, ImportedRecallRow>();
  for (const row of importedRows) {
    const validation = validateBarcode(row.barcode);
    if (!validation.valid || !validation.barcodeKey) {
      throw new Error(
        `Recall item on row ${row.sourceRowNumber ?? "unknown"} has an invalid barcode.`,
      );
    }
    const existing = combined.get(validation.barcodeKey);
    if (existing) {
      existing.quantity = normalizeQuantity(existing.quantity) + normalizeQuantity(row.quantity);
    } else {
      combined.set(validation.barcodeKey, {
        ...row,
        barcode: validation.normalized,
        quantity: normalizeQuantity(row.quantity),
      });
    }
  }

  const items: RecallItem[] = [...combined.entries()].map(([barcodeKey, row]) => ({
    id: id("item"),
    campaignId,
    barcode: row.barcode,
    barcodeKey,
    description: row.description.trim() || `Frame ${row.barcode}`,
    brand: row.brand?.trim() || input.brand.trim(),
    model: row.model?.trim() || undefined,
    style: row.style?.trim() || undefined,
    color: row.color?.trim() || undefined,
    sku: row.sku?.trim() || undefined,
    notes: row.notes?.trim() || undefined,
    quantityRequired: normalizeQuantity(row.quantity),
    quantityFound: 0,
    sourceRowNumber: row.sourceRowNumber,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  await database.transaction("rw", database.campaigns, database.items, async () => {
    await database.campaigns.add(campaign);
    await database.items.bulkAdd(items);
  });
  return campaign;
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
        .filter((candidate) => !candidate.undoneAt)
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
