# Google Sheet Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Save to Sheet" button per outlet that writes that outlet's full scan history into a pre-created Google Sheet, sorted by date, with a merged date column, interspersed daily-summary rows, and currency formatting.

**Architecture:** Extend the existing hand-rolled service-account REST pattern (`api/outlet.js`) with a new endpoint `api/sheet.js`. Shared JWT auth and the outlet-code list move into `api/lib/` so both endpoints use one copy. A pure, unit-tested module (`api/lib/sheetRows.js`) turns `{config, scanHistory}` into sheet rows + formatting metadata, kept separate from the network I/O so it's testable without live Google credentials.

**Tech Stack:** Vanilla JS PWA frontend, Vercel serverless functions (Node ≥18, no framework), Google Drive API v3 + Google Sheets API v4 via raw `fetch` (no `googleapis` SDK), Node's built-in `node:test` runner for the one pure-logic module.

**Spec:** `docs/superpowers/specs/2026-09-06-google-sheet-export-design.md`

## Global Constraints

- No new npm dependency — Node ≥18 built-ins only (global `fetch`, `node:test`, `node:assert/strict`, `crypto`, `http`). `node:test` is a built-in test runner, not a dependency.
- Service account cannot create new Drive files in the personal folder (`storageQuotaExceeded`) — every outlet's Sheet must already exist, named exactly by outlet code, and shared with the service account as **Editor**, before `api/sheet.js` can write to it.
- `VALID_CODES` must stay in sync across `api/lib/outletCodes.js` and `allOutlets` in `index.html` — this frontend/backend duplication is an accepted, already-documented tradeoff (see `CLAUDE.md`); don't try to unify across the build boundary.
- Any change to a cached asset (`index.html`, `manifest.json`, or the Tesseract CDN URL) requires bumping `CACHE_NAME` in `sw.js`, or returning users keep serving stale files.
- Sheet export is a manual, per-outlet, read-facing projection — it must never become the source of truth and must never block or mutate `tk_data_<code>` / `tutupkedai-data.json` on failure.
- Currency formatted as `"RM"#,##0.00`; deposit math mirrors the app's existing on-screen formulas exactly (`updateFields()` in `index.html:1193-1257`).
- No auto-sync hook — this is separate from the existing automatic `syncOutletToDrive` calls.

---

### Task 1: Shared Google-auth and outlet-codes helpers

**Files:**
- Create: `api/lib/googleAuth.js`
- Create: `api/lib/outletCodes.js`
- Modify: `api/outlet.js` (lines 19-29 removed/replaced, line 108 call site updated)

**Interfaces:**
- Produces: `getAccessToken(scopes)` from `api/lib/googleAuth.js` — `scopes` is a string or array of strings; returns `Promise<string>` (the bearer token). Used by `api/outlet.js` and (Task 3) `api/sheet.js`.
- Produces: `VALID_CODES` from `api/lib/outletCodes.js` — a `Set<string>` of the 50 outlet codes. Used by `api/outlet.js` and (Task 3, Task 5) `api/sheet.js` / `scripts/create-outlet-sheets.js`.

This is a pure refactor — no behavior change to `api/outlet.js`. There's no test runner wired to the live Google API in this repo, so verification is: the module loads without syntax errors, and a manual read-through confirms the JWT claim/signing logic is byte-for-byte the same as before, just parameterized by `scopes`.

- [ ] **Step 1: Create `api/lib/googleAuth.js`**

```js
// Shared service-account JWT auth for api/outlet.js and api/sheet.js.
// No googleapis dependency — signs the JWT by hand with Node's built-in crypto.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(scopes) {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Google token exchange failed: ' + JSON.stringify(json));
  return json.access_token;
}

module.exports = { getAccessToken };
```

- [ ] **Step 2: Create `api/lib/outletCodes.js`**

```js
// Mirrors `allOutlets` in index.html. Keep both lists in sync.
const VALID_CODES = new Set([
  "AJ","B6","BB","BG","BJR","BP","CDR","CK","DG","DGD","GB","GBD","GM","HL","HQ","HQCT",
  "JL","JLD","JTH","KB","KBKK","KBKS","KBTJ","KKR","KL","KMD","KMN","KMSK","KS","MC","MCD",
  "MLR","MR","PC","PDM","PK","PM","PP","PPK","PSPD","PT","RJ","SLS","SMR","ST","TM","TMD",
  "TMT","TPOH","TPT","WM"
]);

module.exports = { VALID_CODES };
```

