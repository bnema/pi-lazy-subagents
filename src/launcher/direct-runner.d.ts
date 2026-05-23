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
};

export type WorkflowStatusStep = {
  id?: string;
  status?: "pending" | "running" | "completed" | "failed" | "paused" | "cancelled";
  dependsOn?: string[];
};

export function renderWorkflowPrompt(template: string, results: Record<string, WorkflowPromptResult> | undefined): string;
export function getReadyWorkflowStepIds(steps: WorkflowStatusStep[], maxConcurrency: number): string[];
export function shouldPersistEvent(event: Record<string, unknown> | undefined): boolean;
export function shouldWriteStatusForUsageTotal(previousTotal: number | undefined, nextTotal: number | undefined): boolean;
