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

export async function resolveCompletedSessionFile(sessionDir, continueSessionFile) {
  if (continueSessionFile) return continueSessionFile;
  return await findLatestSessionFile(sessionDir);
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

export function buildResultSummary(results, maxChildLength = 200) {
  const lines = results
    .map((result) => {
      const text = summarizeOutput(result.summary || result.output || result.error || "(no output)", maxChildLength);
      return text ? `${formatResultLabel(result)}: ${text}` : undefined;
    })
    .filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : "";
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getPathValue(source, pathExpression) {
  if (!pathExpression) return source;
  const segments = String(pathExpression).split(".").filter(Boolean);
  let current = source;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function getStructuredValue(structuredOutput, pathExpression) {
  if (!structuredOutput || typeof structuredOutput !== "object") return undefined;
  return getPathValue(structuredOutput, pathExpression);
}

function stringifyTemplateValue(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isTruthyWorkflowValue(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0 && value.trim().toLowerCase() !== "false";
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function sanitizeGeneratedStepId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function resolveWorkflowReference(stepId, fieldPath, results, item) {
  if (stepId === "item") {
    const itemValue = getPathValue(item, fieldPath);
    if (itemValue === undefined) {
      throw new Error(`Workflow item is missing field ${fieldPath}.`);
    }
    return itemValue;
  }

  const stepResult = results?.[stepId];
  if (!stepResult) {
    throw new Error(`Unknown workflow step reference: ${stepId}`);
  }

  if (fieldPath === "summary") {
    return stepResult.summary ?? summarizeOutput(stepResult.output) ?? "";
  }

  if (fieldPath === "output") {
    return stepResult.output ?? "";
  }

  if (fieldPath === "json") {
    if (!stepResult.structuredOutput) {
      throw new Error(`Workflow step ${stepId} has no structured output.`);
    }
    return stepResult.structuredOutput;
  }

  const normalizedPath = fieldPath.startsWith("structured.") ? fieldPath.slice("structured.".length) : fieldPath;
  const structuredValue = getStructuredValue(stepResult.structuredOutput, normalizedPath);
  if (structuredValue === undefined) {
    throw new Error(`Workflow step ${stepId} is missing structured field ${normalizedPath}.`);
  }

  return structuredValue;
}

function extractFencedJsonCandidate(text) {
  const match = text.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/u);
  return match?.[1]?.trim();
}

function extractBalancedJsonObjectCandidate(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1).trim();
  }

  return undefined;
}

function parseJsonObjectCandidate(candidate) {
  if (!candidate) return undefined;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object response for structured workflow output.");
  }
  return parsed;
}

export function parseStructuredStepOutput(output, outputMode) {
  if (outputMode !== "json") return undefined;
  const trimmed = String(output ?? "").trim();
  if (!trimmed) {
    throw new Error("Expected a JSON object response, but the workflow step returned an empty output.");
  }

  const candidates = [
    trimmed,
    extractFencedJsonCandidate(trimmed),
    extractBalancedJsonObjectCandidate(trimmed),
  ];
  let lastError;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return parseJsonObjectCandidate(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Expected a JSON object response, but parsing failed: ${toErrorMessage(lastError ?? "no JSON object found")}`);
}

export async function runWorkflowStepWithRetries({
  maxAttempts,
  executeAttempt,
  isSuccessful = (result) => result?.success !== false,
  onAttemptFailure,
}) {
  const attempts = [];
  let lastResult;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await executeAttempt(attempt);
      const success = isSuccessful(result);
      attempts.push({ attempt, success, result, error: success ? undefined : toErrorMessage(result?.error ?? "Workflow step failed") });
      lastResult = result;
      if (success) {
        return { attemptCount: attempt, attempts, finalResult: result };
      }
      if (attempt < maxAttempts) {
        await onAttemptFailure?.({ attempt, retriesRemaining: maxAttempts - attempt, result });
      }
    } catch (error) {
      lastError = error;
      attempts.push({ attempt, success: false, error: toErrorMessage(error) });
      if (error?.nonRetryable) {
        break;
      }
      if (attempt < maxAttempts) {
        await onAttemptFailure?.({ attempt, retriesRemaining: maxAttempts - attempt, error });
        continue;
      }
    }
  }

  if (lastResult !== undefined) {
    return { attemptCount: maxAttempts, attempts, finalResult: lastResult };
  }

  const terminalError = lastError instanceof Error ? lastError : new Error(toErrorMessage(lastError ?? "Workflow step failed"));
  terminalError.attempts = attempts;
  terminalError.attemptCount = maxAttempts;
  throw terminalError;
}

export function renderWorkflowTemplate(template, results, item) {
  return String(template).replace(/\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, stepId, fieldPath) => {
    return stringifyTemplateValue(resolveWorkflowReference(stepId, fieldPath, results, item));
  });
}

export function renderWorkflowPrompt(template, results) {
  return renderWorkflowTemplate(template, results);
}

export function evaluateWorkflowCondition(expression, results, item) {
  if (expression === undefined || expression === null || String(expression).trim() === "") return true;
  const trimmed = String(expression).trim();
  const referenceMatch = trimmed.match(/^\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*\}\}$/u);
  if (referenceMatch) {
    return isTruthyWorkflowValue(resolveWorkflowReference(referenceMatch[1], referenceMatch[2], results, item));
  }
  return isTruthyWorkflowValue(renderWorkflowTemplate(trimmed, results, item));
}

export function expandFanOutWorkflowStep(step, results) {
  const fanOut = step?.fanOutFrom;
  if (!fanOut) return [];

  const sourceResult = results?.[fanOut.step];
  if (!sourceResult) {
    throw new Error(`Workflow fanOutFrom source ${fanOut.step} is not available.`);
  }

  const pathExpression = String(fanOut.path ?? "");
  const normalizedPath = pathExpression.startsWith("structured.") ? pathExpression.slice("structured.".length) : pathExpression;
  const items = getStructuredValue(sourceResult.structuredOutput, normalizedPath);
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw new Error(`Workflow fanOutFrom path ${fanOut.path} did not resolve to an array.`);
  }

  const maxItems = Number.isInteger(fanOut.maxItems) ? fanOut.maxItems : items.length;
  const generatedIds = new Set();
  return items.slice(0, Math.max(0, maxItems)).map((item, index) => {
    const rawId = fanOut.idField ? getPathValue(item, fanOut.idField) : undefined;
    const itemId = sanitizeGeneratedStepId(rawId ?? index + 1);
    const generatedId = `${step.id}[${itemId}]`;
    if (generatedIds.has(generatedId)) {
      throw new Error(`Duplicate generated workflow step id: ${generatedId}`);
    }
    generatedIds.add(generatedId);
    const render = (value) => typeof value === "string" ? renderWorkflowTemplate(value, results, item) : value;
    return {
      ...step,
      id: generatedId,
      agent: render(step.agent),
      taskSummary: render(step.taskSummary),
      prompt: render(step.prompt),
      cwd: render(step.cwd),
      fanOutFrom: undefined,
      fanOutParentId: step.id,
      fanOutItem: item,
    };
  });
}

export function getDependencyBlockedSkip(child, failedIds, skippedIds) {
  const dependencyIds = child.dependsOn ?? [];
  if (dependencyIds.some((dependencyId) => failedIds.has(dependencyId))) {
    return {
      reason: "Skipped because a dependency did not complete.",
      success: false,
    };
  }
  if (dependencyIds.some((dependencyId) => skippedIds.has(dependencyId))) {
    return {
      reason: "Skipped because a dependency was skipped.",
      success: true,
    };
  }
  return undefined;
}

export function getReadyWorkflowStepIds(steps, maxConcurrency) {
  const runningCount = steps.filter((step) => step.status === "running" && !(step.fanOutFrom && Array.isArray(step.fanOutChildIds))).length;
  const availableSlots = Math.max(0, maxConcurrency - runningCount);
  if (availableSlots === 0) return [];

  const completedIds = new Set(
    steps
      .filter((step) => step.status === "completed" && typeof step.id === "string" && step.id.length > 0)
      .map((step) => step.id),
  );

  return steps
    .filter((step) => step.status === "pending")
    .filter((step) => (step.dependsOn ?? []).every((dependencyId) => completedIds.has(dependencyId)))
    .slice(0, availableSlots)
    .map((step) => step.id)
    .filter((stepId) => typeof stepId === "string" && stepId.length > 0);
}

export function shouldPersistEvent(event) {
  return event?.type !== "message_update";
}

export function shouldWriteStatusForUsageTotal(previousTotal, nextTotal) {
  return typeof nextTotal === "number"
    && Number.isFinite(nextTotal)
    && nextTotal > 0
    && previousTotal !== nextTotal;
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
      id: child.id,
      agent: child.profile.name,
      model: child.resolvedModel,
      thinking: child.resolvedThinking,
      status: "pending",
      taskSummary: child.taskSummary,
      dependsOn: child.dependsOn,
      when: child.when,
      fanOutFrom: child.fanOutFrom,
      fanOutParentId: child.fanOutParentId,
      retries: child.retries ?? 0,
      maxAttempts: (child.retries ?? 0) + 1,
      attempt: 0,
      outputMode: child.outputMode ?? "text",
      outputSchema: child.outputSchema,
      summary: undefined,
      structuredOutput: undefined,
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
  if (steps.some((step) => step.status === "cancelled")) return "cancelled";
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

function appendPiChildArgs(args, child) {
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
}

export function buildPiArgs(child, promptOverride, continueSessionFile) {
  const args = ["--mode", "json"];
  if (continueSessionFile) {
    args.push("--session", continueSessionFile);
  } else {
    args.push("--session-dir", child.sessionDir);
  }
  appendPiChildArgs(args, child);

  const basePrompt = promptOverride ?? child.prompt;
  const structuredOutputInstruction = child.outputMode === "json"
    ? `\n\nReturn ONLY a valid JSON object in your final answer.${child.outputSchema ? ` Match this schema guidance exactly:\n${child.outputSchema}` : ""}`
    : "";
  args.push(`${basePrompt}${structuredOutputInstruction}`);
  return args;
}

async function runChild(config, statusPath, status, child, index, promptOverride, attemptNumber = 1) {
  const step = status.steps[index];
  step.status = "running";
  step.attempt = attemptNumber;
  step.startedAt = now();
  step.endedAt = undefined;
  step.durationMs = undefined;
  step.error = undefined;
  step.summary = undefined;
  step.structuredOutput = undefined;
  step.currentTool = undefined;
  step.currentToolStartedAt = undefined;
  await updateStatus(statusPath, status);

  const continueSessionFile = config.mode === "continue" ? config.continueSessionFile : undefined;
  if (config.mode === "continue" && !continueSessionFile) {
    throw new Error("Continue mode requires a session file.");
  }
  const args = buildPiArgs(child, promptOverride, continueSessionFile);
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

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      await appendLine(config.eventsPath, JSON.stringify({ runId: config.runId, index, raw: trimmed }));
      return;
    }

    if (shouldPersistEvent(event)) {
      await appendLine(config.eventsPath, JSON.stringify({ runId: config.runId, index, raw: trimmed }));
    }

    const usageTotal = extractUsageTotal(event);
    if (usageTotal !== undefined) {
      const nextTotalTokens = recordUsageSample(usageTracker, usageTotal);
      if (shouldWriteStatusForUsageTotal(step.totalTokens, nextTotalTokens)) {
        step.totalTokens = nextTotalTokens;
        await updateStatus(statusPath, status);
      }
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
        await updateStatus(statusPath, status);
      }
      return;
    }

    if (event.type === "turn_end") {
      const committedTotalTokens = commitUsageTurn(usageTracker);
      if (step.totalTokens !== committedTotalTokens) {
        step.totalTokens = committedTotalTokens;
        await updateStatus(statusPath, status);
      }
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

  sessionFile = await resolveCompletedSessionFile(child.sessionDir, continueSessionFile);
  step.sessionFile = sessionFile;
  step.endedAt = now();
  step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : undefined;
  step.currentTool = undefined;
  step.currentToolStartedAt = undefined;
  step.exitCode = exitCode;
  step.totalTokens = finalizeUsageTracker(usageTracker);

  let structuredOutput;
  let summary;
  if (exitCode === 0) {
    try {
      structuredOutput = parseStructuredStepOutput(finalOutput, child.outputMode);
      summary = structuredOutput?.summary && typeof structuredOutput.summary === "string"
        ? structuredOutput.summary
        : summarizeOutput(finalOutput);
      step.status = "completed";
      step.error = undefined;
      step.summary = summary;
      step.structuredOutput = structuredOutput;
    } catch (error) {
      step.status = "failed";
      step.error = toErrorMessage(error);
      step.summary = undefined;
      step.structuredOutput = undefined;
    }
  } else {
    step.status = "failed";
    step.error = summarizeOutput(stderrBuffer) ?? `pi exited with code ${exitCode}`;
    step.summary = undefined;
    step.structuredOutput = undefined;
  }

  await updateStatus(statusPath, status);

  return {
    stepId: child.id,
    taskSummary: child.taskSummary,
    dependsOn: child.dependsOn,
    agent: childAgentName(child),
    output: finalOutput,
    summary,
    structuredOutput,
    error: step.status === "completed" ? undefined : step.error,
    success: step.status === "completed",
    status: step.status,
    attempt: attemptNumber,
    maxAttempts: (child.retries ?? 0) + 1,
    sessionFile,
    totalTokens: step.totalTokens,
    toolCount: step.toolCount,
    artifactPaths: {
      outputPath: path.join(config.asyncDir, child.outputFile),
    },
  };
}

function childAgentName(child) {
  return child.agent ?? child.profile?.name ?? "delegate";
}

function failedChildResult(config, child, error, sessionFile, attempt = 1, attempts = []) {
  return {
    stepId: child.id,
    taskSummary: child.taskSummary,
    dependsOn: child.dependsOn,
    agent: childAgentName(child),
    output: "",
    error,
    success: false,
    status: "failed",
    attempt,
    maxAttempts: (child.retries ?? 0) + 1,
    attempts,
    sessionFile,
    totalTokens: 0,
    toolCount: 0,
    artifactPaths: {
      outputPath: path.join(config.asyncDir, child.outputFile),
    },
  };
}

function skippedChildResult(child, reason, success = true) {
  return {
    stepId: child.id,
    taskSummary: child.taskSummary,
    dependsOn: child.dependsOn,
    agent: childAgentName(child),
    output: "",
    summary: reason,
    error: success ? undefined : reason,
    success,
    status: "skipped",
    skipped: true,
    skipReason: reason,
    attempt: 0,
    maxAttempts: (child.retries ?? 0) + 1,
    attempts: [],
    totalTokens: 0,
    toolCount: 0,
  };
}

function formatResultLabel(result) {
  return result.stepId ?? result.taskSummary ?? result.agent ?? "step";
}

function fanOutChildResultEntry(result) {
  return {
    id: result.stepId,
    taskSummary: result.taskSummary,
    status: result.status ?? (result.skipped ? "skipped" : result.success ? "completed" : "failed"),
    success: Boolean(result.success),
    skipped: result.skipped === true ? true : undefined,
    summary: result.summary ?? summarizeOutput(result.output || result.error || "") ?? "",
    output: result.output ?? "",
    structuredOutput: result.structuredOutput,
    error: result.error,
    totalTokens: result.totalTokens,
    toolCount: result.toolCount,
  };
}

export function aggregateFanOutGroupResult(groupStep, childResults) {
  const children = childResults.map(fanOutChildResultEntry);
  const failedCount = children.filter((child) => !child.success).length;
  const skippedCount = children.filter((child) => child.skipped || child.status === "skipped").length;
  const completedCount = children.filter((child) => child.success && !child.skipped && child.status !== "skipped").length;
  const totalTokens = children.reduce((sum, child) => sum + (typeof child.totalTokens === "number" ? child.totalTokens : 0), 0);
  const toolCount = children.reduce((sum, child) => sum + (typeof child.toolCount === "number" ? child.toolCount : 0), 0);
  const success = failedCount === 0;
  const status = success ? (completedCount === 0 && skippedCount > 0 ? "skipped" : "completed") : "failed";
  const countParts = [];
  if (completedCount > 0) countParts.push(`${completedCount} completed`);
  if (failedCount > 0) countParts.push(`${failedCount} failed`);
  if (skippedCount > 0) countParts.push(`${skippedCount} skipped`);
  const summary = `Fan-out group ${groupStep.id} ${success ? "completed" : "failed"}: ${countParts.join(", ") || "0 children"}.`;
  const output = children.map((child) => {
    const label = child.taskSummary || child.id;
    const text = child.summary || child.error || summarizeOutput(child.output) || "";
    return `## ${label}\nStatus: ${child.status}\n${text}`.trim();
  }).join("\n\n");
  const firstError = children.find((child) => child.error)?.error;

  return {
    stepId: groupStep.id,
    taskSummary: groupStep.taskSummary,
    dependsOn: groupStep.dependsOn,
    agent: childAgentName(groupStep),
    output,
    summary,
    error: success ? undefined : firstError ?? summary,
    success,
    status,
    skipped: status === "skipped" ? true : undefined,
    skipReason: status === "skipped" ? summary : undefined,
    attempt: 0,
    maxAttempts: (groupStep.retries ?? 0) + 1,
    attempts: [],
    totalTokens,
    toolCount,
    structuredOutput: {
      status,
      success,
      summary,
      completedCount,
      failedCount,
      skippedCount,
      children,
    },
  };
}

