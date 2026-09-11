#!/usr/bin/env node
'use strict';

// The Tasks pane: a read-only view of one agent pane's task list.
//
// Which list it shows is fixed when the pane opens. `toggle.js` passes the
// agent pane's id as HERDR_TASKS_TARGET, because by the time this process
// starts, the focused pane is this pane. Without that variable it falls back to
// the pane Herdr reports as focused, which is right when the pane is opened
// unfocused and is the best guess otherwise.
//
// Updates arrive as file writes, so this watches the state directory rather
// than polling Herdr. fs.watch misses events on some filesystems and network
// mounts, so a slow poll runs alongside it as a safety net.

const fs = require('node:fs');

const config = require('../lib/config');
const herdr = require('../lib/herdr');
const paths = require('../lib/paths');
const render = require('../lib/render');
const store = require('../lib/store');

const POLL_MS = 2000;

function resolveTarget() {
  const fromEnv = process.env.HERDR_TASKS_TARGET || paths.fromArgv(process.argv, '--target');
  if (fromEnv) return fromEnv;
  const self = process.env.HERDR_PANE_ID;
  const focused = herdr.focusedPane();
  if (focused && focused.pane_id !== self) return focused.pane_id;
  // Last resort: the nearest agent pane in this tab.
  const agentPane = herdr
    .panes()
    .find((p) => p.agent && p.pane_id !== self && p.tab_id === process.env.HERDR_TAB_ID);
  return agentPane ? agentPane.pane_id : null;
}

const target = resolveTarget();
const settings = config.load();

let offset;            // undefined = follow the active task
let lastSignature = ''; // skip a redraw when nothing changed
let maxOffset = 0;

function size() {
  return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function paint(force = false) {
  const record = target ? store.read(target) : store.empty(null);
  if (target && !record.agent) {
    const live = herdr.pane(target);
    if (live) {
      record.agent = live.display_agent || live.agent || null;
      record.title = record.title || live.label || null;
    }
  }
  const out = render.render(record, size(), settings, { offset });
  maxOffset = out.maxOffset || 0;
  const signature = `${size().columns}x${size().rows}:${out.lines.join('\n')}`;
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  process.stdout.write(`\x1b[H\x1b[2J${out.lines.join('\r\n')}`);
}

function watch() {
  const dir = paths.panesDir();
  fs.mkdirSync(dir, { recursive: true });
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => paint(), 40); // coalesce the rename storm of an atomic write
  };
  try {
    fs.watch(dir, { persistent: true }, schedule).on('error', () => {});
  } catch {
    /* poll only */
  }
  setInterval(() => paint(), POLL_MS);
}

function quit(code = 0) {
  process.stdout.write('\x1b[?25h\x1b[0m\r\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

function keys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    for (const key of data) {
      if (key === 'q' || key === '\x03' || key === '\x04') quit();
      else if (key === 'j') offset = Math.min(maxOffset, (offset ?? 0) + 1);
      else if (key === 'k') offset = Math.max(0, (offset ?? 0) - 1);
      else if (key === 'g') offset = 0;
      else if (key === 'G') offset = maxOffset;
      else if (key === 'f') offset = undefined; // back to following the active task
      else if (key !== 'r') continue;
      paint(true);
    }
  });
}

process.stdout.write('\x1b[?25l'); // a read-only view has nothing to point at
process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());
process.stdout.on('resize', () => paint(true));
keys();
watch();
paint(true);
