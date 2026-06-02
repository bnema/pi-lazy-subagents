import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RunEvent, RunStatus } from "../types.js";

export interface LauncherRuntimeContext {
  pi: ExtensionAPI;
  cwd: string;
  sessionId: string;
  currentModelProvider?: string;
}

export interface LaunchRequestBase {
  runId: string;
  title: string;
  taskSummary: string;
  cwd?: string;
  name?: string;
}

export interface LaunchChildRequest extends LaunchRequestBase {
  agent: string;
  prompt: string;
  sessionFile?: string;
}

export type WorkflowStepOutputMode = "text" | "json";

export interface LaunchGroupChildRequest {
  agent: string;
  prompt: string;
  taskSummary: string;
  cwd?: string;
}

export interface LaunchWorkflowFanOutFromRequest {
  step: string;
  path: string;
  idField?: string;
  maxItems?: number;
}

export interface LaunchWorkflowStepRequest extends LaunchGroupChildRequest {
  id: string;
  dependsOn?: string[];
  retries?: number;
  outputMode?: WorkflowStepOutputMode;
  outputSchema?: string;
  when?: string;
  fanOutFrom?: LaunchWorkflowFanOutFromRequest;
}

export interface LaunchGroupRequest extends LaunchRequestBase {
  children: LaunchGroupChildRequest[];
}

export interface LaunchWorkflowRequest extends LaunchRequestBase {
  steps: LaunchWorkflowStepRequest[];
  maxConcurrency?: number;
}

export interface ContinueLaunchRequest {
  runId: string;
  title: string;
  taskSummary: string;
  prompt: string;
  agent: string;
  asyncDir: string;
  statusPath: string;
  resultPath: string;
  eventsPath: string;
  sessionFile: string;
  artifactPath?: string;
  cwd: string;
}

export interface LaunchResult {
  runId: string;
  asyncId: string;
  asyncDir?: string;
  resultPath?: string;
  sessionFile?: string;
  artifactPath?: string;
  model?: string;
}

export interface NormalizedRunUpdate {
  runId: string;
  status: RunStatus;
  updatedAt: number;
  completedAt?: number;
  sessionFile?: string;
  artifactPath?: string;
  resultPreview?: string;
  errorPreview?: string;
  currentTool?: string;
  toolCount?: number;
  totalTokens?: number;
  attentionNeeded?: boolean;
  event?: RunEvent;
}

export interface Launcher {
  launchChild(request: LaunchChildRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult>;
  launchGroup(request: LaunchGroupRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult>;
  launchWorkflow(request: LaunchWorkflowRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult>;
  continueChild?(request: ContinueLaunchRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult>;
  readUpdate(launch: LaunchResult): Promise<NormalizedRunUpdate | undefined>;
  cancel?(launch: LaunchResult): Promise<boolean>;
}
