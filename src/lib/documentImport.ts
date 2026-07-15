import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { BarcodeInvalidReason } from "../types";
import { validateBarcode } from "./barcodes";

export const DOCUMENT_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxPhotos: 5,
  maxNativeTextPages: 50,
  maxOcrPages: 10,
  maxImagePixels: 16_000_000,
  maxCanvasPixels: 8_000_000,
  maxCanvasLongSide: 2_400,
});

export type DocumentKind = "pdf" | "jpeg" | "png" | "webp";
export type DocumentExtractionMethod = "pdf-text" | "ocr";
export type DocumentRotation = 0 | 90 | 270;
export type DocumentReviewStatus = "pending" | "approved" | "edited" | "rejected";

export interface LocalDocumentFile {
  name: string;
  size: number;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DocumentBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PositionedTextItem {
  str: string;
  transform: ArrayLike<number>;
  width?: number;
  height?: number;
}

export interface DocumentTextLine {
  pageNumber: number;
  lineNumber: number;
  text: string;
  confidence?: number;
  boundingBox?: DocumentBoundingBox;
}

export interface DocumentImportCandidate {
  /** Stable within this import result; callers may replace it when persisting a draft. */
  id: string;
  sourceName: string;
  pageNumber: number;
  lineNumber: number;
  extractionMethod: DocumentExtractionMethod;
  rotation: DocumentRotation;
  rawText: string;
  /** Exactly what text/PDF extraction returned. No O/0, I/1, or other substitutions occur. */
  rawBarcode: string;
  normalizedBarcode: string;
  barcodeKey?: string;
  description: string;
  confidence?: number;
  valid: boolean;
  invalidReason?: BarcodeInvalidReason;
  isDuplicate: boolean;
  duplicateOf?: string;
  reviewStatus: DocumentReviewStatus;
  editable: true;
  boundingBox?: DocumentBoundingBox;
}

export interface DocumentImportSourceSummary {
  name: string;
  kind: DocumentKind;
  pageCount: number;
  nativeTextPages: number;
  ocrPages: number;
}

export interface DocumentImportResult {
  candidates: DocumentImportCandidate[];
  sources: DocumentImportSourceSummary[];
  warnings: string[];
  /** OCR/PDF candidates are never an activated recall list without staff review. */
  requiresReview: true;
}

export type DocumentImportStage =
  | "validating"
  | "pdf-loading"
  | "pdf-text"
  | "pdf-render"
  | "ocr-loading"
  | "ocr"
  | "complete";

export interface DocumentImportProgress {
  stage: DocumentImportStage;
  sourceName?: string;
  pageNumber?: number;
  rotation?: DocumentRotation;
  completed: number;
  total: number;
  fraction?: number;
  message: string;
}

export interface OcrAssetPaths {
  workerPath: string;
  corePath: string;
  langPath: string;
}

export interface OcrRecognitionData {
  text?: string;
  tsv?: string | null;
  confidence?: number;
}

export interface OcrWorkerLike {
  recognize(
    image: HTMLCanvasElement,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: OcrRecognitionData }>;
  setParameters?(parameters: Record<string, unknown>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

interface PdfViewportLike {
  width: number;
  height: number;
}

interface PdfRenderTaskLike {
  promise: Promise<unknown>;
  cancel(): void;
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
  getViewport(options: { scale: number }): PdfViewportLike;
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
  }): PdfRenderTaskLike;
  cleanup?(): void;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  cleanup?(keepLoadedFonts?: boolean): Promise<unknown>;
}

interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void> | void;
}

interface PdfJsLike {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: Record<string, unknown>): PdfLoadingTaskLike;
}

interface CanvasLease {
  canvas: HTMLCanvasElement;
  release(): void;
}

