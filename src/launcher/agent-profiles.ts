import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  source: "builtin" | "file";
  sourcePath?: string;
}

export const DEFAULT_AGENT_PROFILE_NAME = "delegate";

const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls", "diagnostics", "code_search"];
const EDIT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "diagnostics", "code_search"];
const RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls", "web_search", "fetch_content", "code_search"];

const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  delegate: {
    name: "delegate",
    description: "General-purpose fallback. Good when unsure which profile to choose; can inspect and edit code.",
    systemPrompt:
      "You are a delegated Pi child session. Complete the assigned task autonomously with the provided tools. Stay tightly scoped to the task and return a concise useful result.",
    tools: EDIT_TOOLS,
    source: "builtin",
  },
  scout: {
    name: "scout",
    description: "Read-only repo reconnaissance. Use for fast codebase inspection and file discovery.",
    systemPrompt:
      "You are a fast codebase scout. Inspect the local code, identify the relevant files, summarize the current structure, and highlight risks or unanswered questions. Do not edit files.",
    tools: DEFAULT_TOOLS,
    source: "builtin",
  },
  researcher: {
    name: "researcher",
    description: "Read-only evidence gathering. Use for local plus external research-backed answers.",
    systemPrompt:
      "You are a focused research child session. Gather relevant evidence from local code and external sources when needed, then return a concise evidence-backed summary. Do not edit files.",
    tools: RESEARCH_TOOLS,
    source: "builtin",
  },
  planner: {
    name: "planner",
    description: "Read-only planning and design work. Use for implementation plans and structured approach options.",
    systemPrompt:
      "You are a planning child session. Understand the problem, inspect the codebase, and produce a concrete implementation plan or design summary. Do not edit files.",
    tools: DEFAULT_TOOLS,
    source: "builtin",
  },
  reviewer: {
    name: "reviewer",
    description: "Read-only review pass. Use for code review, verification, and findings with evidence.",
    systemPrompt:
      "You are a review child session. Inspect the target carefully, verify from code and tests, and report concise evidence-backed findings with severity. Do not edit files.",
    tools: DEFAULT_TOOLS,
    source: "builtin",
  },
  worker: {
    name: "worker",
    description: "Implementation profile. Use for making code changes and validating them when practical.",
    systemPrompt:
      "You are an implementation child session. Make the requested code changes directly, validate them when practical, and summarize what changed along with any limitations or follow-up needs.",
    tools: EDIT_TOOLS,
    source: "builtin",
  },
};

function defaultAgentProfileSearchDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".agents", "agents"),
    path.join(home, ".pi", "agent", "agents"),
  ];
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function firstBodyLine(body: string): string | undefined {
  return body.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

function parseAgentProfileFile(filePath: string): AgentProfile | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
    const name = normalizeText(frontmatter.name) ?? path.basename(filePath, path.extname(filePath));
    const systemPrompt = body.trim();
    if (!name || !systemPrompt) return undefined;

    return {
      name,
      description: normalizeText(frontmatter.description) ?? firstBodyLine(systemPrompt) ?? `Discovered agent profile from ${filePath}.`,
      systemPrompt,
      tools: normalizeTools(frontmatter.tools),
      model: normalizeText(frontmatter.model),
      thinking: normalizeText(frontmatter.thinking),
      systemPromptMode: normalizeText(frontmatter.systemPromptMode) === "replace" ? "replace" : "append",
      inheritProjectContext: normalizeBoolean(frontmatter.inheritProjectContext),
      inheritSkills: normalizeBoolean(frontmatter.inheritSkills),
      source: "file",
      sourcePath: filePath,
    };
  } catch {
    return undefined;
  }
}

export function listBuiltinAgentProfiles(): AgentProfile[] {
  return Object.values(BUILTIN_PROFILES);
}

export function listDiscoveredAgentProfiles(searchDirs = defaultAgentProfileSearchDirs()): AgentProfile[] {
  const discovered = new Map<string, AgentProfile>();

  for (const dirPath of searchDirs) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const profile = parseAgentProfileFile(path.join(dirPath, entry.name));
        if (!profile) continue;
        discovered.set(profile.name, profile);
      }
    } catch {
      // Missing or unreadable agent directories are ignored.
    }
  }

  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Merge listBuiltinAgentProfiles() with listDiscoveredAgentProfiles().
 *
 * Discovered file-based profiles win on name collisions so project- or machine-specific
 * agent definitions can intentionally shadow builtin defaults without modifying the package.
 */
export function listAvailableAgentProfiles(searchDirs = defaultAgentProfileSearchDirs()): AgentProfile[] {
  const profiles = new Map<string, AgentProfile>();
  for (const profile of listBuiltinAgentProfiles()) {
    profiles.set(profile.name, profile);
  }
  for (const profile of listDiscoveredAgentProfiles(searchDirs)) {
    profiles.set(profile.name, profile);
  }
  return [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveAgentProfileName(agentName: string | undefined): string {
  const normalized = agentName?.trim();
  return normalized ? normalized : DEFAULT_AGENT_PROFILE_NAME;
}

export function getAgentProfile(agentName: string, searchDirs = defaultAgentProfileSearchDirs()): AgentProfile {
  const resolvedName = resolveAgentProfileName(agentName);
  const available = new Map(listAvailableAgentProfiles(searchDirs).map((profile) => [profile.name, profile]));
  return available.get(resolvedName) ?? {
    name: resolvedName,
    description: "Custom delegated profile. Falls back to the general-purpose delegate behavior.",
    systemPrompt:
      "You are a delegated Pi child session. Complete the assigned task with the provided tools, stay within scope, and return a concise useful result.",
    tools: EDIT_TOOLS,
    source: "builtin",
  };
}
