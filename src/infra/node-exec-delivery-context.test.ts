import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stored: {} as Record<string, unknown> | null,
  saveShouldThrow: false,
}));

vi.mock("node:fs", () => ({
  default: {
    rmSync: vi.fn(() => {
      state.stored = null;
    }),
  },
}));

vi.mock("./json-file.js", () => ({
  loadJsonFile: vi.fn(() => state.stored),
  saveJsonFile: vi.fn((_filePath: string, value: Record<string, unknown>) => {
    if (state.saveShouldThrow) {
      throw new Error("write failed");
    }
    state.stored = structuredClone(value);
  }),
}));

vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw-node-exec-delivery-context-tests"),
}));

describe("node exec delivery context cache", () => {
  beforeEach(() => {
    vi.resetModules();
    state.stored = null;
    state.saveShouldThrow = false;
  });

  it("does not rehydrate stale persisted routes after an in-memory change fails to write", async () => {
    state.stored = {
      "node-1::agent:main:main::run-1": {
        deliveryContext: {
          channel: "telegram",
          to: "-100123",
          threadId: 47,
        },
        ts: Date.now(),
      },
    };
    state.saveShouldThrow = true;

    const deliveryContextModule = await import("./node-exec-delivery-context.js");

    expect(
      deliveryContextModule.resolveNodeExecDeliveryContext({
        nodeId: "node-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: 47,
    });

    deliveryContextModule.rememberNodeExecDeliveryContext({
      nodeId: "node-1",
      sessionKey: "agent:main:main",
      runId: "run-1",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        threadId: 88,
      },
    });
    deliveryContextModule.forgetNodeExecDeliveryContext({
      nodeId: "node-1",
      sessionKey: "agent:main:main",
      runId: "run-1",
    });

    vi.resetModules();
    const restartedDeliveryContextModule = await import("./node-exec-delivery-context.js");

    expect(
      restartedDeliveryContextModule.resolveNodeExecDeliveryContext({
        nodeId: "node-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
      }),
    ).toBeUndefined();
  });

  it("drops expired persisted routes during rehydrate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    state.stored = {
      "node-1::agent:main:main::run-1": {
        deliveryContext: {
          channel: "telegram",
          to: "-100123",
          threadId: 47,
        },
        ts: new Date("2026-01-01T00:00:00Z").getTime(),
      },
    };

    const deliveryContextModule = await import("./node-exec-delivery-context.js");

    expect(
      deliveryContextModule.resolveNodeExecDeliveryContext({
        nodeId: "node-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
      }),
    ).toBeUndefined();
    expect(state.stored).toBeNull();
    vi.useRealTimers();
  });
});
