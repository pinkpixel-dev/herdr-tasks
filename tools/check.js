#!/usr/bin/env node
'use strict';

// `npm run check`: the parts worth testing without a Herdr server attached.
//
// The store round-trip, the CLI's task matching, the renderer's wrapping and
// windowing, and what setup writes outside the plugin. Everything runs against a
// temporary state directory and a fake HOME, so a run never touches a real task
// list or a real skill directory.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tasks-check-'));
const stateArgs = ['--state-dir', tmp];

const config = require('../lib/config');
const render = require('../lib/render');
const store = require('../lib/store');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    process.stderr.write(`FAIL ${name}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

function cli(args, stdin) {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'tasks.js'), ...stateArgs, ...args], {
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, HERDR_PANE_ID: 'w1:p1' },
  });
}

test('store writes and reads one pane, bumping seq', () => {
  store.write('w1:p2', { ...store.empty('w1:p2'), tasks: [{ text: 'one', status: 'pending' }] }, process.argv.concat(stateArgs));
  const first = store.read('w1:p2', process.argv.concat(stateArgs));
  assert.equal(first.tasks.length, 1);
  assert.equal(first.seq, 1);
  store.update('w1:p2', (cur) => cur, process.argv.concat(stateArgs));
  assert.equal(store.read('w1:p2', process.argv.concat(stateArgs)).seq, 2);
});

test('store gives an empty list for a pane it has never seen', () => {
  assert.deepEqual(store.read('nope:p0', process.argv.concat(stateArgs)).tasks, []);
});

test('cli set / start / done / next walk the list', () => {
  assert.match(cli(['set', 'alpha', 'beta', 'gamma']).stdout, /alpha/);
  assert.match(cli(['start', '2']).stdout, /\[>\] beta/);
  assert.match(cli(['done', '2']).stdout, /\[x\] beta/);
  const next = cli(['next']).stdout;
  assert.match(next, /\[>\] alpha/, 'next starts the first pending task');
});

test('cli matches a task by text as well as by number', () => {
  cli(['set', 'write the manifest', 'wire the hook']);
  assert.match(cli(['done', 'hook']).stdout, /\[x\] wire the hook/);
});

test('cli start clears any other in-progress task', () => {
  cli(['set', 'one', 'two']);
  cli(['start', '1']);
  const out = cli(['start', '2']).stdout;
  assert.match(out, /\[ \] one/);
  assert.match(out, /\[>\] two/);
});

test('cli block keeps the reason and reset drops it', () => {
  cli(['set', 'one']);
  assert.match(cli(['block', '1', 'waiting', 'on', 'review']).stdout, /\[!\] one {2}\(waiting on review\)/);
  assert.match(cli(['reset', '1']).stdout, /\[ \] one$/m);
});

test('cli set - reads a list from stdin, stripping bullets', () => {
  const out = cli(['set', '-'], '- first\n2. second\n\n* third\n').stdout;
  assert.match(out, / 1 \[ \] first/);
  assert.match(out, / 2 \[ \] second/);
  assert.match(out, / 3 \[ \] third/);
});

test('cli set nests an indented line under the task above it', () => {
  const out = cli(['set', '-'], '- parse\n  - tokenizer\n  - grammar\n- test\n').stdout;
  assert.match(out, / 1 \[ \] parse/);
  assert.match(out, /^ {2}1\.1 \[ \] tokenizer$/m);
  assert.match(out, /^ {2}1\.2 \[ \] grammar$/m);
  assert.match(out, / 2 \[ \] test/, 'the list returned to the top level');
});

test('cli sub hangs a subtask off a task, and refuses a second level', () => {
  cli(['set', 'parse', 'test']);
  const out = cli(['sub', '1', 'tokenizer', 'grammar']).stdout;
  assert.match(out, /1\.1 \[ \] tokenizer/);
  assert.match(out, /1\.2 \[ \] grammar/);
  const deeper = cli(['sub', '1.1', 'nope']);
  assert.notEqual(deeper.status, 0, 'a subtask of a subtask was accepted');
  assert.match(deeper.stderr, /one level deep/);
});

test('cli starts a subtask and its parent together, one in progress per level', () => {
  cli(['set', 'parse', 'test']);
  cli(['sub', '1', 'tokenizer', 'grammar']);
  cli(['start', '1.1']);
  const out = cli(['start', '1.2']).stdout;
  assert.match(out, / 1 \[>\] parse/, 'the parent did not follow its subtask');
  assert.match(out, /1\.1 \[ \] tokenizer/, 'the other subtask stayed in progress');
  assert.match(out, /1\.2 \[>\] grammar/);
});

test('cli done on a parent finishes what is left inside it', () => {
  cli(['set', 'parse']);
  cli(['sub', '1', 'tokenizer', 'grammar']);
  const out = cli(['done', '1']).stdout;
  assert.match(out, / 1 \[x\] parse/);
  assert.match(out, /1\.1 \[x\] tokenizer/);
  assert.match(out, /1\.2 \[x\] grammar/);
});

test('cli next walks the subtasks before moving to the next task', () => {
  cli(['set', 'parse', 'test']);
  cli(['sub', '1', 'tokenizer', 'grammar']);

  const first = cli(['next']).stdout;
  assert.match(first, / 1 \[>\] parse/);
  assert.match(first, /1\.1 \[>\] tokenizer/, 'next skipped into the wrong level');

  const second = cli(['next']).stdout;
  assert.match(second, /1\.1 \[x\] tokenizer/);
  assert.match(second, /1\.2 \[>\] grammar/);
  assert.match(second, / 2 \[ \] test/, 'next left the task before its subtasks were done');

  const third = cli(['next']).stdout;
  assert.match(third, / 1 \[x\] parse/);
  assert.match(third, / 2 \[>\] test/);
});

test('cli matches a subtask by text as well as by address', () => {
  cli(['set', 'parse']);
  cli(['sub', '1', 'write the tokenizer']);
  assert.match(cli(['done', 'tokenizer']).stdout, /1\.1 \[x\] write the tokenizer/);
});

test('cli refuses a task that does not exist, without changing the list', () => {
  cli(['set', 'only one']);
  const bad = cli(['done', '7']);
  assert.notEqual(bad.status, 0);
  assert.match(cli(['show']).stdout, /\[ \] only one/);
});

test('cli clear forgets the list', () => {
  cli(['set', 'gone']);
  cli(['clear']);
  assert.match(cli(['show']).stdout, /no tasks/);
});

test('render wraps on width and never loses a word', () => {
  const lines = render.wrap('the quick brown fox jumps over the lazy dog', 12);
  assert.ok(lines.every((l) => render.cellWidth(l) <= 12));
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
});

test('render breaks a word that cannot fit on its own', () => {
  const lines = render.wrap('abcdefghijklmnopqrstuvwxyz', 10);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => render.cellWidth(l) <= 10));
});

test('render fits the frame and keeps the active task on screen', () => {
  const tasks = Array.from({ length: 40 }, (_, i) => ({
    id: String(i + 1),
    text: `task number ${i + 1}`,
    status: i < 30 ? 'completed' : i === 30 ? 'in_progress' : 'pending',
  }));
  const out = render.render(
    { ...store.empty('w1:p1'), agent: 'claude', tasks },
    { columns: 40, rows: 14 },
    config.DEFAULTS,
  );
  assert.equal(out.lines.length, 14);
  assert.ok(out.lines.join('\n').includes('task number 31'), 'the in-progress task is visible');
  assert.ok(out.lines[0].includes('30/40'), 'the tally counts completed tasks');
});

test('render offers the scroll keys only when the list does not fit', () => {
  const short = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), text: `t${i}`, status: 'pending' }));
  const long = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), text: `t${i}`, status: 'pending' }));
  const frame = { columns: 40, rows: 14 };

  const fits = render.render({ ...store.empty('w1:p1'), tasks: short }, frame, config.DEFAULTS);
  assert.equal(fits.maxOffset, 0);
  assert.match(fits.lines.at(-1), /q quit/);
  assert.doesNotMatch(fits.lines.at(-1), /scroll/, 'a list that fits still advertises scrolling');

  const overflows = render.render({ ...store.empty('w1:p1'), tasks: long }, frame, config.DEFAULTS);
  assert.ok(overflows.maxOffset > 0);
  assert.match(overflows.lines.at(-1), /j\/k scroll/);
  assert.doesNotMatch(overflows.lines.at(-1), /f follow/, 'follow is offered before the view is pinned');

  const pinned = render.render({ ...store.empty('w1:p1'), tasks: long }, frame, config.DEFAULTS, { offset: 5 });
  assert.match(pinned.lines.at(-1), /f follow/);
  assert.equal(pinned.lines.length, 14, 'the footer text must not change the frame height');
});

test('store numbers subtasks by their address and stops at one level', () => {
  const record = store.normalize(
    {
      tasks: [
        { text: 'parse', subtasks: [{ text: 'tokenizer', subtasks: [{ text: 'too deep' }] }, { text: '' }] },
        { text: 'test' },
      ],
    },
    'w1:p3',
  );
  assert.equal(record.tasks[0].id, '1');
  assert.equal(record.tasks[0].subtasks.length, 1, 'an empty subtask was kept');
  assert.equal(record.tasks[0].subtasks[0].id, '1.1');
  assert.equal(record.tasks[0].subtasks[0].subtasks, undefined, 'the second level was kept');
  assert.equal(record.tasks[1].id, '2');
});

test('render indents subtasks under their task and counts only the tasks', () => {
  const tasks = [
    {
      id: '1',
      text: 'parse',
      status: 'in_progress',
      subtasks: [
        { id: '1.1', text: 'tokenizer', status: 'completed' },
        { id: '1.2', text: 'grammar', status: 'in_progress' },
      ],
    },
    { id: '2', text: 'test', status: 'pending' },
  ];
  const out = render.render({ ...store.empty('w1:p1'), tasks }, { columns: 40, rows: 12 }, config.DEFAULTS);
  const plain = out.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plain[0].includes('0/2'), 'the tally counted subtasks');
  const parent = plain.find((l) => l.includes('parse'));
  const child = plain.find((l) => l.includes('grammar'));
  assert.equal(parent.indexOf('parse'), 6);
  assert.equal(child.indexOf('grammar'), 8, 'the subtask is not indented one step in');
});

test('render keeps an active subtask on screen with its task', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1),
    text: `task number ${i + 1}`,
    status: i < 20 ? 'completed' : i === 20 ? 'in_progress' : 'pending',
    subtasks: i === 20 ? [{ id: '21.1', text: 'the inner step', status: 'in_progress' }] : undefined,
  }));
  const out = render.render(
    { ...store.empty('w1:p1'), tasks },
    { columns: 40, rows: 14 },
    config.DEFAULTS,
  );
  const body = out.lines.join('\n');
  assert.ok(body.includes('task number 21'));
  assert.ok(body.includes('the inner step'), 'the active subtask scrolled out of view');
});

test('render hides completed subtasks when the config hides completed tasks', () => {
  const tasks = [
    {
      id: '1',
      text: 'parse',
      status: 'in_progress',
      subtasks: [
        { id: '1.1', text: 'tokenizer', status: 'completed' },
        { id: '1.2', text: 'grammar', status: 'in_progress' },
      ],
    },
  ];
  const settings = { ...config.DEFAULTS, show_completed: false };
  const out = render.render({ ...store.empty('w1:p1'), tasks }, { columns: 40, rows: 12 }, settings);
  const body = out.lines.join('\n');
  assert.ok(!body.includes('tokenizer'), 'a completed subtask was still shown');
  assert.ok(body.includes('grammar'));
});

test('render says so when there are no tasks yet', () => {
  const out = render.render(store.empty('w1:p1'), { columns: 40, rows: 10 }, config.DEFAULTS);
  assert.match(out.lines.join('\n'), /Waiting for the agent/);
});

test('config reads a partial file and keeps the other defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tasks-conf-'));
  fs.writeFileSync(
    path.join(dir, 'config.toml'),
    'show_completed = false\n[icons]\npending = "-" # a dash\n[colors]\naccent = "#ff00ff"\n',
  );
  const loaded = config.load(['--config-dir', dir]);
  assert.equal(loaded.show_completed, false);
  assert.equal(loaded.icons.pending, '-');
  assert.equal(loaded.icons.completed, config.DEFAULTS.icons.completed);
  assert.equal(loaded.colors.accent, '#ff00ff');
  assert.equal(loaded.title, 'Tasks');
  fs.rmSync(dir, { recursive: true, force: true });
});

// configure.js writes outside the plugin, so every check below it runs against a
// fake HOME.
function configure(args, home) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'bin', 'configure.js'), ...args, ...stateArgs, '--config-dir', path.join(home, 'config')],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tasks-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.agents'));
  return home;
}

test('configure installs the skill into both skill directories with the CLI path filled in', () => {
  const home = fakeHome();
  assert.equal(configure(['--apply'], home).status, 0);
  for (const dir of ['.claude', '.agents']) {
    const file = path.join(home, dir, 'skills', 'herdr-tasks', 'SKILL.md');
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!body.includes('{{HERDR_TASKS_CLI}}'), `${dir}: placeholder still present`);
    assert.ok(body.includes(path.join(home, 'config', 'herdr-tasks')), `${dir}: shim path missing`);
    assert.ok(fs.existsSync(path.join(home, dir, 'skills', 'herdr-tasks', '.installed-by-herdr-tasks')));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('configure leaves a skill directory it did not write alone, and uninstall keeps it', () => {
  const home = fakeHome();
  const mine = path.join(home, '.agents', 'skills', 'herdr-tasks');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), 'hand written\n');
  configure(['--apply'], home);
  assert.equal(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'hand written\n');
  configure(['--uninstall'], home);
  assert.ok(fs.existsSync(path.join(mine, 'SKILL.md')), 'uninstall deleted a skill it did not install');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'herdr-tasks')), 'its own skill was not removed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('configure adopts an unstamped verbatim copy of its own template', () => {
  const home = fakeHome();
  const copied = path.join(home, '.agents', 'skills', 'herdr-tasks');
  fs.mkdirSync(copied, { recursive: true });
  fs.copyFileSync(path.join(root, 'skills', 'herdr-tasks', 'SKILL.md'), path.join(copied, 'SKILL.md'));
  configure(['--apply'], home);
  const body = fs.readFileSync(path.join(copied, 'SKILL.md'), 'utf8');
  assert.ok(!body.includes('{{HERDR_TASKS_CLI}}'), 'the copied template was left unsubstituted');
  assert.ok(fs.existsSync(path.join(copied, '.installed-by-herdr-tasks')), 'the adopted copy was not stamped');
  fs.rmSync(home, { recursive: true, force: true });
});

test('configure writes a working shim that drives the list', () => {
  const home = fakeHome();
  configure(['--apply'], home);
  const shim = path.join(home, 'config', 'herdr-tasks');
  assert.ok(fs.existsSync(shim), 'no shim was written');
  const run = spawnSync(shim, ['set', 'through the shim'], {
    encoding: 'utf8',
    env: { ...process.env, HERDR_PANE_ID: 'w2:p2' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /through the shim/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('repair does nothing when nothing was installed', () => {
  const home = fakeHome();
  const run = configure(['--repair'], home);
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), '', 'repair must stay silent: it runs on every server start');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'herdr-tasks')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('repair refreshes an installed shim and skill', () => {
  const home = fakeHome();
  configure(['--apply'], home);
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'herdr-tasks', 'SKILL.md'), 'stale\n');
  const run = configure(['--repair'], home);
  assert.match(run.stdout, /Re-pointed/);
  const body = fs.readFileSync(path.join(home, '.claude', 'skills', 'herdr-tasks', 'SKILL.md'), 'utf8');
  assert.ok(body.includes(path.join(home, 'config', 'herdr-tasks')), 'the stale skill was not refreshed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the skill template documents every command the CLI accepts', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'herdr-tasks', 'SKILL.md'), 'utf8');
  for (const command of ['set', 'add', 'sub', 'start', 'done', 'block', 'next', 'show', 'clear']) {
    assert.ok(new RegExp(`CLI}} ${command}\\b`).test(skill), `the skill never shows \`${command}\``);
  }
});

test('the manifest pane title matches the label the toggle looks for', () => {
  const manifest = fs.readFileSync(path.join(root, 'herdr-plugin.toml'), 'utf8');
  const toggle = fs.readFileSync(path.join(root, 'bin', 'toggle.js'), 'utf8');
  const title = /\[\[panes\]\][\s\S]*?title = "([^"]+)"/.exec(manifest);
  const label = /PANE_LABEL = '([^']+)'/.exec(toggle);
  assert.ok(title && label);
  assert.equal(title[1], label[1]);
});

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`${passed} checks passed\n`);