- [ ] **Step 3: Sanity-check both new files load cleanly**

Run: `node -e "require('./api/lib/googleAuth'); require('./api/lib/outletCodes'); console.log('ok')"`
Expected: prints `ok` with no errors.

- [ ] **Step 4: Refactor `api/outlet.js` to use the shared helpers**

Remove from `api/outlet.js`: the `const crypto = require('crypto');` line, the `base64url` function, the `getAccessToken` function, and the `VALID_CODES` declaration (the block currently at lines 19-29 and the standalone `getAccessToken` function above it).

Add near the top of the file, replacing those removed pieces:

```js
const { getAccessToken } = require('./lib/googleAuth');
const { VALID_CODES } = require('./lib/outletCodes');
```

Update the call site (was `const token = await getAccessToken();`) to pass the scope explicitly:

```js
const token = await getAccessToken('https://www.googleapis.com/auth/drive');
```

- [ ] **Step 5: Sanity-check `api/outlet.js` still loads cleanly**

Run: `node -e "require('./api/outlet.js'); console.log('ok')"`
Expected: prints `ok` with no errors.

- [ ] **Step 6: Diff review**

Run: `git diff api/outlet.js`
Confirm the only changes are the auth/codes wiring — no other logic touched (Drive file lookup, read/write, VALID_CODES membership check, error responses must be byte-identical in behavior).

- [ ] **Step 7: Commit**

```bash
git add api/lib/googleAuth.js api/lib/outletCodes.js api/outlet.js
git commit -m "refactor: extract shared Google auth + outlet codes into api/lib"
```

---

### Task 2: Pure sheet row-building logic (TDD)

**Files:**
- Create: `api/lib/sheetRows.js`
- Test: `api/lib/sheetRows.test.js`

**Interfaces:**
- Consumes: nothing from other tasks (pure function, no I/O).
- Produces: `buildSheetRows(config, scanHistory)` — `config` is the outlet's `{posCount, floatAmount, floatEditable}` object (or `null`), `scanHistory` is the array of `{date, totalCount, digital}` receipt entries. Returns `{ values, mergeRuns, summaryRowIndices, numCols }`:
  - `values`: `Array<Array<string|number>>` — row 0 is the header, ready to hand to `spreadsheets.values.update`.
  - `mergeRuns`: `Array<{startRow: number, endRow: number}>` — 0-indexed rows *within `values`* (inclusive) that share the same date and should be merged in the Date column.
  - `summaryRowIndices`: `Array<number>` — 0-indexed rows within `values` that are daily-summary rows.
  - `numCols`: `number` — column count of `values` (13).
  Used by `api/sheet.js` in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `api/lib/sheetRows.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSheetRows } = require('./sheetRows');

test('sorts by date, ties broken by original order, inserts merge + summary rows', () => {
  const config = { posCount: 1, floatAmount: 300, floatEditable: false };
  const scanHistory = [
    { date: '2026-01-02', totalCount: 500, digital: { val_TRANSFER: 50 } },
    { date: '2026-01-01', totalCount: 400, digital: { val_GRAB: 20 } },
    { date: '2026-01-01', totalCount: 300, digital: {} },
  ];

  const { values, mergeRuns, summaryRowIndices, numCols } = buildSheetRows(config, scanHistory);

  assert.equal(numCols, 13);
  assert.equal(values.length, 5); // header + 3 receipts + 1 summary row
  assert.deepEqual(values[0].slice(0, 4), ['#', 'Date', 'Bill Total', 'Digital Total']);

  // row 1: first 2026-01-01 receipt (total 400, digital 20 -> net 80)
  assert.equal(values[1][1], '2026-01-01');
  assert.equal(values[1][2], 400);
  assert.equal(values[1][12], 80);

  // row 2: second 2026-01-01 receipt (total 300, digital 0 -> net 0)
  assert.equal(values[2][1], '2026-01-01');
  assert.equal(values[2][2], 300);
  assert.equal(values[2][12], 0);

  // row 3: daily summary after bundleSize=2 receipts
  assert.equal(summaryRowIndices.length, 1);
  assert.equal(summaryRowIndices[0], 3);
  assert.match(values[3][0], /Daily Summary \(Receipts 1-2\)/);
  assert.match(values[3][0], /Total RM700\.00/);
  assert.match(values[3][0], /Cash \(Net\) RM80\.00/);
  assert.match(values[3][0], /Digital RM20\.00/);
  assert.match(values[3][0], /Grab: 20\.00/);

  // row 4: 2026-01-02 receipt (total 500, digital 50 -> net 150)
  assert.equal(values[4][1], '2026-01-02');
  assert.equal(values[4][2], 500);
  assert.equal(values[4][12], 150);

  // date merge only for the two 2026-01-01 rows (rows 1-2); none for the lone 2026-01-02 row
  assert.deepEqual(mergeRuns, [{ startRow: 1, endRow: 2 }]);
});

test('floatEditable false ignores a stale floatAmount and uses the 300 default', () => {
  const config = { posCount: 1, floatAmount: 999, floatEditable: false };
  const { values } = buildSheetRows(config, [{ date: '2026-01-01', totalCount: 400, digital: {} }]);
  assert.equal(values[1][12], 100); // 400 - 0 - 300
});

test('floatEditable true uses the configured floatAmount', () => {
  const config = { posCount: 1, floatAmount: 999, floatEditable: true };
  const { values } = buildSheetRows(config, [{ date: '2026-01-01', totalCount: 1000, digital: {} }]);
  assert.equal(values[1][12], 1); // 1000 - 0 - 999
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test api/lib/sheetRows.test.js`
Expected: FAIL — `Cannot find module './sheetRows'`.

