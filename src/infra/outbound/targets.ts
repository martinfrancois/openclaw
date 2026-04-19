import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import {
  comparableChannelTargetsShareRoute,
  resolveComparableTargetForLoadedChannel,
} from "../../channels/plugins/target-parsing-loaded.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.core.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type {
  DeliverableMessageChannel,
  GatewayMessageChannel,
} from "../../utils/message-channel.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
} from "./targets-resolve-shared.js";

export type OutboundChannel = DeliverableMessageChannel;

export type HeartbeatTarget = OutboundChannel;

export type OutboundTarget = {
  channel: OutboundChannel;
  to?: string;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
};

export type HeartbeatSenderContext = {
  sender: string;
  provider?: DeliverableMessageChannel;
  allowFrom: string[];
};

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";
import { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";

// Channel docking: prefer plugin.outbound.resolveTarget + allowFrom to normalize destinations.
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  return (
    resolveOutboundTargetWithPlugin({
      plugin: resolveOutboundChannelPlugin({
        channel: params.channel,
        cfg: params.cfg,
      }),
      target: params,
      onMissingPlugin: () =>
        params.channel === INTERNAL_MESSAGE_CHANNEL
          ? undefined
          : {
              ok: false,
              error: new Error(`Unsupported channel: ${params.channel}`),
            },
    }) ?? {
      ok: false,
      error: new Error(`Unsupported channel: ${params.channel}`),
    }
  );
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
  allowAsyncWakeFallbackToLast?: boolean;
}): OutboundTarget {
  const { cfg, entry } = params;
  const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
  const rawTarget = heartbeat?.target;
  let target: HeartbeatTarget = "none";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeDeliverableOutboundChannel(rawTarget);
    if (normalized) {
      target = normalized;
    }
  }

  const useAsyncWakeFallbackToLast =
    target === "none" && params.allowAsyncWakeFallbackToLast === true;
  const hasExplicitHeartbeatTo = !useAsyncWakeFallbackToLast && Boolean(heartbeat?.to?.trim());
  if (useAsyncWakeFallbackToLast) {
    target = "last";
  }

  if (target === "none") {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoHeartbeatDeliveryTarget({
      reason: "target-none",
      lastChannel: base.lastChannel,
      lastAccountId: base.lastAccountId,
    });
  }

  const sessionDeliveryContext = normalizeDeliveryContext(deliveryContextFromSession(entry));
  const mergeAsyncWakeFallbackTurnSource = (): DeliveryContext | undefined => {
    const normalizedTurnSource = normalizeDeliveryContext(params.turnSource);
    if (
      !normalizedTurnSource?.channel ||
      !normalizedTurnSource.to ||
      normalizedTurnSource.accountId ||
      !sessionDeliveryContext?.channel ||
      !sessionDeliveryContext.to ||
      !sessionDeliveryContext.accountId ||
      normalizedTurnSource.channel !== sessionDeliveryContext.channel
    ) {
      return normalizedTurnSource;
    }
    const turnSourceTarget = resolveComparableTargetForLoadedChannel({
      channel: normalizedTurnSource.channel,
      rawTarget: normalizedTurnSource.to,
      fallbackThreadId: normalizedTurnSource.threadId,
    });
    const sessionTarget = resolveComparableTargetForLoadedChannel({
      channel: sessionDeliveryContext.channel,
      rawTarget: sessionDeliveryContext.to,
      fallbackThreadId: sessionDeliveryContext.threadId,
    });
    return comparableChannelTargetsShareRoute({
      left: turnSourceTarget,
      right: sessionTarget,
    })
      ? {
          ...normalizedTurnSource,
          accountId: sessionDeliveryContext.accountId,
        }
      : normalizedTurnSource;
  };

  const resolvedTurnSource =
    target === "last"
      ? useAsyncWakeFallbackToLast
        ? mergeAsyncWakeFallbackTurnSource()
        : mergeDeliveryContext(params.turnSource, sessionDeliveryContext)
      : undefined;

  const resolvedTarget = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: target === "last" ? "last" : target,
    // Async exec completions falling back from target=none should reply to the
    // originating session route, not heartbeat-level explicit destinations.
    explicitTo: useAsyncWakeFallbackToLast ? undefined : heartbeat?.to,
    mode: "heartbeat",
    turnSourceChannel:
      resolvedTurnSource?.channel && isDeliverableMessageChannel(resolvedTurnSource.channel)
        ? resolvedTurnSource.channel
        : undefined,
    turnSourceTo: resolvedTurnSource?.to,
    turnSourceAccountId: resolvedTurnSource?.accountId,
    // Only pass threadId from an explicit turn source (e.g., restart sentinel's
    // delivery context). Do NOT fall back to session-stored threadId here —
    // heartbeat mode intentionally drops inherited thread IDs to avoid replying
    // in stale threads (e.g., Slack thread_ts). The sentinel's delivery context
    // carries the correct topic/thread ID when present.
    turnSourceThreadId: useAsyncWakeFallbackToLast
      ? resolvedTurnSource?.threadId
      : params.turnSource?.threadId,
  });

  const heartbeatAccountId = useAsyncWakeFallbackToLast ? undefined : heartbeat?.accountId?.trim();
  // Use explicit accountId from heartbeat config if provided, otherwise fall back to session
  let effectiveAccountId = heartbeatAccountId || resolvedTarget.accountId;

  if (heartbeatAccountId && resolvedTarget.channel) {
    const plugin = resolveOutboundChannelPlugin({
      channel: resolvedTarget.channel,
      cfg,
    });
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(heartbeatAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return buildNoHeartbeatDeliveryTarget({
          reason: "unknown-account",
          accountId: normalizedAccountId,
          lastChannel: resolvedTarget.lastChannel,
          lastAccountId: resolvedTarget.lastAccountId,
        });
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const resolved = resolveOutboundTarget({
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: effectiveAccountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const normalizedSessionChatType = normalizeChatType(entry?.chatType);
  const inferredDeliveryChatType = inferChatTypeFromTarget({
    channel: resolvedTarget.channel,
    to: resolved.to,
  });
  const sessionChatTypeHint =
    inferredDeliveryChatType == null &&
    target === "last" &&
    !hasExplicitHeartbeatTo &&
    (!useAsyncWakeFallbackToLast ||
      !params.turnSource ||
      (resolvedTarget.channel === entry?.lastChannel &&
        (resolvedTarget.to === entry?.lastTo || normalizedSessionChatType === "direct")))
      ? normalizedSessionChatType
      : undefined;
  const deliveryChatType = inferredDeliveryChatType ?? sessionChatTypeHint;
  if (deliveryChatType === "direct" && heartbeat?.directPolicy === "block") {
    return buildNoHeartbeatDeliveryTarget({
      reason: "dm-blocked",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  let reason: string | undefined;
  const plugin = resolveOutboundChannelPlugin({
    channel: resolvedTarget.channel,
    cfg,
  });
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      cfg,
      accountId: effectiveAccountId,
      mode: "explicit",
    });
    if (explicit.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  const inheritedHeartbeatThreadId = shouldReuseHeartbeatTelegramTopicThread({
    target,
    turnSource: params.turnSource,
    entry,
    resolvedTarget,
    hasExplicitHeartbeatTo,
  })
    ? resolvedTarget.lastThreadId
    : undefined;

  return {
    channel: resolvedTarget.channel,
    to: resolved.to,
    reason,
    accountId: effectiveAccountId,
    // Heartbeats normally avoid inheriting session reply-thread IDs, but
    // Telegram forum-topic sessions encode the topic as part of the
    // destination identity. Preserve that topic routing when the heartbeat is
    // still targeting the same group session.
    threadId: resolvedTarget.threadId ?? inheritedHeartbeatThreadId,
    lastChannel: resolvedTarget.lastChannel,
    lastAccountId: resolvedTarget.lastAccountId,
  };
}

function buildNoHeartbeatDeliveryTarget(params: {
  reason: string;
  accountId?: string;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
}): OutboundTarget {
  return {
    channel: "none",
    reason: params.reason,
    accountId: params.accountId,
    lastChannel: params.lastChannel,
    lastAccountId: params.lastAccountId,
  };
}

function inferChatTypeFromTarget(params: {
  channel: DeliverableMessageChannel;
  to: string;
}): ChatType | undefined {
  const to = params.to.trim();
  if (!to) {
    return undefined;
  }

  if (/^user:/i.test(to)) {
    return "direct";
  }
  if (/^(channel:|thread:)/i.test(to)) {
    return "channel";
  }
  if (/^group:/i.test(to)) {
    return "group";
  }
  return (
    resolveOutboundChannelPlugin({
      channel: params.channel,
    })?.messaging?.inferTargetChatType?.({ to }) ?? undefined
  );
}

function shouldReuseHeartbeatTelegramTopicThread(params: {
  target: HeartbeatTarget;
  turnSource?: DeliveryContext;
  entry?: SessionEntry;
  resolvedTarget: SessionDeliveryTarget;
  hasExplicitHeartbeatTo: boolean;
}): boolean {
  const turnSourceHasTelegramTopic =
    params.turnSource?.channel === "telegram" &&
    resolveComparableTargetForLoadedChannel({
      channel: "telegram",
      rawTarget: params.turnSource.to,
      fallbackThreadId: params.turnSource.threadId,
    })?.threadId != null;
  return (
    params.resolvedTarget.threadId == null &&
    params.target === "last" &&
    !params.hasExplicitHeartbeatTo &&
    params.turnSource?.threadId == null &&
    (!params.turnSource || turnSourceHasTelegramTopic) &&
    params.resolvedTarget.channel === "telegram" &&
    params.resolvedTarget.lastChannel === "telegram" &&
    Boolean(params.resolvedTarget.to) &&
    Boolean(params.resolvedTarget.lastTo) &&
    params.resolvedTarget.to === params.resolvedTarget.lastTo &&
    normalizeChatType(params.entry?.chatType) === "group"
  );
}

function resolveHeartbeatSenderId(params: {
  allowFrom: Array<string | number>;
  deliveryTo?: string;
  lastTo?: string;
  provider?: string | null;
}) {
  const { allowFrom, deliveryTo, lastTo, provider } = params;
  const candidates = [
    deliveryTo?.trim(),
    provider && deliveryTo ? `${provider}:${deliveryTo}` : undefined,
    lastTo?.trim(),
    provider && lastTo ? `${provider}:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = mapAllowFromEntries(allowFrom).filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) => allowList.includes(candidate));
    if (matched) {
      return matched;
    }
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) {
    return allowList[0];
  }
  return candidates[0] ?? "heartbeat";
}

export function resolveHeartbeatSenderContext(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  delivery: OutboundTarget;
}): HeartbeatSenderContext {
  const provider =
    params.delivery.channel !== "none" ? params.delivery.channel : params.delivery.lastChannel;
  const accountId =
    params.delivery.accountId ??
    (provider === params.delivery.lastChannel ? params.delivery.lastAccountId : undefined);
  const allowFromRaw = provider
    ? (resolveOutboundChannelPlugin({
        channel: provider,
        cfg: params.cfg,
      })?.config.resolveAllowFrom?.({
        cfg: params.cfg,
        accountId,
      }) ?? [])
    : [];
  const allowFrom = mapAllowFromEntries(allowFromRaw);

  const sender = resolveHeartbeatSenderId({
    allowFrom,
    deliveryTo: params.delivery.to,
    lastTo: params.entry?.lastTo,
    provider,
  });

  return { sender, provider, allowFrom };
}
