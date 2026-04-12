import type { AgentTool } from "@mariozechner/pi-agent-core";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { ClientToolDefinition } from "./run/params.js";

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? (normalizeOptionalLowercaseString(value) ?? "") : "";
}

function addName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    names.add(trimmed);
  }
}

export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = new Set<string>();
  for (const name of collectAdvertisedToolNames(params)) {
    names.add(name);
  }
  return names;
}

export function collectAdvertisedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): string[] {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addName(names, tool.name);
  }
  for (const tool of params.clientTools ?? []) {
    addName(names, tool.function?.name);
  }
  return [...names];
}

function collectPresentClientToolNames(clientTools?: ClientToolDefinition[]): Set<string> {
  const names = new Set<string>();
  for (const tool of clientTools ?? []) {
    addName(names, tool.function?.name);
  }
  return names;
}

export function collectSemanticToolAliases(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
  clientToolSemanticAliases?: Record<string, string>;
}): Record<string, string> {
  const aliases = new Map<string, string>();
  for (const tool of params.tools) {
    const normalized = normalizeToolName(tool.name);
    if (normalized) {
      aliases.set(normalized, tool.name);
    }
  }
  const presentClientToolNames = collectPresentClientToolNames(params.clientTools);
  for (const [advertisedName, semanticName] of Object.entries(
    params.clientToolSemanticAliases ?? {},
  )) {
    const trimmedAdvertisedName = advertisedName.trim();
    const normalizedSemanticName = normalizeToolName(semanticName);
    if (!trimmedAdvertisedName || !normalizedSemanticName) {
      continue;
    }
    if (!presentClientToolNames.has(trimmedAdvertisedName)) {
      continue;
    }
    if (!aliases.has(normalizedSemanticName)) {
      aliases.set(normalizedSemanticName, trimmedAdvertisedName);
    }
  }
  return Object.fromEntries(aliases.entries());
}

export function collectSemanticToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
  clientToolSemanticAliases?: Record<string, string>;
}): string[] {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addName(names, tool.name);
  }
  const presentClientToolNames = collectPresentClientToolNames(params.clientTools);
  for (const [advertisedName, semanticName] of Object.entries(
    params.clientToolSemanticAliases ?? {},
  )) {
    if (!presentClientToolNames.has(advertisedName.trim())) {
      continue;
    }
    addName(names, semanticName);
  }
  return [...names];
}
