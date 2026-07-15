# Retail Recall Router operations guide

This guide is the standard store procedure for a dedicated Retail Recall Router workstation. It assumes staff use a USB or Bluetooth barcode scanner that acts like a keyboard.

## 1. Set up a store workstation

1. Choose one store-owned workstation and one dedicated Edge or Chrome browser profile.
2. Open the approved Retail Recall Router website and, if offered, install it as an app.
3. Set the store name and location. New installations default to Philadelphia, PA.
4. Connect the scanner and confirm it sends an Enter suffix after every barcode.
5. Scan a known UPC into a plain text field to confirm the digits arrive once, in order, with no extra prefix.
6. Create a training recall with two sample UPCs. Confirm one green match, one red non-match, one orange short/incomplete scan, and one duplicate match.
7. Download a backup, restore it, and confirm the training recall and its counts return.
8. Delete or archive the training recall before live work.

Use the same browser profile every time. Private/InPrivate windows are not approved for live recall work because their local data can be removed when the window closes.

## 2. Prepare a recall list

Accepted file types are CSV, TSV, XLSX, XLS, PDF, JPG, PNG, and WebP; rows can also be pasted. The minimum useful field is a barcode identifier such as UPC or GTIN. Brand, model/style, color, description, quantity, and notes improve staff confirmation and reports.

Before importing:

- Save a copy of the original recall document in the company-approved recall folder.
- Use clear, straight-on photos with the complete table visible. Multiple photos should cover separate pages, not overlapping copies of the same rows.
- Format UPC and GTIN spreadsheet cells as text to preserve leading zeros.
- Remove totals, section headings, blank lines, and instructions from the item table when practical.
- Do not add patient information or other PHI.

The import review must show the expected number of unique recall identifiers. For PDFs and photos, compare every editable candidate to the source and complete the required review checkbox. Investigate skipped rows, missing identifiers, and duplicate identifiers before activation. Do not start scanning if the imported count cannot be reconciled to the source list. Files must contain product information only—never patient information or PHI.

## 3. Create and activate a recall

1. Select **New recall**.
2. Enter the manufacturer/brand, official recall or RA reference, store location, and a clear internal name.
3. Upload the recall list.
4. Confirm the detected sheet for an Excel workbook.
5. Confirm the identifier, brand, model/style, color, quantity, and notes mappings.
6. Review valid, duplicate, and skipped row counts.
7. Activate only after the source total and imported unique count are understood.

### Correct a list already in progress

1. Choose **Manage list**. The app pauses the recall before any list change.
2. Upload or paste the addendum, or select **Add one frame** for a manual row.
3. Compare the preview: new UPCs will be added and existing UPCs will be skipped.
4. Confirm only after the new-row count matches the source.
5. Choose **Done**, then **Resume** scanning.

Adding rows never resets existing scans, quantities found, or history. A UPC scanned earlier as red remains a historical red scan; scan the physical frame again after adding it. Completed and archived recalls are read-only.

Use one active recall at a time at a scanning station. If multiple brand recalls are open, staff must confirm the correct active recall before scanning.

## 4. Scan at high volume

1. Open the active recall and place the cursor in the scan field once.
2. Scan one frame barcode at a time. Do not hold the scanner trigger while moving across multiple labels.
3. Follow the full-screen decision:
   - **Green — KEEP / RECALL:** place the frame in the recall bin. Its unique item is crossed off and the remaining count decreases.
   - **Red — LEAVE:** return the frame to its correct board or cabinet position.
   - **Orange — SCAN AGAIN:** scan the same barcode again. If it repeats, inspect the label and use the store's recall escalation process.
4. Continue scanning without clicking between results. The field should automatically regain focus.
5. If a recalled UPC is scanned again, confirm the duplicate message. A duplicate does not lower the remaining count twice.
6. Pause if the active recall name, store location, starting count, or remaining count looks wrong.

Keep sound on if the device uses audible decision tones, but use the screen color and written instruction as the authoritative result. Color is never the only cue.

## 5. Pause and resume safely

Progress saves after every accepted scan. Before a long pause or end of shift:

1. Confirm the latest scan appears in activity history.
2. Note the remaining count.
3. Select **Download backup** and save the file in the approved recall folder.
4. Leave the recall active if work will continue; archive only when the operational task is complete.
5. Close the app normally. Do not clear site data.

On return, open the same website in the same browser profile and verify the recall name, matched count, remaining count, and last scan before continuing.

## 6. Complete and archive

When the remaining count reaches zero—or a manager has documented why specific items could not be found:

1. Review unmatched items and scan exceptions.
2. Enter any allowed product-only completion notes.
3. Export the detailed CSV.
4. Print or save the completion report as PDF.
5. Download a full backup.
6. Save exports to the approved recall folder using a clear name such as `2026-07-15_brand_recall-reference_philadelphia`.
7. Archive the recall. Archiving preserves the record and removes it from the active queue.

Never delete a live or recently completed recall until required exports are verified and company retention rules permit deletion.

## 7. Backup and restore

### Backup schedule

Download a complete backup:

- at the end of every scanning session;
- before browser updates or workstation maintenance;
- before changing the website URL;
- before clearing browser/site data;
- before moving to a replacement workstation; and
- after archiving a completed recall.

### Restore drill

1. Open Retail Recall Router on the intended device and website address.
2. Select **Restore backup** and choose the most recent `.json` recovery file.
3. Review the backup date, recall count, scan count, and conflict warning shown before confirmation.
4. Restore and verify at least one active recall, one archived recall, the remaining count, and recent scan history.
5. Download a fresh backup after the restore is confirmed.

Restoring keeps unrelated local campaigns. If the same campaign ID is already on the device, the confirmation warns that the complete local campaign snapshot will be replaced by the backup version so item counts and scan history cannot be mixed.

## 8. Moving devices or changing the website address

Browser storage does not follow the user automatically.

1. Stop scanning on the old device.
2. Download a complete backup and required recall reports.
3. Open the approved website on the new device or URL.
4. Restore the backup.
5. Verify all active recall counts and the last five scans.
6. Perform one controlled test scan.
7. Resume live scanning only after verification.

Keep the old device and backup untouched until the new installation is confirmed.

## 9. Troubleshooting

### A scan produces no result

- Click the scan field and try once more.
- Confirm the scanner still types into a plain text field.
- Confirm the scanner sends Enter after the code.
- Disconnect and reconnect the scanner only after confirming the last scan was saved.

### Every scan is red

- Confirm the correct recall is active.
- Compare the displayed scan digits with the recall file.
- Check whether the source file lost leading zeros.
- Check whether the scanner adds a prefix or suffix other than Enter.
- Stop and escalate if the imported list count or barcode format is wrong.

### Scans are orange

- Hold the label flat and rescan.
- Clean the scanner window and inspect the barcode for damage.
- Confirm the scan is a supported UPC/GTIN-style identifier rather than a serial number.
- Do not manually guess missing digits.

### Progress appears missing

- Confirm the exact website address, browser, and browser profile.
- Do not create a new recall with the same name as a substitute.
- Locate the most recent backup and follow the restore procedure.
- Preserve the current device and browser data until recovery is complete.

### The app is offline

- If it was previously installed or opened successfully, reload once and use the cached app shell.
- Scanning and local saving should continue without internet.
- Export a backup when possible.
- Report the outage; do not clear the cache or reinstall during a live recall.

## 10. Data boundary

Retail Recall Router is limited to frame-product and store-operation information. Never enter patient names, contact details, dates of birth, prescriptions, insurance data, appointment data, or other PHI.

Backups and exports remain company information. Store, transmit, retain, and delete them only through company-approved processes.
