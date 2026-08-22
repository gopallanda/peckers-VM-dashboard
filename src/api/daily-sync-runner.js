'use strict';

/**
 * daily-sync-runner.js
 * --------------------
 * Runs `src/daily/sync.js` as a child process, in-process, on demand.
 *
 * WHY THIS EXISTS
 * ---------------
 * The daily sync is driven by cron-job.org, which can only send an HTTP
 * request. It cannot run Playwright. So the scrape has to happen on whatever
 * host is serving this Express app: cron-job.org POSTs the trigger route, the
 * route calls start() here, and the actual work happens in a child process
 * while the request returns immediately.
 *
 * This replaces the GitHub Actions `workflow_dispatch` path described in
 * docs/daily-net-sales.md — the daily sync no longer touches GitHub Actions at
 * all. (The WEEKLY sync still runs on Actions via sync.yml and is untouched.)
 *
 * ---------------------------------------------------------------------------
 * WHY A CHILD PROCESS AND NOT `require('../daily/sync')`
 * ---------------------------------------------------------------------------
 * src/daily/sync.js is written as a script: it calls main() at import time and
 * ends with process.exit(1) on failure. Requiring it would start a scrape as a
 * side effect of loading, and a failed run would take the whole API server
 * down with it. A child process gives us the script's exit code as data
 * instead of as a fatal event, and guarantees a wedged Playwright can be
 * killed without restarting the API.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOCK AND THE WATCHDOG ARE BOTH REQUIRED
 * ---------------------------------------------------------------------------
 * The lock: two concurrent runs would fight over the same VM Hub session, the
 * same downloads/ directory, and the same (store, date) rows. This is the
 * equivalent of the `concurrency: vm-daily` group in the old workflow.
 *
 * The watchdog: a lock with no timeout is worse than no lock. If Playwright
 * wedges (see docs/daily-net-sales.md section 8 for a DOM state that does
 * exactly that), the lock would be held forever and EVERY subsequent night
 * would be rejected with 409 — a single bad night would silently become a
 * permanently dead feed. The watchdog is what the old workflow's
 * `timeout-minutes: 20` used to provide, and it is kept at the same 20 minutes
 * for the same reason: the daily run must be finished before the weekly sync
 * starts at 01:30 UTC.
 */

const { spawn } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'src', 'daily', 'sync.js');

// Matches the old workflow's `timeout-minutes: 20`. Do not raise this without
// also moving the cron-job.org schedule earlier — see docs/daily-net-sales.md.
const TIMEOUT_MS = Number(process.env.DAILY_SYNC_TIMEOUT_MS || 20 * 60 * 1000);

// Grace period between SIGTERM and SIGKILL when the watchdog fires.
const KILL_GRACE_MS = 10000;

/** @type {null | object} the in-flight run, if any */
let current = null;

/** @type {null | object} the most recent completed run in THIS process */
let lastRun = null;

function nowIso() {
  return new Date().toISOString();
}

/** Is a sync in flight right now? */
function isRunning() {
  return current !== null;
}

/** Snapshot of the in-flight run, or null. */
function getCurrent() {
  return current ? { ...current } : null;
}

/** Snapshot of the most recent completed run in THIS process, or null. */
function getLastRun() {
  return lastRun ? { ...lastRun } : null;
}

/**
 * Prefix every line of the child's output so it is greppable in the host's
 * logs. Hosted platforms (Railway, Fly, Render, journalctl) only capture the
 * parent's stdout, so without this the scrape would run completely blind.
 */
function pipeWithPrefix(stream, write) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) write('[sync:daily] ' + line);
  });
  stream.on('end', () => {
    if (buffer) write('[sync:daily] ' + buffer);
  });
}

/**
 * Kill the child and everything Playwright spawned under it.
 *
 * Killing only the child PID would orphan the Chromium processes it launched,
 * which then keep the container's memory pinned until it OOMs. On POSIX the
 * child is spawned as its own process-group leader so a negative PID signals
 * the whole tree; Windows has no process groups, so it falls back to killing
 * the child alone (acceptable — the container target is Linux, and locally you
 * can just stop the server).
 */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
      return;
    }
    process.kill(-child.pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        /* already gone */
      }
    }, KILL_GRACE_MS).unref();
  } catch (e) {
    /* already exited */
  }
}

/**
 * Start a daily sync, unless one is already running.
 *
 * @param {object} opts
 * @param {string} opts.source      - label for the logs ('cron-job.org', 'manual', ...)
 * @param {string} [opts.startDate] - optional manual re-run range, YYYY-MM-DD
 * @param {string} [opts.endDate]   - optional manual re-run range, YYYY-MM-DD
 * @returns {{started: boolean, run: object}} started:false means one was already in flight
 */
function start(opts) {
  const { source = 'unknown', startDate, endDate } = opts || {};

  if (current) {
    return { started: false, run: getCurrent() };
  }

  // Passed through as DAILY_* so they can never be confused with the weekly
  // sync's START_DATE/END_DATE, which mean a Mon-Sun week window. Callers are
  // responsible for validating the format — see routes.js.
  const env = { ...process.env };
  if (startDate && endDate) {
    env.DAILY_START_DATE = startDate;
    env.DAILY_END_DATE = endDate;
  } else {
    // Explicitly blank them. A hosted process inherits its whole environment,
    // and a DAILY_START_DATE left set on the host from an earlier manual
    // re-run would otherwise silently pin EVERY nightly run to that old date.
    delete env.DAILY_START_DATE;
    delete env.DAILY_END_DATE;
  }

  const startedAt = nowIso();
  const child = spawn(process.execPath, [SYNC_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // own process group, for killTree()
  });

  pipeWithPrefix(child.stdout, (line) => console.log(line));
  pipeWithPrefix(child.stderr, (line) => console.error(line));

  const range = startDate && endDate ? { start_date: startDate, end_date: endDate } : null;
  current = { startedAt, pid: child.pid, source, range };

  console.log(
    '[trigger] daily sync started pid=' + child.pid + ' source=' + source +
    (range ? ' range=' + range.start_date + '..' + range.end_date : ' range=default')
  );

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    console.error(
      '[trigger] daily sync exceeded ' + TIMEOUT_MS + 'ms — killing pid=' + child.pid +
      '. The lock is released so tomorrow night can still run.'
    );
    killTree(child);
  }, TIMEOUT_MS);
  watchdog.unref();

  const settle = (exitCode, signal) => {
    clearTimeout(watchdog);
    if (!current) return; // already settled ('error' and 'close' can both fire)
    const durationMs = Date.now() - new Date(startedAt).getTime();
    const status = timedOut ? 'timeout' : exitCode === 0 ? 'ok' : 'failed';
    lastRun = {
      startedAt,
      finishedAt: nowIso(),
      status,
      exitCode,
      signal: signal || null,
      durationMs,
      timedOut,
      source,
      range,
    };
    current = null;
    const mins = (durationMs / 60000).toFixed(1);
    if (status === 'ok') {
      console.log('[trigger] daily sync finished ok in ' + mins + 'm');
    } else {
      console.error(
        '[trigger] daily sync ' + status + ' after ' + mins + 'm ' +
        '(exit=' + exitCode + ' signal=' + (signal || 'none') + ')'
      );
    }
  };

  child.on('close', settle);
  child.on('error', (err) => {
    console.error('[trigger] failed to spawn daily sync: ' + err.message);
    settle(null, null);
  });

  return { started: true, run: getCurrent() };
}

module.exports = { start, isRunning, getCurrent, getLastRun };
