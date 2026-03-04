import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { firstDefined } from "./bot-access.js";

export function resolveTelegramGroupPromptSettings(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  skillFilter: string[] | undefined;
  groupSystemPrompt: string | undefined;
} {
  const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
  const systemPromptParts = [
    params.groupConfig?.systemPrompt?.trim() || null,
    params.topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  return { skillFilter, groupSystemPrompt };
}

export function resolveTelegramTopicSessionKey(params: {
  isGroup: boolean;
  topicConfig?: TelegramTopicConfig;
  baseSessionKey: string;
}): string {
  // Topic-level session key overrides are currently supported for Telegram DM topics.
  // Group/forum topics keep channel-derived session keys for consistent group routing.
  if (params.isGroup) {
    return params.baseSessionKey;
  }
  const configured = params.topicConfig?.sessionKey?.trim();
  return configured || params.baseSessionKey;
}
