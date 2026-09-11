#!/usr/bin/env node
'use strict';

// Setup and teardown, run as a plugin action so it only happens when asked.
//
// Three things live here, and each one writes somewhere the plugin does not own,
// which is exactly why none of them happen automatically:
//
//   1. config.toml is seeded into HERDR_PLUGIN_CONFIG_DIR (never overwritten).
//   2. A `herdr-tasks` shim is written into that same directory, with this
//      checkout's paths baked in. The config directory is stable across
//      reinstalls, the plugin root is not, so the shim is the path to hand to an
//      agent or to put on PATH.
//   3. A PostToolUse hook on TodoWrite is added to Claude Code's user settings.
//      That is the whole Claude Code integration: no prompt, no skill, no
//      instructions for the agent to follow.
//   4. The herdr-tasks skill is copied into the user's skill directories, with
//      the shim's real path substituted in, so an agent that is not Claude Code
//      can find the CLI without being told about it in every project.
//
//   --apply      (default) do all three
//   --uninstall  remove the hook and the shim, keep config.toml and state
//   --repair     re-point an existing hook and shim at this checkout, and do
//                nothing at all if the hook was never installed. This is what
//                the startup hook runs, so a reinstall into a new managed
//                directory fixes itself.
//
// Claude Code's settings file is merged, never rewritten: the previous contents
// are copied to settings.json.herdr-tasks.bak, every unrelated hook is kept, and
// our own entry is recognised by the --herdr-tasks-hook marker rather than by
// guessing at paths. The installed skill directory is marked the same way, with a
// STAMP file, so removal can never delete a skill the user wrote themselves.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../lib/paths');

const MARKER = '--herdr-tasks-hook';
const EVENT = 'PostToolUse';
const TOOL = 'TodoWrite';
const SKILL = 'herdr-tasks';
const STAMP = '.installed-by-herdr-tasks';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const mode = has('--uninstall') ? 'uninstall' : has('--repair') ? 'repair' : 'apply';

const root = process.env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..');
const configDir = paths.configDir(process.argv);
const stateDir = paths.stateDir(process.argv);
const marked = (file) => path.join(configDir, file);

// A caller that pipes this into `head` closes stdout early. That is not a failure.
process.stdout.on('error', () => {});

const log = (line) => process.stdout.write(`${line}\n`);

// --- Claude Code settings ----------------------------------------------------

function settingsPath() {
  const explicit = paths.fromArgv(process.argv, '--settings');
  if (explicit) return explicit;
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

function hookCommand() {
  // An argv-style command with absolute paths: no shell quoting, no cwd
  // assumption, and nothing that depends on Herdr's environment being present.
  return [
    JSON.stringify(process.execPath),
    JSON.stringify(path.join(root, 'bin', 'hook.js')),
    MARKER,
    '--state-dir',
    JSON.stringify(stateDir),
  ].join(' ');
}

function isOurs(entry) {
  return !!entry && typeof entry.command === 'string' && entry.command.includes(MARKER);
}

function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.herdr-tasks.bak`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function loadSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`${file} is not readable JSON; fix or move it, then run this again`);
  }
}

function installHook({ onlyIfPresent }) {
  const file = settingsPath();
  const settings = loadSettings(file);
  const hooks = (settings.hooks = settings.hooks || {});
  const matchers = (hooks[EVENT] = Array.isArray(hooks[EVENT]) ? hooks[EVENT] : []);

  const present = matchers.some((m) => (m.hooks || []).some(isOurs));
  if (onlyIfPresent && !present) return false;

  let matcher = matchers.find((m) => m && m.matcher === TOOL);
  if (!matcher) {
    matcher = { matcher: TOOL, hooks: [] };
    matchers.push(matcher);
  }
  matcher.hooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];

  const entry = { type: 'command', command: hookCommand(), timeout: 5 };
  const mine = matcher.hooks.findIndex(isOurs);
  if (mine >= 0) matcher.hooks[mine] = entry;
  else matcher.hooks.push(entry);

  // A stale copy can sit under a different matcher after a hand edit.
  for (const m of matchers) {
    if (m === matcher) continue;
    m.hooks = (m.hooks || []).filter((h) => !isOurs(h));
  }
  hooks[EVENT] = matchers.filter((m) => (m.hooks || []).length);

  writeSettings(file, settings);
  return true;
}

function removeHook() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return false;
  const settings = loadSettings(file);
  const matchers = settings.hooks && Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : [];
  let removed = false;
  for (const m of matchers) {
    const before = (m.hooks || []).length;
    m.hooks = (m.hooks || []).filter((h) => !isOurs(h));
    if (m.hooks.length !== before) removed = true;
  }
  if (!removed) return false;
  settings.hooks[EVENT] = matchers.filter((m) => (m.hooks || []).length);
  if (!settings.hooks[EVENT].length) delete settings.hooks[EVENT];
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeSettings(file, settings);
  return true;
}

// --- The CLI shim ------------------------------------------------------------

function installShim() {
  fs.mkdirSync(configDir, { recursive: true });
  const cli = path.join(root, 'bin', 'tasks.js');
  const unix = marked('herdr-tasks');
  fs.writeFileSync(
    unix,
    `#!/bin/sh\n# Written by herdr-tasks configure. Paths are baked in; re-run the\n` +
      `# plugin's "Set up" action after a reinstall to refresh them.\nexec ${JSON.stringify(
        process.execPath,
      )} ${JSON.stringify(cli)} --state-dir ${JSON.stringify(stateDir)} --config-dir ${JSON.stringify(
        configDir,
      )} "$@"\n`,
    'utf8',
  );
  fs.chmodSync(unix, 0o755);

  const win = marked('herdr-tasks.cmd');
  fs.writeFileSync(
    win,
    `@echo off\r\n"${process.execPath}" "${cli}" --state-dir "${stateDir}" --config-dir "${configDir}" %*\r\n`,
    'utf8',
  );
  return unix;
}

