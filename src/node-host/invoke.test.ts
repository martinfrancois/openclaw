import { describe, expect, it, vi } from "vitest";

const handleSystemRunInvokeMock = vi.hoisted(() => vi.fn());
const isSystemRunInvokeReplyFallbackErrorMock = vi.hoisted(() =>
  vi.fn((error: unknown) =>
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { __systemRunInvokeReplyFallback?: unknown }).__systemRunInvokeReplyFallback ===
        true,
    ),
  ),
);

vi.mock("./invoke-system-run.js", () => ({
  buildSystemRunApprovalPlan: vi.fn(),
  handleSystemRunInvoke: handleSystemRunInvokeMock,
  isSystemRunInvokeReplyBestEffortError: vi.fn((error: unknown) =>
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { __systemRunInvokeReplyBestEffort?: unknown }).__systemRunInvokeReplyBestEffort ===
        true,
    ),
  ),
  isSystemRunInvokeReplyFallbackError: isSystemRunInvokeReplyFallbackErrorMock,
}));

import { handleInvoke } from "./invoke.js";

describe("handleInvoke", () => {
  it("preserves suppressNotifyOnExit when bridging exec.finished events", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
      }),
    };
    handleSystemRunInvokeMock.mockImplementationOnce(async (opts) => {
      await opts.sendExecFinishedEvent({
        sessionKey: "agent:main:main",
        runId: "run-1",
        deliveryContext: {
          channel: "telegram",
          to: "-100123",
          threadId: 47,
        },
        commandText: "echo ok",
        result: {
          success: true,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          error: null,
        },
        suppressNotifyOnExit: true,
      });
    });

    await handleInvoke(
      {
        id: "req-1",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
      },
      client as never,
      { current: async () => [] },
    );

    const nodeEvent = requests.find(
      (request) =>
        request.method === "node.event" &&
        typeof (request.params as { event?: unknown } | undefined)?.event === "string",
    );
    expect(nodeEvent).toBeTruthy();
    expect(nodeEvent?.params).toMatchObject({ event: "exec.finished" });
    const payloadJSON =
      typeof (nodeEvent?.params as { payloadJSON?: unknown } | undefined)?.payloadJSON === "string"
        ? ((nodeEvent?.params as { payloadJSON: string }).payloadJSON ?? "")
        : "";
    expect(JSON.parse(payloadJSON)).toMatchObject({
      runId: "run-1",
      suppressNotifyOnExit: true,
    });
  });

  it("swallows system.run invoke delivery failures after sending deferred exec.finished", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "node.invoke.result") {
          throw new Error("request socket closed");
        }
      }),
    };
    handleSystemRunInvokeMock.mockImplementationOnce(async (opts) => {
      try {
        await opts.sendInvokeResult({
          ok: true,
          payloadJSON: JSON.stringify({ success: true }),
        });
      } catch {
        await opts.sendExecFinishedEvent({
          sessionKey: "agent:main:main",
          runId: "run-2",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            threadId: 47,
          },
          commandText: "echo ok",
          result: {
            success: true,
            stdout: "ok",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            error: null,
          },
          notifyDeliveryFailed: true,
        });
        throw Object.assign(new Error("request socket closed"), {
          __systemRunInvokeReplyFallback: true,
        });
      }
    });

    await expect(
      handleInvoke(
        {
          id: "req-2",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        client as never,
        { current: async () => [] },
      ),
    ).resolves.toBeUndefined();

    const nodeEvent = requests.find((request) => request.method === "node.event");
    expect(nodeEvent?.params).toMatchObject({ event: "exec.finished" });
    const payloadJSON =
      typeof (nodeEvent?.params as { payloadJSON?: unknown } | undefined)?.payloadJSON === "string"
        ? ((nodeEvent?.params as { payloadJSON: string }).payloadJSON ?? "")
        : "";
    expect(JSON.parse(payloadJSON)).toMatchObject({
      runId: "run-2",
      notifyDeliveryFailed: true,
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        threadId: 47,
      },
    });
  });

  it("does not swallow exec.finished delivery failures inside sendExecFinishedEvent", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "node.event") {
          throw new Error("node.event failed");
        }
      }),
    };
    handleSystemRunInvokeMock.mockImplementationOnce(async (opts) => {
      await opts.sendExecFinishedEvent({
        sessionKey: "agent:main:main",
        runId: "run-2b",
        deliveryContext: {
          channel: "telegram",
          to: "-100123",
          threadId: 47,
        },
        commandText: "echo ok",
        result: {
          success: true,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          error: null,
        },
      });
    });

    await expect(
      handleInvoke(
        {
          id: "req-2b",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        client as never,
        { current: async () => [] },
      ),
    ).rejects.toThrow("node.event failed");
  });

  it("rethrows non-fallback system.run failures", async () => {
    handleSystemRunInvokeMock.mockRejectedValueOnce(new Error("node.event failed"));

    await expect(
      handleInvoke(
        {
          id: "req-3",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        { request: vi.fn() } as never,
        { current: async () => [] },
      ),
    ).rejects.toThrow("node.event failed");
  });

  it("keeps non-fallback invoke error replies best-effort", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "node.invoke.result") {
          throw new Error("request socket closed");
        }
      }),
    };
    handleSystemRunInvokeMock.mockImplementationOnce(async (opts) => {
      await opts.sendInvokeResult({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "command env assignment rejected" },
      });
    });

    await expect(
      handleInvoke(
        {
          id: "req-4",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        client as never,
        { current: async () => [] },
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps successful invoke reply delivery failures best-effort", async () => {
    handleSystemRunInvokeMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("request socket closed"), {
        __systemRunInvokeReplyBestEffort: true,
      });
    });

    await expect(
      handleInvoke(
        {
          id: "req-5",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        { request: vi.fn() } as never,
        { current: async () => [] },
      ),
    ).resolves.toBeUndefined();
  });
});
