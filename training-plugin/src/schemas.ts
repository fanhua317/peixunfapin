import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

export function parameters(schema: unknown): AnyAgentTool["parameters"] {
  return schema as AnyAgentTool["parameters"];
}

export const EmptyParams = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const satisfies Record<string, unknown>;

export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return parameters({
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  });
}
