import type { Bot, Context } from "grammy";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import type { CommandArgs } from "../auto-reply/commands-registry.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import {
  readConfigFileSnapshotForWrite,
  type OpenClawConfig,
  writeConfigFile,
} from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../config/sessions.js";
import {
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { danger, logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import {
  executePluginCommand,
  getPluginCommandSpecs,
  matchPluginCommand,
} from "../plugins/commands.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAccountId, resolveThreadSessionKeys } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { isSenderAllowed, normalizeDmAllowFromWithStore } from "./bot-access.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";
import { TelegramUpdateKeyContext } from "./bot-updates.js";
import { TelegramBotOptions } from "./bot.js";
import { deliverReplies } from "./bot/delivery.js";
import {
  buildTelegramThreadParams,
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import {
  resolveTelegramGroupPromptSettings,
  resolveTelegramTopicSessionKey,
} from "./group-config-helpers.js";
import { buildInlineKeyboard } from "./send.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const TELEGRAM_TOPIC_COMMAND = {
  command: "topic",
  description: "Map this topic to a named session.",
};

const TOPIC_NAME_INVALID_CHARS_RE = /[^a-z0-9_-]+/gi;
const TOPIC_NAME_DASH_RUN_RE = /-{2,}/g;
const TOPIC_NAME_TRIM_EDGE_RE = /^[-_]+|[-_]+$/g;

type TelegramNativeCommandContext = Context & { match?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveTelegramTopicWriteScope(params: { cfg: OpenClawConfig; accountId: string }):
  | { scope: "global" }
  | {
      scope: "account";
      accountKey: string;
    } {
  const accounts = asRecord(params.cfg.channels?.telegram?.accounts);
  const normalizedAccountId = normalizeAccountId(params.accountId);

  if (accounts) {
    const existingAccountKey = Object.keys(accounts).find(
      (key) => normalizeAccountId(key) === normalizedAccountId,
    );
    if (existingAccountKey) {
      return { scope: "account", accountKey: existingAccountKey };
    }
  }

  if (normalizedAccountId !== "default") {
    return { scope: "account", accountKey: params.accountId };
  }

  return { scope: "global" };
}

function normalizeTelegramTopicNameAlias(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(TOPIC_NAME_INVALID_CHARS_RE, "-")
    .replace(TOPIC_NAME_DASH_RUN_RE, "-")
    .replace(TOPIC_NAME_TRIM_EDGE_RE, "")
    .slice(0, 80);
}

function updateTelegramDirectTopicSessionKeyConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  threadId: number;
  sessionKey?: string;
}): { changed: boolean; configPath: string } {
  params.cfg.channels ??= {};
  params.cfg.channels.telegram ??= {};

  const topicKey = String(params.threadId);
  const writeScope = resolveTelegramTopicWriteScope({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  let direct: Record<string, TelegramDirectConfig> | undefined;
  let configPathPrefix: string;

  if (writeScope.scope === "account") {
    const telegram = params.cfg.channels.telegram;
    const accountConfig = telegram.accounts?.[writeScope.accountKey];
    if (params.sessionKey) {
      telegram.accounts ??= {};
      telegram.accounts[writeScope.accountKey] ??= {};
      telegram.accounts[writeScope.accountKey].direct ??= {};
      direct = telegram.accounts[writeScope.accountKey].direct as Record<
        string,
        TelegramDirectConfig
      >;
    } else {
      direct = accountConfig?.direct;
    }
    configPathPrefix = `channels.telegram.accounts."${writeScope.accountKey}".direct."${params.chatId}"`;
  } else {
    const telegram = params.cfg.channels.telegram;
    if (params.sessionKey) {
      telegram.direct ??= {};
      direct = telegram.direct;
    } else {
      direct = telegram.direct;
    }
    configPathPrefix = `channels.telegram.direct."${params.chatId}"`;
  }

  const configPath = `${configPathPrefix}.topics."${topicKey}".sessionKey`;
  if (!direct) {
    return { changed: false, configPath };
  }

  let changed = false;

  const existingDirectConfig = asRecord(direct[params.chatId]);
  const directConfig = (existingDirectConfig ?? {}) as TelegramDirectConfig;
  if (!existingDirectConfig) {
    if (!params.sessionKey) {
      return { changed: false, configPath };
    }
    direct[params.chatId] = directConfig;
    changed = true;
  }

  if (!directConfig.topics || typeof directConfig.topics !== "object") {
    if (!params.sessionKey) {
      return { changed, configPath };
    }
    directConfig.topics = {};
    changed = true;
  }

  const existingTopic = asRecord(directConfig.topics[topicKey]);
  const topicConfig = (existingTopic ?? {}) as TelegramTopicConfig;
  if (!existingTopic) {
    if (!params.sessionKey) {
      return { changed, configPath };
    }
    directConfig.topics[topicKey] = topicConfig;
    changed = true;
  }

  if (params.sessionKey) {
    if (topicConfig.sessionKey !== params.sessionKey) {
      topicConfig.sessionKey = params.sessionKey;
      changed = true;
    }
  } else if ("sessionKey" in topicConfig) {
    delete topicConfig.sessionKey;
    changed = true;
  }

  return {
    changed,
    configPath,
  };
}

type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  dmThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
};

export type RegisterTelegramHandlerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  bot: Bot;
  mediaMaxBytes: number;
  opts: TelegramBotOptions;
  runtime: RuntimeEnv;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  processMessage: (
    ctx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: {
      messageIdOverride?: string;
      forceWasMentioned?: boolean;
    },
    replyMedia?: TelegramMediaRef[],
  ) => Promise<void>;
  logger: ReturnType<typeof getChildLogger>;
};

type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode: ReplyToMode;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  opts: { token: string };
};

