import { afterEach, describe, expect, it } from "vitest";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../plugins/memory-state.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt memory guidance", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("can suppress base memory guidance so context engines own memory prompt assembly", () => {
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully.", ""]);

    const promptWithMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });
    const promptWithoutMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      includeMemorySection: false,
    });

    expect(promptWithMemory).toContain("## Memory Recall");
    expect(promptWithoutMemory).not.toContain("## Memory Recall");
  });

  it("does not infer hosted memory guidance from arbitrary non-native tool names", () => {
    registerMemoryPromptSection(({ availableTools }) =>
      availableTools.has("memory_search")
        ? ["## Memory Recall", "Use hosted memory carefully.", ""]
        : [],
    );

    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search"],
      nativeToolNames: [],
      semanticToolNames: [],
    });

    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("Use hosted memory carefully.");
  });

  it("preserves hosted memory guidance when semantic tool names are provided", () => {
    registerMemoryPromptSection(({ availableTools }) =>
      availableTools.has("memory_search")
        ? ["## Memory Recall", "Use hosted memory carefully.", ""]
        : [],
    );

    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search"],
      nativeToolNames: [],
      semanticToolNames: ["memory_search"],
    });

    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("Use hosted memory carefully.");
  });
});
