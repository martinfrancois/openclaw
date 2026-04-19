import { parseAgentSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
export { parseSessionThreadInfo } from "./thread-info.js";
import { parseSessionThreadInfo } from "./thread-info.js";

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string }
    | undefined;
  threadId: string | undefined;
} {
  const hasRoutableDeliveryContext = (context?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  }): context is {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  } => Boolean(context?.channel && context?.to);
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string }
    | undefined;
  try {
    const cfg = loadConfig();
    const parsedAgentSession = parseAgentSessionKey(baseSessionKey);
    const candidateStorePaths = [
      resolveStorePath(cfg.session?.store, {
        agentId: parsedAgentSession?.agentId,
      }),
      resolveStorePath(cfg.session?.store),
    ].filter((path, index, all) => all.indexOf(path) === index);
    let storedDeliveryContext:
      | {
          channel: string;
          to: string;
          accountId?: string;
          threadId?: string | number;
        }
      | undefined;
    let freshestUpdatedAt = Number.NEGATIVE_INFINITY;
    for (const storePath of candidateStorePaths) {
      const store = loadSessionStore(storePath);
      const candidateKeys =
        baseSessionKey !== sessionKey ? [sessionKey, baseSessionKey] : [sessionKey];
      for (const candidateKey of candidateKeys) {
        const entry = store[candidateKey];
        const candidateDeliveryContext = deliveryContextFromSession(entry);
        if (!hasRoutableDeliveryContext(candidateDeliveryContext)) {
          continue;
        }
        const updatedAt = entry?.updatedAt ?? 0;
        if (!storedDeliveryContext || updatedAt >= freshestUpdatedAt) {
          storedDeliveryContext = candidateDeliveryContext;
          freshestUpdatedAt = updatedAt;
        }
        break;
      }
    }
    if (storedDeliveryContext) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId:
          storedDeliveryContext.threadId != null
            ? String(storedDeliveryContext.threadId)
            : undefined,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}