- [ ] **Step 3: Implement `api/lib/sheetRows.js`**

```js
// Pure logic: turns {config, scanHistory} into Google Sheet row data plus
// formatting metadata. No network I/O — kept separate so it's unit
// testable without live Google credentials. Consumed by api/sheet.js.

const CATEGORY_IDS = ['val_TRANSFER', 'val_GRAB', 'val_IPAY', 'val_MASTER', 'val_MISI', 'val_QRPAY', 'val_VISA', 'val_VOUCHER'];
const CATEGORY_LABELS = ['Transfer', 'Grab', 'iPay', 'Master', 'Misi', 'QRPay', 'Visa', 'Voucher'];

function buildSheetRows(config, scanHistory) {
  const cfg = config || {};
  const floatAmount = cfg.floatEditable ? (parseFloat(cfg.floatAmount) || 300) : 300;
  const bundleSize = (cfg.posCount || 1) * 2;

  const sorted = scanHistory
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const cmp = (a.entry.date || '').localeCompare(b.entry.date || '');
      return cmp !== 0 ? cmp : a.i - b.i;
    })
    .map((x) => x.entry);

  // Date-run boundaries computed over the sorted receipts only (receipt-space
  // indices), independent of where summary rows will later be inserted.
  const dateRuns = [];
  sorted.forEach((entry, idx) => {
    const last = dateRuns[dateRuns.length - 1];
    const date = entry.date || '';
    if (last && last.date === date) last.end = idx;
    else dateRuns.push({ date, start: idx, end: idx });
  });

  const header = ['#', 'Date', 'Bill Total', 'Digital Total', ...CATEGORY_LABELS, 'Net Bank Deposit'];
  const values = [header];
  const receiptRowOf = []; // receiptRowOf[receiptIdx] = row number in `values`
  const summaryRowIndices = [];

  let dayTotal = 0;
  const dayDigital = {};
  CATEGORY_IDS.forEach((id) => (dayDigital[id] = 0));

  sorted.forEach((entry, idx) => {
    const digitalSum = CATEGORY_IDS.reduce((s, id) => s + (entry.digital[id] || 0), 0);
    const netDeposit = entry.totalCount - digitalSum - floatAmount;
    receiptRowOf[idx] = values.length;
    values.push([
      idx + 1,
      entry.date || '',
      Number(entry.totalCount.toFixed(2)),
      Number(digitalSum.toFixed(2)),
      ...CATEGORY_IDS.map((id) => Number((entry.digital[id] || 0).toFixed(2))),
      Number(netDeposit.toFixed(2)),
    ]);

    dayTotal += entry.totalCount;
    CATEGORY_IDS.forEach((id) => (dayDigital[id] += entry.digital[id] || 0));

    if ((idx + 1) % bundleSize === 0) {
      const totalDayDigital = CATEGORY_IDS.reduce((s, id) => s + dayDigital[id], 0);
      const dayFloat = bundleSize * floatAmount;
      const dayCash = dayTotal - totalDayDigital - dayFloat;
      const breakdown = CATEGORY_IDS
        .map((id, i) => (dayDigital[id] > 0 ? `${CATEGORY_LABELS[i]}: ${dayDigital[id].toFixed(2)}` : null))
        .filter(Boolean)
        .join(' | ') || 'No Digital Sales';

      const summaryRow = new Array(header.length).fill('');
      summaryRow[0] =
        `Daily Summary (Receipts ${idx - bundleSize + 2}-${idx + 1}): ` +
        `Total RM${dayTotal.toFixed(2)} | Cash (Net) RM${dayCash.toFixed(2)} (after RM${dayFloat.toFixed(2)} float) | ` +
        `Digital RM${totalDayDigital.toFixed(2)} | ${breakdown}`;
      summaryRowIndices.push(values.length);
      values.push(summaryRow);

      dayTotal = 0;
      CATEGORY_IDS.forEach((id) => (dayDigital[id] = 0));
    }
  });

  const mergeRuns = dateRuns
    .filter((run) => run.end > run.start)
    .map((run) => ({ startRow: receiptRowOf[run.start], endRow: receiptRowOf[run.end] }));

  return { values, mergeRuns, summaryRowIndices, numCols: header.length };
}

module.exports = { buildSheetRows };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test api/lib/sheetRows.test.js`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add api/lib/sheetRows.js api/lib/sheetRows.test.js
git commit -m "feat: add pure sheet-row builder with date sort/merge/daily-summary logic"
```

---

### Task 3: Sheet export endpoint

**Files:**
- Create: `api/sheet.js`

**Interfaces:**
- Consumes: `getAccessToken(scopes)` from `api/lib/googleAuth.js` (Task 1), `VALID_CODES` from `api/lib/outletCodes.js` (Task 1), `buildSheetRows(config, scanHistory)` from `api/lib/sheetRows.js` (Task 2).
- Produces: `POST /api/sheet?code=<code>` accepting `{config, scanHistory}` JSON body (same shape the frontend already sends to `api/outlet.js`), returning `200 {ok:true, rows:<n>}` on success, `400`/`503`/`405`/`500` with `{error:<message>}` on failure. Consumed by `index.html` in Task 4.

There's no automated test for this task — it needs live Google credentials and a real pre-created Sheet, which this repo has neither in CI nor locally. Verification is a Node syntax check now, and a real end-to-end click-through once Task 4 wires up the button (see Task 4's testing step).

- [ ] **Step 1: Create `api/sheet.js`**

```js
// Vercel serverless function: POST /api/sheet?code=<outletCode>
// Writes one outlet's full scan history into a pre-created Google Sheet
// (named exactly the outlet code) in the shared Drive folder, formatted
// and sorted for human reading. Separate from api/outlet.js's automatic
// JSON sync — this only runs when the "Save to Sheet" button is clicked.
//
// IMPORTANT: same Drive quota wall as api/outlet.js — the service account
// cannot CREATE a new Sheet in this folder, only update one that already
// exists. Each outlet's Sheet must be pre-created once (see
// scripts/create-outlet-sheets.js) and shared with the service account as
// Editor before this endpoint works for that outlet.
//
// Required env vars: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_DRIVE_FOLDER_ID

