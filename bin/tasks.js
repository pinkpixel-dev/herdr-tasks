#!/usr/bin/env node
'use strict';

// The agent-facing CLI: the path for any agent that is not Claude Code, and for
// a human who wants to drive the pane by hand.
//
// Every subcommand acts on one pane's list, defaulting to $HERDR_PANE_ID, so an
// agent running inside a Herdr pane needs no id and no setup. Output is a plain
// text re-print of the list, which is also what an agent reads back.
//
//   tasks set "first" "second" "third"    replace the list
//   tasks set -                           ... reading one task per line from stdin
//   tasks add "another"                   append
//   tasks start 2                         mark in progress (clears any other)
//   tasks done 2 3                        mark complete
//   tasks block 4 "waiting on review"     mark blocked, with a reason
//   tasks reset 4                         back to pending
//   tasks next                            complete the active task, start the next
//   tasks show                            print the list
//   tasks clear                           forget the list
//
// Task numbers are the positions `show` prints. `--pane <id>` targets another
// pane; `--title <text>` names the list in the pane header.

const fs = require('node:fs');

const paths = require('../lib/paths');
const store = require('../lib/store');

// A caller that pipes this into `head` closes stdout early. That is not a failure.
process.stdout.on('error', () => {});

const ICONS = { pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' };

function fail(message) {
  process.stderr.write(`herdr-tasks: ${message}\n`);
  process.exit(1);
}

// Strip the flags paths/store read so what is left is positional.
function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pane' || arg === '--title' || arg === '--state-dir' || arg === '--config-dir') {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function format(record) {
  if (!record.tasks.length) return 'no tasks';
  return record.tasks
    .map((task, i) => {
      const note = task.note ? `  (${task.note})` : '';
      return `${String(i + 1).padStart(2, ' ')} ${ICONS[task.status]} ${task.text}${note}`;
    })
    .join('\n');
}

// Accepts 1-based positions, `all`, and a bare text match, because an agent is
// as likely to name a task as to count it.
function indexesFor(record, args) {
  if (!args.length) return [];
  if (args.length === 1 && args[0] === 'all') return record.tasks.map((_, i) => i);
  const found = [];
  for (const arg of args) {
    const n = Number(arg);
    if (Number.isInteger(n) && n >= 1 && n <= record.tasks.length) {
      found.push(n - 1);
      continue;
    }
    const needle = String(arg).toLowerCase();
    const match = record.tasks.findIndex((t) => t.text.toLowerCase().includes(needle));
    if (match < 0) fail(`no task matching "${arg}"`);
    found.push(match);
  }
  return found;
}

function readLines(values) {
  if (values.length === 1 && values[0] === '-') {
    return fs
      .readFileSync(0, 'utf8')
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
  }
  return values.map((v) => v.trim()).filter(Boolean);
}

function setStatus(record, indexes, status, note) {
  if (status === 'in_progress') {
    record.tasks.forEach((task) => {
      if (task.status === 'in_progress') task.status = 'pending';
    });
  }
  for (const i of indexes) {
    record.tasks[i].status = status;
    if (note) record.tasks[i].note = note;
    else delete record.tasks[i].note;
  }
  return record;
}

const { flags, rest } = parse(process.argv.slice(2));
const command = rest.shift() || 'show';
const paneId = flags.pane || process.env.HERDR_PANE_ID;
if (!paneId) fail('no pane: run this inside a Herdr pane, or pass --pane <id>');

const stamp = (record) => ({
  ...record,
  source: record.source === 'claude-code' ? 'cli' : record.source || 'cli',
  title: flags.title || record.title,
});

let record;
switch (command) {
  case 'set': {
    const texts = readLines(rest);
    if (!texts.length) fail('set needs at least one task, or `-` to read them from stdin');
    record = store.update(
      paneId,
      (current) =>
        stamp({
          ...current,
          tasks: texts.map((text, i) => ({ id: String(i + 1), text, status: 'pending' })),
        }),
      process.argv,
    );
    break;
  }
  case 'add': {
    const texts = readLines(rest);
    if (!texts.length) fail('add needs at least one task');
    record = store.update(
      paneId,
      (current) =>
        stamp({
          ...current,
          tasks: current.tasks.concat(
            texts.map((text, i) => ({ id: String(current.tasks.length + i + 1), text, status: 'pending' })),
          ),
        }),
      process.argv,
    );
    break;
  }
  case 'start':
  case 'done':
  case 'block':
  case 'reset': {
    const status = { start: 'in_progress', done: 'completed', block: 'blocked', reset: 'pending' }[command];
    const note = command === 'block' ? rest.slice(1).join(' ') : '';
    record = store.update(
      paneId,
      (current) => {
        const indexes = indexesFor(current, command === 'block' ? rest.slice(0, 1) : rest);
        if (!indexes.length) fail(`${command} needs a task number or text`);
        return stamp(setStatus(current, indexes, status, note));
      },
      process.argv,
    );
    break;
  }
  case 'next': {
    record = store.update(
      paneId,
      (current) => {
        const active = current.tasks.findIndex((t) => t.status === 'in_progress');
        if (active >= 0) current.tasks[active].status = 'completed';
        const next = current.tasks.findIndex((t) => t.status === 'pending');
        if (next >= 0) current.tasks[next].status = 'in_progress';
        return stamp(current);
      },
      process.argv,
    );
    break;
  }
  case 'clear':
    store.clear(paneId, process.argv);
    process.stdout.write('cleared\n');
    process.exit(0);
    break;
  case 'show':
    record = store.read(paneId, process.argv);
    break;
  default:
    fail(`unknown command "${command}" (set, add, start, done, block, reset, next, show, clear)`);
}

process.stdout.write(`${format(record)}\n`);
