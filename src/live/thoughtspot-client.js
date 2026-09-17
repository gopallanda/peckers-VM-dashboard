'use strict';

/**
 * thoughtspot-client.js
 * ---------------------
 * Plain-HTTP session with Vita Mojo's embedded ThoughtSpot, via VM Hub's own
 * auth endpoints. No browser. See docs/live-gross-sales.md for the chain:
 *
 *   1. VM Hub refresh token  -> access token + user email
 *   2. access token          -> ThoughtSpot token
 *   3. ThoughtSpot token     -> JSESSIONID/clientId cookies
 *   4. cookies               -> /api/rest/2.0/searchdata
 *
 * These are INTERNAL Vita Mojo endpoints, not a published API. They can change
 * without notice; every failure is surfaced with a stable `code` so the health
 * check can tell "token died" apart from "ThoughtSpot changed".
 *
 * Never put a token in an error message or log line: the refresh token is part
 * of the step-1 URL, so URLs are never logged either.
 */

const tokenStore = require('./token-store');

const VMOS = 'https://vmos2.vmos.io';
const TS = 'https://vitamojo.thoughtspot.cloud';
const TIMEOUT_MS = 20000;
const SESSION_MAX_AGE_MS = 20 * 60 * 1000;

class LiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveError';
    this.code = code;
  }
}

/** fetch with a timeout; network failures and timeouts become LiveError(code). */
async function http(url, init, code, step) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    throw new LiveError(code, `${step}: ${why}`);
  }
}

// ---------------------------------------------------------------------------
// Login (steps 1-3)
// ---------------------------------------------------------------------------

/** Step 1. Returns { accessToken, refreshToken, email }. */
async function refreshVmHub(refreshToken) {
  const res = await http(
    `${VMOS}/user/v1/auth/refresh/${encodeURIComponent(refreshToken)}`,
    { method: 'POST' },
    'AUTH_REFRESH_FAILED',
    'VM Hub refresh'
  );
  const body = await res.json().catch(() => ({}));

  if (res.status === 400 && body.vmosCode === 'US-04') {
    throw new LiveError('AUTH_REFRESH_INVALID', 'VM Hub refresh token is not valid (US-04)');
  }
  const payload = body.payload || {};
  if (!res.ok || !payload.token || !payload.token.value || !payload.user || !payload.user.email) {
    throw new LiveError('AUTH_REFRESH_FAILED', `VM Hub refresh returned ${res.status}${body.vmosCode ? ` ${body.vmosCode}` : ''}`);
  }
  return {
    accessToken: payload.token.value,
    refreshToken: payload.token.refresh ? tokenStore.cleanToken(payload.token.refresh) : null,
    email: payload.user.email,
  };
}

/**
 * Step 1 with token resolution: DB row first, then VM_REFRESH_TOKEN. The env
 * token is tried only if the DB token was rejected as US-04 AND the env token
 * is a different value; anything else (network, 5xx) is thrown straight away,
 * because retrying with another token would not help.
 */
async function refreshWithStoredToken() {
  const dbToken = await tokenStore.readDbToken();
  const envToken = tokenStore.readEnvToken();

  const candidates = [];
  if (dbToken) candidates.push({ token: dbToken, source: 'db' });
  if (envToken && envToken !== dbToken) candidates.push({ token: envToken, source: 'env' });
  if (candidates.length === 0) {
    throw new LiveError('AUTH_REFRESH_INVALID', 'no VM Hub refresh token configured (vm_live_auth empty and VM_REFRESH_TOKEN unset)');
  }

  let lastErr;
  for (const { token, source } of candidates) {
    try {
      const result = await refreshVmHub(token);

      // Persist whatever token is now current. That covers two cases: VM Hub
      // rotated it (the old one may already be dead), and the DB row was dead
      // but the env token worked (heal the row so the next login skips it).
      const current = result.refreshToken || token;
      if (current !== dbToken) {
        const saved = await tokenStore.saveDbToken(current);
        if (result.refreshToken && result.refreshToken !== token) {
          console.warn(`[live] VM Hub rotated the refresh token (${saved ? 'saved to vm_live_auth' : 'NOT saved — update VM_REFRESH_TOKEN before the next restart'})`);
        }
      }
      if (source === 'env' && dbToken) {
        console.warn('[live] DB refresh token was rejected; fell back to VM_REFRESH_TOKEN');
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'AUTH_REFRESH_INVALID') throw err;
    }
  }
  throw lastErr;
}

