'use strict';

/**
 * token-store.js
 * --------------
 * Persists the VM Hub refresh token in vm_live_auth (sql/live_sales_auth.sql).
 *
 * The database is best-effort: if the table has not been created yet, or the
 * database is unreachable, reads return null and writes log a warning. The
 * live feed then runs on VM_REFRESH_TOKEN alone, which is fine for as long as
 * VM Hub does not rotate the token.
 */

const { getPool } = require('../api/daily-sales-service');

/** Strip whitespace and any surrounding quotes (auth.json stores it JSON-quoted). */
function cleanToken(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '');
}

function describeDbError(err) {
  // 42P01 = undefined_table: sql/live_sales_auth.sql has not been run yet.
  return err.code === '42P01' ? 'vm_live_auth does not exist (run sql/live_sales_auth.sql)' : err.message;
}

/** @returns {Promise<string|null>} */
async function readDbToken() {
  if (!process.env.SUPABASE_DB_URL) return null;
  try {
    const res = await getPool().query('SELECT refresh_token FROM vm_live_auth WHERE id = 1');
    return res.rows[0] ? cleanToken(res.rows[0].refresh_token) || null : null;
  } catch (err) {
    console.warn('[live] could not read vm_live_auth:', describeDbError(err));
    return null;
  }
}

/** @returns {string|null} */
function readEnvToken() {
  return cleanToken(process.env.VM_REFRESH_TOKEN) || null;
}

/** Upsert the single row. Never throws: a failed save must not fail a login. */
async function saveDbToken(token) {
  if (!process.env.SUPABASE_DB_URL) return false;
  try {
    await getPool().query(
      `INSERT INTO vm_live_auth (id, refresh_token, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
      [token]
    );
    return true;
  } catch (err) {
    console.warn('[live] could not save refresh token to vm_live_auth:', describeDbError(err));
    return false;
  }
}

module.exports = { cleanToken, readDbToken, readEnvToken, saveDbToken };
