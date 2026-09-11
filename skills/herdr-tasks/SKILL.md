---
name: herdr-tasks
description: Publish your task list to the Herdr Tasks pane so the user can watch you check items off. Use when a task has more than two steps, or when the user asks to see your plan or progress.
---

# Herdr Tasks

The user runs Herdr and keeps a Tasks pane open beside you. The pane shows one task list for your
pane, and it redraws the moment you change the list. Publishing your plan lets the user follow your
progress without reading every line of your output.

Claude Code does not need this skill. Its own todo list is mirrored into the pane automatically.
Use this skill for every other agent.

## The command

```
{{HERDR_TASKS_CLI}}
```

Run it from any shell. It writes the list for the Herdr pane you are running in, so it needs no pane
id. Every command prints the list back, which is how you read your own state.

## When to publish a list

Publish a list when the task has three or more steps. Do not publish a list for a single edit, a
question, or a short command.

Write one short line per step. Use the words the user would use, not internal names. Keep each line
under about 60 characters, because a long line wraps in a narrow pane.

## How to use it

Set the list once, when you have a plan:

```
{{HERDR_TASKS_CLI}} set "read the spec" "write the parser" "add tests"
```

Mark a step in progress when you start it:

```
{{HERDR_TASKS_CLI}} start 2
```

Mark it complete when it is done:

```
{{HERDR_TASKS_CLI}} done 2
```

Or do both in one step. `next` completes the task in progress and starts the next pending one:

```
{{HERDR_TASKS_CLI}} next
```

Mark a step blocked when you cannot continue, and say why:

```
{{HERDR_TASKS_CLI}} block 3 "waiting on the API key"
```

Add a step you did not plan for:

```
{{HERDR_TASKS_CLI}} add "fix the test I broke"
```

Print the current list:

```
{{HERDR_TASKS_CLI}} show
```

## Rules

Keep exactly one task in progress. `start` clears any other in-progress task for you.

Mark each step complete as you finish it. A list that is only updated at the end is worse than no
list, because the pane shows stale work.

Address a task by its number, as `show` prints it. A text argument also works, and matches the first
task that contains it:

```
{{HERDR_TASKS_CLI}} done parser
```

Use `set` once per task. A second `set` replaces the list and loses the progress. Use `add` to
extend the list instead.

Clear the list only when the work is finished and the list is no longer useful:

```
{{HERDR_TASKS_CLI}} clear
```

Do not report the command output to the user. They can see the pane.
