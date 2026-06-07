# pi-lazy-subagents

Pi package for asynchronous child-session orchestration with persistent visibility and completion routing.

## What it does

`pi-lazy-subagents` lets Pi launch background child work without blocking the main session while keeping the work legible enough to manage.

Current features:
- async child launches;
- parallel child groups;
- background workflow pipelines with dependency-aware scheduling;
- per-step retries for transient workflow failures;
- direct step-to-step result passing via prompt templates;
- structured JSON step outputs for management/orchestration use;
- persistent run registry;
- footer/widget progress;
- launch, completion, failure, and attention cards;
- blocking `wait` when explicitly needed;
- result retrieval and pickup;
- automatic terminal reporting back to the main agent;
- manual controls for wait, status, result, pickup, clear, and cancel;
- self-contained direct launcher; `pi-subagents` is **not required**.

## Install locally

```bash
pi install /absolute/path/to/pi-lazy-subagents
```

Or load it directly while developing:

```bash
pi --no-extensions -e /absolute/path/to/pi-lazy-subagents/extensions/index.ts
```

## User-facing surfaces

### Slash command

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

Examples:

```text
/lazy-subagents list
/lazy-subagents run reviewer "Review the auth diff" --name diff-reviewer
/lazy-subagents continue diff-reviewer "I applied your fixes; validate"
/lazy-subagents run scout "Inspect the package layout"
/lazy-subagents status
/lazy-subagents wait [runId]
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents pin <runId|on|off>
```

### Tool

The package also registers the `lazy_subagents` tool for Pi itself.

Supported actions:
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

Use `action=list` or `/lazy-subagents list` to print available sub agents. File profiles are discovered from `~/.agents/agents` and `~/.pi/agent/agents`.

For tool calls, `action=run` defaults to `delegate`.

Use `action=parallel` for independent tasks that can run together. The group reports completion/attention as one tracked run.

Use `action=workflow` for dependency-aware pipelines that should stay off the main session context. Each step can reference earlier step results with `{{stepId.summary}}`, `{{stepId.output}}`, `{{stepId.json}}`, or structured fields such as `{{stepId.structured.title}}`. If a step references another step in `prompt`, `when`, or `fanOutFrom`, list that step in `dependsOn` so the scheduler knows the data dependency.

Workflow steps also support:
- `retries` for transient failures;
- `outputMode: "json"` to require a JSON object final response. Raw JSON is preferred, but fenced `json` blocks and embedded JSON objects are accepted for resilience;
- `outputSchema` to describe the expected JSON shape for downstream management/orchestration;
- `when` to skip a step when an upstream structured value is falsey;
- `fanOutFrom` to expand one logical step into a fan-out group from an upstream JSON array. Downstream steps depend on the logical group id and receive its aggregate through `{{group.summary}}`, `{{group.output}}`, `{{group.json}}`, and `{{group.structured.children}}`.

Example parallel launch:

```text
lazy_subagents action=parallel children=[{agent:"reviewer",prompt:"Review the diff for correctness"},{agent:"scout",prompt:"Find related docs and prior art"},{agent:"worker",prompt:"Prototype the isolated parser change"}]
```

Example named run with follow-up:

```text
lazy_subagents action=run agent=reviewer prompt="Review the auth diff for safety" name=diff-reviewer
lazy_subagents action=continue target=diff-reviewer prompt="I applied your fixes; validate them"
```

Example workflow launch:

```text
lazy_subagents action=workflow maxConcurrency=2 steps=[{id:"triage",agent:"scout",retries:1,outputMode:"json",outputSchema:"{ summary: string, runSecurity: boolean, reviewers: Array<{ id: string, agent: string, prompt: string }> }",prompt:"Inspect the diff and choose only necessary reviewers."},{id:"security",agent:"reviewer",dependsOn:["triage"],when:"{{triage.structured.runSecurity}}",prompt:"Review security risks using {{triage.json}}"},{id:"review",agent:"{{item.agent}}",dependsOn:["triage"],fanOutFrom:{step:"triage",path:"structured.reviewers",idField:"id",maxItems:3},prompt:"{{item.prompt}}\n\nTriage: {{triage.json}}"},{id:"synth",agent:"delegate",dependsOn:["review"],prompt:"Synthesize all reviews: {{review.json}}"}]
```

## UX notes

