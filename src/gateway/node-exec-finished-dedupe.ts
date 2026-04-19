import fs from "node:fs";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;
const EXEC_FINISHED_RUN_DEDUPE_FILE = "node-exec-finished-dedupe.json";

const recentExecFinishedRuns = new Map<string, { ts: number; preDelivered: boolean }>();
let hasHydratedRecentExecFinishedRuns = false;

function execFinishedFingerprint(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
}): string {
  return [params.nodeId, params.sessionKey, params.runId].join("::");
}

function resolveDeduplicationFilePath(): string {
  const rootDir = process.env.OPENCLAW_STATE_DIR || resolvePreferredOpenClawTmpDir();
  return path.join(rootDir, EXEC_FINISHED_RUN_DEDUPE_FILE);
}

function normalizePersistedEntry(value: unknown): { ts: number; preDelivered: boolean } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { ts?: unknown; preDelivered?: unknown };
  const ts =
    typeof candidate.ts === "number" && Number.isFinite(candidate.ts) ? candidate.ts : null;
  if (ts === null || candidate.preDelivered !== true) {
    return null;
  }
  return { ts, preDelivered: true };
}

function isExpiredRecentExecFinishedEntry(entry: { ts: number }, now: number): boolean {
  return now - entry.ts > EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS;
}

function persistRecentExecFinishedRuns(): void {
  const filePath = resolveDeduplicationFilePath();
  const serialized = Object.fromEntries(
    [...recentExecFinishedRuns].filter(([, entry]) => entry.preDelivered),
  );
  if (Object.keys(serialized).length === 0) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup for transient restart-recovery state
    }
    return;
  }
  try {
    saveJsonFile(filePath, serialized);
  } catch {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup for transient restart-recovery state
    }
  }
}

function pruneExpiredRecentExecFinishedRuns(now: number): boolean {
  let changed = false;
  for (const [key, entry] of recentExecFinishedRuns) {
    if (!isExpiredRecentExecFinishedEntry(entry, now)) {
      continue;
    }
    recentExecFinishedRuns.delete(key);
    changed = true;
  }
  return changed;
}

function hydrateRecentExecFinishedRuns(): void {
  if (hasHydratedRecentExecFinishedRuns) {
    return;
  }
  hasHydratedRecentExecFinishedRuns = true;
  const stored = loadJsonFile<Record<string, unknown>>(resolveDeduplicationFilePath());
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return;
  }
  const now = Date.now();
  let changed = false;
  for (const [key, value] of Object.entries(stored)) {
    const normalized = normalizePersistedEntry(value);
    if (!normalized || isExpiredRecentExecFinishedEntry(normalized, now)) {
      changed = true;
      continue;
    }
    recentExecFinishedRuns.set(key, normalized);
  }
  if (pruneExpiredRecentExecFinishedRuns(now)) {
    changed = true;
  }
  if (changed) {
    persistRecentExecFinishedRuns();
  }
}

export function classifyDuplicateExecFinished(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
  now: number;
}): "enqueue" | "replay" | "pre-delivered" {
  const fingerprint = execFinishedFingerprint(params);
  let previous = recentExecFinishedRuns.get(fingerprint);
  if (!previous) {
    hydrateRecentExecFinishedRuns();
    previous = recentExecFinishedRuns.get(fingerprint);
  }
  if (previous && isExpiredRecentExecFinishedEntry(previous, params.now)) {
    recentExecFinishedRuns.delete(fingerprint);
    persistRecentExecFinishedRuns();
    previous = undefined;
  }
  if (previous && params.now - previous.ts <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS) {
    if (previous.preDelivered) {
      recentExecFinishedRuns.set(fingerprint, { ts: params.now, preDelivered: false });
      persistRecentExecFinishedRuns();
      return "pre-delivered";
    }
    return "replay";
  }

  hydrateRecentExecFinishedRuns();
  recentExecFinishedRuns.set(fingerprint, { ts: params.now, preDelivered: false });
  pruneExpiredRecentExecFinishedRuns(params.now);
  if (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
    while (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
      const oldestKey = recentExecFinishedRuns.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      recentExecFinishedRuns.delete(oldestKey);
    }
  }

  return "enqueue";
}

export function markExecFinishedDelivered(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
  now?: number;
}): void {
  hydrateRecentExecFinishedRuns();
  const now = params.now ?? Date.now();
  pruneExpiredRecentExecFinishedRuns(now);
  recentExecFinishedRuns.set(execFinishedFingerprint(params), {
    ts: now,
    preDelivered: true,
  });
  persistRecentExecFinishedRuns();
}

export function clearRecentExecFinishedForRun(
  nodeId: string,
  sessionKey: string,
  runId: string,
): void {
  hydrateRecentExecFinishedRuns();
  if (recentExecFinishedRuns.delete(execFinishedFingerprint({ nodeId, sessionKey, runId }))) {
    persistRecentExecFinishedRuns();
  }
}

export function hasPreDeliveredExecFinishedForRun(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
}): boolean {
  hydrateRecentExecFinishedRuns();
  const entry = recentExecFinishedRuns.get(execFinishedFingerprint(params));
  return Boolean(
    entry && Date.now() - entry.ts <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS && entry.preDelivered,
  );
}

export function hasRecentExecFinishedForRun(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
}): boolean {
  hydrateRecentExecFinishedRuns();
  const entry = recentExecFinishedRuns.get(execFinishedFingerprint(params));
  return Boolean(entry && Date.now() - entry.ts <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS);
}

export function resetExecFinishedDeduplicationForTests(opts?: { clearPersisted?: boolean }): void {
  recentExecFinishedRuns.clear();
  hasHydratedRecentExecFinishedRuns = false;
  if (opts?.clearPersisted === false) {
    return;
  }
  try {
    fs.rmSync(resolveDeduplicationFilePath(), { force: true });
  } catch {
    // best-effort test cleanup
  }
}
