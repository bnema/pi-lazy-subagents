import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CompletionPolicy, RunEvent, RunStatus } from "../types.js";

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
  completionPolicy?: CompletionPolicy;
  cwd?: string;
}

export interface LaunchChildRequest extends LaunchRequestBase {
  agent: string;
  prompt: string;
  sessionFile?: string;
}

export interface LaunchGroupChildRequest {
  agent: string;
  prompt: string;
  taskSummary: string;
  cwd?: string;
}

export interface LaunchGroupRequest extends LaunchRequestBase {
  children: LaunchGroupChildRequest[];
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
  readUpdate(launch: LaunchResult): Promise<NormalizedRunUpdate | undefined>;
  cancel?(launch: LaunchResult): Promise<boolean>;
}
