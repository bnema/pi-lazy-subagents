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
- completion policies:
  - `notify_only`
  - `follow_up_when_idle`
  - `wake_if_idle`
  - `manual_pickup`
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
/lazy-subagents run <agent> <prompt> [--policy POLICY] [--title TITLE]
/lazy-subagents status [runId]
/lazy-subagents wait [runId] [--timeout-ms MS]
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents pin <runId>
/lazy-subagents cancel <runId>
/lazy-subagents clear [all|runId]
```

Examples:

```text
/lazy-subagents list
/lazy-subagents run scout "Inspect the package layout" --policy notify_only
/lazy-subagents status
/lazy-subagents wait [runId]
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents pin <runId>
```

### Tool

The package also registers the `lazy_subagents` tool for Pi itself.

Supported actions:
- `help`
- `list`
- `run`
- `parallel`
- `workflow`
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

Use `action=workflow` for dependency-aware pipelines that should stay off the main session context. Each step can reference earlier step results with `{{stepId.summary}}`, `{{stepId.output}}`, `{{stepId.json}}`, or structured fields such as `{{stepId.structured.title}}`.

Workflow steps also support:
- `retries` for transient failures;
- `outputMode: "json"` to require a JSON object final response;
- `outputSchema` to describe the expected JSON shape for downstream management/orchestration.

Example parallel launch:

```text
lazy_subagents action=parallel children=[{agent:"reviewer",prompt:"Review the diff for correctness"},{agent:"scout",prompt:"Find related docs and prior art"},{agent:"worker",prompt:"Prototype the isolated parser change"}]
```

Example workflow launch:

```text
lazy_subagents action=workflow maxConcurrency=2 steps=[{id:"research",agent:"scout",retries:1,outputMode:"json",outputSchema:"{ summary: string, findings: string[] }",prompt:"Inspect the package layout and summarize the best extension seams."},{id:"plan",agent:"reviewer",dependsOn:["research"],retries:2,prompt:"Use {{research.summary}} and {{research.json}} to draft a small refactor plan."},{id:"implement",agent:"worker",dependsOn:["plan"],prompt:"Implement the plan:\n\n{{plan.output}}"}]
```

## UX notes

- Default flow: launch, then return to the user or continue work. Signals arrive automatically.
- Use `workflow` when later steps should consume earlier results without reinjecting every intermediate output into the main chat.
- Failed workflow steps only block dependent descendants; unrelated branches can keep running.
- Invalid workflow graphs are rejected before launch: duplicate ids, missing dependencies, self-dependencies, cycles, and fractional concurrency are not allowed.
- `wait` blocks. Use it only for explicit blocking requests or non-interactive scripts.
- `status` is for health checks: human request, suspected stall, or about 60 seconds with no signal. Do not poll.
- `result` reads final output; it is not a live tail.
- `pickup` injects a completed result into chat.
- `pin` keeps live progress visible without repeated status checks.
- completed successes auto-hide after a grace window; failed, paused, manual-pickup, and pinned runs stay until resolved or cleared.

## Manual smoke test

### Interactive smoke test

1. Start Pi with the extension installed.
2. Run:

   ```text
   /lazy-subagents run delegate "Reply with exactly DONE and nothing else." --policy notify_only
   ```

3. Confirm:
   - a launch card appears;
   - the footer shows an active run;
   - the widget shows elapsed/update/tool context.
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

### Print-mode smoke test

Verify the tool is callable:

```bash
pi --no-session --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=status and answer only with its result."
```

Example non-interactive launch + wait + result flow:

```bash
SMOKE_DIR=$(mktemp -d)
RUN_OUT=$(pi --session-dir "$SMOKE_DIR" --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=run, agent=delegate, prompt='Reply with exactly DONE and nothing else.', completionPolicy='notify_only'. Answer only with the exact tool result text.")
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
pi --no-session --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=workflow, completionPolicy='notify_only', maxConcurrency=2, steps=[{id:'research',agent:'delegate',retries:1,outputMode:'json',outputSchema:'{ summary: string, next: string }',prompt:'Reply with exactly {\"summary\":\"RESEARCH\",\"next\":\"PLAN\"} and nothing else.'},{id:'plan',agent:'delegate',dependsOn:['research'],prompt:'Reply with exactly PLAN after reading {{research.json}} and nothing else.'}] and answer only with the exact tool result text."
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
