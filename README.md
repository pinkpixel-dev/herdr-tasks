# herdr-tasks

A Herdr plugin that shows the task list of the agent you are watching, in a split pane beside it, with items checked off as the agent finishes them.

Agents already plan their work. Claude Code keeps a todo list, and most other agents will write one if you ask. The problem is that the list scrolls away inside the conversation, so following along means reading every line of output to figure out where the agent is. This puts the list somewhere it stays put.

Press one key, the list appears next to the agent. Press it again, the list goes away.

```
Tasks  claude · w6:p4                           2/6
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 1 ✔  Read the Herdr plugin skill references
 2 ✔  Inspect the file viewer plugin for the toggle pattern
 3 ▸  Writing the manifest, pane renderer and toggle launcher
 4 ○  Wire the Claude Code TodoWrite hook
 5 ⊘  Waiting on review
      ↳ blocked on the API key
 6 ○  Write the README

q quit · j/k scroll · g top
```

## How it gets the tasks

Two ways in, one pane.

**Claude Code needs no changes at all.** The setup action adds a hook to Claude Code's settings that fires whenever Claude writes its own todo list. Claude keeps working exactly as it always has, and the pane follows along. Nothing to tell the agent, nothing for it to remember, no extra tool calls.

**Any other agent uses the CLI.** Codex, Gemini, an agent you wrote yourself: anything that can run a shell command can drive the list with `herdr-tasks set`, `herdr-tasks done 2`, and a few others. Setup installs a skill that teaches them how, so usually there is nothing to explain.

Both write a small JSON file per pane. The pane watches that file, so an update shows up the moment it lands.

## Requirements

- Herdr 0.9.0 or newer
- Node 18 or newer, which you already have if you run Claude Code
- Claude Code, only for the automatic path

No dependencies to install. The whole plugin is plain Node scripts.

## Install

```bash
herdr plugin install pinkpixel-dev/herdr-plugins/herdr-tasks
```

Or from a local checkout while you work on it:

```bash
herdr plugin link /path/to/herdr-tasks
```

## Setup

Installing registers the plugin. Two more things are needed, and both write outside the plugin, so neither happens on its own.

**1. Run the setup action.** It adds the Claude Code hook, installs the agent skill, writes the CLI shim, and seeds the config file.

```bash
herdr plugin action invoke pinkpixel.herdr-tasks.configure
```

It prints every path it wrote and the keybinding block from the next step. Your Claude Code settings are merged, not replaced, and the previous file is copied to `settings.json.herdr-tasks.bak` first.

Three things land outside the plugin:

| What | Where |
|---|---|
| the `TodoWrite` hook | `~/.claude/settings.json`, merged |
| the `herdr-tasks` skill | `~/.claude/skills/` and `~/.agents/skills/`, whichever exist |
| the `herdr-tasks` command | the plugin config directory |

The skill is written with the real path of the command filled in, and marked with a `.installed-by-herdr-tasks` file. An unmarked `herdr-tasks` skill directory is left alone, so a skill you wrote yourself is safe. The one exception is a `SKILL.md` that is byte-identical to the plugin's own template, which means a sync tool or a manual copy put it there with the path placeholder still in it. That copy gets finished and marked, because an agent reading it would otherwise find a placeholder instead of a command.

Restart Claude Code, or start a new session, before the hook loads.

**2. Bind the pane to a key.** Add this to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "pinkpixel.herdr-tasks.toggle"
description = "toggle the task list pane"
```

Then reload:

```bash
herdr server reload-config
```

Use any key you like. `prefix+t` is a suggestion, picked so it sits next to the file viewer's `prefix+f` and avoids a bare `ctrl` chord your terminal may already claim.

## Using it

Press the key in the pane running your agent. The task list opens to the right and the agent keeps focus, so you can carry on typing. Press the key again and the pane closes. The list itself survives, so reopening shows the current state.

It is an ordinary Herdr pane, so resizing, moving, zooming, and swapping all work with your normal Herdr keys.

The pane scrolls itself. A list longer than the pane follows the in-progress task, so the current step stays on screen without you touching anything. The keys below matter only for a list that does not fit, and the footer hides them when it does:

| Key | Does |
|---|---|
| `q` | close the pane |
| `j` / `k` | scroll down / up |
| `g` / `G` | jump to the top / bottom |
| `f` | go back to following the in-progress task |

Turn the automatic scrolling off with `follow_active = false` if you would rather the list stayed where you left it.

One list per agent pane. The pane is tied to whichever pane was focused when you pressed the key, so two agents in the same tab each get their own list and their own pane.

## Driving it from an agent that is not Claude Code

The setup action writes a `herdr-tasks` command into the plugin's config directory. Find it with:

```bash
herdr plugin config-dir pinkpixel.herdr-tasks
```

The commands:

```bash
herdr-tasks set "read the spec" "write the parser" "add tests"
herdr-tasks start 2                      # mark in progress
herdr-tasks done 2                       # mark complete
herdr-tasks done parser                  # ... or name it instead of counting
herdr-tasks next                         # complete the active task, start the next one
herdr-tasks block 3 "waiting on the API key"
herdr-tasks add "fix the thing I broke"
herdr-tasks show
herdr-tasks clear
```

Every command prints the list back, which is also how the agent reads its own state. Tasks are numbered by position, and a text argument matches the first task containing it.

Setup installs [the skill](skills/herdr-tasks/SKILL.md) that explains all of this to an agent, with the real command path filled in, so an agent that reads `~/.agents/skills` or `~/.claude/skills` can find it on its own. For an agent that reads neither, point at the same file from the project's `AGENTS.md`:

```md
## Task list

