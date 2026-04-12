import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import type { ClientToolDefinition } from "./command/shared-types.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";
import { splitSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function extractBetween(
  input: string,
  startMarker: string,
  endMarker: string,
): { text: string; found: boolean } {
  const start = input.indexOf(startMarker);
  if (start === -1) {
    return { text: "", found: false };
  }
  const end = input.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    return { text: input.slice(start), found: true };
  }
  return { text: input.slice(start, end), found: true };
}

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  const prompt = skillsPrompt.trim();
  if (!prompt) {
    return [];
  }
  const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map(
    (match) => match[0] ?? "",
  );
  return blocks
    .map((block) => {
      const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
      return { name, blockChars: block.length };
    })
    .filter((b) => b.blockChars > 0);
}

export type PromptReportTool = {
  name: string;
  description?: string;
  parameters?: unknown;
};

type ReportableTool = AgentTool | ClientToolDefinition | PromptReportTool;

function isClientToolDefinition(tool: ReportableTool): tool is ClientToolDefinition {
  if (!tool || typeof tool !== "object" || !("function" in tool)) {
    return false;
  }
  const clientTool = tool;
  return clientTool.type === "function" && typeof clientTool.function?.name === "string";
}

function buildToolsEntries(tools: ReportableTool[]): SessionSystemPromptReport["tools"]["entries"] {
  return tools.map((tool) => {
    const name = isClientToolDefinition(tool) ? tool.function.name : tool.name;
    const summary = isClientToolDefinition(tool)
      ? tool.function.description?.trim() || ""
      : tool.description?.trim() || "";
    const summaryChars = summary.length;
    const schemaChars = (() => {
      const parameters = isClientToolDefinition(tool) ? tool.function.parameters : tool.parameters;
      if (!parameters || typeof parameters !== "object") {
        return 0;
      }
      try {
        return JSON.stringify(parameters).length;
      } catch {
        return 0;
      }
    })();
    const propertiesCount = (() => {
      const parameters = isClientToolDefinition(tool) ? tool.function.parameters : tool.parameters;
      const schema =
        parameters && typeof parameters === "object"
          ? (parameters as Record<string, unknown>)
          : null;
      const props = schema && typeof schema.properties === "object" ? schema.properties : null;
      if (!props || typeof props !== "object") {
        return null;
      }
      return Object.keys(props as Record<string, unknown>).length;
    })();
    return { name, summaryChars, schemaChars, propertiesCount };
  });
}

function extractAvailableSkillsBlockMatches(input: string): Array<{ text: string; start: number }> {
  return Array.from(
    input.matchAll(/(?:^|\n)(<available_skills>\n[\s\S]*?\n<\/available_skills>)(?=\n|$)/gi),
  ).map((match) => {
    const fullMatch = match[0] ?? "";
    const captured = match[1] ?? "";
    return {
      text: captured.trim(),
      start: (match.index ?? 0) + fullMatch.indexOf(captured),
    };
  });
}

const SKILLS_SECTION_HEADING = "## Skills (mandatory)";

function findLastSectionHeadingBefore(input: string, offset: number): string {
  const headingPattern = /(?:^|\n)(#{1,2} [^\n]+)/g;
  let lastHeading = "";
  let match: RegExpExecArray | null = null;
  while ((match = headingPattern.exec(input)) !== null) {
    const heading = match[1] ?? "";
    const headingStart = (match.index ?? 0) + match[0].indexOf(heading);
    if (headingStart >= offset) {
      break;
    }
    lastHeading = heading.trim();
  }
  return lastHeading;
}

function isSkillsSectionOffset(input: string, offset: number): boolean {
  return findLastSectionHeadingBefore(input, offset) === SKILLS_SECTION_HEADING;
}

function extractSkillsPromptText(systemPrompt: string, rawSkillsPrompt: string): string {
  const normalizedSkillsPrompt = normalizeStructuredPromptSection(rawSkillsPrompt);
  if (!normalizedSkillsPrompt) {
    return "";
  }
  const stablePromptPrefix =
    splitSystemPromptCacheBoundary(systemPrompt)?.stablePrefix ?? systemPrompt;

  const exactPromptIndex = stablePromptPrefix.indexOf(normalizedSkillsPrompt);
  if (exactPromptIndex !== -1 && isSkillsSectionOffset(stablePromptPrefix, exactPromptIndex)) {
    return stablePromptPrefix
      .slice(exactPromptIndex, exactPromptIndex + normalizedSkillsPrompt.length)
      .trim();
  }

  const renderedCandidates = extractAvailableSkillsBlockMatches(stablePromptPrefix)
    .map((candidate) => ({
      start: candidate.start,
      normalized: normalizeStructuredPromptSection(candidate.text),
    }))
    .filter(
      (candidate) =>
        candidate.normalized &&
        parseSkillBlocks(candidate.normalized).length > 0 &&
        isSkillsSectionOffset(stablePromptPrefix, candidate.start),
    )
    .toSorted(
      (left, right) =>
        Math.abs(left.normalized.length - normalizedSkillsPrompt.length) -
        Math.abs(right.normalized.length - normalizedSkillsPrompt.length),
    );
  if (renderedCandidates[0]) {
    return renderedCandidates[0].normalized;
  }
  return "";
}

export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: SessionSystemPromptReport["bootstrapTruncation"];
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  skillsPrompt: string;
  tools: ReportableTool[];
  toolListPromptText?: string;
}): SessionSystemPromptReport {
  const systemPrompt = params.systemPrompt.trim();
  const projectContext = extractBetween(
    systemPrompt,
    "\n# Project Context\n",
    "\n## Silent Replies\n",
  );
  const projectContextChars = projectContext.text.length;
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const renderedSkillsPrompt = extractSkillsPromptText(systemPrompt, params.skillsPrompt);
  const skillsEntries = parseSkillBlocks(renderedSkillsPrompt);

  return {
    source: params.source,
    generatedAt: params.generatedAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars: params.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
    ...(params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {}),
    sandbox: params.sandbox,
    systemPrompt: {
      chars: systemPrompt.length,
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPrompt.length - projectContextChars),
    },
    injectedWorkspaceFiles: buildBootstrapInjectionStats({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
    }),
    skills: {
      promptChars: renderedSkillsPrompt.length,
      entries: skillsEntries,
    },
    tools: {
      listChars: normalizeStructuredPromptSection(params.toolListPromptText ?? "").length,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
  };
}
