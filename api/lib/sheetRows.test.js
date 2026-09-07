const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSheetRows, groupEntriesByMonth, isMonthTabTitle, planTabSync } = require('./sheetRows');

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

test('groupEntriesByMonth splits by calendar month, sorted chronologically, titled "Mon YYYY"', () => {
  const scanHistory = [
    { date: '2026-09-02', totalCount: 100, digital: {} },
    { date: '2026-08-25', totalCount: 200, digital: {} },
    { date: '2026-08-26', totalCount: 300, digital: {} },
  ];
  const groups = groupEntriesByMonth(scanHistory);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, '2026-08');
  assert.equal(groups[0].title, 'Aug 2026');
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[1].key, '2026-09');
  assert.equal(groups[1].title, 'Sep 2026');
  assert.equal(groups[1].entries.length, 1);
});

test('groupEntriesByMonth buckets missing/unparseable dates into "Undated"', () => {
  const scanHistory = [{ date: '', totalCount: 100, digital: {} }, { totalCount: 50, digital: {} }];
  const groups = groupEntriesByMonth(scanHistory);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'undated');
  assert.equal(groups[0].title, 'Undated');
  assert.equal(groups[0].entries.length, 2);
});

test('isMonthTabTitle only matches our own "Mon YYYY"/"Undated" naming', () => {
  assert.equal(isMonthTabTitle('Aug 2026'), true);
  assert.equal(isMonthTabTitle('Undated'), true);
  assert.equal(isMonthTabTitle('Sheet1'), false);
  assert.equal(isMonthTabTitle('AJ'), false);
  assert.equal(isMonthTabTitle('Xyz 2026'), false); // not a real month abbreviation
  assert.equal(isMonthTabTitle('August 2026'), false); // full month name, not our format
});

test('planTabSync creates missing months and deletes stale month tabs, leaving non-month tabs alone', () => {
  const plan = planTabSync(['Aug 2026', 'Sep 2026', 'Sheet1'], ['Sep 2026', 'Oct 2026']);
  assert.deepEqual(plan.toCreate, ['Oct 2026']);
  assert.deepEqual(plan.toDelete, ['Aug 2026']);
  assert.equal(plan.keepTitle, null);
});

test('planTabSync keeps the last stale tab instead of deleting it, if deleting it all would leave zero sheets', () => {
  const plan = planTabSync(['Aug 2026', 'Sep 2026'], []);
  assert.deepEqual(plan.toCreate, []);
  assert.deepEqual(plan.toDelete, ['Aug 2026']);
  assert.equal(plan.keepTitle, 'Sep 2026');
});

test('planTabSync deletes every stale month tab when a non-month tab survives as the last sheet', () => {
  const plan = planTabSync(['Aug 2026', 'Sep 2026', 'Sheet1'], []);
  assert.deepEqual(plan.toCreate, []);
  assert.deepEqual(plan.toDelete.sort(), ['Aug 2026', 'Sep 2026']);
  assert.equal(plan.keepTitle, null);
});
