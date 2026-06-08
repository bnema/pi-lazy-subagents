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

- `help`
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

Core parameters:

- `agent`, `prompt`, `title`, `name` for single runs.
- `children` for parallel groups: each child has `agent`, `prompt`, optional `taskSummary`, and optional `cwd`.
- `steps` for workflows: each step has `id`, `agent`, `prompt`, optional `dependsOn`, `retries`, `outputMode`, `outputSchema`, `when`, `fanOutFrom`, and `cwd`.
- `target` for continuing a named run or run id.
- `runId`, `timeoutMs`, and `scope` for status/result/wait/clear-style actions.

Examples:

```text
lazy_subagents action=run agent=reviewer prompt="Review the auth diff" name=auth-review
lazy_subagents action=continue target=auth-review prompt="I applied your fixes; validate again"
lazy_subagents action=parallel children=[{agent:"reviewer",prompt:"Review correctness"},{agent:"scout",prompt:"Find docs"}]
lazy_subagents action=wait runId=<runId> timeoutMs=600000
lazy_subagents action=result runId=<runId>
lazy_subagents action=pickup runId=<runId>
```

Use `run` for one child, `parallel` for independent children, and `workflow` for dependency-aware pipelines. Workflow steps can use `retries`, `outputMode: "json"`, `outputSchema`, `when`, and `fanOutFrom`. Prompts can reference earlier step results with forms like `{{stepId.summary}}`, `{{stepId.output}}`, and `{{stepId.structured.title}}`. `dependsOn` is optional when a dependency is directly inferable from `{{stepId...}}` references in `prompt` or `when`, or from `fanOutFrom.step`; the runner adds those dependencies automatically.

```text
# Explicit dependsOn is still valid:
{id:"synth", dependsOn:["triage", "review"], prompt:"Use {{triage.json}} and {{review.json}}"}

# Also valid: dependencies are inferred from direct references:
{id:"synth", dependsOn:["review"], prompt:"Use {{review.json}} and {{triage.json}}"}
# normalized dependsOn: ["review", "triage"]
```

## Notes

Subagents report terminal results back to the main session automatically. Use blocking `wait` only when you explicitly need to stop the main session until a child completes.

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
