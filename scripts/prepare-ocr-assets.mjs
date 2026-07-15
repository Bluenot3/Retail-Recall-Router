import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tesseractRoot = path.dirname(require.resolve("tesseract.js/package.json"));
const tesseractRequire = createRequire(path.join(tesseractRoot, "package.json"));
const coreRoot = path.dirname(tesseractRequire.resolve("tesseract.js-core/package.json"));
const languageRoot = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
const outputRoot = path.join(root, "public", "ocr");
const coreOutput = path.join(outputRoot, "core");
const languageOutput = path.join(outputRoot, "lang");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(coreOutput, { recursive: true });
await mkdir(languageOutput, { recursive: true });

await copyFile(
  path.join(tesseractRoot, "dist", "worker.min.js"),
  path.join(outputRoot, "worker.min.js"),
);

const coreFiles = (await readdir(coreRoot)).filter(
  (name) => /^tesseract-core(?:-[a-z]+)*\.wasm\.js$/i.test(name),
);
if (!coreFiles.length) throw new Error("Tesseract OCR core assets were not found.");
await Promise.all(
  coreFiles.map((name) => copyFile(path.join(coreRoot, name), path.join(coreOutput, name))),
);

await copyFile(
  path.join(languageRoot, "4.0.0_best_int", "eng.traineddata.gz"),
  path.join(languageOutput, "eng.traineddata.gz"),
);

console.log(`Prepared local OCR assets (${coreFiles.length} core variants).`);
