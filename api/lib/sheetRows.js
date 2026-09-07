// Pure logic: turns {config, scanHistory} into Google Sheet row data plus
// formatting metadata. No network I/O — kept separate so it's unit
// testable without live Google credentials. Consumed by api/sheet.js.

const CATEGORY_IDS = ['val_TRANSFER', 'val_GRAB', 'val_IPAY', 'val_MASTER', 'val_MISI', 'val_QRPAY', 'val_VISA', 'val_VOUCHER'];
const CATEGORY_LABELS = ['Transfer', 'Grab', 'iPay', 'Master', 'Misi', 'QRPay', 'Visa', 'Voucher'];
const MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Groups scanHistory entries by calendar month (keyed off entry.date's YYYY-MM),
// one group per Google Sheet tab. Entries with a missing/unparseable date fall
// into an 'Undated' tab rather than being silently dropped.
function groupEntriesByMonth(scanHistory) {
  const groups = new Map(); // key -> { title, entries }

  scanHistory.forEach((entry) => {
    const m = /^(\d{4})-(\d{2})/.exec(entry.date || '');
    const key = m ? `${m[1]}-${m[2]}` : 'undated';
    const title = m ? `${MONTH_ABBREV[Number(m[2]) - 1]} ${m[1]}` : 'Undated';
    if (!groups.has(key)) groups.set(key, { key, title, entries: [] });
    groups.get(key).entries.push(entry);
  });

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// True only for a tab title this export could itself have created (the exact
// "Mon YYYY" format from groupEntriesByMonth, or "Undated"). Used to decide
// which stale tabs are safe to prune automatically - a tab a human named/added
// by hand never matches this and is never touched.
function isMonthTabTitle(title) {
  if (title === 'Undated') return true;
  const m = /^([A-Za-z]{3}) (\d{4})$/.exec(title);
  return !!m && MONTH_ABBREV.includes(m[1]);
}

// Decides which month tabs to create/delete so the spreadsheet only ever
// shows tabs for months the outlet currently has data for. Pure/testable:
// takes plain title lists, no sheetId/network concerns.
//
// Never deletes a tab whose title isn't one this export could have created
// (isMonthTabTitle), and never deletes the last tab in a spreadsheet a stale
// tab is kept (untouched, later cleared to header-only by the caller) rather
// than deleted if pruning it all would leave zero sheets.
function planTabSync(existingTitles, desiredTitles) {
  const desired = new Set(desiredTitles);
  const stale = existingTitles.filter((t) => isMonthTabTitle(t) && !desired.has(t));
  const toCreate = desiredTitles.filter((t) => !existingTitles.includes(t));

  const finalCount = existingTitles.length + toCreate.length - stale.length;
  let toDelete = stale;
  let keepTitle = null;
  if (finalCount < 1 && stale.length > 0) {
    keepTitle = stale[stale.length - 1];
    toDelete = stale.slice(0, -1);
  }

  return { toCreate, toDelete, keepTitle };
}

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

module.exports = { buildSheetRows, groupEntriesByMonth, isMonthTabTitle, planTabSync };