async function resolveTelegramCommandAuth(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  requireAuth: boolean;
}): Promise<TelegramCommandAuthResult | null> {
  const {
    msg,
    bot,
    cfg,
    accountId,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    chatId,
    accountId,
    isGroup,
    isForum,
    messageThreadId,
    groupAllowFrom,
    resolveTelegramGroupConfig,
  });
  const {
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride,
  } = groupAllowContext;
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing")
      : (telegramCfg.dmPolicy ?? "pairing");
  const requireTopic = (groupConfig as TelegramDirectConfig | undefined)?.requireTopic;
  if (!isGroup && requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";

  const sendAuthMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, text),
    });
    return null;
  };
  const rejectNotAuthorized = async () => {
    return await sendAuthMessage("You are not authorized to use this command.");
  };

  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: requireAuth,
    requireSenderForAllowOverride: true,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      return await sendAuthMessage("This group is disabled.");
    }
    if (baseAccess.reason === "topic-disabled") {
      return await sendAuthMessage("This topic is disabled.");
    }
    return await rejectNotAuthorized();
  }

  const policyAccess = evaluateTelegramGroupPolicyAccess({
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    topicConfig,
    groupConfig,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    resolveGroupPolicy,
    enforcePolicy: useAccessGroups,
    useTopicAndGroupOverrides: false,
    enforceAllowlistAuthorization: requireAuth,
    allowEmptyAllowlistEntries: true,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: useAccessGroups,
  });
  if (!policyAccess.allowed) {
    if (policyAccess.reason === "group-policy-disabled") {
      return await sendAuthMessage("Telegram group commands are disabled.");
    }
    if (
      policyAccess.reason === "group-policy-allowlist-no-sender" ||
      policyAccess.reason === "group-policy-allowlist-unauthorized"
    ) {
      return await rejectNotAuthorized();
    }
    if (policyAccess.reason === "group-chat-not-allowed") {
      return await sendAuthMessage("This group is not allowed.");
    }
  }

  const dmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    storeAllowFrom: isGroup ? [] : storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const senderAllowed = isSenderAllowed({
    allow: dmAllow,
    senderId,
    senderUsername,
  });
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers: [{ configured: dmAllow.hasEntries, allowed: senderAllowed }],
    modeWhenAccessGroupsOff: "configured",
  });
  if (requireAuth && !commandAuthorized) {
    return await rejectNotAuthorized();
  }

  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    dmThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    commandAuthorized,
  };
}

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  replyToMode,
  textLimit,
  useAccessGroups,
  nativeEnabled,
  nativeSkillsEnabled,
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  opts,
}: RegisterTelegramNativeCommandsParams) => {
  const boundRoute =
    nativeEnabled && nativeSkillsEnabled
      ? resolveAgentRoute({ cfg, channel: "telegram", accountId })
      : null;
  const boundAgentIds = boundRoute ? [boundRoute.agentId] : null;
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled
      ? listSkillCommandsForAgents(boundAgentIds ? { cfg, agentIds: boundAgentIds } : { cfg })
      : [];
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, {
        skillCommands,
        provider: "telegram",
      })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs().map((command) => normalizeTelegramCommandName(command.name)),
  );
  for (const command of skillCommands) {
    reservedCommands.add(command.name.toLowerCase());
  }
  const customResolution = resolveTelegramCustomCommands({
    commands: telegramCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const pluginCommandSpecs = getPluginCommandSpecs();
  const existingCommands = new Set(
    [
      ...nativeCommands.map((command) => normalizeTelegramCommandName(command.name)),
      ...customCommands.map((command) => command.command),
    ].map((command) => command.toLowerCase()),
  );
  const canRegisterTopicCommand =
    nativeEnabled && !existingCommands.has(TELEGRAM_TOPIC_COMMAND.command);
  if (canRegisterTopicCommand) {
    existingCommands.add(TELEGRAM_TOPIC_COMMAND.command);
  }
  const pluginCatalog = buildPluginTelegramMenuCommands({
    specs: pluginCommandSpecs,
    existingCommands,
  });
  for (const issue of pluginCatalog.issues) {
    runtime.error?.(danger(issue));
  }
  const allCommandsFull: Array<{ command: string; description: string }> = [
    ...nativeCommands
      .map((command) => {
        const normalized = normalizeTelegramCommandName(command.name);
        if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
          runtime.error?.(
            danger(
              `Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`,
            ),
          );
          return null;
        }
        return {
          command: normalized,
          description: command.description,
        };
      })
      .filter((cmd): cmd is { command: string; description: string } => cmd !== null),
    ...(canRegisterTopicCommand ? [TELEGRAM_TOPIC_COMMAND] : []),
    ...(nativeEnabled ? pluginCatalog.commands : []),
    ...customCommands,
  ];
  const { commandsToRegister, totalCommands, maxCommands, overflowCount } =
    buildCappedTelegramMenuCommands({
      allCommands: allCommandsFull,
    });
  if (overflowCount > 0) {
    runtime.log?.(
      `Telegram limits bots to ${maxCommands} commands. ` +
        `${totalCommands} configured; registering first ${maxCommands}. ` +
        `Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`,
    );
  }
  // Telegram only limits the setMyCommands payload (menu entries).
  // Keep hidden commands callable by registering handlers for the full catalog.
  syncTelegramMenuCommands({ bot, runtime, commandsToRegister });

  const resolveCommandRuntimeContext = (params: {
    msg: NonNullable<TelegramNativeCommandContext["message"]>;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
  }) => {
    const { msg, isGroup, isForum, resolvedThreadId } = params;
    const chatId = msg.chat.id;
    const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
    const threadSpec = resolveTelegramThreadSpec({
      isGroup,
      isForum,
      messageThreadId,
    });
    const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId),
      },
      parentPeer,
    });
    const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "telegram",
      accountId: route.accountId,
    });
    const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
    return { chatId, threadSpec, route, mediaLocalRoots, tableMode, chunkMode };
  };
  const buildCommandDeliveryBaseOptions = (params: {
    chatId: string | number;
    mediaLocalRoots?: readonly string[];
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    tableMode: ReturnType<typeof resolveMarkdownTableMode>;
    chunkMode: ReturnType<typeof resolveChunkMode>;
  }) => ({
    chatId: String(params.chatId),
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots: params.mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: params.threadSpec,
    tableMode: params.tableMode,
    chunkMode: params.chunkMode,
    linkPreview: telegramCfg.linkPreview,
  });

  if (commandsToRegister.length > 0 || pluginCatalog.commands.length > 0) {
    if (typeof (bot as unknown as { command?: unknown }).command !== "function") {
      logVerbose("telegram: bot.command unavailable; skipping native handlers");
    } else {
      if (canRegisterTopicCommand) {
        bot.command(TELEGRAM_TOPIC_COMMAND.command, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) {
            return;
          }
          if (shouldSkipUpdate(ctx)) {
            return;
          }

          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            accountId,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: true,
          });
          if (!auth) {
            return;
          }

          const { chatId, isGroup, isForum, resolvedThreadId, dmThreadId } = auth;
          if (isGroup || isForum) {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(
                  chatId,
                  "This command works in DM topics. Open the target topic and run /topic <name>.",
                ),
            });
            return;
          }

          if (dmThreadId == null) {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(
                  chatId,
                  "No active DM topic found. Run this command inside the topic you want to map.",
                ),
            });
            return;
          }

          const { route } = resolveCommandRuntimeContext({
            msg,
            isGroup,
            isForum,
            resolvedThreadId,
          });
          const defaultSessionKey = resolveThreadSessionKeys({
            baseSessionKey: route.sessionKey,
            threadId: `${chatId}:${dmThreadId}`,
          }).sessionKey;

          const rawTopicName = ctx.match ?? "";
          const topicName = rawTopicName.trim();
          const clearMapping = !topicName;

          let mappedSessionKey: string | undefined;
          if (!clearMapping) {
            const topicAlias = normalizeTelegramTopicNameAlias(topicName);
            if (!topicAlias) {
              await withTelegramApiErrorLogging({
                operation: "sendMessage",
                runtime,
                fn: () =>
                  bot.api.sendMessage(chatId, "Topic name must include letters or numbers."),
              });
              return;
            }
            mappedSessionKey = resolveThreadSessionKeys({
              baseSessionKey: route.sessionKey,
              threadId: `${chatId}:${topicAlias}`,
            }).sessionKey;
          }

          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          const configSnapshot = structuredClone(snapshot.config ?? {});
          if (
            !resolveChannelConfigWrites({ cfg: configSnapshot, channelId: "telegram", accountId })
          ) {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(
                  chatId,
                  "Config writes are disabled for this Telegram account.",
                ),
            });
            return;
          }

          const writeResult = updateTelegramDirectTopicSessionKeyConfig({
            cfg: configSnapshot,
            accountId,
            chatId: String(chatId),
            threadId: dmThreadId,
            sessionKey: mappedSessionKey,
          });

          if (writeResult.changed) {
            await writeConfigFile(configSnapshot, writeOptions);
          }

          const statusMessage = clearMapping
            ? writeResult.changed
              ? `Cleared topic mapping. Using default session key ${defaultSessionKey}.`
              : `Topic already uses default session key ${defaultSessionKey}.`
            : writeResult.changed
              ? `Mapped topic "${topicName}" to session ${mappedSessionKey}.`
              : `Topic already maps to session ${mappedSessionKey}.`;

          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(
                chatId,
                `${statusMessage} Config path: ${writeResult.configPath}.`,
              ),
          });
        });
      }

      for (const command of nativeCommands) {
        const normalizedCommandName = normalizeTelegramCommandName(command.name);
        bot.command(normalizedCommandName, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) {
            return;
          }
          if (shouldSkipUpdate(ctx)) {
            return;
          }
          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            accountId,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: true,
          });
          if (!auth) {
            return;
          }
          const {
            chatId,
            isGroup,
            isForum,
            resolvedThreadId,
            senderId,
            senderUsername,
            groupConfig,
            topicConfig,
            commandAuthorized,
          } = auth;
          const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } =
            resolveCommandRuntimeContext({
              msg,
              isGroup,
              isForum,
              resolvedThreadId,
            });
          const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
            chatId,
            mediaLocalRoots,
            threadSpec,
            tableMode,
            chunkMode,
          });
          const threadParams = buildTelegramThreadParams(threadSpec) ?? {};

          const commandDefinition = findCommandByNativeName(command.name, "telegram");
          const rawText = ctx.match?.trim() ?? "";
          const commandArgs = commandDefinition
            ? parseCommandArgs(commandDefinition, rawText)
            : rawText
              ? ({ raw: rawText } satisfies CommandArgs)
              : undefined;
          const prompt = commandDefinition
            ? buildCommandTextFromArgs(commandDefinition, commandArgs)
            : rawText
              ? `/${command.name} ${rawText}`
              : `/${command.name}`;
          const menu = commandDefinition
            ? resolveCommandArgMenu({
                command: commandDefinition,
                args: commandArgs,
                cfg,
              })
            : null;
          if (menu && commandDefinition) {
            const title =
              menu.title ??
              `Choose ${menu.arg.description || menu.arg.name} for /${commandDefinition.nativeName ?? commandDefinition.key}.`;
            const rows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < menu.choices.length; i += 2) {
              const slice = menu.choices.slice(i, i + 2);
              rows.push(
                slice.map((choice) => {
                  const args: CommandArgs = {
                    values: { [menu.arg.name]: choice.value },
                  };
                  return {
                    text: choice.label,
                    callback_data: buildCommandTextFromArgs(commandDefinition, args),
                  };
                }),
              );
            }
            const replyMarkup = buildInlineKeyboard(rows);
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(chatId, title, {
                  ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                  ...threadParams,
                }),
            });
            return;
          }
          const baseSessionKey = route.sessionKey;
          const topicSessionKey = resolveTelegramTopicSessionKey({
            isGroup,
            topicConfig,
            baseSessionKey,
          });
          // DMs: use raw messageThreadId for thread sessions (not resolvedThreadId which is for forums)
          // unless a DM topic explicitly overrides sessionKey in config.
          const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
          const threadKeys =
            dmThreadId != null && topicSessionKey === baseSessionKey
              ? resolveThreadSessionKeys({
                  baseSessionKey,
                  threadId: `${chatId}:${dmThreadId}`,
                })
              : null;
          const sessionKey = threadKeys?.sessionKey ?? topicSessionKey;
          const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
            groupConfig,
            topicConfig,
          });
          const conversationLabel = isGroup
            ? msg.chat.title
              ? `${msg.chat.title} id:${chatId}`
              : `group:${chatId}`
            : (buildSenderName(msg) ?? String(senderId || chatId));
          const ctxPayload = finalizeInboundContext({
            Body: prompt,
            BodyForAgent: prompt,
            RawBody: prompt,
            CommandBody: prompt,
            CommandArgs: commandArgs,
            From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
            To: `slash:${senderId || chatId}`,
            ChatType: isGroup ? "group" : "direct",
            ConversationLabel: conversationLabel,
            GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
            GroupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
            SenderName: buildSenderName(msg),
            SenderId: senderId || undefined,
            SenderUsername: senderUsername || undefined,
            Surface: "telegram",
            Provider: "telegram",
            MessageSid: String(msg.message_id),
            Timestamp: msg.date ? msg.date * 1000 : undefined,
            WasMentioned: true,
            CommandAuthorized: commandAuthorized,
            CommandSource: "native" as const,
            SessionKey: `telegram:slash:${senderId || chatId}`,
            AccountId: route.accountId,
            CommandTargetSessionKey: sessionKey,
            MessageThreadId: threadSpec.id,
            IsForum: isForum,
            // Originating context for sub-agent announce routing
            OriginatingChannel: "telegram" as const,
            OriginatingTo: `telegram:${chatId}`,
          });

          const storePath = resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          try {
            await recordSessionMetaFromInbound({
              storePath,
              sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
              ctx: ctxPayload,
            });
          } catch (err) {
            runtime.error?.(danger(`telegram slash: failed updating session meta: ${String(err)}`));
          }

          const disableBlockStreaming =
            typeof telegramCfg.blockStreaming === "boolean"
              ? !telegramCfg.blockStreaming
              : undefined;

          const deliveryState = {
            delivered: false,
            skippedNonSilent: 0,
          };

          const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
            cfg,
            agentId: route.agentId,
            channel: "telegram",
            accountId: route.accountId,
          });

          await dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              ...prefixOptions,
              deliver: async (payload, _info) => {
                const result = await deliverReplies({
                  replies: [payload],
                  ...deliveryBaseOptions,
                });
                if (result.delivered) {
                  deliveryState.delivered = true;
                }
              },
              onSkip: (_payload, info) => {
                if (info.reason !== "silent") {
                  deliveryState.skippedNonSilent += 1;
                }
              },
              onError: (err, info) => {
                runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
              },
            },
            replyOptions: {
              skillFilter,
              disableBlockStreaming,
              onModelSelected,
            },
          });
          if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
            await deliverReplies({
              replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
              ...deliveryBaseOptions,
            });
          }
        });
      }

      for (const pluginCommand of pluginCatalog.commands) {
        bot.command(pluginCommand.command, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) {
            return;
          }
          if (shouldSkipUpdate(ctx)) {
            return;
          }
          const chatId = msg.chat.id;
          const rawText = ctx.match?.trim() ?? "";
          const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
          const match = matchPluginCommand(commandBody);
          if (!match) {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () => bot.api.sendMessage(chatId, "Command not found."),
            });
            return;
          }
          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            accountId,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: match.command.requireAuth !== false,
          });
          if (!auth) {
            return;
          }
          const { senderId, commandAuthorized, isGroup, isForum, resolvedThreadId } = auth;
          const { threadSpec, mediaLocalRoots, tableMode, chunkMode } =
            resolveCommandRuntimeContext({
              msg,
              isGroup,
              isForum,
              resolvedThreadId,
            });
          const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
            chatId,
            mediaLocalRoots,
            threadSpec,
            tableMode,
            chunkMode,
          });
          const from = isGroup
            ? buildTelegramGroupFrom(chatId, threadSpec.id)
            : `telegram:${chatId}`;
          const to = `telegram:${chatId}`;

          const result = await executePluginCommand({
            command: match.command,
            args: match.args,
            senderId,
            channel: "telegram",
            isAuthorizedSender: commandAuthorized,
            commandBody,
            config: cfg,
            from,
            to,
            accountId,
            messageThreadId: threadSpec.id,
          });

          await deliverReplies({
            replies: [result],
            ...deliveryBaseOptions,
          });
        });
      }
    }
  } else if (nativeDisabledExplicit) {
    withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands([]),
    }).catch(() => {});
  }
};
