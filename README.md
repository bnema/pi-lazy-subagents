# pi-lazy-subagents

Run background subagents from Pi without blocking the main session.

## What it does

- Launches single child sessions, parallel groups, and dependency-aware workflows.
- Keeps background work visible with status, widgets, and completion cards.
- Routes completion, failure, pause, and attention states back to the main session.
- Supports named runs, continuation, pickup, cancellation, and result retrieval.
- Passes workflow step results directly into dependent prompts.

## Install

```bash
pi install git:github.com/bnema/pi-lazy-subagents
```

## Slash commands

```text
/lazy-subagents help
/lazy-subagents list
/lazy-subagents run <agent> <prompt> [--title TITLE] [--name NAME]
/lazy-subagents continue <name|runId> <prompt> [--title TITLE]
/lazy-subagents status [runId]
/lazy-subagents wait [runId] [--timeout-ms MS]
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents pin <runId|on|off>
/lazy-subagents cancel <runId>
/lazy-subagents clear [all|runId]
```

## Tool

The `lazy_subagents` tool supports:

- `list`
- `run`
- `parallel`
- `workflow`
- `continue`
- `status`
- `wait`
- `result`
- `pickup`
- `pin`
- `clear`
- `cancel`

Use `run` for one child, `parallel` for independent children, and `workflow` for dependency-aware pipelines. Workflow steps can use `retries`, `outputMode: "json"`, `outputSchema`, `when`, and `fanOutFrom`. Prompts can reference earlier step results with forms like `{{stepId.summary}}`, `{{stepId.output}}`, and `{{stepId.structured.title}}`.

## Notes

Subagents report terminal results back to the main session automatically. Use blocking `wait` only when you explicitly need to stop the main session until a child completes.

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
