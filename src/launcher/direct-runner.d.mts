export interface SerialLineProcessor {
  enqueue(lines: string[]): void;
  flush(finalLine?: string): Promise<void>;
}

export function createSerialLineProcessor(
  processLine: (line: string) => Promise<void> | void,
  onError?: (error: unknown, context?: { line?: string }) => void,
): SerialLineProcessor;

export function shouldPersistEvent(event: Record<string, unknown> | undefined): boolean;
export function shouldWriteStatusForUsageTotal(previousTotal: number | undefined, nextTotal: number | undefined): boolean;
