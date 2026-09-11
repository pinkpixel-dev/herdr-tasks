'use strict';

// The plugin's own config file: <config dir>/config.toml, every key optional.
//
// Node ships no TOML parser and this file is a handful of hand-written keys, so
// a subset reader beats a dependency: scalars, string arrays, and one level of
// [table]. A missing or malformed file falls back to the defaults rather than
// leaving the pane blank.

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

const DEFAULTS = {
  title: 'Tasks',
  show_completed: true,
  show_progress_bar: true,
  follow_active: true,
  focus_on_open: false,
  icons: {
    pending: '○',
    in_progress: '▸',
    completed: '✔',
    blocked: '⊘',
  },
  colors: {
    accent: '#7dd3fc', // the active task, the progress bar, the header rule
    done: '#71717a', // completed rows
    blocked: '#f87171',
  },
};

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw) {
  const text = raw.trim();
  if (!text) return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) return text.slice(1, -1);
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((part) => parseValue(part))
      .filter((v) => v !== undefined);
  }
  return text;
}

function parseToml(text) {
  const root = {};
  let table = root;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim().replace(/^"|"$/g, '');
      if (typeof root[name] !== 'object' || root[name] === null) root[name] = {};
      table = root[name];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    const value = parseValue(line.slice(eq + 1));
    if (key && value !== undefined) table[key] = value;
  }
  return root;
}

function pick(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function load(argv = process.argv) {
  let raw = {};
  try {
    raw = parseToml(fs.readFileSync(path.join(paths.configDir(argv), 'config.toml'), 'utf8'));
  } catch {
    /* no config file, or an unreadable one: defaults */
  }
  return {
    title: pick(raw.title, DEFAULTS.title),
    show_completed: pick(raw.show_completed, DEFAULTS.show_completed),
    show_progress_bar: pick(raw.show_progress_bar, DEFAULTS.show_progress_bar),
    follow_active: pick(raw.follow_active, DEFAULTS.follow_active),
    focus_on_open: pick(raw.focus_on_open, DEFAULTS.focus_on_open),
    icons: { ...DEFAULTS.icons, ...(raw.icons || {}) },
    colors: { ...DEFAULTS.colors, ...(raw.colors || {}) },
  };
}

module.exports = { DEFAULTS, load, parseToml };