function removeShim() {
  for (const file of ['herdr-tasks', 'herdr-tasks.cmd']) {
    try {
      fs.unlinkSync(marked(file));
    } catch {
      /* not there */
    }
  }
}

// --- The agent skill --------------------------------------------------------

// Both directories are read by agents, both are plain directories on disk, and
// neither needs a lock file entry. Only the ones whose parent already exists are
// written: creating ~/.agents for someone who does not use it would be presumptuous.
function skillTargets() {
  const home = os.homedir();
  return [path.join(home, '.claude'), path.join(home, '.agents')]
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.join(dir, 'skills', SKILL));
}

// An unstamped directory is treated as the user's own work and left alone, with
// one exception: a SKILL.md that is byte-identical to this plugin's template was
// copied out of the plugin (a skill-sync tool, a manual cp) and still has the
// {{HERDR_TASKS_CLI}} placeholder in it, which is useless to an agent. Nobody
// authors a verbatim copy of our own file, so adopting it is safe and fixes a
// copy that would otherwise stay broken.
function adoptable(target, template) {
  try {
    return fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8') === template;
  } catch {
    return false;
  }
}

function installSkill({ onlyIfPresent }) {
  const source = path.join(root, 'skills', SKILL, 'SKILL.md');
  if (!fs.existsSync(source)) return [];
  const template = fs.readFileSync(source, 'utf8');
  const cli = marked('herdr-tasks');
  const body = template.split('{{HERDR_TASKS_CLI}}').join(cli);

  const written = [];
  for (const target of skillTargets()) {
    const stamp = path.join(target, STAMP);
    const exists = fs.existsSync(target);
    // Someone else's skill of the same name, unless it is a verbatim copy of ours.
    if (exists && !fs.existsSync(stamp) && !adoptable(target, template)) continue;
    if (onlyIfPresent && !exists) continue;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), body, 'utf8');
    fs.writeFileSync(stamp, `${paths.PLUGIN_ID}\n`, 'utf8');
    written.push(target);
  }
  return written;
}

function removeSkill() {
  const removed = [];
  for (const target of skillTargets()) {
    if (!fs.existsSync(path.join(target, STAMP))) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

// --- config.toml ------------------------------------------------------------

function seedConfig() {
  fs.mkdirSync(configDir, { recursive: true });
  const target = marked('config.toml');
  if (fs.existsSync(target)) return false;
  const example = path.join(root, 'config.example.toml');
  if (!fs.existsSync(example)) return false;
  fs.copyFileSync(example, target);
  return true;
}

// --- run --------------------------------------------------------------------

try {
  if (mode === 'uninstall') {
    log(removeHook() ? 'Removed the Claude Code TodoWrite hook.' : 'No Claude Code hook was installed.');
    const gone = removeSkill();
    if (gone.length) log(`Removed the skill from ${gone.join(' and ')}`);
    removeShim();
    log(`Removed the herdr-tasks shim. config.toml and saved lists are untouched in ${configDir}`);
  } else if (mode === 'repair') {
    if (installHook({ onlyIfPresent: true })) {
      installShim();
      installSkill({ onlyIfPresent: true });
      log('Re-pointed the Claude Code hook, the shim and the skill at this checkout.');
    }
    // Nothing installed: stay silent, this runs on every server start.
  } else {
    const seeded = seedConfig();
    const shim = installShim();
    installHook({ onlyIfPresent: false });
    const skills = installSkill({ onlyIfPresent: false });
    log(`Claude Code hook installed in ${settingsPath()}`);
    log(`CLI for other agents: ${shim}`);
    log(skills.length ? `Skill installed in ${skills.join(' and ')}` : 'No skill directory found, so the skill was not installed.');
    log(seeded ? `Config seeded at ${marked('config.toml')}` : `Config kept at ${marked('config.toml')}`);
    log('');
    log('Bind the pane to a key in ~/.config/herdr/config.toml:');
    log('');
    log('  [[keys.command]]');
    log('  key = "prefix+t"');
    log('  type = "plugin_action"');
    log(`  command = "${paths.PLUGIN_ID}.toggle"`);
    log('  description = "toggle the task list pane"');
    log('');
    log('Then reload with: herdr server reload-config');
    log('Restart Claude Code (or start a new session) for the hook to load.');
  }
} catch (err) {
  process.stderr.write(`herdr-tasks configure: ${err.message}\n`);
  process.exit(1);
}
