import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { commitUsageTurn, createUsageTracker, finalizeUsageTracker, recordUsageSample } from "./usage-tracker.js";

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

async function findLatestSessionFile(sessionDir) {
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const fullPath = path.join(sessionDir, entry.name);
          const stats = await fs.stat(fullPath);
          return { fullPath, mtimeMs: stats.mtimeMs };
        }),
    );
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return files[0]?.fullPath;
  } catch {
    return undefined;
  }
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function now() {
  return Date.now();
}

function summarizeOutput(text, maxLength = 400) {
  const singleLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function createInitialStatus(config) {
  const startedAt = now();
  return {
    runId: config.runId,
    mode: config.mode,
    pid: process.pid,
    state: "queued",
    startedAt,
    lastUpdate: startedAt,
    steps: config.children.map((child, index) => ({
      index,
      agent: child.profile.name,
      model: child.resolvedModel,
      thinking: child.resolvedThinking,
      status: "pending",
      taskSummary: child.taskSummary,
      startedAt: undefined,
      endedAt: undefined,
      currentTool: undefined,
      totalTokens: undefined,
      sessionFile: undefined,
      outputFile: child.outputFile,
      error: undefined,
    })),
  };
}

function deriveRootState(status) {
  const steps = status.steps ?? [];
  if (steps.some((step) => step.status === "running" || step.status === "pending")) return "running";
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "paused")) return "paused";
  return "complete";
}

function syncDerivedStatusFields(status) {
  const steps = status.steps ?? [];
  const runningStep = steps.find((step) => step.status === "running");
  const toolCount = steps.reduce((sum, step) => sum + (typeof step.toolCount === "number" ? step.toolCount : 0), 0);
  const totalTokens = steps.reduce((sum, step) => sum + (typeof step.totalTokens === "number" ? step.totalTokens : 0), 0);

  status.currentTool = runningStep?.currentTool;
  status.toolCount = toolCount > 0 ? toolCount : undefined;
  status.totalTokens = totalTokens > 0 ? totalTokens : undefined;
}

async function updateStatus(statusPath, status) {
  syncDerivedStatusFields(status);
  status.state = deriveRootState(status);
  status.lastUpdate = now();
  await writeJson(statusPath, status);
}

function extractUsageTotal(event) {
  const candidates = [
    event?.message?.usage?.totalTokens,
    event?.assistantMessageEvent?.partial?.usage?.totalTokens,
    event?.assistantMessageEvent?.message?.usage?.totalTokens,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function createSerialLineProcessor(processLine, onError) {
  let queue = Promise.resolve();

  const enqueue = (lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return;
    queue = queue
      .then(async () => {
        for (const line of lines) {
          try {
            await processLine(line);
          } catch (error) {
            onError?.(error, { line });
          }
        }
      })
      .catch((error) => {
        onError?.(error);
      });
  };

  return {
    enqueue,
    async flush(finalLine) {
      if (typeof finalLine === "string" && finalLine.trim()) {
        enqueue([finalLine]);
      }
      await queue;
    },
  };
}

function buildPiArgs(child) {
  const args = ["--mode", "json", "--session-dir", child.sessionDir];
  if (child.resolvedModel) {
    args.push("--model", child.resolvedModel);
  }
  if (child.resolvedThinking) {
    args.push("--thinking", child.resolvedThinking);
  }
  if (child.profile.tools?.length) {
    args.push("--tools", child.profile.tools.join(","));
  }
  if (child.profile.inheritProjectContext === false) {
    args.push("--no-context-files");
  }
  if (child.profile.inheritSkills === false) {
    args.push("--no-skills");
  }
  if (child.profile.systemPrompt) {
    args.push(child.profile.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", child.profile.systemPrompt);
  }
  args.push(child.prompt);
  return args;
}

async function runChild(config, statusPath, status, child, index) {
  const step = status.steps[index];
  step.status = "running";
  step.startedAt = now();
  await updateStatus(statusPath, status);

  const args = buildPiArgs(child);
  const childProcess = spawn(config.piBin, args, {
    cwd: child.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  step.pid = childProcess.pid;
  await updateStatus(statusPath, status);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let finalOutput = "";
  let toolCount = 0;
  let sessionFile;
  const usageTracker = createUsageTracker();

  const processLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    await appendLine(config.eventsPath, JSON.stringify({ runId: config.runId, index, raw: trimmed }));

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    const usageTotal = extractUsageTotal(event);
    if (usageTotal !== undefined) {
      step.totalTokens = recordUsageSample(usageTracker, usageTotal);
      await updateStatus(statusPath, status);
    }

    if (event.type === "tool_execution_start") {
      step.currentTool = event.toolName;
      step.currentToolStartedAt = now();
      await updateStatus(statusPath, status);
      return;
    }

    if (event.type === "tool_execution_end") {
      step.currentTool = undefined;
      step.currentToolStartedAt = undefined;
      toolCount += 1;
      step.toolCount = toolCount;
      await updateStatus(statusPath, status);
      return;
    }

    if (event.type === "message_end") {
      const text = extractAssistantText(event.message);
      if (text) {
        finalOutput = text;
        await appendLine(path.join(config.asyncDir, child.outputFile), text);
      }
      return;
    }

    if (event.type === "turn_end") {
      step.totalTokens = commitUsageTurn(usageTracker);
      await updateStatus(statusPath, status);
      return;
    }
  };

  const stdoutProcessor = createSerialLineProcessor(processLine, (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("[pi-lazy-subagents] failed to process child stdout line:", message);
  });

  childProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? "";
    stdoutProcessor.enqueue(lines);
  });

  childProcess.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  const exitCode = await new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", (code) => resolve(code ?? 1));
  });

  const trailingStdout = stdoutBuffer;
  stdoutBuffer = "";
  await stdoutProcessor.flush(trailingStdout);

  sessionFile = await findLatestSessionFile(child.sessionDir);
  step.sessionFile = sessionFile;
  step.endedAt = now();
  step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : undefined;
  step.currentTool = undefined;
  step.currentToolStartedAt = undefined;
  step.exitCode = exitCode;
  step.totalTokens = finalizeUsageTracker(usageTracker);

  if (exitCode === 0) {
    step.status = "completed";
    step.error = undefined;
  } else {
    step.status = "failed";
    step.error = summarizeOutput(stderrBuffer) ?? `pi exited with code ${exitCode}`;
  }

  await updateStatus(statusPath, status);

  return {
    agent: child.profile.name,
    output: finalOutput,
    error: exitCode === 0 ? undefined : step.error,
    success: exitCode === 0,
    sessionFile,
    totalTokens: step.totalTokens,
    toolCount: step.toolCount,
    artifactPaths: {
      outputPath: path.join(config.asyncDir, child.outputFile),
    },
  };
}

