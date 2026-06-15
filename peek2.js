require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });
(async () => {
  try {
    const r = await pool.query(`select store, week_start::text ws, week_end::text we, count(*) n
      from vm_net_sales_by_channel group by store, week_start::text, week_end::text order by ws, store`);
    console.log('RAW stored week_start/week_end (text, no JS Date conversion):');
    r.rows.forEach(x => console.log(`  ${x.store} | ${x.ws} .. ${x.we} | rows=${x.n}`));
    const w = await pool.query(`select week_start::text ws, week_end::text we from vm_v_available_weeks order by ws`);
    console.log('\nvm_v_available_weeks (drives the dashboard week picker):');
    w.rows.forEach(x => console.log(`  ${x.ws} .. ${x.we}`));
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