- Default flow: launch, then return to the user or continue work. Signals arrive automatically.
- Use `workflow` when later steps should consume earlier results without reinjecting every intermediate output into the main chat.
- `when` and empty `fanOutFrom` steps become `skipped` without launching a child; failed or skipped dependencies block dependent descendants.
- Non-empty `fanOutFrom` steps stay as logical group barriers until every expanded child finishes. The group then becomes `completed`, `failed`, or `skipped` and downstream steps can consume the aggregate without knowing child ids.
- Invalid workflow graphs are rejected before launch: duplicate ids, missing dependencies, self-dependencies, cycles, and fractional concurrency are not allowed.
- `wait` blocks. Use it only for explicit blocking requests or non-interactive scripts. In interactive Pi, progress stays in the persistent widget instead of duplicating a live tool-row view.
- `status` is for health checks: human request, suspected stall, or about 60 seconds with no signal. Do not poll.
- `result` reads final output; it is not a live tail.
- `pickup` injects a completed result into chat.
- Active runs show the persistent progress panel by default. Use `pin off` to hide it and `pin on` to show it again; `pin <runId>` re-enables the panel for a specific active run.
- completed successes auto-hide after a grace window; failed and paused runs stay until resolved or cleared.
- Names are only supported for `action=run` single runs; group and workflow runs cannot be continued by name.
- Named single runs stay visible after completion for a bounded lease (default 30 min). Use `action=continue target=<name|runId>` to send follow-up tasks before the lease expires; targets resolve by run id first, then by name.
- Both named and unnamed completed runs can be continued by their run ID while they remain available. Named runs remain continuable by name or run ID until their lease expires.
- When the lease expires, successful named runs leave the normal status/widget surfaces and can no longer be continued by name or run ID.
- Continuation reuses the existing child session so the agent has full context from prior turns.
- Continuation is only supported for idle single runs. Active, expired, failed, cancelled, group, and workflow targets are rejected with a short `Cannot continue ...` error.

## Manual smoke test

### Interactive smoke test

1. Start Pi with the extension installed.
2. Run:

   ```text
   /lazy-subagents run delegate "Reply with exactly DONE and nothing else."
   ```

3. Confirm:
   - a launch card appears;
   - the footer shows an active run;
   - the widget shows a compact Lazy running row with current task context.
4. Return to chat. Do not poll or call blocking `wait`; the completion card should arrive automatically.
5. Confirm:
   - the footer/widget move the run into recent/completed state;
   - a completion card appears exactly once.
6. Run:

   ```text
   /lazy-subagents result <runId>
   ```

7. Confirm the full result is returned.
8. Run:

   ```text
   /lazy-subagents pickup <runId>
   ```

9. Confirm the completed result is injected back into chat.
10. Optional slower-run health check: after about 60 seconds with no signal, run:

   ```text
   /lazy-subagents status
   ```

11. Confirm the report shows live timing and recent activity fields.
    - For a long-running task, confirm the pinned progress panel stays above the Lazy row; run `/lazy-subagents pin off` and `/lazy-subagents pin on` to verify the visibility toggle.

### Print-mode smoke test

Verify the tool is callable:

```bash
pi --no-session --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=status and answer only with its result."
```

Example non-interactive launch + wait + result flow:

```bash
SMOKE_DIR=$(mktemp -d)
RUN_OUT=$(pi --session-dir "$SMOKE_DIR" --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=run, agent=delegate, prompt='Reply with exactly DONE and nothing else.'. Answer only with the exact tool result text.")
RUN_ID=$(printf '%s' "$RUN_OUT" | grep -oE '[0-9a-f-]{36}' | head -n1)
pi --session-dir "$SMOKE_DIR" -c --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=wait, runId='$RUN_ID' and answer only with its result."
pi --session-dir "$SMOKE_DIR" -c --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=result, runId='$RUN_ID' and answer only with its result."
```

Optional health-check example for a slower run:

```bash
pi --session-dir "$SMOKE_DIR" -c --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=status, runId='$RUN_ID' only if about 60 seconds have passed with no completion or attention signal, and answer only with its result."
```

Example workflow smoke test:

```bash
pi --no-session --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=workflow, maxConcurrency=2, steps=[{id:'research',agent:'delegate',retries:1,outputMode:'json',outputSchema:'{ summary: string, next: string }',prompt:'Reply with exactly {\"summary\":\"RESEARCH\",\"next\":\"PLAN\"} and nothing else.'},{id:'plan',agent:'delegate',dependsOn:['research'],prompt:'Reply with exactly PLAN after reading {{research.json}} and nothing else.'}] and answer only with the exact tool result text."
```

## Development

```bash
npm test
npm run typecheck
```

## Runtime notes

Background runner state is written under a temp root like:

```text
/tmp/pi-lazy-subagents-uid-<uid>/
```

That temp root contains:
- `async-runs/<run-id>/status.json`
- `async-runs/<run-id>/events.jsonl`
- `results/<run-id>.json`

## Package layout

```text
extensions/index.ts
src/
  defaults.ts
  launcher/
  orchestration/
  state/
  ui/
  utils/
tests/
```
