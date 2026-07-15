import { db, getCampaignSnapshot, type RetailRecallDatabase } from "../db";
import type {
  AppSetting,
  BackupPayload,
  CampaignSnapshot,
  ScanRecord,
} from "../types";
import { validateBarcode } from "./barcodes";

export interface RestoreBackupOptions {
  mode?: "merge" | "replace";
}

export interface CsvExportOptions {
  /** Excel opens long/zero-prefixed GTINs correctly when they are text formulas. */
  excelSafeBarcodes?: boolean;
  includeBom?: boolean;
}

export type CampaignCsvSelection = "all" | "remaining" | "found";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Neutralize formula injection for user-supplied descriptions and notes.
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvBarcode(barcode: string, excelSafe = true): string {
  if (!excelSafe) return csvCell(barcode);
  const validation = validateBarcode(barcode);
  // Only a validated digits-only GTIN may use the Excel text formula wrapper.
  return validation.valid ? `="${validation.normalized}"` : csvCell(barcode);
}

function csv(rows: unknown[][], includeBom = true): string {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `${includeBom ? "\uFEFF" : ""}${body}\r\n`;
}

export async function createBackup(
  database: RetailRecallDatabase = db,
): Promise<BackupPayload> {
  const [campaigns, items, scans, settings] = await Promise.all([
    database.campaigns.toArray(),
    database.items.toArray(),
    database.scans.toArray(),
    database.settings.toArray(),
  ]);
  return {
    kind: "retail-recall-router-backup",
    version: 1,
    generatedAt: new Date().toISOString(),
    campaigns,
    items,
    scans,
    settings,
  };
}

export async function backupToJson(
  database: RetailRecallDatabase = db,
): Promise<string> {
  return JSON.stringify(await createBackup(database), null, 2);
}

