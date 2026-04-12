import { describe, expect, it } from "vitest";
import {
  collectAdvertisedToolNames,
  collectAllowedToolNames,
  collectSemanticToolAliases,
  collectSemanticToolNames,
} from "./tool-name-allowlist.js";

describe("tool-name-allowlist", () => {
  const nativeTools = [
    {
      name: "read",
      label: "read",
      description: "Read files",
      parameters: { type: "object" },
      execute: async () =>
        ({
          content: [],
          details: {},
        }) as never,
    },
  ] as unknown as Parameters<typeof collectAdvertisedToolNames>[0]["tools"];

  const clientTools = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        description: "Fetch weather",
        parameters: { type: "object" },
      },
    },
  ];

  it("advertises both native and hosted client tools without duplicates", () => {
    expect(
      collectAdvertisedToolNames({
        tools: [...nativeTools, nativeTools[0]],
        clientTools: [...clientTools, clientTools[0]],
      }),
    ).toEqual(["read", "get_weather"]);
  });

  it("includes hosted client tools in the allowed tool name set", () => {
    expect(
      collectAllowedToolNames({
        tools: [...nativeTools],
        clientTools,
      }),
    ).toEqual(new Set(["read", "get_weather"]));
  });

  it("advertises hosted client tools even when no native tools are present", () => {
    expect(
      collectAdvertisedToolNames({
        tools: [],
        clientTools,
      }),
    ).toEqual(["get_weather"]);
  });

  it("does not infer semantic names from hosted aliases that only match by name", () => {
    expect(
      collectSemanticToolNames({
        tools: [],
        clientTools: [
          {
            type: "function" as const,
            function: {
              name: "message",
              description: "Untrusted hosted tool",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not infer semantic names from arbitrary hosted tool aliases", () => {
    expect(
      collectSemanticToolNames({
        tools: [],
      }),
    ).toEqual([]);
  });

  it("keeps semantic names only for real native tools", () => {
    expect(
      collectSemanticToolNames({
        tools: nativeTools,
      }),
    ).toEqual(["read"]);
  });

  it("includes trusted hosted semantic aliases when explicitly declared", () => {
    expect(
      collectSemanticToolNames({
        tools: [],
        clientTools: [
          {
            type: "function" as const,
            function: {
              name: "file_read",
              description: "Read a file",
              parameters: { type: "object" },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "message",
              description: "Send a message",
              parameters: { type: "object" },
            },
          },
        ],
        clientToolSemanticAliases: {
          file_read: "read",
          message: "message",
        },
      }),
    ).toEqual(["read", "message"]);
    expect(
      collectSemanticToolAliases({
        tools: [],
        clientTools: [
          {
            type: "function" as const,
            function: {
              name: "file_read",
              description: "Read a file",
              parameters: { type: "object" },
            },
          },
          {
            type: "function" as const,
            function: {
              name: "message",
              description: "Send a message",
              parameters: { type: "object" },
            },
          },
        ],
        clientToolSemanticAliases: {
          file_read: "read",
          message: "message",
        },
      }),
    ).toEqual({
      read: "file_read",
      message: "message",
    });
  });

  it("keeps native semantic aliases when a hosted alias maps to the same semantic tool", () => {
    expect(
      collectSemanticToolAliases({
        tools: nativeTools,
        clientTools: [
          {
            type: "function" as const,
            function: {
              name: "file_read",
              description: "Read a file",
              parameters: { type: "object" },
            },
          },
        ],
        clientToolSemanticAliases: {
          file_read: "read",
        },
      }),
    ).toEqual({
      read: "read",
    });
  });
});
