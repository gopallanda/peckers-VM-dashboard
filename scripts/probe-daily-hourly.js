'use strict';
/**
 * PHASE 0 PROBE — read-only, writes NOTHING to the database.
 *
 * Question: does the VM Hub chart "Net Sales by Hour" return that DAY's hour
 * buckets when the filter window is a single business date (start === end)?
 *
 * If yes, one daily chart replaces both deliverables in the handoff brief.
 */
require('dotenv').config();

const { withSession, extractReportForStoreWeek } = require('../src/extract');
const { fmtISO, fmtUK, parseISO } = require('../src/config');

const STORE = process.env.PROBE_STORE || 'Peckers Stevenage';
const DATES = (process.env.PROBE_DATES || '2026-09-18,2026-09-16').split(',');

const REPORT = { chart: 'Net Sales by Hour', table: 'probe_only_not_written' };

function day(iso) {
  const d = parseISO(iso);
  return { businessDate: fmtISO(d), startISO: fmtISO(d), endISO: fmtISO(d), startUK: fmtUK(d), endUK: fmtUK(d) };
}

(async () => {
  // Newest-first, same rule as the real daily sync.
  const dates = DATES.map(day).sort((a, b) => b.startISO.localeCompare(a.startISO));

  await withSession(async (page) => {
    for (const d of dates) {
      console.log(`\n=============== ${STORE} @ ${d.businessDate} ===============`);
      const cap = await extractReportForStoreWeek(page, { report: REPORT, store: STORE, week: d });
      console.log('columns :', JSON.stringify(cap.columns));
      console.log('rowCount:', cap.rows.length);
      console.log('rows    :');
      for (const r of cap.rows) console.log('   ', JSON.stringify(r));

      // If there is a numeric-looking column, total it so we can eyeball the
      // day against VM Hub straight away.
      const numCol = cap.columns.find((c) => /net_?sales/i.test(c));
      if (numCol) {
        const total = cap.rows.reduce((s, r) => s + (parseFloat(String(r[numCol]).replace(/[^0-9.-]/g, '')) || 0), 0);
        console.log(`SUM(${numCol}) = ${total.toFixed(4)}`);
      }
    }
  });
})().catch((e) => {
  console.error('[probe] FAILED:', e.message);
  process.exit(1);
});