/** Steps 1-3. Returns { cookie, email, createdAt }. */
async function login() {
  const { accessToken, email } = await refreshWithStoredToken();

  // Step 2
  const tsRes = await http(
    `${VMOS}/tenant/v1/reporting/thoughtspot/auth`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
    'AUTH_TS_FAILED',
    'ThoughtSpot token'
  );
  // The body may be a JSON-quoted string or the bare token.
  const tsToken = tokenStore.cleanToken(await tsRes.text());
  if (!tsRes.ok || !tsToken) {
    throw new LiveError('AUTH_TS_FAILED', `ThoughtSpot token request returned ${tsRes.status}`);
  }

  // Step 3. redirect:'manual' — the cookies are on the 302 itself.
  const loginRes = await http(
    `${TS}/callosum/v1/session/login/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: email, auth_token: tsToken }).toString(),
      redirect: 'manual',
    },
    'AUTH_TS_FAILED',
    'ThoughtSpot login'
  );
  const cookies = loginRes.headers.getSetCookie().map((c) => c.split(';')[0].trim()).filter(Boolean);
  if (loginRes.status >= 400 || !cookies.some((c) => c.startsWith('JSESSIONID='))) {
    throw new LiveError('AUTH_TS_FAILED', `ThoughtSpot login returned ${loginRes.status} without a session cookie`);
  }

  return { cookie: cookies.join('; '), email, createdAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Session cache with single-flight
// ---------------------------------------------------------------------------
let session = null;
let loginInFlight = null;

/**
 * Shared ThoughtSpot session. Concurrent callers share one login; the cookie
 * is reused for up to 20 minutes.
 */
async function getSession() {
  if (session && Date.now() - session.createdAt < SESSION_MAX_AGE_MS) {
    return session;
  }
  if (!loginInFlight) {
    loginInFlight = login()
      .then((s) => { session = s; return s; })
      .finally(() => { loginInFlight = null; });
  }
  return loginInFlight;
}

/** Drop the cached session, but only if nobody has already replaced it. */
function invalidate(stale) {
  if (session === stale) session = null;
}

// ---------------------------------------------------------------------------
// Queries (step 4)
// ---------------------------------------------------------------------------

/** POST to ThoughtSpot with the session; on 401/403 log in again once and retry. */
async function tsPost(path, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession();
    const res = await http(
      `${TS}${path}`,
      {
        method: 'POST',
        headers: {
          Cookie: s.cookie,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Requested-By': 'ThoughtSpot',
        },
        body: JSON.stringify(payload),
      },
      'TS_QUERY_FAILED',
      'ThoughtSpot query'
    );
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      invalidate(s);
      continue;
    }
    return res;
  }
  // Unreachable: the second iteration always returns.
  throw new LiveError('TS_QUERY_FAILED', 'ThoughtSpot query failed');
}

/** Pull ThoughtSpot's human-readable reason out of an error body, if any. */
function tsErrorReason(text) {
  try {
    const debug = JSON.parse(text).error.message.debug.debug;
    const reasons = JSON.parse(debug).filter(Boolean);
    return reasons.join('; ').slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * @param {string} queryString - ThoughtSpot search, e.g. "[Sales] [Store] [Order Date] = '09/16/2026'"
 * @param {object} [paramOverrides] - runtime_param_override
 * @returns {Promise<{columnNames: string[], rows: any[][]}>}
 */
async function searchData(queryString, paramOverrides) {
  const MODEL_ORDER_ITEMS = 'eff271e3-51a6-4dbd-ade1-7612d73d366f';
  const res = await tsPost('/api/rest/2.0/searchdata', {
    logical_table_identifier: MODEL_ORDER_ITEMS,
    query_string: queryString,
    record_size: 1000,
    ...(paramOverrides ? { runtime_param_override: paramOverrides } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const reason = tsErrorReason(text);
    throw new LiveError('TS_QUERY_FAILED', `searchdata returned ${res.status}${reason ? `: ${reason}` : ''}`);
  }
  let contents;
  try {
    contents = JSON.parse(text).contents[0];
  } catch {
    contents = null;
  }
  if (!contents || !Array.isArray(contents.column_names) || !Array.isArray(contents.data_rows)) {
    throw new LiveError('TS_QUERY_FAILED', 'searchdata returned an unexpected body');
  }
  return { columnNames: contents.column_names, rows: contents.data_rows };
}

module.exports = { getSession, searchData, LiveError };
