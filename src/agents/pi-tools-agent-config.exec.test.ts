import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { getFinishedSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

const isWin = process.platform === "win32";
// Keep this barely asynchronous so tests exercise the real background-session path without slowing the suite.
const shortDelayCmd = isWin ? "Start-Sleep -Milliseconds 4" : "sleep 0.004";

async function waitForNotifyEvent(
  sessionKey: string,
  predicate: (events: string[]) => boolean,
  timeoutMs = isWin ? 12_000 : 5_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = peekSystemEvents(sessionKey);
    if (predicate(events)) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return peekSystemEvents(sessionKey);
}

async function waitForFinishedProcessSession(
  sessionId: string,
  timeoutMs = isWin ? 12_000 : 5_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (getFinishedSession(sessionId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for process session ${sessionId} to finish`);
}

function createExecHostDefaultsConfig(
  agents: Array<{ id: string; execHost?: "auto" | "gateway" | "sandbox" }>,
): OpenClawConfig {
  return {
    tools: {
      exec: {
        host: "auto",
        security: "full",
        ask: "off",
      },
    },
    agents: {
      list: agents.map((agent) => ({
        id: agent.id,
        ...(agent.execHost
          ? {
              tools: {
                exec: {
                  host: agent.execHost,
                },
              },
            }
          : {}),
      })),
    },
  };
}

describe("Agent-specific exec tool defaults", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    resetSystemEventsForTest();
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    resetSystemEventsForTest();
    resetProcessRegistryForTests();
  });

  it("should run exec synchronously when process is denied", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["process"],
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool?.execute("call1", {
      command: "echo done",
      yieldMs: 10,
    });

    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("routes implicit auto exec to gateway without a sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-implicit-gateway",
      agentDir: "/tmp/agent-main-implicit-gateway",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool!.execute("call-implicit-auto-default", {
      command: "echo done",
    });
    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("fails closed when exec host=sandbox is requested without sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {},
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-fail-closed",
      agentDir: "/tmp/agent-main-fail-closed",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    await expect(
      execTool!.execute("call-fail-closed", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("should apply agent-specific exec host defaults over global defaults", async () => {
    const cfg = createExecHostDefaultsConfig([
      { id: "main", execHost: "gateway" },
      { id: "helper" },
    ]);

    const mainTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-exec-defaults",
      agentDir: "/tmp/agent-main-exec-defaults",
    });
    const mainExecTool = mainTools.find((tool) => tool.name === "exec");
    expect(mainExecTool).toBeDefined();
    const mainResult = await mainExecTool!.execute("call-main-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const mainDetails = mainResult?.details as { status?: string } | undefined;
    expect(mainDetails?.status).toBe("completed");
    await expect(
      mainExecTool!.execute("call-main", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow("exec host not allowed");

    const helperTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:helper:main",
      workspaceDir: "/tmp/test-helper-exec-defaults",
      agentDir: "/tmp/agent-helper-exec-defaults",
    });
    const helperExecTool = helperTools.find((tool) => tool.name === "exec");
    expect(helperExecTool).toBeDefined();
    const helperResult = await helperExecTool!.execute("call-helper-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const helperDetails = helperResult?.details as { status?: string } | undefined;
    expect(helperDetails?.status).toBe("completed");
    await expect(
      helperExecTool!.execute("call-helper", {
        command: "echo done",
        host: "sandbox",
        yieldMs: 1000,
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("applies explicit agentId exec defaults when sessionKey is opaque", async () => {
    const cfg = createExecHostDefaultsConfig([{ id: "main", execHost: "gateway" }]);

    const tools = createOpenClawCodingTools({
      config: cfg,
      agentId: "main",
      sessionKey: "run-opaque-123",
      workspaceDir: "/tmp/test-main-opaque-session",
      agentDir: "/tmp/agent-main-opaque-session",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    const result = await execTool!.execute("call-main-opaque-session", {
      command: "echo done",
      yieldMs: 1000,
    });
    const details = result?.details as { status?: string } | undefined;
    expect(details?.status).toBe("completed");
  });

  it("does not notify on quiet background success by default for agent exec tools", async () => {
    const sessionKey = "agent:main:main";
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            host: "gateway",
            security: "full",
            ask: "off",
          },
        },
      },
      sessionKey,
      workspaceDir: "/tmp/test-main-background-notify",
      agentDir: "/tmp/agent-main-background-notify",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool!.execute("call-main-background-notify", {
      command: shortDelayCmd,
      background: true,
    });
    const details = result?.details as { status?: string; sessionId?: string } | undefined;
    expect(details?.status).toBe("running");
    expect(details?.sessionId).toBeTruthy();

    await waitForFinishedProcessSession(details?.sessionId ?? "");
    const events = await waitForNotifyEvent(sessionKey, () => false, 150);
    expect(events.some((event) => event.includes("Exec completed"))).toBe(false);
  });

  it("still allows explicit opt-in for quiet background success notifications", async () => {
    const sessionKey = "agent:main:main";
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            host: "gateway",
            security: "full",
            ask: "off",
            notifyOnExitEmptySuccess: true,
          },
        },
      },
      sessionKey,
      workspaceDir: "/tmp/test-main-background-notify-enabled",
      agentDir: "/tmp/agent-main-background-notify-enabled",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool!.execute("call-main-background-notify-enabled", {
      command: shortDelayCmd,
      background: true,
    });
    const details = result?.details as { status?: string } | undefined;
    expect(details?.status).toBe("running");

    const events = await waitForNotifyEvent(sessionKey, (items) =>
      items.some((event) => event.includes("Exec completed")),
    );
    expect(events.some((event) => event.includes("Exec completed"))).toBe(true);
  });

  it("keeps quiet background success notifications disabled when explicitly set to false", async () => {
    const sessionKey = "agent:main:main";
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            host: "gateway",
            security: "full",
            ask: "off",
            notifyOnExitEmptySuccess: false,
          },
        },
      },
      sessionKey,
      workspaceDir: "/tmp/test-main-background-notify-disabled",
      agentDir: "/tmp/agent-main-background-notify-disabled",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool!.execute("call-main-background-notify-disabled", {
      command: shortDelayCmd,
      background: true,
    });
    const details = result?.details as { status?: string; sessionId?: string } | undefined;
    expect(details?.status).toBe("running");
    expect(details?.sessionId).toBeTruthy();

    await waitForFinishedProcessSession(details?.sessionId ?? "");
    const events = await waitForNotifyEvent(sessionKey, () => false, 150);
    expect(events.some((event) => event.includes("Exec completed"))).toBe(false);
  });
});
