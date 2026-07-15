# Retail Recall Router release checklist

Complete every applicable item before staff use a new production release. Record the release version, date, reviewer, deployment URL, test store/location, browser version, and scanner model with the release evidence.

## Release identity

- [ ] Version and release date are visible in the release record.
- [ ] Production deployment URL is approved and will remain stable.
- [ ] Philadelphia, PA is the default location and can be changed per recall.
- [ ] No live recall lists, scan logs, local progress, backups, or exports are committed.
- [ ] User-facing changes are summarized for store staff.

## Build and automated checks

- [ ] Dependency install completes from a clean checkout.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] The production bundle opens with no console errors.
- [ ] Source maps are handled according to deployment policy.

## Recall-list import

- [ ] CSV import is verified with quoted commas, blank rows, duplicate identifiers, and leading-zero UPCs.
- [ ] TSV import is verified.
- [ ] XLSX import is verified with multiple sheets and a user-selected sheet.
- [ ] XLS import is verified or explicitly blocked with a clear message.
- [ ] Common identifier headings (UPC, GTIN, barcode, SKU) are detected.
- [ ] Brand, model/style, color, description, quantity, and notes can be mapped.
- [ ] Import review shows valid, duplicate, skipped, and unique-item counts.
- [ ] Empty files, unsupported files, and missing identifier columns fail safely.
- [ ] Spreadsheet numeric/scientific-notation identifiers do not produce silent false matches.
- [ ] A recall cannot activate until its mapping and counts are confirmed.
- [ ] PDF native-text extraction is verified and falls back safely when text is unavailable.
- [ ] JPG, PNG, and WebP OCR candidates remain editable and cannot be committed before source review.
- [ ] Photo/PDF intake sends no document bytes to a remote service.
- [ ] File, photo-count, page-count, image-size, and OCR-page limits fail with clear messages.
- [ ] A paused recall accepts an addendum, skips existing UPCs, and preserves all prior scans and found counts.
- [ ] Manual add rejects an invalid or duplicate UPC without partial changes.

## High-volume scan engine

- [ ] A real hardware scanner is configured with an Enter suffix.
- [ ] A recalled UPC produces a green KEEP / RECALL decision and reduces remaining by one.
- [ ] A non-recalled UPC produces a red LEAVE decision and does not change remaining.
- [ ] A malformed or incomplete scan produces an orange SCAN AGAIN decision.
- [ ] Written instructions and icons accompany color decisions.
- [ ] A duplicate recalled scan stays green, is labeled already found, and does not decrement twice.
- [ ] Input focus returns automatically after green, red, orange, and duplicate results.
- [ ] 100 mixed scans can be completed without pointer or keyboard intervention between scans.
- [ ] Rapid repeated Enter keys do not create blank scan events.
- [ ] Matching is exact after documented normalization; substring and fuzzy matches are rejected.
- [ ] Scan activity records time, normalized identifier, result, recall, and duplicate status.
- [ ] Counts remain correct after refresh, browser restart, and device restart.

## Local data and archives

- [ ] Active recalls, items, and scans persist in IndexedDB.
- [ ] The app clearly states that data belongs to one device/browser profile and origin.
- [ ] Multiple recalls can be saved without mixing items or scan history.
- [ ] Active, completed, and archived recalls are distinguishable.
- [ ] Archiving preserves recall details and exports.
- [ ] Delete requires a clear destructive confirmation and cannot happen from the scan input.
- [ ] Browser quota and storage errors show an actionable stop message.
- [ ] Private/InPrivate browsing is discouraged for production use.

## Backup, restore, and exports

- [ ] Full JSON backup includes settings, recall metadata, items, scan history, status, and archive state.
- [ ] Backup schema/version is recorded and validated before restore.
- [ ] Restore preview shows backup date, location, recall count, and scan count.
- [ ] Corrupt, wrong-format, and future-version backups fail without altering current data.
- [ ] Restore merge/replace behavior is explicit and tested.
- [ ] CSV export opens correctly in Excel with leading-zero identifiers preserved.
- [ ] Print/Save as PDF includes recall identity, store, totals, unmatched items, exceptions, and completion time.
- [ ] Export filenames are useful and contain no PHI.
- [ ] A backup/restore drill succeeds on a clean browser profile.

## Progressive web app and offline behavior

- [ ] Manifest name, icons, theme, start URL, and scope are valid on the production path.
- [ ] Service worker installs after the first successful online load.
- [ ] A new release activates predictably and old caches are removed.
- [ ] The app shell opens offline after a prior successful visit.
- [ ] An active recall can be scanned, saved, and exported while offline.
- [ ] Returning online does not overwrite or duplicate local data.
- [ ] Install-to-desktop behavior is verified in the production browser.

## Usability and accessibility

- [ ] A staff member unfamiliar with the app can import, scan, pause, resume, export, and archive using the operations guide.
- [ ] The active recall name, brand, store, matched count, and remaining count are always visible while scanning.
- [ ] Critical buttons have clear labels and sufficiently large targets.
- [ ] Keyboard-only navigation is complete and focus is visible.
- [ ] Screen-reader labels identify inputs, status changes, and action buttons.
- [ ] Green/red/orange contrast meets accessibility requirements.
- [ ] Color is never the only indicator of scan result.
- [ ] The layout is usable at common retail workstation resolutions and 200% zoom.
- [ ] Accidental browser back/reload behavior does not silently lose progress.

## Security, privacy, and operational boundary

- [ ] The application collects no patient data and displays a clear no-PHI boundary.
- [ ] No analytics, error reporting, or remote requests transmit recall data without approval.
- [ ] Production uses HTTPS except an explicitly controlled localhost migration.
- [ ] Dependencies have been reviewed for known production-impacting vulnerabilities.
- [ ] Content Security Policy and hosting headers are configured for the deployment.
- [ ] Backups and exports follow company storage and retention policy.
- [ ] One-device-per-store limitations and lack of live cross-store sync are documented for staff.

## Store acceptance

- [ ] Test store and device are recorded.
- [ ] Scanner model and configuration are recorded.
- [ ] Store manager completes a controlled recall from import through archive.
- [ ] Store manager confirms green means set aside and red means leave.
- [ ] Store manager completes a backup and knows where it is stored.
- [ ] Store manager can restore a backup or knows the approved escalation path.
- [ ] Support owner and escalation route are communicated.
- [ ] Final release approval is recorded before live scanning.
