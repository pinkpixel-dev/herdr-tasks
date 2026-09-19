#!/usr/bin/env node
'use strict';

// Setup and teardown, run as a plugin action so it only happens when asked.
//
// Two things live here, and both write somewhere the plugin does not own, which
// is why neither happens automatically:
//
//   1. A `herdr-tasks` shim in HERDR_PLUGIN_CONFIG_DIR, with this checkout's
//      paths baked in. The config directory is stable across reinstalls, the
//      plugin root is not, so the shim is the path to hand to an agent or to put
//      on PATH. config.toml is seeded into the same directory, never overwritten.
//   2. The herdr-tasks skill, copied into the user's skill directories with the
//      shim's real path substituted in. That is how an agent finds the CLI
//      without being told about it in every project.
//
//   --apply      (default) do both
//   --uninstall  remove the skill and the shim, keep config.toml and state
//   --repair     re-point an installed shim and skill at this checkout, and do
//                nothing when nothing is installed. This is what the startup hook
//                runs, so a reinstall into a new managed directory fixes itself.
//
// Installed skill directories are marked with a STAMP file, so removal can never
// delete a skill the user wrote themselves.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../lib/paths');

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

function shimInstalled() {
  return fs.existsSync(marked('herdr-tasks'));
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
    const gone = removeSkill();
    log(gone.length ? `Removed the skill from ${gone.join(' and ')}` : 'No skill was installed by this plugin.');
    removeShim();
    log(`Removed the herdr-tasks shim. config.toml and saved lists are untouched in ${configDir}`);
  } else if (mode === 'repair') {
    // Silent by default: this runs on every server start.
    if (shimInstalled()) {
      installShim();
      installSkill({ onlyIfPresent: true });
      log('Re-pointed the shim and the skill at this checkout.');
    }
  } else {
    const seeded = seedConfig();
    const shim = installShim();
    const skills = installSkill({ onlyIfPresent: false });
    log(`CLI for your agents: ${shim}`);
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
  }
} catch (err) {
  process.stderr.write(`herdr-tasks configure: ${err.message}\n`);
  process.exit(1);
}
