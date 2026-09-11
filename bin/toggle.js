#!/usr/bin/env node
'use strict';

// Open / close the Tasks pane, scoped to the current tab. This is what the
// keybinding runs.
//
//   no Tasks pane in this tab -> open a split to the right
//   a Tasks pane in this tab  -> close it
//
// A plain two-state toggle, not the open/focus/close cycle a file viewer wants:
// this pane is read-only, so the useful default is that it appears beside the
// agent WITHOUT stealing focus, and one more press makes it go away. Focus never
// enters the decision, which keeps the key honest no matter where the cursor is.
// Set `focus_on_open = true` in config.toml to have it take focus instead.
//
// The pane is found by its label, which Herdr sets from the manifest pane title.
// PANE_LABEL must stay in step with `title` under [[panes]].

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('../lib/config');
const herdr = require('../lib/herdr');
const paths = require('../lib/paths');

const PANE_LABEL = 'Tasks';

function run(args) {
  return spawnSync(paths.herdrBin(), args, { encoding: 'utf8', stdio: 'ignore', windowsHide: true });
}

// A pane's list outlives the pane, and nothing else is in a position to notice.
// Opening the pane is a rare, already-slow moment, and the pane list is in hand,
// so sweep the lists whose pane is gone rather than pay an event hook for it.
function prune(livePanes) {
  const live = new Set(livePanes.map((p) => path.basename(paths.paneFile(p.pane_id))));
  let dir;
  try {
    dir = fs.readdirSync(paths.panesDir());
  } catch {
    return;
  }
  for (const name of dir) {
    if (!name.endsWith('.json') || live.has(name)) continue;
    try {
      fs.unlinkSync(path.join(paths.panesDir(), name));
    } catch {
      /* someone else got there first */
    }
  }
}

const settings = config.load();
const panes = herdr.panes();
const focused = panes.find((p) => p.focused);
const tabId = (focused && focused.tab_id) || process.env.HERDR_TAB_ID;
const existing = panes.find((p) => p.label === PANE_LABEL && p.tab_id === tabId);

if (panes.length) prune(panes);

if (existing) {
  run(['pane', 'close', existing.pane_id]);
  process.exit(0);
}

// Whose list to show. The pane the key was pressed in is the honest first
// answer, and HERDR_PANE_ID is how Herdr reports it to an action. But the key is
// as likely to be pressed from another plugin's pane as from the agent, and a
// file viewer has no task list, so a context pane with no agent on it defers to
// an agent pane in the same tab.
function pickTarget() {
  const byId = (id) => panes.find((p) => p.pane_id === id) || null;
  const context = byId(process.env.HERDR_PANE_ID) || focused;
  if (!context) return process.env.HERDR_PANE_ID || null;
  if (context.agent) return context.pane_id;
  const agentPane = panes.find((p) => p.agent && p.tab_id === context.tab_id);
  return agentPane ? agentPane.pane_id : context.pane_id;
}

const targetId = pickTarget();

const args = [
  'plugin',
  'pane',
  'open',
  '--plugin',
  paths.PLUGIN_ID,
  '--entrypoint',
  'tasks',
  '--placement',
  'split',
  '--direction',
  'right',
  settings.focus_on_open ? '--focus' : '--no-focus',
];
if (targetId) args.push('--target-pane', targetId, '--env', `HERDR_TASKS_TARGET=${targetId}`);
run(args);
