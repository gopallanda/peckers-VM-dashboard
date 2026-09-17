'use strict';

/**
 * scripts/live-probe.js
 * ---------------------
 * READ-ONLY discovery for the live gross-sales feed (docs/live-gross-sales.md).
 * Plain HTTP only — no Playwright.
 *
 *   npm run live-probe
 *
 * Refresh token: env VM_REFRESH_TOKEN, else auth.json
 * (origins[vmos2.vmos.io].localStorage 'refresh-token').
 *
 * Never prints a full token. If VM Hub hands back a DIFFERENT refresh token
 * (i.e. they rotate), the new one is written to debug/live-refresh-token.txt
 * (gitignored) so a probe run cannot strand you with a dead token.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const VMOS = 'https://vmos2.vmos.io';
const TS = 'https://vitamojo.thoughtspot.cloud';
const MODEL_ID = 'eff271e3-51a6-4dbd-ade1-7612d73d366f';
const LIVEBOARD_ID = 'a2b45f63-740c-4d52-b81c-f7ec2a858038';
const TILES = ['Sales', 'Orders', 'AOV', 'Products Sold', 'Sales by 15 Minute Time Window'];
const GROSS = {
  param1: 'Sales Type', paramVal1: 'gross sales',
  param2: 'Exclude Service Charge and Tip', paramVal2: 'false',
};

const mask = (s) => (s ? `${String(s).slice(0, 6)}… (${String(s).length} chars)` : '(none)');
const unquote = (s) => String(s || '').trim().replace(/^"+|"+$/g, '');

function readRefreshToken() {
  if (process.env.VM_REFRESH_TOKEN) return { token: unquote(process.env.VM_REFRESH_TOKEN), source: 'env VM_REFRESH_TOKEN' };
  const auth = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'auth.json'), 'utf8'));
  const origin = (auth.origins || []).find((o) => o.origin.includes('vmos2.vmos.io'));
  const item = origin && (origin.localStorage || []).find((x) => x.name === 'refresh-token');
  if (!item) throw new Error('no refresh token in env or auth.json');
  return { token: unquote(item.value), source: 'auth.json' };
}

async function main() {
  const { token: refresh, source } = readRefreshToken();
  console.log(`refresh token source: ${source}, sent: ${mask(refresh)}`);

  // 1. VM Hub refresh
  let r = await fetch(`${VMOS}/user/v1/auth/refresh/${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
  let body = await r.json().catch(() => ({}));
  console.log(`[1] refresh -> ${r.status}`);
  if (!r.ok) { console.log('   ', body.vmosCode, body.message); process.exit(1); }
  const { token, user } = body.payload;
  const rotated = token.refresh && token.refresh !== refresh;
  console.log(`    returned refresh: ${mask(token.refresh)}  differs from sent: ${rotated}`);
  console.log(`    access token: ${mask(token.value)}  user keys: ${Object.keys(user).join(',')}`);
  if (rotated) {
    fs.mkdirSync(path.join(__dirname, '..', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'debug', 'live-refresh-token.txt'), token.refresh);
    console.log('    ROTATED — new refresh token saved to debug/live-refresh-token.txt');
  }

  // 2. ThoughtSpot token
  r = await fetch(`${VMOS}/tenant/v1/reporting/thoughtspot/auth`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email }),
    signal: AbortSignal.timeout(20000),
  });
  const tsToken = unquote(await r.text());
  console.log(`[2] thoughtspot/auth -> ${r.status}, ts token ${mask(tsToken)}`);
  if (!r.ok) process.exit(1);

  // 3. ThoughtSpot session
  r = await fetch(`${TS}/callosum/v1/session/login/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user.email, auth_token: tsToken }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  console.log(`[3] session/login/token -> ${r.status}, cookies: ${r.headers.getSetCookie().map((c) => c.split('=')[0]).join(',')}`);

  const tsHeaders = { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-By': 'ThoughtSpot' };
  const tsPost = async (p, payload) => {
    const res = await fetch(`${TS}${p}`, { method: 'POST', headers: tsHeaders, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  };

  r = await fetch(`${TS}/api/rest/2.0/auth/session/user`, { headers: tsHeaders, signal: AbortSignal.timeout(20000) });
  const me = await r.json().catch(() => ({}));
  console.log(`    session/user -> ${r.status}, time_zone=${me.time_zone ?? me.preferred_locale ?? '?'} locale=${me.preferred_locale ?? '?'}`);

  // TML export of the intraday liveboard
  console.log('\n===== Liveboard TML =====');
  const tml = await tsPost('/api/rest/2.0/metadata/tml/export', { metadata: [{ identifier: LIVEBOARD_ID }], edoc_format: 'YAML' });
  console.log(`tml/export -> ${tml.status}`);
  if (tml.json && tml.json[0]) {
    const edoc = tml.json[0].edoc || '';
    fs.mkdirSync(path.join(__dirname, '..', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'debug', 'intraday-liveboard.tml.yaml'), edoc);
    // Crude YAML slicing: each visualization block starts with "- id:" under visualizations.
    const blocks = edoc.split(/\n\s{2}- id: /);
    for (const b of blocks) {
      const name = (b.match(/\n\s+name: (.+)/) || [])[1];
      if (!name) continue;
      const clean = name.replace(/^["']|["']$/g, '').trim();
      if (!TILES.includes(clean)) continue;
      console.log(`\n--- tile: ${clean}`);
      const lines = b.split('\n').filter((l) => /search_query|formula|expr:|name:|column_id|chart_type|type:/.test(l));
      console.log(lines.slice(0, 40).join('\n'));
    }
  } else {
    console.log(tml.text.slice(0, 500));
  }

  // Candidate searches
  console.log('\n===== searchdata candidates =====');
  // Findings from the first run (2026-09-17), kept here so a re-run shows them:
  //  - [Order At] is DATE-only in this model: .detailed/.hourly/'hour of day'
  //    all give midnight/0, and the liveboard's own 15-minute tile returns one
  //    bucket. [Time Window] likewise is always "00:00". No sub-hour grain exists.
  //  - [Hour of Day] is real and Europe/London local ([Time of Day] labels say
  //    "lunch 11am-3pm", first sales at hour 11).
  //  - Date literals must be MM/DD/YYYY; ISO 'YYYY-MM-DD' is rejected.
  const ukDate = (offsetDays) => {
    const iso = new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  };
  const candidates = [
    '[Sales] [Store] [Order Date].today',
    '[Sales] [Store] [Order Date].yesterday',
    '[Orders] [Store] [Order Date].today',
    '[Sales] [Orders] [Store] [Order Date].yesterday',
    '[Sales] [Orders] [Store] [15 Minute Time Window] [Order Date].yesterday',
    '[Sales] [Orders] [Store] [Time Window] [Order Date].yesterday',
    '[Sales] [Orders] [Store] [Order At].hourly [Order Date].yesterday',
    '[Sales] [Time of Day] [Order Date].yesterday',
    // The final queries used by src/live/intraday-gross.js:
    `[Sales] [Orders] [Store] [Order Date] = '${ukDate(-1)}'`,
    `[Sales] [Orders] [Store] [Hour of Day] [Order Date] = '${ukDate(-1)}'`,
    `[Sales] [Orders] [Store] [Order Date] = '${ukDate(0)}'`,
    `[Sales] [Orders] [Store] [Hour of Day] [Order Date] = '${ukDate(0)}'`,
  ];
  for (const q of candidates) {
    const res = await tsPost('/api/rest/2.0/searchdata', { logical_table_identifier: MODEL_ID, query_string: q, record_size: 1000, runtime_param_override: GROSS });
    const c = res.json && res.json.contents && res.json.contents[0];
    if (res.status === 200 && c) {
      console.log(`\n${q}\n  -> 200 columns=${JSON.stringify(c.column_names)} rows=${c.data_rows.length}`);
      for (const row of c.data_rows.slice(0, 24)) console.log('    ', JSON.stringify(row));
    } else {
      console.log(`\n${q}\n  -> ${res.status} ${res.text.slice(0, 300)}`);
    }
  }

  // The liveboard's own 15-minute tile (reference only — the feature does not
  // use liveboard/data): shows whether ThoughtSpot itself has sub-hour grain.
  const lb = await tsPost('/api/rest/2.0/metadata/liveboard/data', {
    metadata_identifier: LIVEBOARD_ID,
    visualization_identifiers: ['Sales by 15 Minute Time Window'],
    record_size: 200,
    runtime_param_override: GROSS,
  });
  const lbc = lb.json && lb.json.contents && lb.json.contents[0];
  console.log(`\nliveboard tile "Sales by 15 Minute Time Window" -> ${lb.status}`,
    lbc ? `${JSON.stringify(lbc.column_names)} rows=${lbc.data_rows.length} first=${JSON.stringify(lbc.data_rows.slice(0, 3))}` : lb.text.slice(0, 300));
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
