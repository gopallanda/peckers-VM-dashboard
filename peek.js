require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });
const iso = d => (d && d.toISOString) ? d.toISOString().slice(0,10) : String(d);
(async () => {
  try {
    const t = await pool.query(`select table_name from information_schema.tables where table_schema='public' and table_name like 'vm\_%' and table_type='BASE TABLE' order by table_name`);
    const tables = t.rows.map(r => r.table_name);
    console.log('BASE TABLES ('+tables.length+'):\n  '+tables.join('\n  '));
    for (const tbl of ['vm_net_sales_by_channel']) {
      const r = await pool.query(`select store, week_start, week_end, count(*) n from "${tbl}" group by store, week_start, week_end order by week_start, store`);
      console.log('\n--- '+tbl+' coverage ---');
      r.rows.forEach(x => console.log(`  ${x.store} | ${iso(x.week_start)} .. ${iso(x.week_end)} | rows=${x.n}`));
    }
    let allWeeks = new Set();
    for (const tbl of tables) {
      try { const r = await pool.query(`select distinct week_start from "${tbl}"`); r.rows.forEach(x => x.week_start && allWeeks.add(iso(x.week_start))); } catch(e) {}
    }
    console.log('\nDISTINCT week_start across all vm_ tables:', [...allWeeks].sort().join(', ') || '(none)');
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
