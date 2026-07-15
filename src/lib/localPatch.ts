import type { RetailRecallDatabase } from "../db";
import {
  createCampaignWithItems,
  db,
  mergeCampaignItems,
  previewCampaignItemMerge,
} from "../db";
import type {
  AppSetting,
  CampaignStatus,
  CreateCampaignInput,
  ImportedRecallRow,
  RecallItem,
  ScanRecord,
} from "../types";
import { validateBarcode } from "./barcodes";

const PATCH_KIND = "retail-recall-router-local-patch";
const PATCH_VERSION = 1;
const DEFAULT_PATCH_URL = "./local-recall-patch.json";
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_PATCH_ITEMS = 25_000;
const MAX_LEGACY_SCANS = 50_000;
const SOUND_SETTING_KEY = "preferences:soundEnabled";
const CURRENT_SOUND_STORAGE_KEY = "recall-router:sound";

interface LocalPatchLegacyConfig {
  pulledKey: string;
  scanCountKey: string;
  soundKey: string;
  migrationSettingKey: string;
}

interface ValidatedLocalPatch {
  kind: typeof PATCH_KIND;
  version: typeof PATCH_VERSION;
  patchId: string;
  campaign: CreateCampaignInput & { id: string };
  items: ImportedRecallRow[];
  itemBarcodeKeys: string[];
  legacy?: LocalPatchLegacyConfig;
}

interface LegacyState {
  pulled: Array<{ barcode: string; barcodeKey: string }>;
  scanCount: number;
  soundEnabled?: boolean;
  signature: string;
}

export interface LocalPatchApplyResult {
  found: boolean;
  patchId?: string;
  campaignId?: string;
  campaignCreated: boolean;
  itemsAdded: number;
  itemsAlreadyPresent: number;
  legacyConfigured: boolean;
  legacyMigrated: boolean;
  legacyPulledCount: number;
  legacyScanCount: number;
  soundEnabled?: boolean;
}

export interface ApplyOptionalLocalPatchOptions {
  database?: RetailRecallDatabase;
  fetchImpl?: typeof fetch;
  storage?: Storage | null;
  patchUrl?: string;
}

function emptyResult(): LocalPatchApplyResult {
  return {
    found: false,
    campaignCreated: false,
    itemsAdded: 0,
    itemsAlreadyPresent: 0,
    legacyConfigured: false,
    legacyMigrated: false,
    legacyPulledCount: 0,
    legacyScanCount: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds the ${maximumLength}-character limit.`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds the ${maximumLength}-character limit.`);
  }
  return normalized || undefined;
}

