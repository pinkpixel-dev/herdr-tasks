# Changelog

## 0.1.0 - September 11, 2026

First release.

### ✨ Added

- A `Tasks` split pane that shows one agent pane's task list and redraws when it changes.
- A `toggle` action for the pane: open beside the focused pane, or close the one already open in this tab. Opens without taking focus.
- A Claude Code `PostToolUse` hook on `TodoWrite`, so Claude's own todo list appears in the pane with no change to how the agent works.
- A `herdr-tasks` CLI for every other agent: `set`, `add`, `start`, `done`, `block`, `reset`, `next`, `show`, `clear`.
- A bundled `herdr-tasks` skill, installed into `~/.claude/skills` and `~/.agents/skills` by the setup action with the real CLI path filled in, so agents that are not Claude Code learn the commands without a per-project note. A skill directory the plugin did not install is left alone, unless it holds an unmodified copy of the plugin's own template.
- Setup and teardown actions that install or remove the Claude Code hook, the skill and the CLI shim, seed `config.toml`, and print the keybinding to add.
- A startup hook that re-points an already installed Claude Code hook and refreshes the installed skill after a reinstall.
- `config.toml` support for the heading, focus on open, completed tasks, the progress bar, active-task following, state glyphs, and colors.
- `tools/check.js`, 23 checks covering the store, the CLI, the renderer, the config reader, the Claude Code payload mapping, and what setup writes outside the plugin.
