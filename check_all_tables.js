require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });
(async () => {
  try {
    const t = await pool.query(`select table_name from information_schema.tables where table_schema='public' and table_name like 'vm\_%' and table_type='BASE TABLE' order by table_name`);
    const tables = t.rows.map(r => r.table_name);
    console.log(`\nChecking all ${tables.length} tables for BOTH weeks:\n`);
    let allHaveBoth = true;
    for (const tbl of tables) {
      const r = await pool.query(`select distinct week_start::text ws from "${tbl}" order by ws`);
      const weeks = r.rows.map(x => x.ws);
      const hasMay = weeks.includes('2026-05-25');
      const hasJune = weeks.includes('2026-06-01');
      const status = (hasMay && hasJune) ? '✓ BOTH' : hasMay ? '⚠ May only' : hasJune ? '⚠ June only' : '❌ EMPTY';
      console.log(`  ${status.padEnd(12)} ${tbl}`);
      if (!(hasMay && hasJune)) allHaveBoth = false;
    }
    console.log(`\n${allHaveBoth ? '✓ All tables have both weeks!' : '⚠ Some tables missing a week'}\n`);
    const w = await pool.query(`select week_start::text ws, week_end::text we from vm_v_available_weeks order by ws`);
    console.log('Week picker will show:');
    w.rows.forEach(x => console.log(`  ${x.ws} .. ${x.we}`));
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
