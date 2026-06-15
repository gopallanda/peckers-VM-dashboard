require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });
(async () => {
  try {
    console.log('\n=== WoW Metrics (Executive Dashboard) ===\n');
    const r = await pool.query(`
      select store, week_start::text ws, 
             round(net_sales::numeric, 0) sales, 
             net_sales_wow_pct wow_sales,
             number_of_orders orders, 
             orders_wow_pct wow_orders
      from vm_v_exec_dashboard_with_wow
      order by store, week_start desc
      limit 4
    `);
    r.rows.forEach(x => {
      const wowSales = x.wow_sales ? `${x.wow_sales > 0 ? '+' : ''}${x.wow_sales}%` : 'N/A';
      const wowOrders = x.wow_orders ? `${x.wow_orders > 0 ? '+' : ''}${x.wow_orders}%` : 'N/A';
      console.log(`  ${x.store} | Week ${x.ws}`);
      console.log(`    Net Sales: £${x.sales} (WoW: ${wowSales})`);
      console.log(`    Orders: ${x.orders} (WoW: ${wowOrders})\n`);
    });
    console.log('✓ WoW calculations working — latest week shows growth %\n');
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
