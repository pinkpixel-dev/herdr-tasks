'use strict';

// Where the plugin keeps its files.
//
// Two of the five entrypoints run OUTSIDE Herdr's plugin runtime: the Claude
// Code hook (Claude spawns it) and the `tasks` CLI (an agent or a human runs
// it). Neither gets HERDR_PLUGIN_STATE_DIR injected, so both accept an explicit
// `--state-dir`, which `configure.js` bakes into the shim and the hook command
// while it still has the injected value. The platform guesses below are the
// last resort for someone running a script by hand.

const os = require('node:os');
const path = require('node:path');

const PLUGIN_ID = 'pinkpixel.herdr-tasks';

function fromArgv(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

function guessStateDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'herdr', 'plugins', PLUGIN_ID);
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'herdr', 'plugins', PLUGIN_ID);
}

function guessConfigDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'herdr', 'plugins', 'config', PLUGIN_ID);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'plugins', 'config', PLUGIN_ID);
}

// argv wins over the environment so a shim with a baked path stays right even
// if it is invoked from inside another plugin's command.
function stateDir(argv = process.argv) {
  return fromArgv(argv, '--state-dir') || process.env.HERDR_PLUGIN_STATE_DIR || guessStateDir();
}

function configDir(argv = process.argv) {
  return fromArgv(argv, '--config-dir') || process.env.HERDR_PLUGIN_CONFIG_DIR || guessConfigDir();
}

// Pane ids look like `w6:p4`, and `:` is not a portable filename character.
function paneFile(paneId, argv = process.argv) {
  const safe = String(paneId).replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(stateDir(argv), 'panes', `${safe}.json`);
}

function panesDir(argv = process.argv) {
  return path.join(stateDir(argv), 'panes');
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

module.exports = {
  PLUGIN_ID,
  configDir,
  fromArgv,
  herdrBin,
  paneFile,
  panesDir,
  stateDir,
};
