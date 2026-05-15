# pi-lazy-subagents

Pi package for asynchronous child-session orchestration with persistent visibility and completion routing.

## What it does

`pi-lazy-subagents` lets Pi launch background child work without blocking the main session while keeping the work legible enough to manage.

Current features:
- async child launches with immediate return to the parent session;
- persistent run registry stored in the Pi session;
- richer footer + widget visibility with elapsed time, update age, current tool, and recent activity context;
- durable launch / completion / failure / attention cards;
- explicit result retrieval for completed runs;
- pickup that injects the completed result back into chat now;
- completion policies:
  - `notify_only`
  - `follow_up_when_idle`
  - `wake_if_idle`
  - `manual_pickup`
- manual controls for status, result, pickup, clear, and cancel;
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
/lazy-subagents run <agent> <prompt> [--policy POLICY] [--title TITLE]
/lazy-subagents status [runId]
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents pin <runId>
/lazy-subagents cancel <runId>
/lazy-subagents clear [all|runId]
```

Examples:

```text
/lazy-subagents run scout "Inspect the package layout" --policy notify_only
/lazy-subagents status
/lazy-subagents result <runId>
/lazy-subagents pickup <runId>
/lazy-subagents pin <runId>
```

### Tool

The package also registers the `lazy_subagents` tool for Pi itself.

Supported actions:
- `help`
- `run`
- `parallel`
- `status`
- `result`
- `pickup`
- `pin`
- `clear`
- `cancel`

Built-in agent profiles:
- `delegate` — general-purpose fallback; good default when unsure
- `scout` — read-only codebase inspection and file discovery
- `researcher` — read-only evidence gathering, including external research when needed
- `planner` — read-only planning and design work
- `reviewer` — read-only review/verification
- `worker` — implementation and edits

File-based profiles discovered from `~/.agents/agents` and `~/.pi/agent/agents` override builtins with the same name, so you can shadow defaults like `reviewer` or `scout`.

For tool calls, `action=run` defaults `agent` to `delegate` when omitted.

## UX notes

- normal orchestration flow is: launch once, then wait. Launch, completion, and attention cards are emitted back into the same parent session automatically.
- `status` is for later health checks: it reports elapsed time, last update age, current tool when known, tool count when known, and the last recorded event.
- do not poll `status` in a loop; use it only when the human asks, when about 60 seconds have passed with no signal and you need a health check, or when you suspect a stall.
- `result` returns the full final output for a completed run and acknowledges it for live-UI cleanup; it is not meant to be a live tail.
- `pickup` injects that completed result back into the current Pi chat so the parent/orchestrator can act on it immediately.
- `pin` posts a durable chat card that shows detailed subagent progress lines and keeps that run visible in live UI surfaces, which is usually better than repeated status checks.
- routine completed runs are collapsed into one inbox row so active and attention-needed runs stay visible.
- plain successful runs auto-hide from the footer/widget after a short grace window; failed, paused, manual-pickup, and pinned runs stay visible until resolved or cleared.

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
4. Wait for the completion signal. Do not poll immediately on this fast smoke test.
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
10. Optional health-check smoke test for a slower run: launch a longer task, wait about 60 seconds with no signal, then run:

   ```text
   /lazy-subagents status
   ```

11. Confirm the report shows live timing and recent activity fields.

### Print-mode smoke test

Verify the tool is callable:

```bash
pi --no-session --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=status and answer only with its result."
```

Example launch + wait + result flow:

```bash
SMOKE_DIR=$(mktemp -d)
RUN_OUT=$(pi --session-dir "$SMOKE_DIR" --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=run, agent=delegate, prompt='Reply with exactly DONE and nothing else.', completionPolicy='notify_only'. Answer only with the exact tool result text.")
RUN_ID=$(printf '%s' "$RUN_OUT" | grep -oE '[0-9a-f-]{36}' | head -n1)
sleep 5
pi --session-dir "$SMOKE_DIR" -c --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=result, runId='$RUN_ID' and answer only with its result."
```

Optional health-check example for a slower run:

```bash
pi --session-dir "$SMOKE_DIR" -c --no-extensions -e ./extensions/index.ts --tools lazy_subagents -p "Use lazy_subagents with action=status, runId='$RUN_ID' only if about 60 seconds have passed with no completion or attention signal, and answer only with its result."
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