const { getAccessToken } = require('./lib/googleAuth');
const { VALID_CODES } = require('./lib/outletCodes');
const { buildSheetRows } = require('./lib/sheetRows');

const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'];
const DATE_COL = 1; // 0-indexed column for date merges
const MONEY_COL_START = 2; // Bill Total onward are currency columns

async function findSheetFile(token, folderId, code) {
  const q = `'${folderId}' in parents and name = '${code}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Drive file lookup failed: ' + JSON.stringify(json));
  return (json.files && json.files[0]) || null;
}

async function getSheetInfo(token, spreadsheetId) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error('Sheet info lookup failed: ' + JSON.stringify(json));
  const props = json.sheets[0].properties;
  return { sheetId: props.sheetId, title: props.title };
}

async function clearAndWriteValues(token, spreadsheetId, title, values) {
  const encodedTitle = encodeURIComponent(title);

  const clearRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedTitle}:clear`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );
  if (!clearRes.ok) throw new Error('Sheet clear failed: ' + JSON.stringify(await clearRes.json()));

  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedTitle}!A1?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!writeRes.ok) throw new Error('Sheet write failed: ' + JSON.stringify(await writeRes.json()));
}

function buildFormattingRequests(sheetId, { numRows, numCols, mergeRuns, summaryRowIndices }) {
  const requests = [];

  // Unmerge first so re-running this endpoint never collides with merges from a previous run.
  requests.push({
    unmergeCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numCols },
    },
  });

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.87, blue: 0.9 } } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });

  if (numRows > 1) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: MONEY_COL_START, endColumnIndex: numCols },
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"RM"#,##0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  summaryRowIndices.forEach((rowIdx) => {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: numCols },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 1, green: 0.95, blue: 0.75 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
  });

  mergeRuns.forEach(({ startRow, endRow }) => {
    requests.push({
      mergeCells: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow + 1, startColumnIndex: DATE_COL, endColumnIndex: DATE_COL + 1 },
        mergeType: 'MERGE_ALL',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow + 1, startColumnIndex: DATE_COL, endColumnIndex: DATE_COL + 1 },
        cell: { userEnteredFormat: { verticalAlignment: 'MIDDLE' } },
        fields: 'userEnteredFormat.verticalAlignment',
      },
    });
  });

  requests.push({
    autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: numCols } },
  });

  return requests;
}

