# Changelog

## 0.2.0 - September 19, 2026

Subtasks. A step that breaks into pieces can now carry its parts, one level deep, without the list turning into a wall of steps.

### ✨ Added

- Subtasks on any task, addressed as `parent.child`. `start`, `done`, `block` and `reset` take that address, and a text argument matches a subtask as well as a task.
- A `sub` command: `herdr-tasks sub 2 "the tokenizer" "the grammar rules"` hangs subtasks off task 2.
- Indented lines in `set` and `add` become subtasks of the line above, so a markdown list piped on stdin keeps its shape.
- The pane draws subtasks indented under their task, in the same block, so the scroll window never separates a task from its parts.

### 🎨 Behaviour

- Starting a subtask starts the task holding it, and one task stays in progress at each level.
- `done` on a task completes the subtasks left inside it, skipping any that are blocked.
- `next` works through a task's subtasks before it moves to the next task.
- The header count and the progress bar still count tasks, not subtasks. A step with six subtasks is one step of progress.
- `show_completed = false` hides completed subtasks as well as completed tasks.

### 🧹 Maintenance

- A task's `id` on disk is now its address (`2`, `2.1`), derived from its position instead of whatever was written before, so the file and the pane cannot disagree.
- `tools/check.js` is up to 33 checks, 10 of them covering subtasks in the store, the CLI and the renderer.

## 0.1.0 - September 11, 2026

First release.

The `TodoWrite` hook that an earlier draft carried is not in it. `TodoWrite` is disabled by default in current Claude Code, replaced by `TaskCreate`, `TaskGet`, `TaskList` and `TaskUpdate`, and a session with none of those enabled gives a hook nothing to fire on. Every agent publishes its list through the CLI instead.

### ✨ Added

- A `Tasks` split pane that shows one agent pane's task list and redraws when it changes. A list longer than the pane scrolls itself to keep the in-progress task visible, and the footer offers the manual scroll keys only when there is something below the fold.
- A `toggle` action for the pane: open beside the focused pane, or close the one already open in this tab. Opens without taking focus.
- A `herdr-tasks` CLI for any agent: `set`, `add`, `start`, `done`, `block`, `reset`, `next`, `show`, `clear`.
- A bundled `herdr-tasks` skill, installed into `~/.claude/skills` and `~/.agents/skills` by the setup action with the real CLI path filled in, so an agent learns the commands without a per-project note. A skill directory the plugin did not install is left alone, unless it holds an unmodified copy of the plugin's own template.
- Setup and teardown actions that install or remove the skill and the CLI shim, seed `config.toml`, and print the keybinding to add.
- A startup hook that re-points an installed shim and refreshes the installed skill after a reinstall.
- `config.toml` support for the heading, focus on open, completed tasks, the progress bar, active-task following, state glyphs, and colors.
- `tools/check.js`, 23 checks covering the store, the CLI, the renderer, the config reader, and what setup writes outside the plugin.
