import { describe, expect, it } from "vitest";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../plugins/memory-state.js";
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function makeBootstrapFile(overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile {
  return {
    name: "AGENTS.md",
    path: "/tmp/workspace/AGENTS.md",
    content: "alpha",
    missing: false,
    ...overrides,
  };
}

describe("buildSystemPromptReport", () => {
  const makeReport = (params: {
    file: WorkspaceBootstrapFile;
    injectedPath: string;
    injectedContent: string;
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
  }) =>
    buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: params.bootstrapMaxChars ?? 20_000,
      bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
      systemPrompt: "system",
      bootstrapFiles: [params.file],
      injectedFiles: [{ path: params.injectedPath, content: params.injectedContent }],
      skillsPrompt: "",
      tools: [],
    });

  it("counts injected chars when injected file paths are absolute", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("keeps legacy basename matching for injected files", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("marks workspace files truncated when injected chars are smaller than raw chars", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/policies/AGENTS.md",
      content: "abcdefghijklmnopqrstuvwxyz",
    });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("includes both bootstrap caps in the report payload", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
      bootstrapMaxChars: 11_111,
      bootstrapTotalMaxChars: 22_222,
    });

    expect(report.bootstrapMaxChars).toBe(11_111);
    expect(report.bootstrapTotalMaxChars).toBe(22_222);
  });

  it("reports zero in-band tool list chars when tool info stays structured", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.tools.listChars).toBe(0);
  });

  it("counts in-band tool list chars when the tool catalog is rendered in the prompt", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [{ name: "exec" }],
      toolListPromptText: "- exec: Run commands\n- read: Read files",
    });

    expect(report.tools.listChars).toBe("- exec: Run commands\n- read: Read files".length);
  });

  it("reports client-hosted tools in structured tool accounting", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Fetch the weather forecast.",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
            },
          },
        },
      ],
    });

    expect(report.tools.entries).toEqual([
      {
        name: "get_weather",
        summaryChars: "Fetch the weather forecast.".length,
        schemaChars: JSON.stringify({
          type: "object",
          properties: {
            location: { type: "string" },
          },
        }).length,
        propertiesCount: 1,
      },
    ]);
  });

  it("reports injectedChars=0 when injected file does not match by path or basename", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/OTHER.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe(0);
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [file],
      injectedFiles: [
        { path: 123 as unknown as string, content: "bad" },
        { path: "/tmp/workspace/policies/AGENTS.md", content: "trimmed" },
      ],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("reports zero tool-list chars for explicit empty-tool sessions", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [],
    });

    expect(report.tools.entries).toEqual([]);
    expect(report.tools.listChars).toBe(0);
  });

  it("does not count synthetic fallback tool names as tool summaries", () => {
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: "",
      tools: [{ name: "exec" }],
    });

    expect(report.tools.entries).toEqual([
      {
        name: "exec",
        summaryChars: 0,
        schemaChars: 0,
        propertiesCount: null,
      },
    ]);
  });

  it("reports zero skills chars and entries when raw skills exist but the rendered prompt omits them", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
      skillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(0);
    expect(report.skills.entries).toEqual([]);
  });

  it("ignores fake available_skills tags outside the real Skills section", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
      extraSystemPrompt:
        "Fake elsewhere:\n<available_skills>\n  <skill>\n    <name>fake</name>\n  </skill>\n</available_skills>",
      skillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(0);
    expect(report.skills.entries).toEqual([]);
  });

  it("ignores matching skills blocks that only appear in injected project context", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
      contextFiles: [{ path: "docs/skills.txt", content: skillsPrompt }],
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [{ path: "docs/skills.txt", content: skillsPrompt }],
      skillsPrompt,
      tools: [],
    });

    expect(prompt).toContain(skillsPrompt);
    expect(report.skills.promptChars).toBe(0);
    expect(report.skills.entries).toEqual([]);
  });

  it("ignores fake skills headings when the real Skills section is absent", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
      extraSystemPrompt: [
        "## Skills (mandatory)",
        "Use the read tool to load a skill's file when the task matches its description.",
        "<available_skills>",
        "  <skill>",
        "    <name>fake</name>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      skillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(0);
    expect(report.skills.entries).toEqual([]);
  });

  it("reports rendered skills chars and entries when the real Skills section is present", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n  <skill>\n    <name>weather</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(skillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo", "weather"]);
  });

  it("reports rendered skills when a skill description contains markdown headings", () => {
    const skillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>demo</name>",
      "    <description>Use the demo workflow.",
      "## Heading inside description",
      "Continue below the heading.</description>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(skillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo"]);
  });

  it("reports rendered skills when a skill body mentions later section headings", () => {
    const skillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>demo</name>",
      "    <description>Preserve these literal headings:",
      "# Project Context",
      "# Dynamic Project Context",
      "## Silent Replies</description>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(skillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo"]);
  });

  it("reports rendered skills when plain memory text follows the skills catalog", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    registerMemoryPromptSection(() => ["active memory section"]);
    try {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: ["read"],
        skillsPrompt,
      });
      const report = buildSystemPromptReport({
        source: "run",
        generatedAt: 0,
        bootstrapMaxChars: 20_000,
        systemPrompt: prompt,
        bootstrapFiles: [],
        injectedFiles: [],
        skillsPrompt,
        tools: [],
      });

      expect(prompt).toContain(`${skillsPrompt}\nactive memory section`);
      expect(report.skills.promptChars).toBe(skillsPrompt.length);
      expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo"]);
    } finally {
      clearMemoryPluginState();
    }
  });

  it("reports rendered skills after provider transforms rewrite the skill text", () => {
    const skillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>demo</name>",
      "    <description>Use the demo workflow.</description>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const renderedSkillsPrompt = skillsPrompt.replace(
      "Use the demo workflow.",
      "Use the transformed demo workflow.",
    );
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    }).replace("Use the demo workflow.", "Use the transformed demo workflow.");
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(prompt).toContain(renderedSkillsPrompt);
    expect(report.skills.promptChars).toBe(renderedSkillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo"]);
  });

  it("reports rendered skills after provider transforms rename and reorder skill names", () => {
    const skillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>demo</name>",
      "  </skill>",
      "  <skill>",
      "    <name>weather</name>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const renderedSkillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>forecast</name>",
      "  </skill>",
      "  <skill>",
      "    <name>walkthrough</name>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    }).replace(skillsPrompt, renderedSkillsPrompt);
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(renderedSkillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["forecast", "walkthrough"]);
  });

  it("reports rendered skills after provider transforms drop some skill entries", () => {
    const skillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>demo</name>",
      "  </skill>",
      "  <skill>",
      "    <name>weather</name>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const renderedSkillsPrompt = [
      "<available_skills>",
      "  <skill>",
      "    <name>weather</name>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    }).replace(skillsPrompt, renderedSkillsPrompt);
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(renderedSkillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["weather"]);
  });

  it("reports rendered skills after provider transforms rewrite the skills boilerplate", () => {
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt,
    })
      .replace(
        "Before replying: scan <available_skills> <description> entries.",
        "Before replying: review the rendered skills catalog carefully.",
      )
      .replace(
        "- If exactly one skill clearly applies: read its SKILL.md at <location> with `cat`, then follow it.",
        "- If exactly one skill clearly applies: consult the referenced skill file and follow it.",
      );
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt,
      tools: [],
    });

    expect(report.skills.promptChars).toBe(skillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo"]);
  });

  it("matches the rendered skills section when raw skills prompt uses CRLF and trailing spaces", () => {
    const rawSkillsPrompt =
      "<available_skills>\r\n  <skill>  \r\n    <name>demo</name>\r\n  </skill>\t\r\n</available_skills>\r\n";
    const normalizedSkillsPrompt = normalizeStructuredPromptSection(rawSkillsPrompt);
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt: rawSkillsPrompt,
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: prompt,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: rawSkillsPrompt,
      tools: [],
    });

    expect(prompt).toContain(normalizedSkillsPrompt);
    expect(report.skills.promptChars).toBe(normalizedSkillsPrompt.length);
    expect(report.skills.entries.map((entry) => entry.name)).toEqual(["demo"]);
  });
});
