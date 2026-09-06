# Google Sheet export — design

## Purpose

Add a manual "Save to Sheet" action per outlet that pushes that
outlet's full scan history into a pre-created Google Sheet, formatted
and sorted for easy human reading — separate from the existing
silent, automatic Drive JSON sync (`api/outlet.js`,
`tutupkedai-data.json`) that stays the source of truth for the app
itself.

## Constraints carried over from the existing Drive integration

- Service account has zero Drive storage quota of its own. It can
  **update** a file it doesn't own but cannot **create** a new one in
  a personal (non-Workspace) Drive folder — fails with
  `storageQuotaExceeded`. Confirmed true for plain files; Sheets are
  Drive files too, so the same wall applies.
- Consequence: the app cannot auto-create a Sheet on first use. Each
  outlet's Sheet must be pre-created once, by hand or via a one-off
  script (see below), before the button works for that outlet.
- No new npm dependency (`googleapis` etc.) — extend the existing
  hand-rolled REST + JWT pattern in `api/outlet.js` rather than adding
  an SDK, per project's no-build-creep rule.

## Trigger

New "Save to Sheet" button in the outlet screen, next to the existing
`Export CSV` / `Export PDF` buttons (`index.html` ~line 322-323).
Manual click only — does not hook into the existing automatic
`syncOutletToDrive` calls that fire on every scan/edit/delete.

## Data flow

1. User clicks "Save to Sheet" → `syncOutletToSheet(code)` in
   `index.html`.
2. `POST /api/sheet?code=<code>` with `{ config, scanHistory }` — same
   payload shape already sent to `api/outlet.js`.
3. New serverless function `api/sheet.js`:
   - Reuses the same service-account JWT auth as `api/outlet.js`, but
     the token's `scope` claim gains `https://www.googleapis.com/auth/spreadsheets`
     alongside the existing `https://www.googleapis.com/auth/drive`.
   - Looks up a Sheet named **exactly the outlet code** (e.g. `AJ`)
     inside `GOOGLE_DRIVE_FOLDER_ID`, `mimeType = application/vnd.google-apps.spreadsheet`.
   - If not found: `503` with an instruction message (mirrors the
     `tutupkedai-data.json`-missing message in `api/outlet.js`) telling
     a human to create a Sheet with that exact name in the folder and
     share it with the service account as Editor.
   - If found: builds the row data (see Layout below) and writes it
     with `spreadsheets.values.update` (`valueInputOption=USER_ENTERED`,
     overwriting the whole sheet range each call — no incremental
     diffing, no stale-row risk), then applies formatting with a
     single `spreadsheets.batchUpdate` call.
4. Frontend flips the existing sync tag (`setSyncTag`) to `busy` /
   `ok` / `err` around the call, same UX as the current Drive sync
   indicator. On error, nothing local changes — `tk_data_<code>` and
   `tutupkedai-data.json` remain canonical; the Sheet is a read-facing
   projection only.

## Sheet layout

Header row (row 1, frozen, bold, shaded fill):

```
# | Date | Bill Total | Digital Total | Transfer | Grab | iPay | Master | Misi | QRPay | Visa | Voucher | Net Bank Deposit
```

- One data row per `scanHistory` entry.
- **Sort order:** by `date` ascending; ties broken by original array
  index (preserves scan order within a day, which matters for the
  daily-summary grouping below). Oldest at top, newest at bottom.
- **Net Bank Deposit** per row = `totalCount − digitalSum − currentFloatAmount`,
  using the outlet's *current* configured float (`config.floatAmount`)
  — the app has no per-receipt historical float value stored, so this
  matches what the on-screen log already shows; not a new limitation.
- **Date column merge:** after sorting, walk rows top to bottom;
  consecutive rows sharing the same `date` are merged into a single
  vertically-centered cell via a `mergeCells` request per run, so the
  date isn't repeated on every receipt row of the same day.
- **Daily Summary row:** inserted every `bundleSize` receipt rows
  (`bundleSize = config.posCount * 2`, same as the on-screen "Daily
  Summary (Receipts N-M)" block at `index.html:1222-1245`) — merged
  across all columns, shaded distinctly from data rows, showing:
  `Total Sales | Total Cash (Net, after float) | Digital Total | per-category breakdown string`.
  Uses the same math as `updateFields()`'s existing daily-summary
  block.
- **Formatting** (one `batchUpdate`): freeze row 1; bold header;
  number format `"RM"#,##0.00` on all money columns; distinct
  background fill on summary rows; auto-resize all columns.

## One-time setup (outside the app)

`scripts/create-outlet-sheets.js` — throwaway Node script, run once by
the project owner under their **own** Google login (OAuth installed-app
flow, not the service account):

- Creates one Google Sheet per outlet code (all 50, from the same
  `VALID_CODES` list in `api/outlet.js`) in the shared Drive folder,
  named exactly by outlet code.
- Shares each with the service account email as **Editor** (not just
  Viewer — Sheets API writes require edit access).
- Not deployed, not imported by the app; deleted or archived after the
  one-time run.

## Error handling

- `api/sheet.js` mirrors `api/outlet.js`'s error shape: `400` invalid
  outlet code, `503` Sheet-not-found-in-folder (with the create/share
  instruction), `500` + server-side `console.error` on any Sheets API
  failure (auth, write, or format call).
- Frontend: sync tag → `err`; no retry loop, no local data mutation.
  User can just click the button again once the underlying issue
  (missing Sheet, missing share, transient API error) is fixed.

## Testing

- Serve locally (`npx serve .` — OCR/service worker need `http(s)://`).
- Pre-create one real Sheet for a test outlet code, share it with the
  service account.
- Click "Save to Sheet", then verify directly in the Google Sheet:
  rows sorted by date, date-column merges correct, daily summary rows
  appear every `bundleSize` receipts with correct totals, currency
  formatting applied, header frozen — cross-checked by eye against
  that outlet's on-screen Receipt Log.
- Check Vercel function logs / browser network tab for `api/sheet.js`
  errors (missing Sheet, auth scope, malformed payload).

## Explicitly out of scope

- No auto-creation of Sheets (blocked by Drive quota — see
  Constraints).
- No hook into the existing automatic `syncOutletToDrive` flow — this
  is a separate, manual, per-outlet action.
- No combined/all-outlets sheet, no per-outlet tabs in one file —
  one Sheet file per outlet, matching the per-outlet JSON sync model.
- No historical float tracking — deposit figures use the outlet's
  current float setting, same as the app's own on-screen calculations.
