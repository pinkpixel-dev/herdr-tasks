#!/usr/bin/env node
'use strict';

// `npm run check`: the parts worth testing without a Herdr server attached.
//
// The store round-trip, the CLI's task matching, the renderer's wrapping and
// windowing, and the Claude Code payload mapping. Everything runs against a
// temporary state directory, so a run never touches a real task list.

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

function hook(payload) {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'hook.js'), ...stateArgs], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, HERDR_PANE_ID: 'w1:p9' },
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
  const out = cli(['set', '-'], '- first\n2. second\n\n  * third\n').stdout;
  assert.match(out, / 1 \[ \] first/);
  assert.match(out, / 2 \[ \] second/);
  assert.match(out, / 3 \[ \] third/);
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

test('hook mirrors a TodoWrite payload into the pane list', () => {
  const run = hook({
    tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'read the refs', status: 'completed', activeForm: 'Reading the refs' },
        { content: 'write the pane', status: 'in_progress', activeForm: 'Writing the pane' },
        { content: 'test it', status: 'pending', activeForm: 'Testing it' },
      ],
    },
  });
  assert.equal(run.status, 0);
  const record = store.read('w1:p9', process.argv.concat(stateArgs));
  assert.equal(record.source, 'claude-code');
  assert.equal(record.agent, 'claude');
  assert.deepEqual(
    record.tasks.map((t) => t.status),
    ['completed', 'in_progress', 'pending'],
  );
  assert.equal(record.tasks[1].active_form, 'Writing the pane');
});

test('hook ignores a payload that is not TodoWrite, and bad input', () => {
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
  const junk = spawnSync(process.execPath, [path.join(root, 'bin', 'hook.js'), ...stateArgs], {
    encoding: 'utf8',
    input: 'not json',
    env: { ...process.env, HERDR_PANE_ID: 'w1:pX' },
  });
  assert.equal(junk.status, 0);
  assert.deepEqual(store.read('w1:pX', process.argv.concat(stateArgs)).tasks, []);
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
// fake HOME and a fake settings file.
function configure(args, home) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'bin', 'configure.js'), ...args, ...stateArgs, '--config-dir', path.join(home, 'config'), '--settings', path.join(home, 'settings.json')],
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

test('configure keeps an unrelated hook and its own is removable', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
  );
  configure(['--apply'], home);
  let settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 2);
  configure(['--uninstall'], home);
  settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'echo mine');
  fs.rmSync(home, { recursive: true, force: true });
});

test('repair does nothing when nothing was installed', () => {
  const home = fakeHome();
  const run = configure(['--repair'], home);
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), '');
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'herdr-tasks')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('the skill template documents every command the CLI accepts', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'herdr-tasks', 'SKILL.md'), 'utf8');
  for (const command of ['set', 'add', 'start', 'done', 'block', 'next', 'show', 'clear']) {
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
