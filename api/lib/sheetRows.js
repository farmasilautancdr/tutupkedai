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