async function applyFormatting(token, spreadsheetId, requests) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error('Sheet formatting failed: ' + JSON.stringify(await res.json()));
}

module.exports = async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!VALID_CODES.has(code)) {
      res.status(400).json({ error: 'invalid outlet code' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const token = await getAccessToken(SCOPES);
    const file = await findSheetFile(token, folderId, code);

    if (!file) {
      res.status(503).json({
        error: `No Google Sheet named "${code}" found in the Drive folder. Create one there and share it ` +
               `with the service account as Editor first (see scripts/create-outlet-sheets.js), or run that script.`,
      });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const config = body.config || null;
    const scanHistory = Array.isArray(body.scanHistory) ? body.scanHistory : [];

    const { values, mergeRuns, summaryRowIndices, numCols } = buildSheetRows(config, scanHistory);
    const { sheetId, title } = await getSheetInfo(token, file.id);

    await clearAndWriteValues(token, file.id, title, values);
    const requests = buildFormattingRequests(sheetId, { numRows: values.length, numCols, mergeRuns, summaryRowIndices });
    await applyFormatting(token, file.id, requests);

    res.status(200).json({ ok: true, rows: values.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
```

- [ ] **Step 2: Sanity-check the file loads cleanly**

Run: `node -e "require('./api/sheet.js'); console.log('ok')"`
Expected: prints `ok` with no errors.

- [ ] **Step 3: Commit**

```bash
git add api/sheet.js
git commit -m "feat: add /api/sheet endpoint to export outlet data to a Google Sheet"
```

---

### Task 4: Frontend button + sync function + cache bump

**Files:**
- Modify: `index.html` (near `API_BASE` at line 374, near `syncOutletToDrive` around line 399-415, and the settings-row buttons around line 317-324)
- Modify: `sw.js` (line 1, `CACHE_NAME`)

**Interfaces:**
- Consumes: `POST /api/sheet?code=<code>` from Task 3.
- Produces: `syncOutletToSheet(code)` global function and a `#saveSheetBtn` button, wired for manual use — nothing later depends on these beyond the user clicking the button.

- [ ] **Step 1: Add the Sheet API base constant**

In `index.html`, right after the existing `const API_BASE = 'api/outlet';` (line 374), add:

```js
const SHEET_API_BASE = 'api/sheet';
```

- [ ] **Step 2: Add `syncOutletToSheet`**

Directly after the existing `syncOutletToDrive` function (after line 415), add:

```js
async function syncOutletToSheet(code) {
    if (!code) return;
    const btn = document.getElementById('saveSheetBtn');
    const original = btn ? btn.innerText : null;
    if (btn) { btn.innerText = 'Saving…'; btn.style.pointerEvents = 'none'; }
    try {
        const hist = (code === currentOutlet) ? scanHistory : JSON.parse(localStorage.getItem('tk_data_' + code) || '[]');
        const res = await fetch(SHEET_API_BASE + '?code=' + encodeURIComponent(code), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: outletConfig[code] || null, scanHistory: hist })
        });
        if (!res.ok) throw new Error('sheet save failed: ' + res.status);
        if (btn) btn.innerText = 'Saved ✓';
    } catch (e) {
        console.warn('Sheet export failed:', e);
        if (btn) btn.innerText = 'Failed ✗';
    } finally {
        if (btn) {
            setTimeout(() => { btn.innerText = original; btn.style.pointerEvents = ''; }, 2000);
        }
    }
}
```

- [ ] **Step 3: Add the button**

In the settings-row block containing Export CSV/PDF (`index.html` lines 321-324), add a new row directly below it:

```html
      <div class="settings-row">
        <div class="btn-mini" onclick="exportCSV()">Export CSV</div>
        <div class="btn-mini" onclick="exportPDF()">Export PDF</div>
      </div>
      <div class="settings-row">
        <div class="btn-mini" id="saveSheetBtn" onclick="syncOutletToSheet(currentOutlet)">Save to Sheet</div>
      </div>
```

- [ ] **Step 4: Bump the service worker cache name**

In `sw.js`, change line 1 from `const CACHE_NAME = 'tutupkedai-v2.16';` to `const CACHE_NAME = 'tutupkedai-v2.17';` (increment from whatever the current value is at implementation time — check the file first).

- [ ] **Step 5: Manual end-to-end verification**

This needs a real pre-created test Sheet, so do it after Task 5's script exists (or after creating one test Sheet by hand). Steps:

1. Serve the app locally: `npx serve .` (OCR/service worker require `http(s)://`, not `file://`).
2. Set `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_FOLDER_ID` in your Vercel dev environment (or deploy to a preview branch) so `api/sheet.js` has credentials.
3. Pick a test outlet code that has a real pre-created, shared Sheet.
4. In the app, select that outlet, confirm a few scans across at least two different dates (enough to trigger one daily-summary row and one date merge).
5. Click "Save to Sheet". Confirm the button shows "Saving…" then "Saved ✓" and reverts after ~2s.
6. Open the real Google Sheet and confirm: header frozen and bold, rows sorted oldest-to-newest, same-date rows merged in the Date column, a Daily Summary row appears at the right position with the right totals, currency columns show `RM` formatting, columns are auto-sized.
7. Check the browser network tab and Vercel function logs for any errors.

- [ ] **Step 6: Commit**

```bash
git add index.html sw.js
git commit -m "feat: add Save to Sheet button and wire it to /api/sheet"
```

---

### Task 5: One-off bulk Sheet-creation script

**Files:**
- Create: `scripts/create-outlet-sheets.js`

**Interfaces:**
- Consumes: `VALID_CODES` from `api/lib/outletCodes.js` (Task 1).
- Produces: nothing consumed by the app or by other tasks — this is a standalone, manually-run, one-time script, never deployed or imported.

- [ ] **Step 1: Create `scripts/create-outlet-sheets.js`**

```js
#!/usr/bin/env node
// One-off, run ONCE under your own Google login (NOT the service account).
// Creates one Google Sheet per outlet code in GOOGLE_DRIVE_FOLDER_ID and
// shares each with the service account as Editor, so api/sheet.js can
// write to them later. Not deployed, not imported by the app.
//
// Setup (one-time):
//   1. In the same Google Cloud project as the service account, create an
//      OAuth client of type "Desktop app" (APIs & Services > Credentials).
//   2. Set env vars before running:
//        GOOGLE_OAUTH_CLIENT_ID
//        GOOGLE_OAUTH_CLIENT_SECRET
//        GOOGLE_DRIVE_FOLDER_ID       (same folder api/outlet.js uses)
//        GOOGLE_SERVICE_ACCOUNT_EMAIL (same as GOOGLE_CLIENT_EMAIL in Vercel)
//   3. Preview only:  node scripts/create-outlet-sheets.js --dry-run
//      Create for real: node scripts/create-outlet-sheets.js
//
// Safe to re-run: skips any outlet code that already has a Sheet in the folder.

const http = require('http');
const { VALID_CODES } = require('../api/lib/outletCodes');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const DRY_RUN = process.argv.includes('--dry-run');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

function requireEnv() {
  const missing = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars: ' + missing.join(', '));
    process.exit(1);
  }
}

function getAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      res.end(code ? 'Login complete, you can close this tab.' : 'No code received.');
      server.close();
      code ? resolve(code) : reject(new Error('No auth code in callback'));
    });
    server.listen(REDIRECT_PORT, () => {
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent',
      });
      console.log('Open this URL in your browser and log in:\n' + authUrl + '\n');
    });
  });
}

async function exchangeCodeForToken(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Token exchange failed: ' + JSON.stringify(json));
  return json.access_token;
}

async function findExistingSheet(token, code) {
  const q = `'${FOLDER_ID}' in parents and name = '${code}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Drive lookup failed: ' + JSON.stringify(json));
  return (json.files && json.files[0]) || null;
}

async function createSheet(token, code) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: code,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [FOLDER_ID],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Create failed: ' + JSON.stringify(json));
  return json.id;
}

async function shareWithServiceAccount(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: SERVICE_ACCOUNT_EMAIL }),
  });
  if (!res.ok) throw new Error('Share failed: ' + JSON.stringify(await res.json()));
}

