import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../../plugins/memory-state.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "./system-prompt.js";

type MutableSession = {
  _baseSystemPrompt?: string;
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
};

type MockSession = MutableSession & {
  agent: {
    state: {
      systemPrompt?: string;
    };
  };
};

function createMockSession(): {
  session: MockSession;
} {
  const session = {
    agent: { state: {} },
  } as MockSession;
  return { session };
}

function applyAndGetMutableSession(
  prompt: Parameters<typeof applySystemPromptOverrideToSession>[1],
) {
  const { session } = createMockSession();
  applySystemPromptOverrideToSession(session as unknown as AgentSession, prompt);
  return {
    mutable: session,
  };
}

describe("applySystemPromptOverrideToSession", () => {
  it("applies a string override to the session system prompt", () => {
    const prompt = "You are a helpful assistant with custom context.";
    const { mutable } = applyAndGetMutableSession(prompt);

    expect(mutable.agent.state.systemPrompt).toBe(prompt);
    expect(mutable._baseSystemPrompt).toBe(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { mutable } = applyAndGetMutableSession("  padded prompt  ");

    expect(mutable.agent.state.systemPrompt).toBe("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const override = createSystemPromptOverride("function-based prompt");
    const { mutable } = applyAndGetMutableSession(override);

    expect(mutable.agent.state.systemPrompt).toBe("function-based prompt");
  });

  it("sets _rebuildSystemPrompt that returns the override", () => {
    const { mutable } = applyAndGetMutableSession("rebuild test");
    expect(mutable._rebuildSystemPrompt?.(["tool1"])).toBe("rebuild test");
  });
});

describe("buildEmbeddedSystemPrompt", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("forwards provider prompt contributions into the embedded prompt", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      promptContribution: {
        stablePrefix: "## Embedded Stable\n\nStable provider guidance.",
      },
    });

    expect(prompt).toContain("## Embedded Stable\n\nStable provider guidance.");
  });

  it("treats hosted client tools as available when explicit tool names are provided", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      toolNames: ["get_weather"],
      modelAliasLines: [],
      userTimezone: "UTC",
    });

    expect(prompt).not.toContain("No tools are available in this session.");
    expect(prompt).toContain("- get_weather");
  });

  it("does not infer native prompt semantics from arbitrary hosted tool names", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      toolNames: ["read", "exec", "session_status"],
      nativeToolNames: [],
      semanticToolNames: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("- read");
    expect(prompt).toContain("- exec");
    expect(prompt).toContain("- session_status");
    expect(prompt).not.toContain("read its SKILL.md");
    expect(prompt).not.toContain("consult local docs first");
    expect(prompt).not.toContain("Never execute /approve");
    expect(prompt).not.toContain(
      "If you need the current date, time, or day of week, run session_status",
    );
  });

  it("preserves hosted semantic guidance when a client tool name intentionally matches it", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      toolNames: ["message"],
      nativeToolNames: [],
      semanticToolNames: ["message"],
      modelAliasLines: [],
      userTimezone: "UTC",
    });

    expect(prompt).toContain("- message");
    expect(prompt).toContain("### message tool");
    expect(prompt).toContain("Never use exec/curl for provider messaging");
    expect(prompt).not.toContain("Cross-session messaging");
  });

  it("renders semantic guidance with the advertised hosted alias name", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      toolNames: ["file_read", "notify_user"],
      nativeToolNames: [],
      semanticToolNames: ["read", "message"],
      semanticToolAliases: {
        read: "file_read",
        message: "notify_user",
      },
      modelAliasLines: [],
      userTimezone: "UTC",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("with `file_read`");
    expect(prompt).toContain("### notify_user tool");
    expect(prompt).toContain("Use `notify_user` for proactive sends + channel actions");
    expect(prompt).not.toContain("### message tool");
  });

  it("can omit base memory guidance for non-legacy context engines", () => {
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully.", ""]);

    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      includeMemorySection: false,
    });

    expect(prompt).not.toContain("## Memory Recall");
  });
});
