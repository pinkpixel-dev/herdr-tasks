#!/usr/bin/env node
'use strict';

// The Claude Code bridge: a PostToolUse hook on TodoWrite.
//
// Claude already keeps a todo list and already checks items off as it works, so
// there is nothing for the agent to learn and nothing extra to call. Every time
// it writes that list, Claude runs this hook with the tool call on stdin, and
// this copies the list into the pane's state file.
//
// Two things this must never do: block the agent or make it read an error. So it
// always exits 0, prints nothing on the happy path, and gives up quietly when
// the payload is not what it expects.
//
// It runs as a child of the agent's shell, so HERDR_PANE_ID is inherited from
// the Herdr pane the agent is running in - that is how the list finds its pane.
// `configure.js` bakes --state-dir into the command, because Herdr's plugin
// environment is not present here.

const store = require('../lib/store');

const STATUS = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  blocked: 'blocked',
};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) done(); // a runaway payload is not our todo list
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000).unref();
  });
}

async function main() {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return; // not inside a Herdr pane: nothing to show

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }

  const tool = payload && payload.tool_name;
  if (tool !== 'TodoWrite') return;

  const todos = payload.tool_input && Array.isArray(payload.tool_input.todos) ? payload.tool_input.todos : null;
  if (!todos) return;

  const tasks = todos.map((todo, i) => ({
    id: String(i + 1),
    text: String(todo.content || '').trim(),
    status: STATUS[todo.status] || 'pending',
    active_form: todo.activeForm || todo.active_form || undefined,
  }));

  store.update(
    paneId,
    (current) => ({ ...current, source: 'claude-code', agent: current.agent || 'claude', tasks }),
    process.argv,
  );
}

main().catch(() => {});