function failedChildResult(config, child, error, sessionFile) {
  return {
    agent: child.profile.name,
    output: "",
    error,
    success: false,
    sessionFile,
    totalTokens: 0,
    toolCount: 0,
    artifactPaths: {
      outputPath: path.join(config.asyncDir, child.outputFile),
    },
  };
}

async function writeResult(config, status, results) {
  const timestamp = now();
  const success = results.every((result) => result.success);
  const summary = summarizeOutput(
    results
      .map((result) => `${result.agent}: ${result.output || result.error || "(no output)"}`)
      .join("\n\n"),
  );

  await writeJson(config.resultPath, {
    id: config.runId,
    runId: config.runId,
    state: success ? "complete" : "failed",
    success,
    summary,
    timestamp,
    sessionFile: results.find((result) => result.sessionFile)?.sessionFile,
    toolCount: status.toolCount,
    totalTokens: status.totalTokens,
    results,
  });

  status.state = success ? "complete" : "failed";
  status.endedAt = timestamp;
  status.lastUpdate = timestamp;
  await writeJson(config.statusPath, status);
}

async function run(config) {
  await ensureDir(config.asyncDir);
  await ensureDir(config.resultsDir);
  for (const child of config.children) {
    await ensureDir(child.sessionDir);
  }

  const status = createInitialStatus(config);
  await writeJson(config.statusPath, status);

  const results = config.mode === "parallel"
    ? await Promise.all(
        config.children.map(async (child, index) => {
          try {
            return await runChild(config, config.statusPath, status, child, index);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const step = status.steps[index];
            step.status = "failed";
            step.error = message;
            step.endedAt = now();
            step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : undefined;
            await updateStatus(config.statusPath, status);
            return failedChildResult(config, child, message, step.sessionFile);
          }
        }),
      )
    : [await runChild(config, config.statusPath, status, config.children[0], 0)];

  await writeResult(config, status, results);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("Missing config path");
  }

  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  await run(config);
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const configPath = process.argv[2];
    if (configPath) {
      const raw = await fs.readFile(configPath, "utf8");
      let config;
      try {
        config = JSON.parse(raw);
      } catch (parseError) {
        const parseMessage = parseError instanceof Error ? parseError.stack ?? parseError.message : String(parseError);
        console.error("[pi-lazy-subagents] failed to parse runner config during error handling:", parseMessage);
        throw parseError;
      }
      const statusPath = config.statusPath ?? path.join(config.asyncDir, "status.json");
      const resultPath = config.resultPath;
      const timestamp = now();
      const failedStatus = {
        runId: config.runId,
        mode: config.mode,
        pid: process.pid,
        state: "failed",
        startedAt: timestamp,
        lastUpdate: timestamp,
        endedAt: timestamp,
        error: message,
        steps: (config.children ?? []).map((child, index) => ({
          index,
          agent: child.profile?.name ?? child.agent ?? `child-${index + 1}`,
          status: "failed",
          error: message,
          outputFile: child.outputFile,
        })),
      };
      await writeJson(statusPath, failedStatus);
      await writeJson(resultPath, {
        id: config.runId,
        runId: config.runId,
        state: "failed",
        success: false,
        summary: message,
        timestamp,
        results: failedStatus.steps.map((step) => ({
          agent: step.agent,
          error: message,
          success: false,
          artifactPaths: step.outputFile ? { outputPath: path.join(config.asyncDir, step.outputFile) } : undefined,
        })),
      });
    }
  } catch (persistError) {
    const persistMessage = persistError instanceof Error ? persistError.stack ?? persistError.message : String(persistError);
    console.error("[pi-lazy-subagents] failed to persist runner failure state:", persistMessage);
  }
  process.exitCode = 1;
});
}
