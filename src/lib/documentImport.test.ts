import { describe, expect, it, vi } from "vitest";

import {
  DocumentImportError,
  detectDocumentKind,
  extractGtinCandidates,
  groupPdfTextItems,
  importRecallDocuments,
  markDuplicateCandidates,
  parseOcrTsv,
  recognizeCanvasWithRotationFallback,
  validateDocumentSelection,
  type DocumentImportCandidate,
  type DocumentTextLine,
  type OcrWorkerLike,
} from "./documentImport";

function tsv(text: string, confidence = 90): string {
  const words = text.split(" ");
  return [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    ...words.map((word, index) =>
      [5, 1, 1, 1, 1, index + 1, 10 + index * 90, 20, 80, 20, confidence, word].join("\t"),
    ),
  ].join("\n");
}

function candidate(id: string, barcode: string): DocumentImportCandidate {
  return extractGtinCandidates(
    [{ pageNumber: 1, lineNumber: 1, text: barcode }],
    { sourceName: id, extractionMethod: "pdf-text" },
  )[0];
}

describe("assisted document import parsers", () => {
  it("detects supported file signatures instead of trusting extensions", () => {
    expect(detectDocumentKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("pdf");
    expect(detectDocumentKind(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("jpeg");
    expect(detectDocumentKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(detectDocumentKind(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]))).toBe("webp");
    expect(detectDocumentKind(new TextEncoder().encode("not a document"))).toBeNull();
  });

  it("groups PDF text by y coordinate and restores left-to-right row order", () => {
    const lines = groupPdfTextItems([
      { str: "Frame A", transform: [1, 0, 0, 1, 120, 700], width: 50, height: 10 },
      { str: "036000291452", transform: [1, 0, 0, 1, 10, 701], width: 90, height: 10 },
      { str: "Frame B", transform: [1, 0, 0, 1, 120, 650], width: 50, height: 10 },
      { str: "4006381333931", transform: [1, 0, 0, 1, 10, 650], width: 95, height: 10 },
    ], 2);

    expect(lines.map((line) => line.text)).toEqual([
      "036000291452 Frame A",
      "4006381333931 Frame B",
    ]);
    expect(lines[0].boundingBox).toEqual({ x0: 10, y0: 700, x1: 170, y1: 711 });
  });

  it("returns valid and invalid editable candidates without OCR character substitutions", () => {
    const lines: DocumentTextLine[] = [{
      pageNumber: 3,
      lineNumber: 7,
      text: "036000291452 Peahi O36000291452 036000291453",
      confidence: 87,
    }];
    const candidates = extractGtinCandidates(lines, {
      sourceName: "recall.pdf",
      extractionMethod: "ocr",
      rotation: 90,
    });

    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      rawBarcode: "036000291452",
      normalizedBarcode: "036000291452",
      valid: true,
      pageNumber: 3,
      confidence: 87,
      reviewStatus: "pending",
      editable: true,
    });
    expect(candidates[1]).toMatchObject({
      rawBarcode: "36000291452",
      valid: false,
      invalidReason: "unsupported-length",
    });
    expect(candidates[2]).toMatchObject({
      rawBarcode: "036000291453",
      valid: false,
      invalidReason: "bad-check-digit",
    });
    expect(candidates.some((entry) => entry.rawBarcode.includes("O"))).toBe(false);
  });

  it("parses Tesseract TSV words into bounded lines with weighted confidence", () => {
    const lines = parseOcrTsv(tsv("036000291452 Peahi", 92), 4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      pageNumber: 4,
      lineNumber: 1,
      text: "036000291452 Peahi",
      confidence: 92,
      boundingBox: { x0: 10, y0: 20, x1: 180, y1: 40 },
    });
  });

  it("flags canonical GTIN duplicates while keeping every candidate editable", () => {
    const first = candidate("one", "036000291452");
    const equivalent = candidate("two", "0036000291452");
    const marked = markDuplicateCandidates([first, equivalent]);
    expect(marked[0].isDuplicate).toBe(false);
    expect(marked[1]).toMatchObject({ isDuplicate: true, duplicateOf: marked[0].id });
  });

  it("enforces the five-photo and 25 MB intake limits before decoding", () => {
    const photo = (index: number, size = 10) => ({
      name: `photo-${index}.jpg`,
      type: "image/jpeg",
      size,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(() => validateDocumentSelection(Array.from({ length: 6 }, (_, index) => photo(index))))
      .toThrowError(DocumentImportError);
    expect(() => validateDocumentSelection([photo(1, 25 * 1024 * 1024 + 1)]))
      .toThrow(/25 MB/);
  });

  it("runs a mocked local photo import and always releases its worker and canvas", async () => {
    const release = vi.fn();
    const terminate = vi.fn(async () => undefined);
    const worker: OcrWorkerLike = {
      recognize: vi.fn(async () => ({ data: { tsv: tsv("036000291452 Peahi") } })),
      setParameters: vi.fn(async () => undefined),
      terminate,
    };
    const result = await importRecallDocuments([{
      name: "recall.jpg",
      type: "image/jpeg",
      size: 3,
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    }], {
      adapters: {
        decodeImage: vi.fn(async () => ({
          canvas: { width: 100, height: 50 } as HTMLCanvasElement,
          release,
        })),
        createOcrWorker: vi.fn(async () => worker),
      },
    });

    expect(result.requiresReview).toBe(true);
    expect(result.candidates[0]).toMatchObject({ valid: true, rawBarcode: "036000291452" });
    expect(release).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("reads native PDF text and destroys the loading task with PDF.js 6", async () => {
    const pageCleanup = vi.fn();
    const documentCleanup = vi.fn(async () => undefined);
    const loadingDestroy = vi.fn(async () => undefined);
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getTextContent: vi.fn(async () => ({
          items: [
            { str: "036000291452", transform: [1, 0, 0, 1, 10, 700] },
            { str: "Peahi", transform: [1, 0, 0, 1, 120, 700] },
          ],
        })),
        getViewport: vi.fn(() => ({ width: 100, height: 100 })),
        render: vi.fn(),
        cleanup: pageCleanup,
      })),
      cleanup: documentCleanup,
    };
    const loadingTask = { promise: Promise.resolve(pdf), destroy: loadingDestroy };
    const result = await importRecallDocuments([{
      name: "recall.pdf",
      type: "application/pdf",
      size: 5,
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer,
    }], {
      adapters: {
        loadPdfJs: vi.fn(async () => ({
          GlobalWorkerOptions: { workerSrc: "" },
          getDocument: vi.fn(() => loadingTask),
        })),
      },
    });

    expect(result.candidates[0]).toMatchObject({
      rawBarcode: "036000291452",
      description: "Peahi",
      extractionMethod: "pdf-text",
    });
    expect(pageCleanup).toHaveBeenCalledOnce();
    expect(documentCleanup).toHaveBeenCalledOnce();
    expect(loadingDestroy).toHaveBeenCalledOnce();
  });
});