function optionalIsoDate(value: unknown, label: string): string | undefined {
  const normalized = optionalString(value, label, 64);
  if (!normalized) return undefined;
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid date.`);
  }
  return normalized;
}

function validateCampaign(value: unknown): CreateCampaignInput & { id: string } {
  if (!isObject(value)) throw new Error("Local patch campaign must be an object.");
  const id = requiredString(value.id, "Local patch campaign id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error("Local patch campaign id contains unsupported characters.");
  }

  const statusValue = value.status ?? "draft";
  const allowedStatuses: CampaignStatus[] = ["draft", "active", "paused"];
  if (typeof statusValue !== "string" || !allowedStatuses.includes(statusValue as CampaignStatus)) {
    throw new Error("Local patch campaign status must be draft, active, or paused.");
  }

  return {
    id,
    name: requiredString(value.name, "Local patch campaign name", 200),
    brand: requiredString(value.brand, "Local patch campaign brand", 120),
    recallReference: optionalString(value.recallReference, "Recall reference", 120),
    locationName: optionalString(value.locationName, "Location name", 200),
    locationCode: optionalString(value.locationCode, "Location code", 80),
    region: optionalString(value.region, "Region", 200),
    status: statusValue as CampaignStatus,
    notes: optionalString(value.notes, "Campaign notes", 2_000),
    sourceFileName: optionalString(value.sourceFileName, "Source file name", 255),
    sourceFileType: optionalString(value.sourceFileType, "Source file type", 120),
    importedAt: optionalIsoDate(value.importedAt, "Imported date"),
    startedAt: optionalIsoDate(value.startedAt, "Started date"),
  };
}

function validateItem(value: unknown, index: number): {
  row: ImportedRecallRow;
  barcodeKey: string;
} {
  const label = `Local patch item ${index + 1}`;
  if (!isObject(value)) throw new Error(`${label} must be an object.`);

  const barcode = requiredString(value.barcode, `${label} barcode`, 32);
  const validation = validateBarcode(barcode);
  if (!validation.valid || !validation.barcodeKey) {
    throw new Error(`${label} has an invalid GTIN barcode.`);
  }

  let quantity: number | undefined;
  if (value.quantity !== undefined && value.quantity !== null) {
    if (
      typeof value.quantity !== "number" ||
      !Number.isInteger(value.quantity) ||
      value.quantity < 1 ||
      value.quantity > 1_000_000
    ) {
      throw new Error(`${label} quantity must be a whole number from 1 to 1,000,000.`);
    }
    quantity = value.quantity;
  }

  let sourceRowNumber: number | undefined;
  if (value.sourceRowNumber !== undefined && value.sourceRowNumber !== null) {
    if (
      typeof value.sourceRowNumber !== "number" ||
      !Number.isInteger(value.sourceRowNumber) ||
      value.sourceRowNumber < 1 ||
      value.sourceRowNumber > 1_000_000
    ) {
      throw new Error(`${label} source row number is invalid.`);
    }
    sourceRowNumber = value.sourceRowNumber;
  }

  return {
    row: {
      barcode: validation.normalized,
      description: requiredString(value.description, `${label} description`, 500),
      brand: optionalString(value.brand, `${label} brand`, 120),
      model: optionalString(value.model, `${label} model`, 160),
      style: optionalString(value.style, `${label} style`, 160),
      color: optionalString(value.color, `${label} color`, 160),
      sku: optionalString(value.sku, `${label} SKU`, 160),
      notes: optionalString(value.notes, `${label} notes`, 2_000),
      quantity,
      sourceRowNumber,
    },
    barcodeKey: validation.barcodeKey,
  };
}

function validateStorageKey(value: unknown, label: string): string {
  return requiredString(value, label, 200);
}

function validateLegacy(value: unknown): LocalPatchLegacyConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error("Local patch legacy settings must be an object.");

  // `settingKey` was used by the first private patch file. Keep it as a
  // backwards-compatible alias while publishing the clearer schema name.
  const migrationSettingValue = value.migrationSettingKey ?? value.settingKey;
  if (
    value.migrationSettingKey !== undefined &&
    value.settingKey !== undefined &&
    value.migrationSettingKey !== value.settingKey
  ) {
    throw new Error("Legacy migration setting keys conflict.");
  }
  const migrationSettingKey = validateStorageKey(
    migrationSettingValue,
    "Legacy migration setting key",
  );
  if (!migrationSettingKey.startsWith("migration:")) {
    throw new Error("Legacy migration setting key must start with migration:.");
  }

  return {
    pulledKey: validateStorageKey(value.pulledKey, "Legacy pulled key"),
    scanCountKey: validateStorageKey(value.scanCountKey, "Legacy scan-count key"),
    soundKey: validateStorageKey(value.soundKey, "Legacy sound key"),
    migrationSettingKey,
  };
}

function validatePatch(value: unknown): ValidatedLocalPatch {
  if (!isObject(value)) throw new Error("Local patch must be a JSON object.");
  if (value.kind !== PATCH_KIND || value.version !== PATCH_VERSION) {
    throw new Error("Local patch kind or version is not supported.");
  }
  const patchId = requiredString(value.patchId, "Local patch id", 128);
  const campaign = validateCampaign(value.campaign);
  if (!Array.isArray(value.items) || !value.items.length) {
    throw new Error("Local patch must include at least one recall item.");
  }
  if (value.items.length > MAX_PATCH_ITEMS) {
    throw new Error(`Local patch exceeds the ${MAX_PATCH_ITEMS.toLocaleString()}-item limit.`);
  }

  const rows: ImportedRecallRow[] = [];
  const itemBarcodeKeys: string[] = [];
  const seen = new Set<string>();
  value.items.forEach((candidate, index) => {
    const validated = validateItem(candidate, index);
    if (seen.has(validated.barcodeKey)) {
      throw new Error(`Local patch contains duplicate barcode ${validated.row.barcode}.`);
    }
    seen.add(validated.barcodeKey);
    rows.push(validated.row);
    itemBarcodeKeys.push(validated.barcodeKey);
  });

  return {
    kind: PATCH_KIND,
    version: PATCH_VERSION,
    patchId,
    campaign,
    items: rows,
    itemBarcodeKeys,
    legacy: validateLegacy(value.legacy),
  };
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseLegacyPulled(raw: string | null): Array<{ barcode: string; barcodeKey: string }> {
  if (!raw) return [];
  if (raw.length > MAX_PATCH_BYTES) {
    throw new Error("Legacy pulled-frame data exceeds the safe size limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Legacy pulled-frame data is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Legacy pulled-frame data must be a JSON array.");
  }
  if (parsed.length > MAX_LEGACY_SCANS) {
    throw new Error(`Legacy pulled-frame data exceeds the ${MAX_LEGACY_SCANS.toLocaleString()}-row limit.`);
  }

  const unique = new Map<string, { barcode: string; barcodeKey: string }>();
  for (const value of parsed) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const validation = validateBarcode(String(value));
    if (!validation.valid || !validation.barcodeKey) continue;
    unique.set(validation.barcodeKey, {
      barcode: validation.normalized,
      barcodeKey: validation.barcodeKey,
    });
  }
  return [...unique.values()];
}

function parseLegacyScanCount(raw: string | null, minimum: number): number {
  if (!raw) return minimum;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("Legacy scan count must be a non-negative whole number.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_LEGACY_SCANS) {
    throw new Error(`Legacy scan count exceeds the ${MAX_LEGACY_SCANS.toLocaleString()}-scan limit.`);
  }
  return Math.max(value, minimum);
}

function parseLegacySound(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(normalized)) return true;
  if (["off", "false", "0", "no"].includes(normalized)) return false;
  return undefined;
}

function readLegacyState(
  patch: ValidatedLocalPatch,
  storage: Storage,
): LegacyState {
  const legacy = patch.legacy!;
  const pulled = parseLegacyPulled(storage.getItem(legacy.pulledKey));
  const scanCount = parseLegacyScanCount(
    storage.getItem(legacy.scanCountKey),
    pulled.length,
  );
  const soundEnabled = parseLegacySound(storage.getItem(legacy.soundKey));
  const signature = JSON.stringify({
    kind: "retail-recall-router-legacy-signature",
    version: 1,
    patchId: patch.patchId,
    campaignId: patch.campaign.id,
    itemBarcodeKeys: [...patch.itemBarcodeKeys].sort(),
    pulled: pulled.map((item) => item.barcodeKey).sort(),
    scanCount,
    soundEnabled: soundEnabled ?? null,
  });
  return { pulled, scanCount, soundEnabled, signature };
}

function settingSignature(setting: AppSetting | undefined): string | undefined {
  if (typeof setting?.value === "string") return setting.value;
  if (isObject(setting?.value) && typeof setting.value.signature === "string") {
    return setting.value.signature;
  }
  return undefined;
}

function migrationScanId(campaignId: string, settingKey: string, index: number): string {
  const safeCampaign = campaignId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60);
  const safeKey = settingKey.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60);
  return `scan-local-patch-${safeCampaign}-${safeKey}-${index}`;
}

function nextTimestamp(...values: Array<string | undefined>): string {
  const latest = values.reduce((maximum, value) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
  }, 0);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

async function migrateLegacyState(
  patch: ValidatedLocalPatch,
  state: LegacyState,
  database: RetailRecallDatabase,
): Promise<boolean> {
  const legacy = patch.legacy!;
  let migrated = false;

  await database.transaction(
    "rw",
    database.campaigns,
    database.items,
    database.scans,
    database.settings,
    async () => {
      const priorSetting = await database.settings.get(legacy.migrationSettingKey);
      if (settingSignature(priorSetting) === state.signature) return;

      const campaign = await database.campaigns.get(patch.campaign.id);
      if (!campaign) throw new Error(`Campaign ${patch.campaign.id} was not found during migration.`);
      if (campaign.status === "completed" || campaign.status === "archived") {
        throw new Error("Legacy progress cannot be imported into a completed or archived recall.");
      }
      const campaignItems = await database.items
        .where("campaignId")
        .equals(patch.campaign.id)
        .toArray();
      const itemByBarcode = new Map(campaignItems.map((item) => [item.barcodeKey, item]));
      const timestamp = nextTimestamp(
        campaign.updatedAt,
        ...campaignItems.map((item) => item.updatedAt),
      );

      const changedItems: RecallItem[] = [];
      for (const pulled of state.pulled) {
        const current = itemByBarcode.get(pulled.barcodeKey);
        if (!current || current.quantityFound >= 1) continue;
        const updated: RecallItem = {
          ...current,
          quantityFound: 1,
          firstMatchedAt: current.firstMatchedAt ?? timestamp,
          lastMatchedAt: current.lastMatchedAt ?? timestamp,
          updatedAt: timestamp,
        };
        itemByBarcode.set(updated.barcodeKey, updated);
        changedItems.push(updated);
      }

      const campaignScans = await database.scans
        .where("campaignId")
        .equals(patch.campaign.id)
        .toArray();
      const priorMigrationScanIds = campaignScans
        .filter(
          (scan) =>
            scan.source === "legacy" &&
            scan.metadata?.localPatchMigrationSetting === legacy.migrationSettingKey,
        )
        .map((scan) => scan.id);

      const summaryScans: ScanRecord[] = Array.from(
        { length: state.scanCount },
        (_, index) => {
          const pulled = state.pulled[index];
          const item = pulled ? itemByBarcode.get(pulled.barcodeKey) : undefined;
          const representsMatch = Boolean(pulled && item);
          return {
            id: migrationScanId(patch.campaign.id, legacy.migrationSettingKey, index),
            campaignId: patch.campaign.id,
            rawValue: pulled?.barcode ?? "",
            barcode: pulled?.barcode,
            barcodeKey: pulled?.barcodeKey,
            itemId: item?.id,
            itemDescription: item?.description,
            outcome: representsMatch ? "match" : "legacy",
            decision: representsMatch ? "keep" : "unknown",
            isRepeatMatch: false,
            source: "legacy",
            scannedAt: timestamp,
            metadata: {
              localPatchMigrationSetting: legacy.migrationSettingKey,
              patchId: patch.patchId,
              summaryIndex: index + 1,
            },
          };
        },
      );

      if (changedItems.length) await database.items.bulkPut(changedItems);
      if (priorMigrationScanIds.length) await database.scans.bulkDelete(priorMigrationScanIds);
      if (summaryScans.length) await database.scans.bulkPut(summaryScans);
      await database.campaigns.update(patch.campaign.id, { updatedAt: timestamp });
      if (state.soundEnabled !== undefined) {
        await database.settings.put({
          key: SOUND_SETTING_KEY,
          value: state.soundEnabled,
          updatedAt: timestamp,
        });
      }
      await database.settings.put({
        key: legacy.migrationSettingKey,
        value: {
          kind: "retail-recall-router-legacy-migration",
          version: 1,
          signature: state.signature,
          patchId: patch.patchId,
          campaignId: patch.campaign.id,
          pulledCount: state.pulled.length,
          scanCount: state.scanCount,
        },
        updatedAt: timestamp,
      });
      migrated = true;
    },
  );

  return migrated;
}

async function fetchValidatedPatch(
  patchUrl: string,
  fetchImpl: typeof fetch,
): Promise<ValidatedLocalPatch | null> {
  const response = await fetchImpl(patchUrl, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`Local patch request failed with status ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PATCH_BYTES) {
    throw new Error("Local patch exceeds the safe file-size limit.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PATCH_BYTES) {
    throw new Error("Local patch exceeds the safe file-size limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Local patch is not valid JSON.");
  }
  return validatePatch(parsed);
}