Publish your plan to the Herdr Tasks pane. Read ~/.agents/skills/herdr-tasks/SKILL.md for how.
```

Symlinking the shim onto your `PATH` shortens the commands, and is worth doing if you use the CLI path a lot.

## Configuration

The setup action seeds `config.toml` in the plugin config directory. Every key is optional. The full file with comments is [config.example.toml](config.example.toml), and the settings are:

| Key | Default | Does |
|---|---|---|
| `title` | `"Tasks"` | heading when the list has no name of its own |
| `focus_on_open` | `false` | whether the pane takes focus when it opens |
| `show_completed` | `true` | keep finished tasks on screen |
| `show_progress_bar` | `true` | draw the bar under the heading |
| `follow_active` | `true` | scroll a long list to keep the current task visible |
| `[icons]` | `○ ▸ ✔ ⊘` | one glyph per state |
| `[colors]` | sky / zinc / red | `accent`, `done`, `blocked`, as hex |

Pending tasks use your terminal's own foreground color, so the list picks up your theme instead of fighting it.

## Removing it

```bash
herdr plugin action invoke pinkpixel.herdr-tasks.unconfigure
herdr plugin uninstall pinkpixel.herdr-tasks
```

The first takes the hook back out of Claude Code's settings, removes the skill it installed, and deletes the shim. Your `config.toml` and any saved lists stay where they are, so reinstalling picks up where you left off. Delete the config and state directories by hand if you want them gone.

## How it works

```text
herdr-plugin.toml      the manifest: one pane, three actions, one startup hook
bin/
  pane.js              the pane: watches the state directory, draws the list
  toggle.js            the key: open a split, or close the one in this tab
  tasks.js             the CLI other agents call
  hook.js              the Claude Code PostToolUse bridge
  configure.js         setup and teardown, the only thing that writes outside
lib/
  store.js             one JSON file per pane, written atomically
  render.js            record plus size in, styled lines out
  config.js            config.toml, with a small TOML reader
  paths.js             where state, config and the Herdr binary live
skills/
  herdr-tasks/SKILL.md the instructions setup installs for other agents
```

The pane finds its agent through `HERDR_TASKS_TARGET`, which the toggle passes when it opens the split. Without it the pane falls back to whichever pane Herdr reports as focused.

The toggle finds an open task pane by its label, which Herdr sets from the pane title in the manifest. If you change that title, change `PANE_LABEL` in `bin/toggle.js` to match. A check in `tools/check.js` fails if they drift apart.

Pane ids are not stable forever, so a closed pane leaves its list behind. The toggle sweeps lists whose pane no longer exists each time it opens a pane, which avoids paying for an event hook to do the same job.

## Development

```bash
herdr plugin link /path/to/herdr-tasks
node tools/check.js
herdr plugin log list --plugin pinkpixel.herdr-tasks --limit 20
```

`plugin link` does not run build commands, but there is nothing to build here. The checks cover the store, the CLI, the renderer, the config reader, and the Claude Code payload mapping, all against a temporary state directory.

## Known limitations

- The automatic path is Claude Code only. Other agents work through the CLI, and whether they use it depends on them reading the skill or your `AGENTS.md`.
- The Claude Code hook needs `HERDR_PANE_ID` in the agent's environment, which means the agent has to be running in a Herdr pane. Claude Code started outside Herdr writes nothing.
- Tested on Linux. The code avoids anything platform-specific and ships a Windows shim, but macOS and Windows have not been exercised yet.
- The pane is read-only. You cannot check something off yourself from inside it, although `herdr-tasks done 2` from any shell works.
- One task list per pane, not per agent session. A pane that closes loses its list.

## License

Apache 2.0. See [LICENSE](LICENSE).

Made with 💖 by Pink Pixel
