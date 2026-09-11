'use strict';

// Talking to the running Herdr server through its CLI.
//
// The CLI, not the socket: every call here is one request and one response, and
// the CLI already handles the Unix-socket / named-pipe difference. Responses are
// newline JSON shaped `{ id, result }` or `{ id, error }`.

const { spawnSync } = require('node:child_process');

const paths = require('./paths');

function call(args) {
  const run = spawnSync(paths.herdrBin(), args, { encoding: 'utf8', windowsHide: true });
  if (run.error || run.status !== 0) return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed && parsed.result ? parsed.result : null;
  } catch {
    return null;
  }
}

function panes() {
  const result = call(['pane', 'list']);
  return result && Array.isArray(result.panes) ? result.panes : [];
}

function pane(paneId) {
  return panes().find((p) => p.pane_id === paneId) || null;
}

function focusedPane() {
  return panes().find((p) => p.focused) || null;
}

module.exports = { call, focusedPane, pane, panes };
