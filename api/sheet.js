// Vercel serverless function: POST /api/sheet?code=<outletCode>
// Writes one outlet's full scan history into a pre-created Google Sheet
// (named exactly the outlet code) in the shared Drive folder, split into
// one tab per calendar month ("Aug 2026", "Sep 2026", ...), auto-creating
// any month tab that doesn't exist yet. Formatted and sorted for human
// reading. Separate from api/outlet.js's automatic JSON sync — this only
// runs when the "Save to Sheet" button is clicked.
//
// IMPORTANT: same Drive quota wall as api/outlet.js — the service account
// cannot CREATE a new Sheet FILE in this folder, only update one that
// already exists. Each outlet's Sheet file must be pre-created once (see
// scripts/create-outlet-sheets.js) and shared with the service account as
// Editor before this endpoint works for that outlet. Creating new TABS
// inside an existing Sheet file (via spreadsheets.batchUpdate) is not
// subject to that quota wall — the service account owns nothing there,
// it's just editing a file it already has Editor access to.
//
// Required env vars: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_DRIVE_FOLDER_ID

const { getAccessToken } = require('./lib/googleAuth');
const { VALID_CODES } = require('./lib/outletCodes');
const { buildSheetRows, groupEntriesByMonth } = require('./lib/sheetRows');

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

async function getExistingTabs(token, spreadsheetId) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error('Sheet info lookup failed: ' + JSON.stringify(json));
  return json.sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title }));
}

// Creates any month tabs that don't exist yet. Returns a Map of title -> sheetId
// covering every tab that will be written to (pre-existing + newly created).
async function ensureMonthTabs(token, spreadsheetId, existingTabs, monthGroups) {
  const byTitle = new Map(existingTabs.map((t) => [t.title, t.sheetId]));
  const missing = monthGroups.filter((g) => !byTitle.has(g.title));
  if (missing.length === 0) return byTitle;

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: missing.map((g) => ({ addSheet: { properties: { title: g.title } } })),
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Adding month tab(s) failed: ' + JSON.stringify(json));

  json.replies.forEach((reply, i) => {
    byTitle.set(missing[i].title, reply.addSheet.properties.sheetId);
  });
  return byTitle;
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
    // Merge the whole row into one real cell (not just text overflowing into blank
    // neighbors) so it stays readable regardless of column widths, and wrap since
    // the summary text is long.
    requests.push({
      mergeCells: {
        range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: numCols },
        mergeType: 'MERGE_ALL',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: numCols },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 1, green: 0.95, blue: 0.75 },
            wrapStrategy: 'WRAP',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)',
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

    const monthGroups = groupEntriesByMonth(scanHistory);
    const existingTabs = await getExistingTabs(token, file.id);
    const sheetIdByTitle = await ensureMonthTabs(token, file.id, existingTabs, monthGroups);

    const tabsWritten = [];
    for (const group of monthGroups) {
      const { values, mergeRuns, summaryRowIndices, numCols } = buildSheetRows(config, group.entries);
      const sheetId = sheetIdByTitle.get(group.title);

      await clearAndWriteValues(token, file.id, group.title, values);
      const requests = buildFormattingRequests(sheetId, { numRows: values.length, numCols, mergeRuns, summaryRowIndices });
      await applyFormatting(token, file.id, requests);

      tabsWritten.push({ title: group.title, rows: values.length });
    }

    res.status(200).json({ ok: true, tabs: tabsWritten });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
