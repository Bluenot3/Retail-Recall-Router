# Retail Recall Router

Retail Recall Router is a fast, local-first optical frame recall scanner for retail teams. Import a recall list, scan UPC barcodes at full counter speed, and get an immediate decision:

- **Green — KEEP / RECALL:** set the frame aside and cross it off the recall list.
- **Red — LEAVE:** the scanned frame is not on the active recall list.
- **Orange — SCAN AGAIN:** the scan is incomplete or cannot be read safely.

Progress saves automatically on the device. Staff can stop, resume, archive completed recalls, and export records without entering scan results by hand.

## Operating model

Version 1 is intentionally lightweight: it is a **one-device-per-store, local-first application**. Each retail location should use one dedicated workstation or browser profile for recall work. There is no cloud account, central database, or cross-store live sync.

That boundary keeps setup simple and lets scanning continue during an internet outage, but it also means:

- recall lists, scan history, and archives belong to that browser profile and website address;
- a backup must be downloaded before moving to another device, clearing browser data, or changing the deployed website address; and
- another store does not automatically see this store's records.

The default location is **Philadelphia, PA** and can be changed for each recall so the same build can be used at other retail locations.

## Supported recall lists

Import `.csv`, `.tsv`, `.xlsx`, or `.xls` files, paste rows, or use product-only PDFs and clear `.jpg`, `.png`, or `.webp` photos. A downloadable starter file is included at [`public/recall-list-template.csv`](public/recall-list-template.csv).

PDF/photo reading runs locally in the browser. Every detected UPC and description remains editable and must be compared with the source before it can be added; the app never silently trusts OCR. Document files are limited to 25 MB each, five photos per batch, and ten OCR pages per batch. The first document-reading session needs the locally hosted OCR assets to load; the service worker caches successful same-origin requests for later offline use.

The importer is designed to recognize common optical-list headings such as:

- UPC, GTIN, barcode, or SKU
- brand or manufacturer
- model, style, or frame
- color
- description
- quantity
- notes

Review the detected barcode column and row count before starting a recall. Keep UPC/GTIN columns formatted as text in spreadsheets whenever possible so leading zeros are not removed. The application normalizes scanner punctuation and whitespace, but it does not guess a materially incomplete barcode.

## Daily scanner workflow

1. Create a recall and enter the brand, recall/reference name, and store location.
2. Upload the recall file, confirm the mapped fields, and check duplicates or skipped rows.
3. Open the active recall and click or tap the scan field once.
4. Scan continuously. Most USB and Bluetooth scanners act like a keyboard and submit each barcode with Enter.
5. Put green results in the recall bin, leave red results in place, and rescan orange results.
6. Watch the remaining count fall as recall quantities are satisfied. Every repeated matching physical frame stays green and is logged as another recall piece; the unique list row is crossed off only when its required quantity is met.
7. Download a backup and the required PDF/CSV report, then archive the completed recall.

If a source list is corrected after scanning starts, choose **Manage list**. The app pauses scanning, compares the addendum against current UPCs, skips duplicates, and shows the exact number of new rows before confirmation. Staff can also add one missing frame manually or correct product details. Existing scan records, found quantities, and history are preserved.

The scan field returns to focus after every result, so staff do not need to touch the mouse between frames.

## Saving, backup, restore, and exports

The app saves recalls and scan activity automatically in the browser's IndexedDB storage. This survives a normal refresh, browser restart, and device restart. It does **not** survive browser-data deletion or every device failure.

- **Backup** downloads a complete JSON recovery file for the local recall library.
- **Restore** imports a previously downloaded Retail Recall Router backup.
- **CSV export** provides row-level recall and scan data for office follow-up.
- **PDF / print** creates a staff-friendly completion report using the browser's Save as PDF option.
- **Archive** removes a recall from the active work queue without deleting its record.

Download a backup after each recall session and before browser maintenance, workstation replacement, or deployment changes. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the store procedure.

## Local development

Requirements:

- Node.js 20 or newer
- pnpm 11

Install and run:

```powershell
pnpm install
pnpm dev
```

Quality checks:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Preview the production build:

```powershell
pnpm preview
```

## Production deployment

Run `pnpm build` and publish the generated `dist` directory as a static website. The build copies the OCR worker, WebAssembly cores, and English model from installed packages into same-origin static assets; no CDN is required at runtime. Use HTTPS for a normal production domain. The manual service worker and web app manifest provide offline app-shell support after the first successful visit.

The repository intentionally contains no live recall lists or scan progress. Import recall files through the application and keep local working documents in the ignored `local-data/` or `uploads/` folders.

Keep the deployment URL stable. Changing the protocol, hostname, subdomain, or port creates a different browser-storage boundary. Before any URL change, export a complete backup and verify restoration on the new URL.

The release owner should complete [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md), including a real scanner test, offline restart test, backup/restore drill, and report review.

## Data and privacy boundary

Retail Recall Router is for product recall inventory data only. **Do not enter patient names, dates of birth, contact information, prescription information, insurance information, or other PHI.** The application is not a patient-record system and does not claim HIPAA compliance.

Recall files and backups can contain internal inventory or operational information. Store them only in company-approved locations and follow company retention policy.

## Browser support

Use a current version of Microsoft Edge or Google Chrome on the dedicated store device. Confirm the barcode scanner is configured to send an Enter suffix. Safari and Firefox may work, but the production hardware checklist should be completed in the exact browser used by staff.

## Documentation

- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — store setup, scanning, backup, recovery, and troubleshooting
- [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) — pre-release and deployment gates
