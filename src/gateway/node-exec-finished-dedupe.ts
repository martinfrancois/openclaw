const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;

const recentExecFinishedRuns = new Map<string, { ts: number; preDelivered: boolean }>();

function execFinishedFingerprint(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
}): string {
  return [params.nodeId, params.sessionKey, params.runId].join("::");
}

export function classifyDuplicateExecFinished(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
  now: number;
}): "enqueue" | "replay" | "pre-delivered" {
  const fingerprint = execFinishedFingerprint(params);
  const previous = recentExecFinishedRuns.get(fingerprint);
  if (previous && params.now - previous.ts <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS) {
    if (previous.preDelivered) {
      recentExecFinishedRuns.set(fingerprint, { ts: params.now, preDelivered: false });
      return "pre-delivered";
    }
    return "replay";
  }

  recentExecFinishedRuns.set(fingerprint, { ts: params.now, preDelivered: false });
  if (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
    const cutoff = params.now - EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS;
    for (const [key, entry] of recentExecFinishedRuns) {
      if (entry.ts < cutoff) {
        recentExecFinishedRuns.delete(key);
      }
      if (recentExecFinishedRuns.size <= MAX_RECENT_EXEC_FINISHED_RUNS) {
        break;
      }
    }
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
  recentExecFinishedRuns.set(execFinishedFingerprint(params), {
    ts: params.now ?? Date.now(),
    preDelivered: true,
  });
}

export function clearRecentExecFinishedForRun(
  nodeId: string,
  sessionKey: string,
  runId: string,
): void {
  recentExecFinishedRuns.delete(execFinishedFingerprint({ nodeId, sessionKey, runId }));
}

export function hasPreDeliveredExecFinishedForRun(params: {
  nodeId: string;
  sessionKey: string;
  runId: string;
}): boolean {
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
  const entry = recentExecFinishedRuns.get(execFinishedFingerprint(params));
  return Boolean(entry && Date.now() - entry.ts <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS);
}

export function resetExecFinishedDeduplicationForTests(): void {
  recentExecFinishedRuns.clear();
}
