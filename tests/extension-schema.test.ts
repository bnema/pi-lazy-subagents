import { describe, expect, test } from "vitest";

import { ToolParamsSchema } from "../extensions/index.js";

describe("lazy_subagents tool schema", () => {
  test("completionPolicy is not exposed because subagents always report back", () => {
    expect(ToolParamsSchema.properties).not.toHaveProperty("completionPolicy");
  });

  test("workflow action exposes workflow steps and concurrency controls", () => {
    const action = ToolParamsSchema.properties.action;
    const maxConcurrency = ToolParamsSchema.properties.maxConcurrency;
    const steps = ToolParamsSchema.properties.steps;

    expect(action).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({ const: "workflow" }),
      ]),
    });
    expect(ToolParamsSchema.properties).toHaveProperty("steps");
    expect(ToolParamsSchema.properties).toHaveProperty("maxConcurrency");
    expect(maxConcurrency).toMatchObject({ type: "integer" });
    expect(steps).toMatchObject({
      items: {
        properties: expect.objectContaining({
          retries: expect.any(Object),
          outputMode: expect.any(Object),
          outputSchema: expect.any(Object),
        }),
      },
    });
  });
});
