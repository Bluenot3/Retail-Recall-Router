import {
  AlertTriangle,
  CheckCircle2,
  FileImage,
  FileSpreadsheet,
  ListChecks,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ImportResult, ImportedRecallRow, RejectedRecallRow } from "../types";
import { validateBarcode } from "../lib/barcodes";
import {
  type DocumentImportCandidate,
  type DocumentImportProgress,
  type DocumentImportResult,
  importRecallDocuments,
  markDuplicateCandidates,
} from "../lib/documentImport";
import { parseDelimitedRecall, parseRecallFile } from "../lib/importers";

export interface RecallIntakeValue {
  result: ImportResult | null;
  ready: boolean;
  assisted: boolean;
}

interface RecallIntakeProps {
  onChange: (value: RecallIntakeValue) => void;
  onBrandDetected?: (brand: string) => void;
  pushToast: (message: string, error?: boolean) => void;
}

const DOCUMENT_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png", "webp"]);

function extension(name: string): string {
  return name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";
}

function isDocumentFile(file: File): boolean {
  return DOCUMENT_EXTENSIONS.has(extension(file.name));
}

function candidateRows(candidates: readonly DocumentImportCandidate[]): ImportedRecallRow[] {
  return candidates
    .filter((candidate) => candidate.valid && !candidate.isDuplicate && candidate.reviewStatus !== "rejected")
    .map((candidate, index) => ({
      barcode: candidate.normalizedBarcode,
      description: candidate.description.trim() || `Frame ${candidate.normalizedBarcode}`,
      quantity: 1,
      notes: `${candidate.sourceName}${candidate.pageNumber ? ` page ${candidate.pageNumber}` : ""}`,
      sourceRowNumber: index + 1,
    }));
}

function candidateRejects(candidates: readonly DocumentImportCandidate[]): RejectedRecallRow[] {
  return candidates
    .filter((candidate) => !candidate.valid || candidate.isDuplicate)
    .map((candidate, index) => ({
      rowNumber: candidate.lineNumber || index + 1,
      barcode: candidate.rawBarcode || undefined,
      reason: candidate.isDuplicate
        ? "Duplicate barcode candidate"
        : candidate.invalidReason || "Invalid barcode candidate",
      values: [candidate.rawBarcode, candidate.description, candidate.rawText],
    }));
}

function assistedImportResult(
  documentResult: DocumentImportResult,
  candidates: readonly DocumentImportCandidate[],
): ImportResult {
  const sourceNames = documentResult.sources.map((source) => source.name);
  const allPdf = documentResult.sources.every((source) => source.kind === "pdf");
  return {
    sourceName: sourceNames.join(", ") || "assisted-document-import",
    sourceType: allPdf ? "pdf" : "image",
    rows: candidateRows(candidates),
    rejected: candidateRejects(candidates),
    inference: {
      mapping: { barcode: 0, description: 1 },
      headerRowIndex: null,
      confidence: "low",
      headers: [],
    },
    warnings: documentResult.warnings,
  };
}

function progressLabel(progress: DocumentImportProgress | null): string {
  if (!progress) return "Reading document locally…";
  const percent = progress.fraction === undefined ? "" : ` ${Math.round(progress.fraction * 100)}%`;
  return `${progress.message}${percent}`;
}