function buildWorkflowResultsMap(results) {
  return Object.fromEntries(
    results
      .filter((result) => typeof result?.stepId === "string" && result.stepId.length > 0)
      .map((result) => [result.stepId, {
        summary: result.summary ?? summarizeOutput(result.output || result.error || "") ?? "",
        output: result.output ?? result.error ?? "",
        structuredOutput: result.structuredOutput,
      }]),
  );
}

function updateFanOutGroupStatus(status, groupStep, aggregate) {
  const step = (status.steps ?? []).find((candidate) => candidate.id === groupStep.id);
  if (!step) return false;
  step.status = aggregate.status;
  step.error = aggregate.error;
  step.skipReason = aggregate.skipReason;
  step.summary = aggregate.summary;
  step.structuredOutput = aggregate.structuredOutput;
  step.totalTokens = aggregate.totalTokens;
  step.toolCount = aggregate.toolCount;
  step.endedAt = now();
  step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : 0;
  return true;
}

function markWorkflowStepsSkipped(status, stepIds, reason) {
  let changed = false;
  const wanted = new Set(stepIds);
  for (const step of status.steps ?? []) {
    if (!wanted.has(step.id) || (step.status !== "pending" && step.status !== "running")) continue;
    step.status = "skipped";
    step.error = undefined;
    step.skipReason = reason;
    step.summary = reason;
    step.structuredOutput = undefined;
    step.endedAt = now();
    step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : 0;
    changed = true;
  }
  return changed;
}

