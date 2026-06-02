import { describe, expect, test } from "vitest";

import { ToolParamsSchema } from "../extensions/index.js";

describe("lazy_subagents tool schema", () => {
  test("completionPolicy is not exposed because subagents always report back", () => {
    expect(ToolParamsSchema.properties).not.toHaveProperty("completionPolicy");
  });

  test("name parameter is optional and validates pattern for named run addressing", () => {
    expect(ToolParamsSchema.properties).toHaveProperty("name");
    const nameProp = ToolParamsSchema.properties.name as any;
    expect(nameProp.type).toBe("string");
    expect(nameProp.pattern).toBe("^[a-z0-9][a-z0-9_-]{0,63}$");
    expect(nameProp.description).toContain("action=continue");
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
