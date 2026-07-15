import type { CreateCampaignInput, ImportedRecallRow } from "../types";

export const TEST_CAMPAIGN_ID = "test-optical-recall";

export const testCampaign: CreateCampaignInput = {
  id: TEST_CAMPAIGN_ID,
  name: "Test Optical Recall",
  brand: "Example Optical",
  recallReference: "TEST-001",
  locationName: "Philadelphia, PA",
  region: "Philadelphia, PA",
  status: "active",
  sourceFileName: "test-recall.csv",
  sourceFileType: "text/csv",
};

export const testRecallRows: ImportedRecallRow[] = [
  { barcode: "036000291452", description: "Test Frame A", brand: "Example Optical", model: "A100" },
  { barcode: "4006381333931", description: "Test Frame B", brand: "Example Optical", model: "B200" },
  { barcode: "5901234123457", description: "Test Frame C", brand: "Example Optical", model: "C300" },
].map((row, index) => ({ ...row, quantity: 1, sourceRowNumber: index + 2 }));