export function parseBackup(value: string | BackupPayload): BackupPayload {
  const payload: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!payload || typeof payload !== "object") throw new Error("Backup is not valid JSON data.");
  const candidate = payload as Partial<BackupPayload>;
  if (candidate.kind !== "retail-recall-router-backup" || candidate.version !== 1) {
    throw new Error("This is not a supported Retail Recall Router backup.");
  }
  if (
    !Array.isArray(candidate.campaigns) ||
    !Array.isArray(candidate.items) ||
    !Array.isArray(candidate.scans) ||
    !Array.isArray(candidate.settings)
  ) {
    throw new Error("The backup is incomplete.");
  }
  if (candidate.campaigns.length > 500 || candidate.items.length > 100_000 || candidate.scans.length > 250_000 || candidate.settings.length > 1_000) {
    throw new Error("The backup is larger than the supported retail safety limits.");
  }
  const isText = (text: unknown, max = 5_000) => typeof text === "string" && text.length > 0 && text.length <= max;
  const isOptionalText = (text: unknown, max = 5_000) => text === undefined || (typeof text === "string" && text.length <= max);
  const isDate = (text: unknown) => typeof text === "string" && Number.isFinite(Date.parse(text));
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`The backup contains duplicate ${label} IDs.`);
  };
  if (!isDate(candidate.generatedAt)) throw new Error("The backup has an invalid creation date.");
  unique(candidate.campaigns.map((campaign) => campaign.id), "campaign");
  const campaignIds = new Set(candidate.campaigns.map((campaign) => campaign.id));
  const statuses = new Set(["draft", "active", "paused", "completed", "archived"]);
  for (const campaign of candidate.campaigns) {
    if (!isText(campaign?.id, 200) || !isText(campaign?.name, 300) || !isText(campaign?.brand, 200) || !isText(campaign?.locationName, 300) || !statuses.has(campaign?.status) || !isDate(campaign?.createdAt) || !isDate(campaign?.updatedAt) || !isOptionalText(campaign?.notes, 20_000) || !isOptionalText(campaign?.sourceFileName, 500)) {
      throw new Error("The backup contains an invalid campaign.");
    }
  }
  unique(candidate.items.map((item) => item.id), "recall item");
  const itemIds = new Set(candidate.items.map((item) => item.id));
  for (const item of candidate.items) {
    const barcode = validateBarcode(item?.barcode);
    if (!isText(item?.id, 200) || !campaignIds.has(item?.campaignId) || !barcode.valid || barcode.barcodeKey !== item?.barcodeKey || !isText(item?.description, 2_000) || !Number.isInteger(item?.quantityRequired) || item.quantityRequired < 1 || item.quantityRequired > 1_000_000 || !Number.isInteger(item?.quantityFound) || item.quantityFound < 0 || item.quantityFound > 1_000_000 || !isDate(item?.createdAt) || !isDate(item?.updatedAt)) {
      throw new Error("The backup contains an invalid recall item.");
    }
  }
  unique(candidate.scans.map((scan) => scan.id), "scan");
  const outcomes = new Set(["match", "miss", "invalid", "legacy"]);
  const decisions = new Set(["keep", "leave", "retry", "unknown"]);
  const sources = new Set(["scanner", "manual", "legacy", "restore"]);
  for (const scan of candidate.scans) {
    const barcode = scan?.barcode === undefined ? undefined : validateBarcode(scan.barcode);
    if (!isText(scan?.id, 200) || !campaignIds.has(scan?.campaignId) || !isText(scan?.rawValue, 2_000) || !outcomes.has(scan?.outcome) || !decisions.has(scan?.decision) || !sources.has(scan?.source) || typeof scan?.isRepeatMatch !== "boolean" || !isDate(scan?.scannedAt) || (scan?.undoneAt !== undefined && !isDate(scan.undoneAt)) || (scan?.itemId !== undefined && !itemIds.has(scan.itemId)) || (barcode && (!barcode.valid || (scan.barcodeKey !== undefined && barcode.barcodeKey !== scan.barcodeKey)))) {
      throw new Error("The backup contains an invalid scan record.");
    }
  }
  unique(candidate.settings.map((setting: AppSetting) => setting.key), "setting");
  if (candidate.settings.some((setting: AppSetting) => !isText(setting?.key, 200) || !isDate(setting?.updatedAt))) {
    throw new Error("The backup contains an invalid setting.");
  }
  return candidate as BackupPayload;
}

export async function restoreBackup(
  value: string | BackupPayload,
  options: RestoreBackupOptions = {},
  database: RetailRecallDatabase = db,
): Promise<BackupPayload> {
  const payload = parseBackup(value);
  await database.transaction(
    "rw",
    database.campaigns,
    database.items,
    database.scans,
    database.settings,
    async () => {
      if (options.mode === "replace") {
        await Promise.all([
          database.campaigns.clear(),
          database.items.clear(),
          database.scans.clear(),
          database.settings.clear(),
        ]);
      } else {
        const campaignIds = payload.campaigns.map((campaign) => campaign.id);
        if (campaignIds.length) {
          // A conflicting campaign is restored as one consistent snapshot.
          // Unrelated local campaigns remain untouched.
          await database.items.where("campaignId").anyOf(campaignIds).delete();
          await database.scans.where("campaignId").anyOf(campaignIds).delete();
        }
      }
      await database.campaigns.bulkPut(payload.campaigns);
      await database.items.bulkPut(payload.items);
      await database.scans.bulkPut(payload.scans);
      await database.settings.bulkPut(payload.settings);
    },
  );
  return payload;
}

