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
//   tasks sub 2 "a step inside task 2"    append a subtask
//   tasks start 2.1                       mark in progress (clears any other)
//   tasks done 2 3                        mark complete
//   tasks block 4 "waiting on review"     mark blocked, with a reason
//   tasks reset 4                         back to pending
//   tasks next                            complete the active task, start the next
//   tasks show                            print the list
//   tasks clear                           forget the list
//
// A task is addressed by the number `show` prints, a subtask by `parent.child`.
// `--pane <id>` targets another pane; `--title <text>` names the list in the
// pane header.

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

function row(address, task, indent) {
  const note = task.note ? `  (${task.note})` : '';
  return `${indent}${address.padStart(2, ' ')} ${ICONS[task.status]} ${task.text}${note}`;
}

function format(record) {
  if (!record.tasks.length) return 'no tasks';
  const lines = [];
  record.tasks.forEach((task, i) => {
    lines.push(row(String(i + 1), task, ''));
    (task.subtasks || []).forEach((sub, j) => lines.push(row(`${i + 1}.${j + 1}`, sub, '  ')));
  });
  return lines.join('\n');
}

// Every addressable task, in the order `show` prints them. A reference carries
// the task itself, so a caller changes it in place, and its parent, because the
// rules for one task in progress apply within a parent as well as across the
// list.
function references(record) {
  const refs = [];
  record.tasks.forEach((task, i) => {
    refs.push({ address: String(i + 1), parent: null, task });
    (task.subtasks || []).forEach((sub, j) => {
      refs.push({ address: `${i + 1}.${j + 1}`, parent: task, task: sub });
    });
  });
  return refs;
}

// Accepts an address (`2`, `2.1`), `all`, and a bare text match, because an
// agent is as likely to name a task as to count it.
function resolve(record, args) {
  if (!args.length) return [];
  const refs = references(record);
  if (args.length === 1 && args[0] === 'all') return refs;
  const found = [];
  for (const arg of args) {
    const wanted = String(arg).trim();
    const exact = refs.find((ref) => ref.address === wanted);
    if (exact) {
      found.push(exact);
      continue;
    }
    const needle = wanted.toLowerCase();
    const match = refs.find((ref) => ref.task.text.toLowerCase().includes(needle));
    if (!match) fail(`no task matching "${arg}"`);
    found.push(match);
  }
  return found;
}

// An indented line is a subtask of the line above it, which is how both a
// markdown list and a hand-typed plan already read.
function readLines(values) {
  const raw = values.length === 1 && values[0] === '-' ? fs.readFileSync(0, 'utf8').split('\n') : values;
  return raw
    .map((value) => {
      const line = String(value).replace(/\t/g, '  ');
      const depth = /^ */.exec(line)[0].length >= 2 ? 1 : 0;
      return { depth, text: line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim() };
    })
    .filter((line) => line.text);
}

// A flat list of texts, for the commands that cannot nest.
function flatLines(values) {
  return readLines(values).map((line) => line.text);
}

// Turn parsed lines into tasks, hanging each indented line off the last
// top-level one. An indented first line has nothing to hang off, so it stands
// on its own.
function nest(lines) {
  const tasks = [];
  for (const line of lines) {
    if (line.depth && tasks.length) {
      const parent = tasks[tasks.length - 1];
      parent.subtasks = (parent.subtasks || []).concat({ text: line.text, status: 'pending' });
    } else {
      tasks.push({ text: line.text, status: 'pending' });
    }
  }
  return tasks;
}

function demote(task) {
  if (task.status === 'in_progress') task.status = 'pending';
  (task.subtasks || []).forEach((sub) => {
    if (sub.status === 'in_progress') sub.status = 'pending';
  });
}

// One task in progress per level. Starting a subtask also puts its parent in
// progress, so the pane shows both which step you are on and what you are doing
// inside it.
function start(record, ref) {
  const siblings = ref.parent ? ref.parent.subtasks : record.tasks;
  siblings.forEach((task) => {
    if (task !== ref.task) demote(task);
  });
  if (ref.parent) {
    record.tasks.forEach((task) => {
      if (task !== ref.parent) demote(task);
    });
    ref.parent.status = 'in_progress';
  }
  ref.task.status = 'in_progress';
}

// Completing a task completes what is left inside it: a step is not half done
// once you have called it finished.
function complete(task) {
  task.status = 'completed';
  (task.subtasks || []).forEach((sub) => {
    if (sub.status !== 'blocked') sub.status = 'completed';
  });
}

function setStatus(record, refs, status, note) {
  for (const ref of refs) {
    if (status === 'in_progress') start(record, ref);
    else if (status === 'completed') complete(ref.task);
    else ref.task.status = status;
    if (note) ref.task.note = note;
    else delete ref.task.note;
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
    const lines = readLines(rest);
    if (!lines.length) fail('set needs at least one task, or `-` to read them from stdin');
    record = store.update(paneId, (current) => stamp({ ...current, tasks: nest(lines) }), process.argv);
    break;
  }
  case 'add': {
    const lines = readLines(rest);
    if (!lines.length) fail('add needs at least one task');
    record = store.update(
      paneId,
      (current) => stamp({ ...current, tasks: current.tasks.concat(nest(lines)) }),
      process.argv,
    );
    break;
  }
  case 'sub': {
    const [address, ...texts] = rest;
    if (!address) fail('sub needs the task to add to, then the subtask text');
    const lines = flatLines(texts);
    if (!lines.length) fail('sub needs at least one subtask, or `-` to read them from stdin');
    record = store.update(
      paneId,
      (current) => {
        const [ref] = resolve(current, [address]);
        if (ref.parent) fail(`"${ref.address}" is already a subtask: subtasks are only one level deep`);
        ref.task.subtasks = (ref.task.subtasks || []).concat(
          lines.map((text) => ({ text, status: 'pending' })),
        );
        return stamp(current);
      },
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
        const refs = resolve(current, command === 'block' ? rest.slice(0, 1) : rest);
        if (!refs.length) fail(`${command} needs a task number or text`);
        return stamp(setStatus(current, refs, status, note));
      },
      process.argv,
    );
    break;
  }
  case 'next': {
    record = store.update(
      paneId,
      (current) => {
        // Work through the subtasks of the active task before leaving it, so
        // one command walks the whole list from top to bottom.
        const active = current.tasks.find((t) => t.status === 'in_progress');
        if (active && active.subtasks) {
          const sub = active.subtasks.find((t) => t.status === 'in_progress');
          if (sub) sub.status = 'completed';
          const nextSub = active.subtasks.find((t) => t.status === 'pending');
          if (nextSub) {
            nextSub.status = 'in_progress';
            return stamp(current);
          }
        }
        if (active) complete(active);
        const next = current.tasks.find((t) => t.status === 'pending');
        if (next) {
          next.status = 'in_progress';
          const firstSub = (next.subtasks || []).find((t) => t.status === 'pending');
          if (firstSub) firstSub.status = 'in_progress';
        }
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
    fail(`unknown command "${command}" (set, add, sub, start, done, block, reset, next, show, clear)`);
}

process.stdout.write(`${format(record)}\n`);
