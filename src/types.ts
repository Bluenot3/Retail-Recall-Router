export type CampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "archived";

export type ScanOutcome = "match" | "miss" | "invalid" | "legacy";
export type ScanDecision = "keep" | "leave" | "retry" | "unknown";
export type ScanSource = "scanner" | "manual" | "legacy" | "restore";

export type BarcodeFormat = "GTIN-8" | "UPC-A" | "EAN-13" | "GTIN-14";
export type BarcodeInvalidReason =
  | "empty"
  | "non-numeric"
  | "unsupported-length"
  | "bad-check-digit";

export interface Campaign {
  id: string;
  name: string;
  brand: string;
  recallReference?: string;
  locationName: string;
  locationCode?: string;
  region?: string;
  status: CampaignStatus;
  notes?: string;
  sourceFileName?: string;
  sourceFileType?: string;
  createdAt: string;
  updatedAt: string;
  importedAt?: string;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  archivedAt?: string;
}

export interface CreateCampaignInput {
  id?: string;
  name: string;
  brand: string;
  recallReference?: string;
  locationName?: string;
  locationCode?: string;
  region?: string;
  status?: CampaignStatus;
  notes?: string;
  sourceFileName?: string;
  sourceFileType?: string;
  importedAt?: string;
  startedAt?: string;
}

export interface RecallItem {
  id: string;
  campaignId: string;
  /** The display GTIN exactly as normalized from the recall list. */
  barcode: string;
  /** A zero-padded GTIN-14 used only for exact matching. */
  barcodeKey: string;
  description: string;
  brand?: string;
  model?: string;
  style?: string;
  color?: string;
  sku?: string;
  notes?: string;
  quantityRequired: number;
  quantityFound: number;
  sourceRowNumber?: number;
  firstMatchedAt?: string;
  lastMatchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScanRecord {
  id: string;
  campaignId: string;
  rawValue: string;
  barcode?: string;
  barcodeKey?: string;
  itemId?: string;
  itemDescription?: string;
  outcome: ScanOutcome;
  decision: ScanDecision;
  isRepeatMatch: boolean;
  source: ScanSource;
  invalidReason?: BarcodeInvalidReason;
  scannedAt: string;
  undoneAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AppSetting<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

export interface ImportedRecallRow {
  barcode: string;
  description: string;
  brand?: string;
  model?: string;
  style?: string;
  color?: string;
  sku?: string;
  notes?: string;
  quantity?: number;
  sourceRowNumber?: number;
}

export interface RejectedRecallRow {
  rowNumber: number;
  reason: string;
  barcode?: string;
  values: string[];
}

export interface RecallColumnMapping {
  barcode: number;
  description?: number;
  brand?: number;
  model?: number;
  style?: number;
  color?: number;
  sku?: number;
  quantity?: number;
  notes?: number;
}

export interface ColumnInference {
  mapping: RecallColumnMapping;
  headerRowIndex: number | null;
  confidence: "high" | "medium" | "low";
  headers: string[];
}

export interface ImportResult {
  sourceName: string;
  sourceType: "csv" | "tsv" | "xlsx" | "xls" | "text";
  rows: ImportedRecallRow[];
  rejected: RejectedRecallRow[];
  inference: ColumnInference;
  warnings: string[];
  sheetName?: string;
}

export interface CampaignSummary {
  totalItems: number;
  foundItems: number;
  remainingItems: number;
  requiredQuantity: number;
  foundQuantity: number;
  totalScans: number;
  matchScans: number;
  repeatMatchScans: number;
  missScans: number;
  invalidScans: number;
  legacyScans: number;
  percentComplete: number;
}

export interface CampaignSnapshot {
  campaign: Campaign;
  items: RecallItem[];
  scans: ScanRecord[];
  summary: CampaignSummary;
}

export interface BarcodeValidation {
  raw: string;
  normalized: string;
  barcodeKey?: string;
  format?: BarcodeFormat;
  valid: boolean;
  reason?: BarcodeInvalidReason;
}

export interface ScanEvaluation extends BarcodeValidation {
  outcome: "valid" | "invalid";
}

export interface RecordedScanResult {
  scan: ScanRecord;
  item?: RecallItem;
  evaluation: ScanEvaluation;
  alreadyMatched: boolean;
}

export interface UndoScanResult {
  scan: ScanRecord;
  item?: RecallItem;
}

export interface LegacyMigrationResult {
  campaignId: string;
  migrated: boolean;
  pulledCount: number;
  scanCount: number;
  soundEnabled?: boolean;
}

export interface BackupPayload {
  kind: "retail-recall-router-backup";
  version: 1;
  generatedAt: string;
  campaigns: Campaign[];
  items: RecallItem[];
  scans: ScanRecord[];
  settings: AppSetting[];
}

