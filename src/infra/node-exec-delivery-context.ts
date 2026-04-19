import fs from "node:fs";
import path from "node:path";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type RegisteredNodeExecDeliveryContext = {
  deliveryContext: DeliveryContext;
  ts: number;
};

const NODE_EXEC_DELIVERY_CONTEXTS_KEY = Symbol.for("openclaw.nodeExecDeliveryContexts");
const NODE_EXEC_DELIVERY_CONTEXTS_FILE = "node-exec-delivery-contexts.json";
// Keep deferred routes only as long as exec.finished replay dedupe is relevant.
// Successful direct replies should not pin an old route for hours after the user
// follow-up window has passed.
const NODE_EXEC_DELIVERY_CONTEXT_TTL_MS = 10 * 60 * 1000;

const registeredNodeExecDeliveryContexts = resolveGlobalMap<
  string,
  RegisteredNodeExecDeliveryContext
>(NODE_EXEC_DELIVERY_CONTEXTS_KEY);
let hasHydratedRegisteredNodeExecDeliveryContexts = false;

function buildRegistryKey(params: {
  nodeId?: string;
  sessionKey?: string;
  runId?: string;
}): string | null {
  const normalizedNodeId = normalizeOptionalString(params.nodeId);
  const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
  const normalizedRunId = normalizeOptionalString(params.runId);
  if (!normalizedNodeId || !normalizedSessionKey || !normalizedRunId) {
    return null;
  }
  return `${normalizedNodeId}::${normalizedSessionKey}::${normalizedRunId}`;
}

function resolveRegistryFilePath(): string {
  const stateDir = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR);
  const rootDir = stateDir || resolvePreferredOpenClawTmpDir();
  return path.join(rootDir, NODE_EXEC_DELIVERY_CONTEXTS_FILE);
}

function normalizeRegisteredEntry(value: unknown): RegisteredNodeExecDeliveryContext | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    deliveryContext?: DeliveryContext;
    ts?: unknown;
  };
  const deliveryContext = normalizeDeliveryContext(candidate.deliveryContext);
  const ts =
    typeof candidate.ts === "number" && Number.isFinite(candidate.ts) ? candidate.ts : null;
  if (!deliveryContext || ts === null) {
    return null;
  }
  return { deliveryContext, ts };
}

function isExpiredRegisteredEntry(entry: RegisteredNodeExecDeliveryContext, now: number): boolean {
  return now - entry.ts >= NODE_EXEC_DELIVERY_CONTEXT_TTL_MS;
}

function pruneExpiredRegisteredNodeExecDeliveryContexts(now: number): boolean {
  let changed = false;
  for (const [key, entry] of registeredNodeExecDeliveryContexts) {
    if (!isExpiredRegisteredEntry(entry, now)) {
      continue;
    }
    registeredNodeExecDeliveryContexts.delete(key);
    changed = true;
  }
  return changed;
}

function persistRegisteredNodeExecDeliveryContexts(): void {
  const filePath = resolveRegistryFilePath();
  if (registeredNodeExecDeliveryContexts.size === 0) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup for the transient restart-recovery cache.
    }
    return;
  }
  const serialized = Object.fromEntries(registeredNodeExecDeliveryContexts);
  try {
    saveJsonFile(filePath, serialized);
  } catch {
    // Best-effort persistence: keep the in-memory path working even if the durable
    // restart-recovery cache cannot be updated on this host, but drop any stale
    // on-disk snapshot so a later restart cannot resurrect outdated routes.
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup for the transient restart-recovery cache.
    }
  }
}

function hydrateRegisteredNodeExecDeliveryContexts(): void {
  if (hasHydratedRegisteredNodeExecDeliveryContexts) {
    return;
  }
  hasHydratedRegisteredNodeExecDeliveryContexts = true;
  const filePath = resolveRegistryFilePath();
  const stored = loadJsonFile<Record<string, unknown>>(filePath);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return;
  }
  const now = Date.now();
  let changed = false;
  for (const [key, value] of Object.entries(stored)) {
    const normalized = normalizeRegisteredEntry(value);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (isExpiredRegisteredEntry(normalized, now)) {
      changed = true;
      continue;
    }
    registeredNodeExecDeliveryContexts.set(key, normalized);
  }
  if (changed) {
    persistRegisteredNodeExecDeliveryContexts();
  }
}

export function rememberNodeExecDeliveryContext(params: {
  nodeId?: string;
  sessionKey?: string;
  runId?: string;
  deliveryContext?: DeliveryContext;
}) {
  const key = buildRegistryKey(params);
  const deliveryContext = normalizeDeliveryContext(params.deliveryContext);
  if (!key || !deliveryContext) {
    return;
  }
  const now = Date.now();
  hydrateRegisteredNodeExecDeliveryContexts();
  pruneExpiredRegisteredNodeExecDeliveryContexts(now);
  registeredNodeExecDeliveryContexts.set(key, { deliveryContext, ts: now });
  persistRegisteredNodeExecDeliveryContexts();
}

export function forgetNodeExecDeliveryContext(params: {
  nodeId?: string;
  sessionKey?: string;
  runId?: string;
}) {
  const key = buildRegistryKey(params);
  if (!key) {
    return;
  }
  hydrateRegisteredNodeExecDeliveryContexts();
  if (!registeredNodeExecDeliveryContexts.delete(key)) {
    return;
  }
  persistRegisteredNodeExecDeliveryContexts();
}

export function resolveNodeExecDeliveryContext(params: {
  nodeId?: string;
  sessionKey?: string;
  runId?: string;
  consume?: boolean;
}): DeliveryContext | undefined {
  const key = buildRegistryKey(params);
  if (!key) {
    return undefined;
  }
  let current = registeredNodeExecDeliveryContexts.get(key);
  if (!current) {
    hydrateRegisteredNodeExecDeliveryContexts();
    current = registeredNodeExecDeliveryContexts.get(key);
  }
  if (!current) {
    return undefined;
  }
  if (isExpiredRegisteredEntry(current, Date.now())) {
    registeredNodeExecDeliveryContexts.delete(key);
    persistRegisteredNodeExecDeliveryContexts();
    return undefined;
  }
  if (params.consume) {
    registeredNodeExecDeliveryContexts.delete(key);
    persistRegisteredNodeExecDeliveryContexts();
  }
  return { ...current.deliveryContext };
}

export function resetNodeExecDeliveryContextRegistryForTests(opts?: { clearPersisted?: boolean }) {
  registeredNodeExecDeliveryContexts.clear();
  hasHydratedRegisteredNodeExecDeliveryContexts = false;
  if (opts?.clearPersisted === false) {
    return;
  }
  try {
    fs.rmSync(resolveRegistryFilePath(), { force: true });
  } catch {
    // best-effort test cleanup
  }
}
