export function buildResultSummary(results: Array<{ stepId?: string; taskSummary?: string; agent?: string; summary?: string; output?: string; error?: string; [key: string]: unknown }>, maxChildLength?: number): string;
export function createSerialLineProcessor(processLine: (line: string) => Promise<void>, onError?: (error: unknown, context?: { line?: string }) => void): { enqueue(lines: string[]): void; flush(): Promise<void> };
export function getReadyWorkflowStepIds(steps: Array<{ id?: string; status?: string; dependsOn?: string[] }>, maxConcurrency: number): string[];
export function parseStructuredStepOutput(output: string, outputMode: string): Record<string, unknown> | undefined;
export function renderWorkflowPrompt(template: string, results: Record<string, { summary?: string; output?: string; structuredOutput?: Record<string, unknown> }>): string;
export function runWorkflowStepWithRetries<T>(options: { maxAttempts: number; executeAttempt: (attempt: number) => Promise<T> }): Promise<{ attemptCount: number; finalResult: T }>;
export function shouldPersistEvent(event: Record<string, any>): boolean;
export function shouldWriteStatusForUsageTotal(previousTotal: number | undefined, nextTotal: number | undefined): boolean;
