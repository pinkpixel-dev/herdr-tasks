'use strict';

// The task list for one pane, on disk.
//
// One JSON file per agent pane under <state>/panes/. Writers are short-lived
// (a hook invocation, a CLI call) and the reader is the pane UI watching the
// directory, so every write is atomic: write a temp file next to the target,
// then rename over it. A reader never sees half a list.
//
// `seq` exists because the Claude Code hook and the CLI can both write the same
// pane. A writer that is behind what is already on disk is ignored rather than
// allowed to resurrect an older list.

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

const STATUSES = ['pending', 'in_progress', 'completed', 'blocked'];
const VERSION = 1;

function empty(paneId) {
  return {
    version: VERSION,
    pane_id: paneId,
    source: null,
    agent: null,
    title: null,
    seq: 0,
    updated_at: 0,
    tasks: [],
  };
}

function normalizeTask(raw, index) {
  const text = String(raw && raw.text !== undefined ? raw.text : raw && raw.content ? raw.content : '').trim();
  const status = STATUSES.includes(raw && raw.status) ? raw.status : 'pending';
  const task = { id: String((raw && raw.id) || index + 1), text, status };
  const note = raw && raw.note ? String(raw.note).trim() : '';
  if (note) task.note = note;
  const active = raw && raw.active_form ? String(raw.active_form).trim() : '';
  if (active) task.active_form = active;
  return task;
}

function normalize(data, paneId) {
  const base = empty(paneId);
  if (!data || typeof data !== 'object') return base;
  const tasks = Array.isArray(data.tasks) ? data.tasks.map(normalizeTask).filter((t) => t.text) : [];
  return {
    ...base,
    source: data.source || null,
    agent: data.agent || null,
    title: data.title || null,
    seq: Number.isFinite(data.seq) ? data.seq : 0,
    updated_at: Number.isFinite(data.updated_at) ? data.updated_at : 0,
    tasks,
  };
}

function read(paneId, argv) {
  const file = paths.paneFile(paneId, argv);
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')), paneId);
  } catch {
    // Missing, unreadable, or mid-rename: an empty list is the honest answer.
    return empty(paneId);
  }
}

function write(paneId, next, argv) {
  const file = paths.paneFile(paneId, argv);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = normalize({ ...next, seq: (next.seq || 0) + 1, updated_at: Date.now() }, paneId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return record;
}

// Read, change, write as one step. `mutate` receives the current record and
// either changes it in place or returns a replacement.
function update(paneId, mutate, argv) {
  const current = read(paneId, argv);
  const next = mutate(current) || current;
  return write(paneId, next, argv);
}

function clear(paneId, argv) {
  try {
    fs.unlinkSync(paths.paneFile(paneId, argv));
  } catch {
    /* already gone */
  }
}

module.exports = { STATUSES, clear, empty, normalize, read, update, write };
