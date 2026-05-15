import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_AGENT_PROFILE_NAME,
  getAgentProfile,
  listAvailableAgentProfiles,
  listBuiltinAgentProfiles,
  listDiscoveredAgentProfiles,
  resolveAgentProfileName,
} from "../src/launcher/agent-profiles.js";

describe("agent profiles", () => {
  test("lists built-in profiles with descriptions", () => {
    const profiles = listBuiltinAgentProfiles();

    expect(profiles.map((profile) => profile.name)).toEqual(expect.arrayContaining([
      "delegate",
      "scout",
      "researcher",
      "planner",
      "reviewer",
      "worker",
    ]));
    expect(profiles.every((profile) => profile.description.length > 0)).toBe(true);
  });

  test("loads discovered agent profiles from configured agent directories and lets them override built-ins", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-agents-"));
    const genericDir = path.join(tempRoot, ".agents", "agents");
    const piDir = path.join(tempRoot, ".pi", "agent", "agents");
    await fs.mkdir(genericDir, { recursive: true });
    await fs.mkdir(piDir, { recursive: true });

    await fs.writeFile(
      path.join(genericDir, "typescript-reviewer.md"),
      `---\nname: typescript-reviewer\ndescription: TS review agent\ntools: read, grep, bash\nmodel: openai/gpt-5\nthinking: high\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritSkills: false\n---\nYou are the TypeScript reviewer.\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(piDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Project reviewer override\ntools: read, bash\n---\nYou are the project-specific reviewer.\n`,
      "utf8",
    );

    const discovered = listDiscoveredAgentProfiles([genericDir, piDir]);
    const available = listAvailableAgentProfiles([genericDir, piDir]);
    const reviewer = getAgentProfile("reviewer", [genericDir, piDir]);

    expect(discovered.map((profile) => profile.name)).toEqual(expect.arrayContaining(["typescript-reviewer", "reviewer"]));
    expect(available.map((profile) => profile.name)).toEqual(expect.arrayContaining(["delegate", "reviewer", "typescript-reviewer"]));
    expect(reviewer.description).toBe("Project reviewer override");
    expect(reviewer.systemPrompt).toContain("project-specific reviewer");
    expect(getAgentProfile("typescript-reviewer", [genericDir, piDir]).thinking).toBe("high");
    expect(getAgentProfile("typescript-reviewer", [genericDir, piDir]).systemPromptMode).toBe("replace");
    expect(getAgentProfile("typescript-reviewer", [genericDir, piDir]).inheritProjectContext).toBe(false);
    expect(getAgentProfile("typescript-reviewer", [genericDir, piDir]).inheritSkills).toBe(false);
  });

  test("defaults omitted agent selection to delegate", () => {
    expect(DEFAULT_AGENT_PROFILE_NAME).toBe("delegate");
    expect(resolveAgentProfileName(undefined)).toBe("delegate");
    expect(resolveAgentProfileName("  ")).toBe("delegate");
    expect(resolveAgentProfileName("reviewer")).toBe("reviewer");
    expect(getAgentProfile(resolveAgentProfileName(undefined)).name).toBe("delegate");
  });
});