export function campaignToCsv(
  snapshot: CampaignSnapshot,
  selectionOrOptions: CampaignCsvSelection | CsvExportOptions = {},
): string {
  const selection: CampaignCsvSelection =
    typeof selectionOrOptions === "string" ? selectionOrOptions : "all";
  const options =
    typeof selectionOrOptions === "string" ? {} : selectionOrOptions;
  const rows: unknown[][] = [[
    "Campaign",
    "Recall Reference",
    "Brand",
    "Location",
    "UPC / GTIN",
    "Description",
    "Model",
    "Style",
    "Color",
    "SKU",
    "Quantity Required",
    "Quantity Found",
    "Status",
    "First Matched",
    "Last Matched",
    "Notes",
  ]];
  const selectedItems = snapshot.items.filter((item) => {
    const found = item.quantityFound >= item.quantityRequired;
    if (selection === "found") return found;
    if (selection === "remaining") return !found;
    return true;
  });
  for (const item of selectedItems) {
    rows.push([
      snapshot.campaign.name,
      snapshot.campaign.recallReference ?? "",
      item.brand ?? snapshot.campaign.brand,
      snapshot.campaign.locationName,
      csvBarcode(item.barcode, options.excelSafeBarcodes !== false),
      item.description,
      item.model ?? "",
      item.style ?? "",
      item.color ?? "",
      item.sku ?? "",
      item.quantityRequired,
      item.quantityFound,
      item.quantityFound >= item.quantityRequired ? "Found" : "Remaining",
      item.firstMatchedAt ?? "",
      item.lastMatchedAt ?? "",
      item.notes ?? "",
    ]);
  }
  // Barcode cells are already safe formula strings. Avoid escaping the leading
  // equals sign a second time while retaining general formula protection.
  const body = rows
    .map((row, rowIndex) =>
      row
        .map((value, columnIndex) => {
          if (rowIndex > 0 && columnIndex === 4) return String(value);
          return csvCell(value);
        })
        .join(","),
    )
    .join("\r\n");
  return `${options.includeBom === false ? "" : "\uFEFF"}${body}\r\n`;
}

export function scansToCsv(
  scansOrSnapshot: ScanRecord[] | CampaignSnapshot,
  options: CsvExportOptions = {},
): string {
  const scans = Array.isArray(scansOrSnapshot)
    ? scansOrSnapshot
    : scansOrSnapshot.scans;
  const rows: unknown[][] = [[
    "Scanned At",
    "Outcome",
    "Decision",
    "UPC / GTIN",
    "Frame",
    "Repeat Recall Match",
    "Source",
    "Invalid Reason",
    "Undone At",
  ]];
  for (const scan of scans) {
    rows.push([
      scan.scannedAt,
      scan.outcome,
      scan.decision,
      scan.barcode ? csvBarcode(scan.barcode, options.excelSafeBarcodes !== false) : scan.rawValue,
      scan.itemDescription ?? "",
      scan.isRepeatMatch ? "Yes" : "No",
      scan.source,
      scan.invalidReason ?? "",
      scan.undoneAt ?? "",
    ]);
  }
  const body = rows
    .map((row, rowIndex) =>
      row
        .map((value, columnIndex) => {
          if (rowIndex > 0 && columnIndex === 3 && /^="\d+"$/.test(String(value))) {
            return String(value);
          }
          return csvCell(value);
        })
        .join(","),
    )
    .join("\r\n");
  return `${options.includeBom === false ? "" : "\uFEFF"}${body}\r\n`;
}

export async function exportCampaignCsv(
  campaignId: string,
  options: CsvExportOptions = {},
  database: RetailRecallDatabase = db,
): Promise<string> {
  return campaignToCsv(await getCampaignSnapshot(campaignId, database), options);
}

export async function exportCampaignScansCsv(
  campaignId: string,
  options: CsvExportOptions = {},
  database: RetailRecallDatabase = db,
): Promise<string> {
  const scans = await database.scans.where("campaignId").equals(campaignId).toArray();
  scans.sort((left, right) => left.scannedAt.localeCompare(right.scannedAt));
  return scansToCsv(scans, options);
}

export function safeFilename(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recall";
}

export function downloadTextFile(
  filename: string,
  contents: string,
  mimeType = "text/plain;charset=utf-8",
): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Downloads are only available in a browser.");
  }
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Used internally by tests and callers constructing small ad-hoc CSVs.
export const csvFromRows = csv;