describe("OCR rotation fallback", () => {
  it("tries 0 then 90 degrees and stops when a valid GTIN is found", async () => {
    const recognize = vi
      .fn<OcrWorkerLike["recognize"]>()
      .mockResolvedValueOnce({ data: { tsv: tsv("036000291453 Bad") } })
      .mockResolvedValueOnce({ data: { tsv: tsv("036000291452 Peahi") } });
    const worker: OcrWorkerLike = { recognize, terminate: vi.fn(async () => undefined) };
    const source = { width: 100, height: 50 } as HTMLCanvasElement;
    const rotated = { width: 50, height: 100 } as HTMLCanvasElement;
    const rotate = vi.fn<(
      canvas: HTMLCanvasElement,
      rotation: 90 | 270,
    ) => HTMLCanvasElement>(() => rotated);

    const result = await recognizeCanvasWithRotationFallback(source, worker, {
      sourceName: "photo.jpg",
      pageNumber: 1,
      rotateCanvas: rotate,
    });

    expect(result.rotation).toBe(90);
    expect(result.attemptedRotations).toEqual([0, 90]);
    expect(result.candidates[0]).toMatchObject({ valid: true, rawBarcode: "036000291452" });
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(rotate).toHaveBeenCalledWith(source, 90);
  });

  it("attempts 0, 90, and 270 when no rotation yields a valid GTIN", async () => {
    const recognize = vi.fn<OcrWorkerLike["recognize"]>()
      .mockResolvedValue({ data: { text: "No valid barcode here", confidence: 40 } });
    const worker: OcrWorkerLike = { recognize, terminate: vi.fn(async () => undefined) };
    const source = { width: 100, height: 50 } as HTMLCanvasElement;
    const rotate = vi.fn<(
      canvas: HTMLCanvasElement,
      rotation: 90 | 270,
    ) => HTMLCanvasElement>(() => ({ width: 50, height: 100 }) as HTMLCanvasElement);

    const result = await recognizeCanvasWithRotationFallback(source, worker, {
      sourceName: "photo.jpg",
      pageNumber: 1,
      rotateCanvas: rotate,
    });

    expect(result.attemptedRotations).toEqual([0, 90, 270]);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(rotate.mock.calls.map((call) => call[1])).toEqual([90, 270]);
  });

  it("honors an AbortSignal before invoking OCR", async () => {
    const controller = new AbortController();
    controller.abort();
    const recognize = vi.fn<OcrWorkerLike["recognize"]>();
    const worker: OcrWorkerLike = { recognize, terminate: vi.fn(async () => undefined) };

    await expect(recognizeCanvasWithRotationFallback(
      { width: 1, height: 1 } as HTMLCanvasElement,
      worker,
      { sourceName: "photo.jpg", pageNumber: 1, signal: controller.signal },
    )).rejects.toMatchObject({ code: "aborted" });
    expect(recognize).not.toHaveBeenCalled();
  });
});