async function writeResult(config, status, results) {
  const timestamp = now();
  const success = results.every((result) => result.success);
  const summary = buildResultSummary(results);

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

async function runWorkflow(config, status) {
  const results = [];
  const active = new Map();
  const maxConcurrency = Math.max(1, config.maxConcurrency ?? config.children.length);

  const appendSyntheticStep = async (child) => {
    const index = config.children.length;
    child.sessionDir = path.join(config.asyncDir, `session-${index}`);
    child.outputFile = `output-${index}.log`;
    child.profile = child.profileByAgent?.[child.agent] ?? child.profile;
    const resolvedAgentSettings = child.resolvedByAgent?.[child.agent];
    child.resolvedModel = resolvedAgentSettings?.resolvedModel;
    child.resolvedThinking = resolvedAgentSettings?.resolvedThinking;
    config.children.push(child);
    await ensureDir(child.sessionDir);
    status.steps.push({
      index,
      id: child.id,
      agent: child.profile?.name ?? child.agent,
      model: child.resolvedModel,
      thinking: child.resolvedThinking,
      status: "pending",
      taskSummary: child.taskSummary,
      dependsOn: child.dependsOn,
      when: child.when,
      fanOutParentId: child.fanOutParentId,
      retries: child.retries ?? 0,
      maxAttempts: (child.retries ?? 0) + 1,
      attempt: 0,
      outputMode: child.outputMode ?? "text",
      outputSchema: child.outputSchema,
      outputFile: child.outputFile,
    });
  };

  while (results.length < config.children.length) {
    const groupChildrenByParent = new Map();
    for (const child of config.children) {
      if (!child.fanOutParentId) continue;
      const list = groupChildrenByParent.get(child.fanOutParentId) ?? [];
      list.push(child);
      groupChildrenByParent.set(child.fanOutParentId, list);
    }

    let aggregatedGroups = false;
    for (const groupChild of config.children.filter((child) => child.fanOutFrom && !results.some((result) => result.stepId === child.id))) {
      const fanOutChildren = groupChildrenByParent.get(groupChild.id);
      if (!fanOutChildren || fanOutChildren.length === 0) continue;
      const childResults = fanOutChildren
        .map((child) => results.find((result) => result.stepId === child.id))
        .filter(Boolean);
      if (childResults.length !== fanOutChildren.length) continue;
      const aggregate = aggregateFanOutGroupResult(groupChild, childResults);
      updateFanOutGroupStatus(status, groupChild, aggregate);
      results.push(aggregate);
      aggregatedGroups = true;
    }
    if (aggregatedGroups) {
      await updateStatus(config.statusPath, status);
      continue;
    }

    const failedIds = new Set(results.filter((result) => !result.success && !result.skipped).map((result) => result.stepId));
    const skippedIds = new Set(results.filter((result) => result.skipped).map((result) => result.stepId));
    const unsatisfiedIds = new Set([...failedIds, ...skippedIds]);

    const dependencyBlockedChildren = config.children
      .map((child) => ({
        child,
        skip: results.some((result) => result.stepId === child.id)
          ? undefined
          : getDependencyBlockedSkip(child, failedIds, skippedIds),
      }))
      .filter((entry) => entry.skip);

    if (dependencyBlockedChildren.length > 0) {
      for (const { child, skip } of dependencyBlockedChildren) {
        const changed = markWorkflowStepsSkipped(status, [child.id], skip.reason);
        if (changed) {
          await updateStatus(config.statusPath, status);
        }
        if (results.some((result) => result.stepId === child.id)) continue;
        results.push(skippedChildResult(child, skip.reason, skip.success));
      }
      continue;
    }

    const readyStepIds = getReadyWorkflowStepIds(
      (status.steps ?? []).filter((step) => !(step.dependsOn ?? []).some((dependencyId) => unsatisfiedIds.has(dependencyId))),
      maxConcurrency,
    );

    let progressedWithoutActive = false;
    for (const stepId of readyStepIds) {
      if (active.has(stepId) || results.some((result) => result.stepId === stepId)) continue;
      const index = config.children.findIndex((child) => child.id === stepId);
      if (index < 0) continue;
      const child = config.children[index];
      const workflowResults = buildWorkflowResultsMap(results);

      if (!evaluateWorkflowCondition(child.when, workflowResults, child.fanOutItem)) {
        const reason = `Skipped because when condition evaluated false: ${child.when}`;
        markWorkflowStepsSkipped(status, [child.id], reason);
        results.push(skippedChildResult(child, reason, true));
        progressedWithoutActive = true;
        await updateStatus(config.statusPath, status);
        continue;
      }

      if (child.fanOutFrom) {
        let expansions;
        try {
          expansions = expandFanOutWorkflowStep(child, workflowResults);
        } catch (error) {
          const message = toErrorMessage(error);
          const step = status.steps[index];
          step.status = "failed";
          step.error = message;
          step.endedAt = now();
          await updateStatus(config.statusPath, status);
          results.push(failedChildResult(config, child, message, undefined, 0, []));
          progressedWithoutActive = true;
          continue;
        }

        if (expansions.length === 0) {
          const reason = `Skipped because fanOutFrom ${child.fanOutFrom.step}.${child.fanOutFrom.path} produced no children.`;
          markWorkflowStepsSkipped(status, [child.id], reason);
          results.push(skippedChildResult(child, reason, true));
          progressedWithoutActive = true;
          await updateStatus(config.statusPath, status);
          continue;
        }

        const groupStatusStep = status.steps[index];
        groupStatusStep.status = "running";
        groupStatusStep.startedAt = groupStatusStep.startedAt ?? now();
        groupStatusStep.summary = `Expanded into ${expansions.length} fan-out child step${expansions.length === 1 ? "" : "s"}.`;
        groupStatusStep.fanOutChildIds = expansions.map((expansion) => expansion.id);
        const existingStepIds = new Set(status.steps.map((step) => step.id));
        for (const expansion of expansions) {
          if (existingStepIds.has(expansion.id)) {
            throw new Error(`Dynamic workflow step id collision: ${expansion.id}`);
          }
          existingStepIds.add(expansion.id);
          await appendSyntheticStep(expansion);
        }
        progressedWithoutActive = true;
        await updateStatus(config.statusPath, status);
        continue;
      }

      const task = runWorkflowStepWithRetries({
        maxAttempts: (child.retries ?? 0) + 1,
        executeAttempt: async (attempt) => {
          const workflowResults = buildWorkflowResultsMap(results);
          let renderedPrompt;
          try {
            renderedPrompt = renderWorkflowTemplate(child.prompt, workflowResults, child.fanOutItem);
          } catch (error) {
            const promptError = error instanceof Error ? error : new Error(String(error));
            promptError.nonRetryable = true;
            throw promptError;
          }
          return await runChild(config, config.statusPath, status, child, index, renderedPrompt, attempt);
        },
        onAttemptFailure: async ({ retriesRemaining, result, error }) => {
          if (retriesRemaining <= 0) return;
          const step = status.steps[index];
          step.status = "pending";
          step.error = result?.error ?? toErrorMessage(error ?? "Workflow step failed");
          step.summary = undefined;
          step.structuredOutput = undefined;
          step.currentTool = undefined;
          step.currentToolStartedAt = undefined;
          step.endedAt = now();
          step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : undefined;
          await updateStatus(config.statusPath, status);
        },
      })
        .then(({ attemptCount, attempts, finalResult }) => ({
          stepId,
          result: {
            ...finalResult,
            attempt: attemptCount,
            attempts,
          },
        }))
        .catch(async (error) => {
          const message = toErrorMessage(error);
          const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
          const step = status.steps[index];
          step.status = "failed";
          step.error = message;
          step.summary = undefined;
          step.structuredOutput = undefined;
          step.endedAt = now();
          step.durationMs = step.startedAt ? Math.max(0, step.endedAt - step.startedAt) : undefined;
          await updateStatus(config.statusPath, status);
          return {
            stepId,
            result: failedChildResult(config, child, message, step.sessionFile, error?.attemptCount ?? step.attempt ?? 1, attempts),
          };
        });
      active.set(stepId, task);
    }

    if (active.size === 0 && progressedWithoutActive) {
      continue;
    }

    if (active.size === 0) {
      const unresolvedChildren = config.children.filter((child) => !results.some((result) => result.stepId === child.id));
      if (unresolvedChildren.length === 0) break;
      const changed = markWorkflowStepsSkipped(
        status,
        unresolvedChildren.map((child) => child.id),
        "Skipped because workflow dependencies could not be satisfied.",
      );
      if (changed) {
        await updateStatus(config.statusPath, status);
      }
      for (const child of unresolvedChildren) {
        if (results.some((result) => result.stepId === child.id)) continue;
        results.push(skippedChildResult(child, "Skipped because workflow dependencies could not be satisfied.", false));
      }
      break;
    }

    const { stepId, result } = await Promise.race(active.values());
    active.delete(stepId);
    results.push(result);
  }

  return results;
}

async function run(config) {
  await ensureDir(config.asyncDir);
  await ensureDir(config.resultsDir);

  // For continue mode, the session directory already exists and the controller
  // has cleared stale artifacts. We pass continueSessionFile through to
  // buildPiArgs so Pi resumes the existing session.
  if (config.mode !== "continue") {
    for (const child of config.children) {
      await ensureDir(child.sessionDir);
    }
  }

  const status = createInitialStatus(config);
  await writeJson(config.statusPath, status);

  const results = config.mode === "continue"
    ? [await runChild(config, config.statusPath, status, config.children[0], 0)]
    : config.mode === "parallel"
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
    : config.mode === "workflow"
      ? await runWorkflow(config, status)
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
