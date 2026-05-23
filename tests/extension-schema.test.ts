import { describe, expect, test } from "vitest";

import { ToolParamsSchema } from "../extensions/index.js";

describe("lazy_subagents tool schema", () => {
  test("completionPolicy is exposed as a string enum for clearer validation errors", () => {
    const completionPolicy = ToolParamsSchema.properties.completionPolicy;

    expect(completionPolicy).toMatchObject({
      type: "string",
      enum: ["notify_only", "follow_up_when_idle", "wake_if_idle", "manual_pickup"],
    });
    expect(completionPolicy).not.toHaveProperty("anyOf");
  });

  test("workflow action exposes workflow steps and concurrency controls", () => {
    const action = ToolParamsSchema.properties.action;

    expect(action).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({ const: "workflow" }),
      ]),
    });
    expect(ToolParamsSchema.properties).toHaveProperty("steps");
    expect(ToolParamsSchema.properties).toHaveProperty("maxConcurrency");
  });
});
