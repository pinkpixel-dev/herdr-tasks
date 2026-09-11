'use strict';

// Turning a task list into the lines the pane prints.
//
// Pure: it takes a record, a size, and a config, and returns an array of
// strings. That keeps every layout decision (wrapping, the scroll window, the
// progress bar) testable without a terminal attached.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function fg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

// Width in terminal cells, near enough for task text: every CJK/emoji range we
// are likely to meet is double width, and a combining mark is zero.
function cellWidth(text) {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || cp === 0xfe0f) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function truncate(text, max) {
  if (cellWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

// Greedy word wrap on cell width, breaking a word that cannot fit alone.
function wrap(text, max) {
  if (max < 2) return [text];
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (cellWidth(candidate) <= max) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (cellWidth(word) <= max) {
      line = word;
      continue;
    }
    let rest = word;
    while (cellWidth(rest) > max) {
      let chunk = '';
      for (const ch of rest) {
        if (cellWidth(chunk + ch) > max) break;
        chunk += ch;
      }
      lines.push(chunk);
      rest = rest.slice(chunk.length);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function counts(tasks) {
  const done = tasks.filter((t) => t.status === 'completed').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  return { blocked, done, total: tasks.length };
}

function bar(done, total, width, accent) {
  if (width < 4 || total === 0) return '';
  const filled = Math.round((done / total) * width);
  return `${fg(accent)}${'━'.repeat(filled)}${RESET}${DIM}${'━'.repeat(width - filled)}${RESET}`;
}

// One task becomes one or more display lines, already styled.
function taskLines(task, index, width, config) {
  const icon = config.icons[task.status] || config.icons.pending;
  const number = `${String(index + 1).padStart(2, ' ')}`;
  const indent = ' '.repeat(number.length + 4);
  const text = task.status === 'in_progress' && task.active_form ? task.active_form : task.text;
  const body = wrap(text, Math.max(8, width - indent.length));

  let colour = '';
  let weight = '';
  if (task.status === 'completed') colour = fg(config.colors.done);
  if (task.status === 'blocked') colour = fg(config.colors.blocked);
  if (task.status === 'in_progress') {
    colour = fg(config.colors.accent);
    weight = BOLD;
  }

  const head = `${DIM}${number}${RESET} ${colour}${icon}${RESET}  ${colour}${weight}${body[0]}${RESET}`;
  const rest = body.slice(1).map((line) => `${indent}${colour}${weight}${line}${RESET}`);
  const lines = [head, ...rest];
  if (task.note) {
    for (const line of wrap(`↳ ${task.note}`, Math.max(8, width - indent.length))) {
      lines.push(`${indent}${DIM}${line}${RESET}`);
    }
  }
  return lines;
}

// The scroll window: keep the in-progress task visible, otherwise show the top.
function windowFor(blocks, height, activeBlock, follow) {
  const flat = [];
  blocks.forEach((lines, i) => lines.forEach(() => flat.push(i)));
  if (flat.length <= height) return { offset: 0 };
  if (!follow || activeBlock < 0) return { offset: 0 };
  const start = flat.indexOf(activeBlock);
  const end = flat.lastIndexOf(activeBlock);
  let offset = 0;
  if (end >= height) offset = Math.min(flat.length - height, start - Math.floor(height / 3));
  return { offset: Math.max(0, offset) };
}

function render(record, size, config, options = {}) {
  const width = Math.max(24, size.columns || 80);
  const height = Math.max(6, size.rows || 24);
  const accent = fg(config.colors.accent);

  const visible = config.show_completed
    ? record.tasks
    : record.tasks.filter((t) => t.status !== 'completed');
  const { done, total } = counts(record.tasks);

  const tally = total ? `${done}/${total}` : 'no tasks';
  const label = truncate(record.title || config.title, Math.max(6, width - tally.length - 4));
  const who = truncate(
    [record.agent, record.pane_id].filter(Boolean).join(' · '),
    Math.max(0, width - cellWidth(label) - tally.length - 5),
  );
  const pad = Math.max(1, width - cellWidth(label) - cellWidth(who) - tally.length - (who ? 3 : 1));
  const lines = [
    `${accent}${BOLD}${label}${RESET}${who ? `  ${DIM}${who}${RESET}` : ''}${' '.repeat(pad)}${DIM}${tally}${RESET}`,
  ];

  lines.push(config.show_progress_bar ? bar(done, total, width - 1, config.colors.accent) : `${DIM}${'─'.repeat(width - 1)}${RESET}`);
  lines.push('');

  const footer = options.footer === false ? [] : ['', `${DIM}q quit · j/k scroll · g top${RESET}`];
  const room = height - lines.length - footer.length;

  if (!total) {
    lines.push(`${DIM}Waiting for the agent's task list…${RESET}`);
    return { lines: lines.concat(footer), offset: 0 };
  }

  const blocks = visible.map((task, i) => taskLines(task, record.tasks.indexOf(task), width - 1, config));
  const activeBlock = visible.findIndex((t) => t.status === 'in_progress');
  const { offset } =
    options.offset === undefined
      ? windowFor(blocks, room, activeBlock, config.follow_active)
      : { offset: options.offset };

  const flat = blocks.flat();
  const clamped = Math.max(0, Math.min(offset, Math.max(0, flat.length - room)));
  lines.push(...flat.slice(clamped, clamped + room));

  return { lines: lines.concat(footer), maxOffset: Math.max(0, flat.length - room), offset: clamped };
}

module.exports = { cellWidth, counts, render, truncate, wrap };
