import type { LaunchWorkflowStepRequest } from "./interface.js";
import type { FanOutGroupResult, WorkflowStepResult } from "./workflow-results.js";

export type { FanOutGroupResult, FanOutGroupStructuredOutput, WorkflowChildResultSnapshot, WorkflowResultMetrics, WorkflowStepResult, WorkflowStepResultBase, WorkflowTerminalStatus } from "./workflow-results.js";

export type ExpandedWorkflowStep = LaunchWorkflowStepRequest & {
  fanOutFrom?: undefined;
  fanOutParentId?: string;
  fanOutItem?: unknown;
};

export interface SerialLineProcessor {
  enqueue(lines: string[]): void;
  flush(finalLine?: string): Promise<void>;
}

export function createSerialLineProcessor(
  processLine: (line: string) => Promise<void> | void,
  onError?: (error: unknown, context?: { line?: string }) => void,
): SerialLineProcessor;

export type WorkflowPromptResult = {
  summary?: string;
  output?: string;
  structuredOutput?: Record<string, unknown>;
};

export type WorkflowStatusStep = {
  id?: string;
  status?: "pending" | "running" | "completed" | "skipped" | "failed" | "paused" | "cancelled";
  dependsOn?: string[];
};


export interface WorkflowRetryAttemptResult<T = unknown> {
  attempt: number;
  success: boolean;
  result?: T;
  error?: string;
}

export interface WorkflowRetryExecutionResult<T = unknown> {
  attemptCount: number;
  attempts: WorkflowRetryAttemptResult<T>[];
  finalResult: T;
}

export function renderWorkflowPrompt(template: string, results: Record<string, WorkflowPromptResult> | undefined): string;
export function renderWorkflowTemplate(template: string, results: Record<string, WorkflowPromptResult> | undefined, item?: unknown): string;
export function evaluateWorkflowCondition(expression: string | undefined, results: Record<string, WorkflowPromptResult> | undefined, item?: unknown): boolean;
export function expandFanOutWorkflowStep(step: LaunchWorkflowStepRequest, results: Record<string, WorkflowPromptResult> | undefined): ExpandedWorkflowStep[];
export function aggregateFanOutGroupResult(groupStep: LaunchWorkflowStepRequest, childResults: WorkflowStepResult[]): FanOutGroupResult;
export function parseStructuredStepOutput(output: string, outputMode: "json" | "text" | undefined): Record<string, unknown> | undefined;
export function getReadyWorkflowStepIds(steps: WorkflowStatusStep[], maxConcurrency: number): string[];
export function runWorkflowStepWithRetries<T>(options: {
  maxAttempts: number;
  executeAttempt: (attempt: number) => Promise<T>;
  isSuccessful?: (result: T) => boolean;
  onAttemptFailure?: (details: { attempt: number; retriesRemaining: number; result?: T; error?: unknown }) => Promise<void> | void;
}): Promise<WorkflowRetryExecutionResult<T>>;
export function shouldPersistEvent(event: Record<string, unknown> | undefined): boolean;
export function shouldWriteStatusForUsageTotal(previousTotal: number | undefined, nextTotal: number | undefined): boolean;
