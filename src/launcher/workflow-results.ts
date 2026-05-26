export type WorkflowTerminalStatus = "completed" | "skipped" | "failed";

export type WorkflowResultMetrics = {
  totalTokens?: number;
  toolCount?: number;
};

export type WorkflowChildResultSnapshot = WorkflowResultMetrics & {
  id?: string;
  taskSummary?: string;
  status?: string;
  success: boolean;
  skipped?: boolean;
  summary: string;
  output: string;
  structuredOutput?: unknown;
  error?: string;
};

export type FanOutGroupStructuredOutput = {
  status: WorkflowTerminalStatus;
  success: boolean;
  summary: string;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  children: WorkflowChildResultSnapshot[];
};

export type WorkflowStepResultBase = Required<WorkflowResultMetrics> & {
  stepId: string;
  taskSummary?: string;
  dependsOn?: string[];
  agent?: string;
  output: string;
  summary: string;
  error?: string;
  success: boolean;
  status: WorkflowTerminalStatus;
  skipped?: boolean;
  skipReason?: string;
};

export type WorkflowStepResult = Partial<WorkflowStepResultBase> & WorkflowResultMetrics & {
  artifactPaths?: {
    outputPath?: string;
  };
  structuredOutput?: unknown;
};

export type FanOutGroupResult = WorkflowStepResultBase & {
  structuredOutput: FanOutGroupStructuredOutput;
};