async function main() {
  requireEnv();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Outlets to process: ${VALID_CODES.size}`);
  if (DRY_RUN) {
    [...VALID_CODES].forEach((code) => console.log(' - ' + code));
    return;
  }

  const authCode = await getAuthCode();
  const token = await exchangeCodeForToken(authCode);

  for (const code of VALID_CODES) {
    try {
      const existing = await findExistingSheet(token, code);
      if (existing) {
        console.log(`SKIP ${code} (already exists: ${existing.id})`);
        continue;
      }
      const fileId = await createSheet(token, code);
      await shareWithServiceAccount(token, fileId);
      console.log(`CREATED ${code} -> ${fileId}`);
    } catch (e) {
      console.error(`FAILED ${code}: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Test the dry-run path (no real Google calls, no credentials needed beyond dummy values)**

Run:
```bash
GOOGLE_OAUTH_CLIENT_ID=x GOOGLE_OAUTH_CLIENT_SECRET=x GOOGLE_DRIVE_FOLDER_ID=x GOOGLE_SERVICE_ACCOUNT_EMAIL=x node scripts/create-outlet-sheets.js --dry-run
```
Expected: prints `[DRY RUN] Outlets to process: 50` followed by all 50 codes, one per line, and exits without opening a browser or making network calls.

- [ ] **Step 3: Real run (do this once, manually, when ready)**

Set the four real env vars, run `node scripts/create-outlet-sheets.js` without `--dry-run`, open the printed URL, log in with your own Google account, and confirm the console logs `CREATED <code> -> <fileId>` for each of the 50 outlets (or `SKIP` for any that already exist).

- [ ] **Step 4: Commit**

```bash
git add scripts/create-outlet-sheets.js
git commit -m "feat: add one-off script to bulk-create and share outlet Sheets"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` (Architecture Notes section)
- Modify: `MEMORY.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Add an architecture note to `CLAUDE.md`**

In the `# ARCHITECTURE NOTES` section, after the existing Google Drive sync bullet block, add:

```markdown
- **Google Sheet export (`api/sheet.js`, `POST /api/sheet?code=<code>`):** manual "Save to Sheet" button per outlet (next to Export CSV/PDF) — separate from the automatic JSON sync above. Writes that outlet's full scan history into a pre-created Google Sheet named exactly by outlet code, sorted by date, with same-date rows merged in the Date column, a Daily Summary row every `posCount * 2` receipts, and currency formatting. Same service-account auth as `api/outlet.js` (shared via `api/lib/googleAuth.js`), extended with the `spreadsheets` scope. Same Drive quota wall as the JSON file — Sheets must be pre-created once (`scripts/create-outlet-sheets.js`, run under your own Google login) and shared with the service account as Editor; the endpoint only ever finds-and-updates an existing Sheet. Row-building/sorting/merge logic lives in `api/lib/sheetRows.js` (unit tested via `node --test`).
```

- [ ] **Step 2: Append a `MEMORY.md` entry**

Add a brief entry noting: Google Sheet export feature added (design + plan in `docs/superpowers/specs/` and `docs/superpowers/plans/`), manual per-outlet button, requires one-time Sheet pre-creation via `scripts/create-outlet-sheets.js` before it works for a given outlet.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md MEMORY.md
git commit -m "docs: document Google Sheet export feature"
```
