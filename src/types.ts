export const RUN_KINDS = ["single", "group", "workflow", "child"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "blocked",
  "completed",
  "skipped",
  "failed",
  "cancelled",
  "paused",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const COMPLETION_POLICIES = ["wake_if_idle"] as const;
export type CompletionPolicy = (typeof COMPLETION_POLICIES)[number];

export const RUN_EVENT_CATEGORIES = [
  "launch",
  "progress",
  "tool",
  "attention",
  "completion",
  "failure",
] as const;
export type RunEventCategory = (typeof RUN_EVENT_CATEGORIES)[number];

export interface RunEvent {
  id: string;
  category: RunEventCategory;
  timestamp: number;
  summary: string;
  key?: string;
  status?: RunStatus;
  details?: Record<string, unknown>;
}

export interface RunLaunchRef {
  runId: string;
  asyncId: string;
  asyncDir?: string;
  resultPath?: string;
  sessionFile?: string;
  artifactPath?: string;
}

export interface RunRecord {
  id: string;
  kind: RunKind;
  agent: string;
  title: string;
  taskSummary: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  completionPolicy: CompletionPolicy;
  sessionFile?: string;
  artifactPath?: string;
  resultPreview?: string;
  errorPreview?: string;
  currentTool?: string;
  toolCount?: number;
  totalTokens?: number;
  model?: string;
  attentionNeeded: boolean;
  name?: string;
  cwd?: string;
  leaseExpiry?: number;
  archived?: boolean;
  groupId?: string;
  children?: string[];
  launchRef?: RunLaunchRef;
  recentEvents: RunEvent[];
}

export interface RunCounts {
  queued: number;
  running: number;
  blocked: number;
  completed: number;
  skipped: number;
  failed: number;
  cancelled: number;
  paused: number;
  attentionNeeded: number;
}

export interface RunRegistrySnapshot {
  runs: RunRecord[];
  counts: RunCounts;
  activeRuns: RunRecord[];
  recentRuns: RunRecord[];
}