/**
 * Applies an optional, deployment-local recall patch without shipping its data
 * in source control. Existing campaign items, scan records, and progress are
 * never replaced; a patch can only add previously unseen valid GTINs.
 */
export async function applyOptionalLocalPatch(
  options: ApplyOptionalLocalPatchOptions = {},
): Promise<LocalPatchApplyResult> {
  const database = options.database ?? db;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return emptyResult();

  const patch = await fetchValidatedPatch(
    options.patchUrl ?? DEFAULT_PATCH_URL,
    fetchImpl,
  );
  if (!patch) return emptyResult();

  const existingCampaign = await database.campaigns.get(patch.campaign.id);
  let campaignCreated = false;
  let itemsAdded = 0;
  let itemsAlreadyPresent = 0;
  if (!existingCampaign) {
    await createCampaignWithItems(patch.campaign, patch.items, database);
    campaignCreated = true;
    itemsAdded = patch.items.length;
  } else {
    const readOnly = existingCampaign.status === "completed" || existingCampaign.status === "archived";
    if (readOnly) {
      const preview = await previewCampaignItemMerge(
        patch.campaign.id,
        patch.items,
        database,
      );
      if (preview.additions.length) {
        throw new Error("A local patch cannot add items to a completed or archived recall.");
      }
      itemsAlreadyPresent = preview.existing.length;
    } else {
      const merged = await mergeCampaignItems(
        patch.campaign.id,
        patch.items,
        {
          expectedCampaignUpdatedAt: existingCampaign.updatedAt,
          allowActiveCampaign: true,
        },
        database,
      );
      itemsAdded = merged.addedItems.length;
      itemsAlreadyPresent = merged.skippedExistingItems.length;
    }
  }

  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let legacyMigrated = false;
  let legacyPulledCount = 0;
  let legacyScanCount = 0;
  let soundEnabled: boolean | undefined;
  if (patch.legacy && storage) {
    const state = readLegacyState(patch, storage);
    legacyPulledCount = state.pulled.length;
    legacyScanCount = state.scanCount;
    soundEnabled = state.soundEnabled;
    legacyMigrated = await migrateLegacyState(patch, state, database);
    if (legacyMigrated && soundEnabled !== undefined) {
      // Preserve every legacy key. This only initializes the current UI's
      // equivalent preference after the IndexedDB transaction succeeds.
      storage.setItem(CURRENT_SOUND_STORAGE_KEY, soundEnabled ? "on" : "off");
    }
  }

  return {
    found: true,
    patchId: patch.patchId,
    campaignId: patch.campaign.id,
    campaignCreated,
    itemsAdded,
    itemsAlreadyPresent,
    legacyConfigured: Boolean(patch.legacy),
    legacyMigrated,
    legacyPulledCount,
    legacyScanCount,
    soundEnabled,
  };
}