export interface DocumentImportAdapters {
  loadPdfJs(): Promise<PdfJsLike>;
  createOcrWorker(
    assets: OcrAssetPaths,
    logger: (message: { status?: string; progress?: number }) => void,
  ): Promise<OcrWorkerLike>;
  decodeImage(
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<CanvasLease>;
  renderPdfPage(page: PdfPageLike, signal?: AbortSignal): Promise<CanvasLease>;
  rotateCanvas(
    canvas: HTMLCanvasElement,
    rotation: Exclude<DocumentRotation, 0>,
  ): HTMLCanvasElement;
}

export interface DocumentImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DocumentImportProgress) => void;
  ocrAssets?: Partial<OcrAssetPaths>;
  /** Intended for deterministic tests; production callers should use the secure defaults. */
  adapters?: Partial<DocumentImportAdapters>;
}

export class DocumentImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "aborted"
      | "empty-selection"
      | "file-too-large"
      | "too-many-photos"
      | "too-many-pages"
      | "too-many-ocr-pages"
      | "unsupported-file"
      | "invalid-file"
      | "cross-origin-asset"
      | "browser-unsupported",
  ) {
    super(message);
    this.name = "DocumentImportError";
  }
}

function abortError(): DocumentImportError {
  return new DocumentImportError("Document import was canceled.", "aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function extension(name: string): string {
  return name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";
}

function kindFromMetadata(file: Pick<LocalDocumentFile, "name" | "type">): DocumentKind | null {
  const mime = (file.type ?? "").toLowerCase().split(";", 1)[0].trim();
  if (mime === "application/pdf" || extension(file.name) === "pdf") return "pdf";
  if (mime === "image/jpeg" || ["jpg", "jpeg"].includes(extension(file.name))) return "jpeg";
  if (mime === "image/png" || extension(file.name) === "png") return "png";
  if (mime === "image/webp" || extension(file.name) === "webp") return "webp";
  return null;
}

export function validateDocumentSelection(files: readonly LocalDocumentFile[]): void {
  if (!files.length) {
    throw new DocumentImportError("Choose a PDF or at least one photo.", "empty-selection");
  }

  let photoCount = 0;
  for (const file of files) {
    const kind = kindFromMetadata(file);
    if (!kind) {
      throw new DocumentImportError(
        `${file.name} is not a supported PDF, JPEG, PNG, or WebP file.`,
        "unsupported-file",
      );
    }
    if (kind !== "pdf") photoCount += 1;
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > DOCUMENT_IMPORT_LIMITS.maxFileBytes) {
      throw new DocumentImportError(
        `${file.name} is larger than the 25 MB document safety limit.`,
        "file-too-large",
      );
    }
  }

  if (photoCount > DOCUMENT_IMPORT_LIMITS.maxPhotos) {
    throw new DocumentImportError(
      `Choose no more than ${DOCUMENT_IMPORT_LIMITS.maxPhotos} photos at one time.`,
      "too-many-photos",
    );
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Detects by file signature; a filename or MIME type alone is not trusted. */
export function detectDocumentKind(bytes: Uint8Array): DocumentKind | null {
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
}

function safeItem(value: unknown): value is PositionedTextItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PositionedTextItem>;
  return typeof item.str === "string" && Boolean(item.transform) && Number(item.transform?.length) >= 6;
}

interface LineAccumulator {
  y: number;
  items: Array<PositionedTextItem & { x: number; y: number }>;
}

/** Reconstructs PDF rows using PDF-space coordinates rather than extraction order. */
export function groupPdfTextItems(
  values: readonly unknown[],
  pageNumber: number,
  yTolerance = 3,
): DocumentTextLine[] {
  const items = values
    .filter(safeItem)
    .map((item) => ({
      ...item,
      x: Number(item.transform[4]),
      y: Number(item.transform[5]),
    }))
    .filter((item) => item.str.trim() && Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((left, right) => right.y - left.y || left.x - right.x);

  const groups: LineAccumulator[] = [];
  for (const item of items) {
    const existing = groups.find((group) => Math.abs(group.y - item.y) <= yTolerance);
    if (existing) {
      existing.items.push(item);
      existing.y = existing.items.reduce((sum, entry) => sum + entry.y, 0) / existing.items.length;
    } else {
      groups.push({ y: item.y, items: [item] });
    }
  }

  return groups
    .sort((left, right) => right.y - left.y)
    .map((group, index) => {
      const sorted = group.items.sort((left, right) => left.x - right.x);
      const x0 = Math.min(...sorted.map((item) => item.x));
      const x1 = Math.max(...sorted.map((item) => item.x + Math.max(0, item.width ?? 0)));
      const y0 = Math.min(...sorted.map((item) => item.y));
      const y1 = Math.max(...sorted.map((item) => item.y + Math.max(0, item.height ?? 0)));
      return {
        pageNumber,
        lineNumber: index + 1,
        text: sorted.map((item) => item.str.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
        boundingBox: { x0, y0, x1, y1 },
      };
    })
    .filter((line) => line.text);
}

const GTIN_TEXT_PATTERNS = [
  /(?:^|[^\d])(\d{8,14})(?!\d)/g,
  /(?:^|[^\d])((?:\d{2,4}[ -]){1,5}\d{2,4})(?![ -]?\d)/g,
];

interface RawBarcodeMatch {
  rawBarcode: string;
  start: number;
}

function barcodeMatches(text: string): RawBarcodeMatch[] {
  const matches: RawBarcodeMatch[] = [];
  const seen = new Set<string>();
  for (const pattern of GTIN_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const rawBarcode = match[1].trim();
      const digits = rawBarcode.replace(/[ -]/g, "");
      if (digits.length < 8 || digits.length > 14) continue;
      const start = text.indexOf(match[1], match.index);
      const key = `${start}:${start + match[1].length}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ rawBarcode, start });
      }
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

function stripCandidateFromDescription(text: string, rawBarcode: string, normalized: string): string {
  const description = text.replace(rawBarcode, " ").replace(/\s+/g, " ").trim();
  return description || `Frame ${normalized}`;
}

export interface CandidateExtractionContext {
  sourceName: string;
  sourceId?: string;
  extractionMethod: DocumentExtractionMethod;
  rotation?: DocumentRotation;
}

/** Extracts only digits plus printed spaces/hyphens. It never guesses OCR characters. */
export function extractGtinCandidates(
  lines: readonly DocumentTextLine[],
  context: CandidateExtractionContext,
): DocumentImportCandidate[] {
  const candidates: DocumentImportCandidate[] = [];

  for (const line of lines) {
    const matches = barcodeMatches(line.text);
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const rawBarcode = matches[matchIndex].rawBarcode;
      const validation = validateBarcode(rawBarcode);
      const normalized = validation.normalized;
      candidates.push({
        id: `${context.sourceId ?? context.sourceName}:${line.pageNumber}:${line.lineNumber}:${matchIndex}`,
        sourceName: context.sourceName,
        pageNumber: line.pageNumber,
        lineNumber: line.lineNumber,
        extractionMethod: context.extractionMethod,
        rotation: context.rotation ?? 0,
        rawText: line.text,
        rawBarcode,
        normalizedBarcode: normalized,
        barcodeKey: validation.barcodeKey,
        description: stripCandidateFromDescription(line.text, rawBarcode, normalized),
        confidence: line.confidence,
        valid: validation.valid,
        invalidReason: validation.reason,
        isDuplicate: false,
        reviewStatus: "pending",
        editable: true,
        boundingBox: line.boundingBox,
      });
    }
  }

  return candidates;
}

export function markDuplicateCandidates(
  values: readonly DocumentImportCandidate[],
): DocumentImportCandidate[] {
  const firstByKey = new Map<string, string>();
  return values.map((candidate) => {
    if (!candidate.valid || !candidate.barcodeKey) return { ...candidate };
    const first = firstByKey.get(candidate.barcodeKey);
    if (!first) {
      firstByKey.set(candidate.barcodeKey, candidate.id);
      return { ...candidate, isDuplicate: false, duplicateOf: undefined };
    }
    return { ...candidate, isDuplicate: true, duplicateOf: first };
  });
}

interface TsvWord {
  key: string;
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Converts Tesseract TSV word output into editable visual lines. */
export function parseOcrTsv(tsv: string, pageNumber: number): DocumentTextLine[] {
  const rows = tsv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];
  const headers = rows[0].split("\t");
  const column = (name: string) => headers.indexOf(name);
  const required = ["level", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text"];
  if (required.some((name) => column(name) < 0)) return [];

  const words: TsvWord[] = [];
  for (const row of rows.slice(1)) {
    const cells = row.split("\t");
    if (cells[column("level")] !== "5") continue;
    const text = cells.slice(column("text")).join("\t").trim();
    if (!text) continue;
    const number = (name: string) => Number(cells[column(name)]);
    const values = {
      confidence: number("conf"),
      left: number("left"),
      top: number("top"),
      width: number("width"),
      height: number("height"),
    };
    if (Object.values(values).some((value) => !Number.isFinite(value))) continue;
    words.push({
      key: [cells[column("block_num")], cells[column("par_num")], cells[column("line_num")]].join(":"),
      text,
      ...values,
    });
  }

  const grouped = new Map<string, TsvWord[]>();
  for (const word of words) grouped.set(word.key, [...(grouped.get(word.key) ?? []), word]);

  return [...grouped.values()]
    .map((lineWords) => lineWords.sort((left, right) => left.left - right.left))
    .sort((left, right) => left[0].top - right[0].top || left[0].left - right[0].left)
    .map((lineWords, index) => {
      const x0 = Math.min(...lineWords.map((word) => word.left));
      const y0 = Math.min(...lineWords.map((word) => word.top));
      const x1 = Math.max(...lineWords.map((word) => word.left + word.width));
      const y1 = Math.max(...lineWords.map((word) => word.top + word.height));
      const weightedLength = lineWords.reduce((sum, word) => sum + word.text.length, 0) || 1;
      const confidence = lineWords.reduce(
        (sum, word) => sum + Math.max(0, word.confidence) * word.text.length,
        0,
      ) / weightedLength;
      return {
        pageNumber,
        lineNumber: index + 1,
        text: lineWords.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
        confidence,
        boundingBox: { x0, y0, x1, y1 },
      };
    });
}

function linesFromRecognition(data: OcrRecognitionData, pageNumber: number): DocumentTextLine[] {
  const tsvLines = data.tsv ? parseOcrTsv(data.tsv, pageNumber) : [];
  if (tsvLines.length) return tsvLines;
  return (data.text ?? "")
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({
      pageNumber,
      lineNumber: index + 1,
      text,
      confidence: data.confidence,
    }));
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Test doubles and detached canvases may be immutable; there is no resource to release then.
  }
}

function defaultRotateCanvas(
  source: HTMLCanvasElement,
  rotation: Exclude<DocumentRotation, 0>,
): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new DocumentImportError("Photo rotation requires a browser document.", "browser-unsupported");
  }
  const canvas = document.createElement("canvas");
  canvas.width = source.height;
  canvas.height = source.width;
  const context = canvas.getContext("2d");
  if (!context) throw new DocumentImportError("Canvas rendering is unavailable.", "browser-unsupported");
  if (rotation === 90) {
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
  } else {
    context.translate(0, canvas.height);
    context.rotate(-Math.PI / 2);
  }
  context.drawImage(source, 0, 0);
  return canvas;
}

export interface OcrRotationOptions {
  sourceName: string;
  sourceId?: string;
  pageNumber: number;
  signal?: AbortSignal;
  onAttempt?: (rotation: DocumentRotation, attempt: number) => void;
  rotateCanvas?: (
    canvas: HTMLCanvasElement,
    rotation: Exclude<DocumentRotation, 0>,
  ) => HTMLCanvasElement;
}

export interface OcrRotationResult {
  rotation: DocumentRotation;
  attemptedRotations: DocumentRotation[];
  lines: DocumentTextLine[];
  candidates: DocumentImportCandidate[];
}

/** Tries upright first, then 90 and 270 degrees only when no valid GTIN was found. */
export async function recognizeCanvasWithRotationFallback(
  source: HTMLCanvasElement,
  worker: OcrWorkerLike,
  options: OcrRotationOptions,
): Promise<OcrRotationResult> {
  const rotations: DocumentRotation[] = [0, 90, 270];
  const attemptedRotations: DocumentRotation[] = [];
  const attempts: OcrRotationResult[] = [];
  const rotate = options.rotateCanvas ?? defaultRotateCanvas;

  for (let index = 0; index < rotations.length; index += 1) {
    throwIfAborted(options.signal);
    const rotation = rotations[index];
    options.onAttempt?.(rotation, index + 1);
    attemptedRotations.push(rotation);
    const image = rotation === 0 ? source : rotate(source, rotation);
    try {
      const result = await worker.recognize(
        image,
        { rotateAuto: false },
        { text: true, tsv: true },
      );
      throwIfAborted(options.signal);
      const lines = linesFromRecognition(result.data, options.pageNumber);
      const candidates = extractGtinCandidates(lines, {
        sourceName: options.sourceName,
        sourceId: options.sourceId,
        extractionMethod: "ocr",
        rotation,
      });
      const attempt = { rotation, attemptedRotations: [...attemptedRotations], lines, candidates };
      attempts.push(attempt);
      if (candidates.some((candidate) => candidate.valid)) return attempt;
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      throw error;
    } finally {
      if (rotation !== 0) clearCanvas(image);
    }
  }

  const best = attempts.sort((left, right) => {
    const candidateDelta = right.candidates.length - left.candidates.length;
    if (candidateDelta) return candidateDelta;
    const confidence = (attempt: OcrRotationResult) =>
      attempt.lines.reduce((sum, line) => sum + (line.confidence ?? 0), 0) /
      Math.max(1, attempt.lines.length);
    return confidence(right) - confidence(left);
  })[0];
  return best
    ? { ...best, attemptedRotations: [...attemptedRotations] }
    : { rotation: 0, attemptedRotations, lines: [], candidates: [] };
}

function currentDocumentUrl(): string {
  if (typeof window !== "undefined" && window.location?.href) return window.location.href;
  return "http://localhost/";
}

function sameOriginAssetUrl(value: string): string {
  const page = new URL(currentDocumentUrl());
  const url = new URL(value, page);
  if (url.origin !== page.origin) {
    throw new DocumentImportError("Document workers and OCR data must be served by this app.", "cross-origin-asset");
  }
  return url.toString();
}

export function resolveOcrAssetPaths(overrides: Partial<OcrAssetPaths> = {}): OcrAssetPaths {
  const base = `${import.meta.env.BASE_URL}ocr/`;
  return {
    workerPath: sameOriginAssetUrl(overrides.workerPath ?? `${base}worker.min.js`),
    corePath: sameOriginAssetUrl(overrides.corePath ?? `${base}core`),
    langPath: sameOriginAssetUrl(overrides.langPath ?? `${base}lang`),
  };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new DocumentImportError("Document rendering requires a browser.", "browser-unsupported");
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function fittedSize(width: number, height: number): { width: number; height: number } {
  const longScale = DOCUMENT_IMPORT_LIMITS.maxCanvasLongSide / Math.max(width, height, 1);
  const pixelScale = Math.sqrt(DOCUMENT_IMPORT_LIMITS.maxCanvasPixels / Math.max(width * height, 1));
  const scale = Math.min(1, longScale, pixelScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function defaultDecodeImage(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<CanvasLease> {
  throwIfAborted(signal);
  if (typeof createImageBitmap !== "function") {
    throw new DocumentImportError("This browser cannot decode document photos.", "browser-unsupported");
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }), {
    imageOrientation: "from-image",
  });
  try {
    throwIfAborted(signal);
    if (bitmap.width * bitmap.height > DOCUMENT_IMPORT_LIMITS.maxImagePixels) {
      throw new DocumentImportError(
        "That photo exceeds the 16 megapixel safety limit. Resize it and try again.",
        "invalid-file",
      );
    }
    const size = fittedSize(bitmap.width, bitmap.height);
    const canvas = createCanvas(size.width, size.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new DocumentImportError("Canvas rendering is unavailable.", "browser-unsupported");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { canvas, release: () => clearCanvas(canvas) };
  } finally {
    bitmap.close();
  }
}

async function defaultRenderPdfPage(page: PdfPageLike, signal?: AbortSignal): Promise<CanvasLease> {
  throwIfAborted(signal);
  const original = page.getViewport({ scale: 1 });
  const fitted = fittedSize(original.width * 2, original.height * 2);
  const scale = Math.min(fitted.width / original.width, fitted.height / original.height);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new DocumentImportError("Canvas rendering is unavailable.", "browser-unsupported");
  const renderTask = page.render({ canvas, canvasContext: context, viewport });
  const cancel = () => renderTask.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await renderTask.promise;
    throwIfAborted(signal);
    return { canvas, release: () => clearCanvas(canvas) };
  } catch (error) {
    clearCanvas(canvas);
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

async function defaultCreateOcrWorker(
  assets: OcrAssetPaths,
  logger: (message: { status?: string; progress?: number }) => void,
): Promise<OcrWorkerLike> {
  const Tesseract = await import("tesseract.js");
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    workerPath: assets.workerPath,
    corePath: assets.corePath,
    langPath: assets.langPath,
    workerBlobURL: false,
    gzip: true,
    logger: (message) => logger(message),
  });
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.AUTO,
    preserve_interword_spaces: "1",
  });
  return worker as OcrWorkerLike;
}

const defaultAdapters: DocumentImportAdapters = {
  loadPdfJs: async () => await import("pdfjs-dist") as unknown as PdfJsLike,
  createOcrWorker: defaultCreateOcrWorker,
  decodeImage: defaultDecodeImage,
  renderPdfPage: defaultRenderPdfPage,
  rotateCanvas: defaultRotateCanvas,
};

function mimeForKind(kind: Exclude<DocumentKind, "pdf">): string {
  return kind === "jpeg" ? "image/jpeg" : kind === "png" ? "image/png" : "image/webp";
}

interface PreparedFile {
  id: string;
  file: LocalDocumentFile;
  bytes: Uint8Array;
  kind: DocumentKind;
}

async function prepareFiles(
  files: readonly LocalDocumentFile[],
  signal?: AbortSignal,
  onProgress?: (progress: DocumentImportProgress) => void,
): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal);
    const file = files[index];
    onProgress?.({
      stage: "validating",
      sourceName: file.name,
      completed: index,
      total: files.length,
      message: `Checking ${file.name}`,
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > DOCUMENT_IMPORT_LIMITS.maxFileBytes) {
      throw new DocumentImportError(`${file.name} is larger than 25 MB.`, "file-too-large");
    }
    const kind = detectDocumentKind(bytes);
    const metadataKind = kindFromMetadata(file);
    if (!kind || !metadataKind || kind !== metadataKind) {
      throw new DocumentImportError(`${file.name} does not match its PDF or image file type.`, "invalid-file");
    }
    prepared.push({ id: `${index}:${file.name}`, file, bytes, kind });
  }
  return prepared;
}

/**
 * Reads local File bytes only. The function contains no upload/fetch path; its
 * only runtime asset requests are same-origin PDF/OCR workers and OCR data.
 */
export async function importRecallDocuments(
  files: readonly LocalDocumentFile[],
  options: DocumentImportOptions = {},
): Promise<DocumentImportResult> {
  validateDocumentSelection(files);
  throwIfAborted(options.signal);

  const adapters: DocumentImportAdapters = { ...defaultAdapters, ...options.adapters };
  const onProgress = options.onProgress;
  const assets = resolveOcrAssetPaths(options.ocrAssets);
  const prepared = await prepareFiles(files, options.signal, onProgress);
  const plannedPhotoOcrPages = prepared.filter((source) => source.kind !== "pdf").length;
  if (plannedPhotoOcrPages > DOCUMENT_IMPORT_LIMITS.maxOcrPages) {
    throw new DocumentImportError("This selection exceeds the 10-page OCR limit.", "too-many-ocr-pages");
  }

  const candidates: DocumentImportCandidate[] = [];
  const summaries: DocumentImportSourceSummary[] = [];
  const warnings: string[] = [];
  let nativeTextPages = 0;
  let plannedOcrPages = plannedPhotoOcrPages;
  let completedOcrPages = 0;
  let worker: OcrWorkerLike | undefined;
  let activeOcrContext: { sourceName: string; pageNumber: number; rotation: DocumentRotation } | undefined;

  const emitOcrLog = (message: { status?: string; progress?: number }) => {
    onProgress?.({
      stage: "ocr",
      sourceName: activeOcrContext?.sourceName,
      pageNumber: activeOcrContext?.pageNumber,
      rotation: activeOcrContext?.rotation,
      completed: completedOcrPages,
      total: plannedOcrPages,
      fraction: message.progress,
      message: message.status ? `OCR: ${message.status}` : "Reading recall page",
    });
  };

  const getWorker = async (): Promise<OcrWorkerLike> => {
    throwIfAborted(options.signal);
    if (!worker) {
      onProgress?.({
        stage: "ocr-loading",
        completed: completedOcrPages,
        total: plannedOcrPages,
        message: "Opening the local OCR engine",
      });
      worker = await adapters.createOcrWorker(assets, emitOcrLog);
    }
    return worker;
  };

  const terminateOnAbort = () => {
    if (worker) void worker.terminate().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", terminateOnAbort, { once: true });

  try {
    for (const source of prepared) {
      throwIfAborted(options.signal);
      if (source.kind !== "pdf") {
        const lease = await adapters.decodeImage(source.bytes, mimeForKind(source.kind), options.signal);
        try {
          const ocrWorker = await getWorker();
          const result = await recognizeCanvasWithRotationFallback(lease.canvas, ocrWorker, {
            sourceName: source.file.name,
            sourceId: source.id,
            pageNumber: 1,
            signal: options.signal,
            rotateCanvas: adapters.rotateCanvas,
            onAttempt: (rotation) => {
              activeOcrContext = { sourceName: source.file.name, pageNumber: 1, rotation };
              onProgress?.({
                stage: "ocr",
                sourceName: source.file.name,
                pageNumber: 1,
                rotation,
                completed: completedOcrPages,
                total: plannedOcrPages,
                message: `Reading ${source.file.name} at ${rotation} degrees`,
              });
            },
          });
          candidates.push(...result.candidates);
          completedOcrPages += 1;
          if (!result.candidates.length) warnings.push(`No GTIN candidates were found in ${source.file.name}.`);
          summaries.push({
            name: source.file.name,
            kind: source.kind,
            pageCount: 1,
            nativeTextPages: 0,
            ocrPages: 1,
          });
        } finally {
          lease.release();
        }
        continue;
      }

      onProgress?.({
        stage: "pdf-loading",
        sourceName: source.file.name,
        completed: nativeTextPages,
        total: DOCUMENT_IMPORT_LIMITS.maxNativeTextPages,
        message: `Opening ${source.file.name} locally`,
      });
      const pdfjs = await adapters.loadPdfJs();
      pdfjs.GlobalWorkerOptions.workerSrc = sameOriginAssetUrl(pdfWorkerUrl);
      const loadingTask = pdfjs.getDocument({
        data: source.bytes.slice(),
        enableXfa: false,
        isEvalSupported: false,
        maxImageSize: DOCUMENT_IMPORT_LIMITS.maxImagePixels,
        canvasMaxAreaInBytes: DOCUMENT_IMPORT_LIMITS.maxCanvasPixels * 4,
        useWasm: false,
        disableRange: true,
        disableStream: true,
      });
      const abortLoading = () => void loadingTask.destroy();
      options.signal?.addEventListener("abort", abortLoading, { once: true });
      let pdf: PdfDocumentLike | undefined;
      try {
        pdf = await loadingTask.promise;
        throwIfAborted(options.signal);
        if (nativeTextPages + pdf.numPages > DOCUMENT_IMPORT_LIMITS.maxNativeTextPages) {
          throw new DocumentImportError(
            `PDF intake is limited to ${DOCUMENT_IMPORT_LIMITS.maxNativeTextPages} pages at one time.`,
            "too-many-pages",
          );
        }

        const pagesForOcr: number[] = [];
        let sourceNativeTextPages = 0;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          throwIfAborted(options.signal);
          onProgress?.({
            stage: "pdf-text",
            sourceName: source.file.name,
            pageNumber,
            completed: pageNumber - 1,
            total: pdf.numPages,
            message: `Reading PDF text on page ${pageNumber} of ${pdf.numPages}`,
          });
          const page = await pdf.getPage(pageNumber);
          try {
            const content = await page.getTextContent();
            const lines = groupPdfTextItems(content.items, pageNumber);
            const pageCandidates = extractGtinCandidates(lines, {
              sourceName: source.file.name,
              sourceId: source.id,
              extractionMethod: "pdf-text",
            });
            if (pageCandidates.some((candidate) => candidate.valid)) {
              candidates.push(...pageCandidates);
              sourceNativeTextPages += 1;
            } else {
              pagesForOcr.push(pageNumber);
            }
          } finally {
            page.cleanup?.();
          }
        }
        nativeTextPages += pdf.numPages;

        if (plannedOcrPages + pagesForOcr.length > DOCUMENT_IMPORT_LIMITS.maxOcrPages) {
          throw new DocumentImportError(
            `This document needs OCR on more than ${DOCUMENT_IMPORT_LIMITS.maxOcrPages} pages. Split it into smaller files or select fewer pages.`,
            "too-many-ocr-pages",
          );
        }
        plannedOcrPages += pagesForOcr.length;

        for (const pageNumber of pagesForOcr) {
          throwIfAborted(options.signal);
          onProgress?.({
            stage: "pdf-render",
            sourceName: source.file.name,
            pageNumber,
            completed: completedOcrPages,
            total: plannedOcrPages,
            message: `Preparing page ${pageNumber} for local OCR`,
          });
          const page = await pdf.getPage(pageNumber);
          try {
            const lease = await adapters.renderPdfPage(page, options.signal);
            try {
              const ocrWorker = await getWorker();
              const result = await recognizeCanvasWithRotationFallback(lease.canvas, ocrWorker, {
                sourceName: source.file.name,
                sourceId: source.id,
                pageNumber,
                signal: options.signal,
                rotateCanvas: adapters.rotateCanvas,
                onAttempt: (rotation) => {
                  activeOcrContext = { sourceName: source.file.name, pageNumber, rotation };
                  onProgress?.({
                    stage: "ocr",
                    sourceName: source.file.name,
                    pageNumber,
                    rotation,
                    completed: completedOcrPages,
                    total: plannedOcrPages,
                    message: `Reading page ${pageNumber} at ${rotation} degrees`,
                  });
                },
              });
              candidates.push(...result.candidates);
              completedOcrPages += 1;
              if (!result.candidates.length) {
                warnings.push(`No GTIN candidates were found on page ${pageNumber} of ${source.file.name}.`);
              }
            } finally {
              lease.release();
            }
          } finally {
            page.cleanup?.();
          }
        }

        summaries.push({
          name: source.file.name,
          kind: "pdf",
          pageCount: pdf.numPages,
          nativeTextPages: sourceNativeTextPages,
          ocrPages: pagesForOcr.length,
        });
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", abortLoading);
        if (pdf?.cleanup) await pdf.cleanup().catch(() => undefined);
        await Promise.resolve(loadingTask.destroy()).catch(() => undefined);
      }
    }

    const reviewedCandidates = markDuplicateCandidates(candidates);
    if (!reviewedCandidates.length) warnings.push("No UPC/GTIN candidates were found. Review the source before continuing.");
    onProgress?.({
      stage: "complete",
      completed: prepared.length,
      total: prepared.length,
      fraction: 1,
      message: `${reviewedCandidates.length} candidate rows are ready for staff review`,
    });
    return { candidates: reviewedCandidates, sources: summaries, warnings, requiresReview: true };
  } finally {
    options.signal?.removeEventListener("abort", terminateOnAbort);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}
