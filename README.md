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

## Use

```text
/lazy-subagents list
/lazy-subagents run reviewer "Review the auth diff" --name auth-review
/lazy-subagents continue auth-review "I applied your fixes; validate again"
/lazy-subagents status
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents cancel <runId>
```

The extension also registers the `lazy_subagents` tool for agents. Main actions:

- `run`
- `parallel`
- `workflow`
- `continue`
- `status`
- `result`
- `pickup`
- `cancel`
- `clear`

Use `parallel` for independent work. Use `workflow` when steps depend on earlier results.

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
