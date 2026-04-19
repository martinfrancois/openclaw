import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stored: {} as Record<string, unknown> | null,
}));

vi.mock("node:fs", () => ({
  default: {
    rmSync: vi.fn(() => {
      state.stored = null;
    }),
  },
}));

vi.mock("../infra/json-file.js", () => ({
  loadJsonFile: vi.fn(() => state.stored),
  saveJsonFile: vi.fn((_filePath: string, value: Record<string, unknown>) => {
    state.stored = structuredClone(value);
  }),
}));

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw-node-exec-finished-dedupe-tests"),
}));

describe("node exec finished dedupe", () => {
  beforeEach(() => {
    vi.resetModules();
    state.stored = null;
  });

  it("persists pre-delivered dedupe across restarts until the real completion is consumed", async () => {
    const dedupeModule = await import("./node-exec-finished-dedupe.js");
    dedupeModule.markExecFinishedDelivered({
      nodeId: "node-1",
      sessionKey: "agent:main:main",
      runId: "run-1",
      now: Date.now(),
    });

    expect(state.stored).toEqual({
      "node-1::agent:main:main::run-1": {
        ts: expect.any(Number),
        preDelivered: true,
      },
    });

    vi.resetModules();
    const restartedDedupeModule = await import("./node-exec-finished-dedupe.js");

    expect(
      restartedDedupeModule.classifyDuplicateExecFinished({
        nodeId: "node-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
        now: Date.now(),
      }),
    ).toBe("pre-delivered");
    expect(state.stored).toBeNull();
  });

  it("drops expired persisted pre-delivered entries during rehydrate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:20:00Z"));
    state.stored = {
      "node-1::agent:main:main::run-1": {
        ts: new Date("2026-01-01T00:00:00Z").getTime(),
        preDelivered: true,
      },
    };

    const dedupeModule = await import("./node-exec-finished-dedupe.js");

    expect(
      dedupeModule.hasPreDeliveredExecFinishedForRun({
        nodeId: "node-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
      }),
    ).toBe(false);
    expect(state.stored).toBeNull();
    vi.useRealTimers();
  });
});