export function RecallIntake({ onChange, onBrandDetected, pushToast }: RecallIntakeProps) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [pasteValue, setPasteValue] = useState("");
  const [standardResult, setStandardResult] = useState<ImportResult | null>(null);
  const [documentResult, setDocumentResult] = useState<DocumentImportResult | null>(null);
  const [candidates, setCandidates] = useState<DocumentImportCandidate[]>([]);
  const [documentConfirmed, setDocumentConfirmed] = useState(false);
  const [productOnlyConfirmed, setProductOnlyConfirmed] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<DocumentImportProgress | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => () => abortController.current?.abort(), []);

  const publishDocument = (
    nextCandidates: DocumentImportCandidate[],
    confirmed = documentConfirmed,
    source = documentResult,
  ) => {
    if (!source) {
      onChange({ result: null, ready: false, assisted: true });
      return;
    }
    const deduped = markDuplicateCandidates(nextCandidates);
    const result = assistedImportResult(source, deduped);
    const allResolved = deduped.length > 0 && deduped.every(
      (candidate) => candidate.valid && !candidate.isDuplicate && candidate.reviewStatus !== "rejected",
    );
    onChange({ result, ready: confirmed && allResolved && result.rows.length > 0, assisted: true });
  };

  const resetResults = () => {
    setStandardResult(null);
    setDocumentResult(null);
    setCandidates([]);
    setDocumentConfirmed(false);
    setProgress(null);
    setImagePreview(null);
    onChange({ result: null, ready: false, assisted: false });
  };

  const parseFiles = async (files: File[]) => {
    if (!files.length) return;
    const documents = files.filter(isDocumentFile);
    if (documents.length && documents.length !== files.length) {
      pushToast("Upload photos/PDFs together, or upload one spreadsheet/text list separately.", true);
      return;
    }
    if (!productOnlyConfirmed) {
      pushToast("Confirm that the files contain product information only and no patient information.", true);
      return;
    }
    if (!documents.length && files.length !== 1) {
      pushToast("Choose one CSV, TSV, XLSX, or XLS file at a time.", true);
      return;
    }
    if (files.some((file) => file.size > 25 * 1024 * 1024)) {
      pushToast("Each file must be 25 MB or smaller.", true);
      return;
    }

    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    setParsing(true);
    resetResults();
    try {
      if (documents.length) {
        const firstImage = documents.find((file) => file.type.startsWith("image/"));
        if (firstImage) {
          const reader = new FileReader();
          reader.addEventListener("load", () => setImagePreview(typeof reader.result === "string" ? reader.result : null), { once: true });
          reader.readAsDataURL(firstImage);
        }
        const parsed = await importRecallDocuments(documents, {
          signal: controller.signal,
          onProgress: setProgress,
        });
        const initial = markDuplicateCandidates(parsed.candidates);
        setDocumentResult(parsed);
        setCandidates(initial);
        setDocumentConfirmed(false);
        publishDocument(initial, false, parsed);
        pushToast(`${initial.length} document row candidates are ready for required review.`);
      } else {
        const parsed = await parseRecallFile(files[0]);
        setStandardResult(parsed);
        setDocumentResult(null);
        setCandidates([]);
        onChange({ result: parsed, ready: parsed.rows.length > 0, assisted: false });
        if (parsed.rows[0]?.brand) onBrandDetected?.(parsed.rows[0].brand);
        pushToast(`${parsed.rows.length} list rows are ready to review.`);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        pushToast(error instanceof Error ? error.message : "Those files could not be read.", true);
      }
    } finally {
      if (abortController.current === controller) abortController.current = null;
      setParsing(false);
    }
  };

  const parsePaste = () => {
    try {
      const parsed = parseDelimitedRecall(pasteValue, {}, "pasted-recall-list.csv");
      setStandardResult(parsed);
      setDocumentResult(null);
      setCandidates([]);
      setDocumentConfirmed(false);
      onChange({ result: parsed, ready: parsed.rows.length > 0, assisted: false });
      if (parsed.rows[0]?.brand) onBrandDetected?.(parsed.rows[0].brand);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Those pasted rows could not be read.", true);
    }
  };

  const updateCandidate = (id: string, field: "barcode" | "description", value: string) => {
    const next = candidates.map((candidate) => {
      if (candidate.id !== id) return candidate;
      if (field === "description") {
        return { ...candidate, description: value, reviewStatus: "edited" as const };
      }
      const validation = validateBarcode(value);
      return {
        ...candidate,
        rawBarcode: value,
        normalizedBarcode: validation.normalized,
        barcodeKey: validation.barcodeKey,
        valid: validation.valid,
        invalidReason: validation.reason,
        reviewStatus: "edited" as const,
      };
    });
    const deduped = markDuplicateCandidates(next);
    setCandidates(deduped);
    setDocumentConfirmed(false);
    publishDocument(deduped, false);
  };

  const removeCandidate = (id: string) => {
    const next = markDuplicateCandidates(candidates.filter((candidate) => candidate.id !== id));
    setCandidates(next);
    setDocumentConfirmed(false);
    publishDocument(next, false);
  };

  const addCandidate = () => {
    const next = markDuplicateCandidates([
      ...candidates,
      {
        id: `manual-${crypto.randomUUID()}`,
        sourceName: "Manual review row",
        pageNumber: 0,
        lineNumber: candidates.length + 1,
        extractionMethod: "ocr",
        rotation: 0,
        rawText: "Manually added during document review",
        rawBarcode: "",
        normalizedBarcode: "",
        description: "",
        valid: false,
        invalidReason: "empty",
        isDuplicate: false,
        reviewStatus: "edited",
        editable: true,
      },
    ]);
    setCandidates(next);
    setDocumentConfirmed(false);
    publishDocument(next, false);
  };

  const displayedResult = documentResult
    ? assistedImportResult(documentResult, candidates)
    : standardResult;
  const unresolvedCount = candidates.filter((candidate) => !candidate.valid || candidate.isDuplicate).length;
  const sourceSummary = useMemo(
    () => documentResult?.sources.map((source) => `${source.name}: ${source.pageCount} page${source.pageCount === 1 ? "" : "s"}`).join(" · "),
    [documentResult],
  );

  return (
    <div className="recall-intake">
      <div className="input-tabs" role="tablist" aria-label="List input method">
        <button className={`input-tab ${mode === "file" ? "active" : ""}`} onClick={() => setMode("file")} role="tab" aria-selected={mode === "file"}>
          Upload list, PDF, or photos
        </button>
        <button className={`input-tab ${mode === "paste" ? "active" : ""}`} onClick={() => setMode("paste")} role="tab" aria-selected={mode === "paste"}>
          Paste rows
        </button>
      </div>

      {mode === "file" ? (
        <>
          <label className="privacy-check">
            <input type="checkbox" checked={productOnlyConfirmed} onChange={(event) => setProductOnlyConfirmed(event.target.checked)} />
            <span><strong>Product information only.</strong> These files contain no patient names, prescriptions, insurance information, or other PHI.</span>
          </label>
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            multiple
            accept=".csv,.tsv,.xlsx,.xls,.pdf,.jpg,.jpeg,.png,.webp,text/csv,text/tab-separated-values,application/pdf,image/jpeg,image/png,image/webp"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length) void parseFiles(files);
              event.target.value = "";
            }}
          />
          <div
            className={`drop-zone ${dragging ? "dragging" : ""} ${!productOnlyConfirmed ? "disabled" : ""}`}
            role="button"
            tabIndex={0}
            aria-disabled={!productOnlyConfirmed || parsing}
            onClick={() => {
              if (productOnlyConfirmed && !parsing) fileInput.current?.click();
            }}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && productOnlyConfirmed && !parsing) fileInput.current?.click();
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              if (productOnlyConfirmed) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              setDragging(false);
              if (productOnlyConfirmed) void parseFiles(Array.from(event.dataTransfer.files));
            }}
          >
            {documentsIcon(displayedResult?.sourceType)}
            <strong>{parsing ? progressLabel(progress) : "Drop a list, PDF, or clear photos here"}</strong>
            <span>{productOnlyConfirmed ? "or click to choose files" : "confirm the product-only checkbox first"}</span>
            <small>CSV, TSV, XLSX, XLS, PDF, JPG, PNG, or WebP · photos/PDFs stay on this device</small>
          </div>
          {parsing ? (
            <button className="secondary-button" onClick={() => abortController.current?.abort()}>
              Cancel document reading
            </button>
          ) : null}
        </>
      ) : (
        <div className="field">
          <label htmlFor="paste-rows">Paste a header row and product items</label>
          <textarea
            id="paste-rows"
            value={pasteValue}
            onChange={(event) => setPasteValue(event.target.value)}
            placeholder={"UPC,Brand,Model,Color,Quantity\n036000291452,Example Optical,A100,Black,1"}
          />
          <button className="secondary-button" onClick={parsePaste} disabled={!pasteValue.trim()}>
            <ListChecks size={18} /> Review pasted rows
          </button>
        </div>
      )}

      {documentResult ? (
        <>
          <div className="document-review-heading">
            <div>
              <h3>Required document review · {candidates.length} candidate row{candidates.length === 1 ? "" : "s"}</h3>
              <p>{sourceSummary}</p>
            </div>
            <button className="secondary-button" onClick={addCandidate}>Add a missing row</button>
          </div>
          {imagePreview ? <img className="document-source-preview" src={imagePreview} alt="Uploaded source photo for row review" /> : null}
          <div className="document-candidate-scroll">
            <table className="document-candidate-table">
              <thead><tr><th>Status</th><th>UPC / GTIN</th><th>Frame description</th><th>Source</th><th aria-label="Remove row" /></tr></thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.id} className={!candidate.valid || candidate.isDuplicate ? "candidate-error" : ""}>
                    <td className="candidate-status">
                      {candidate.isDuplicate ? <><AlertTriangle size={16} /> Duplicate</> : candidate.valid ? <><CheckCircle2 size={16} /> Valid</> : <><XCircle size={16} /> Fix</>}
                    </td>
                    <td>
                      <input
                        aria-label={`Barcode from ${candidate.sourceName} row ${candidate.lineNumber}`}
                        value={candidate.rawBarcode}
                        onChange={(event) => updateCandidate(candidate.id, "barcode", event.target.value)}
                        inputMode="numeric"
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Description for ${candidate.rawBarcode || "new row"}`}
                        value={candidate.description}
                        onChange={(event) => updateCandidate(candidate.id, "description", event.target.value)}
                      />
                    </td>
                    <td><span>{candidate.sourceName}</span><small>{candidate.pageNumber ? `Page ${candidate.pageNumber}` : "Manual"}{candidate.confidence === undefined ? "" : ` · ${Math.round(candidate.confidence)}% OCR`}</small></td>
                    <td><button className="icon-button" onClick={() => removeCandidate(candidate.id)} aria-label={`Remove ${candidate.rawBarcode || "row"}`}><Trash2 size={17} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unresolvedCount ? (
            <div className="notice warning"><AlertTriangle size={19} /><span>Resolve or remove {unresolvedCount} invalid or duplicate row{unresolvedCount === 1 ? "" : "s"}. OCR is never trusted automatically.</span></div>
          ) : null}
          <label className={`document-confirm ${unresolvedCount ? "disabled" : ""}`}>
            <input
              type="checkbox"
              checked={documentConfirmed}
              disabled={Boolean(unresolvedCount) || !candidates.length}
              onChange={(event) => {
                const confirmed = event.target.checked;
                setDocumentConfirmed(confirmed);
                publishDocument(candidates, confirmed);
              }}
            />
            <span><strong>I compared all {candidates.length} rows to the source.</strong> The UPCs and frame descriptions above are correct.</span>
          </label>
        </>
      ) : displayedResult ? (
        <StandardPreview result={displayedResult} />
      ) : null}
    </div>
  );
}

function documentsIcon(sourceType?: ImportResult["sourceType"]) {
  return sourceType === "pdf" || sourceType === "image"
    ? <FileImage size={34} aria-hidden="true" />
    : <FileSpreadsheet size={34} aria-hidden="true" />;
}

function StandardPreview({ result }: { result: ImportResult }) {
  return (
    <>
      <div className="mapping-card">
        <h3>Import preview · {result.rows.length} valid item{result.rows.length === 1 ? "" : "s"}</h3>
        <div className="preview-scroll">
          <table className="preview-table">
            <thead><tr><th>Barcode</th><th>Description</th><th>Qty</th></tr></thead>
            <tbody>
              {result.rows.slice(0, 12).map((row, index) => (
                <tr key={`${row.barcode}-${index}`}><td>{row.barcode}</td><td>{row.description || row.model || "—"}</td><td>{row.quantity || 1}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {result.rejected.length ? (
        <div className="notice warning"><AlertTriangle size={19} /><span>{result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} cannot be imported. Reconcile the count to the source before continuing.</span></div>
      ) : (
        <div className="notice success"><ShieldCheck size={19} /><span>All imported rows have valid UPC/GTIN check digits.</span></div>
      )}
      {result.warnings.map((warning) => <div className="notice warning" key={warning}><AlertTriangle size={19} /><span>{warning}</span></div>)}
    </>
  );
}
