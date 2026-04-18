import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Ghost reminder bug (issue #13317)", () => {
  const createHeartbeatDeps = (replyText: string) => {
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi.fn().mockResolvedValue({ text: replyText });
    return { sendTelegram, getReplySpy };
  };

  const createConfig = async (params: {
    tmpDir: string;
    storePath: string;
    target?: "telegram" | "none";
    isolatedSession?: boolean;
  }): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
            ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
          },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: params.storePath },
    };
    const sessionKey = await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });

    return { cfg, sessionKey };
  };

  const createLastTargetConfig = (params: {
    tmpDir: string;
    storePath: string;
    isolatedSession?: boolean;
  }): OpenClawConfig => ({
    agents: {
      defaults: {
        workspace: params.tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: params.storePath },
  });

  const writeTelegramSessionStore = async (
    storePath: string,
    sessionKey: string,
    overrides: Record<string, unknown>,
  ): Promise<void> => {
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          ...overrides,
        },
      }),
    );
  };

  const expectCronEventPrompt = (
    calledCtx: {
      Provider?: string;
      Body?: string;
    } | null,
    reminderText: string,
  ) => {
    expect(calledCtx).not.toBeNull();
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain(reminderText);
    expect(calledCtx?.Body).not.toContain("HEARTBEAT_OK");
    expect(calledCtx?.Body).not.toContain("heartbeat poll");
  };

  const runCronReminderCase = async (
    tmpPrefix: string,
    enqueue: (sessionKey: string) => void,
  ): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string; ForceSenderIsOwnerFalse?: boolean } | null;
  }> => {
    return runHeartbeatCase({
      tmpPrefix,
      replyText: "Relay this reminder now",
      reason: "cron:reminder-job",
      enqueue,
    });
  };

  const runHeartbeatCase = async (params: {
    tmpPrefix: string;
    replyText: string;
    reason: string;
    enqueue: (sessionKey: string) => void;
    target?: "telegram" | "none";
    isolatedSession?: boolean;
  }): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: {
      Provider?: string;
      Body?: string;
      SessionKey?: string;
      OriginatingChannel?: string;
      OriginatingTo?: string;
      MessageThreadId?: string | number;
      ForceSenderIsOwnerFalse?: boolean;
    } | null;
    replyCallCount: number;
  }> => {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const { sendTelegram, getReplySpy } = createHeartbeatDeps(params.replyText);
        const { cfg, sessionKey } = await createConfig({
          tmpDir,
          storePath,
          target: params.target,
          isolatedSession: params.isolatedSession,
        });
        params.enqueue(sessionKey);
        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          reason: params.reason,
          deps: {
            getReplyFromConfig: getReplySpy,
            telegram: sendTelegram,
          },
        });
        const calledCtx = (getReplySpy.mock.calls[0]?.[0] ?? null) as {
          Provider?: string;
          Body?: string;
          SessionKey?: string;
          OriginatingChannel?: string;
          OriginatingTo?: string;
          MessageThreadId?: string | number;
          ForceSenderIsOwnerFalse?: boolean;
        } | null;
        return {
          result,
          sendTelegram,
          calledCtx,
          replyCallCount: getReplySpy.mock.calls.length,
        };
      },
      { prefix: params.tmpPrefix },
    );
  };

  const expectUntrustedEventOwnership = async (params: {
    tmpPrefix: string;
    reason: "hook:wake" | "interval";
    isolatedSession?: boolean;
    forceSenderIsOwnerFalse: boolean;
  }): Promise<void> => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: params.tmpPrefix,
      replyText: "Handled internally",
      reason: params.reason,
      target: "none",
      isolatedSession: params.isolatedSession,
      enqueue: (sessionKey) => {
        enqueueSystemEvent("GitHub issue opened: untrusted webhook content", {
          sessionKey,
          trusted: false,
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("heartbeat");
    if (params.isolatedSession === true) {
      expect(calledCtx?.SessionKey).toContain(":heartbeat");
    }
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(params.forceSenderIsOwnerFalse);
    expect(sendTelegram).not.toHaveBeenCalled();
  };

  it("does not use CRON_EVENT_PROMPT when only a HEARTBEAT_OK event is present", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-ghost-",
      replyText: "Heartbeat check-in",
      reason: "cron:test-job",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("heartbeat");
    expect(calledCtx?.Body).not.toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).not.toContain("relay this reminder");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when an actionable cron event exists", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-",
      (sessionKey) => {
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when cron events are mixed with heartbeat noise", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-mixed-",
      (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT for tagged cron events on interval wake", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-interval-",
      replyText: "Relay this cron update now",
      reason: "interval",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Cron: QMD maintenance completed", {
          sessionKey,
          contextKey: "cron:qmd-maintenance",
        });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain("Cron: QMD maintenance completed");
    expect(calledCtx?.Body).not.toContain("Read HEARTBEAT.md");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("drains inspected cron events after a successful run so later heartbeats do not replay them", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      const getReplySpy = vi
        .fn()
        .mockResolvedValueOnce({ text: "Relay this cron update now" })
        .mockResolvedValueOnce({ text: "HEARTBEAT_OK" });
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });

      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey,
        contextKey: "cron:qmd-maintenance",
      });

      const first = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });
      const second = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(first.status).toBe("ran");
      expect(second.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(2);

      const firstCtx = getReplySpy.mock.calls[0]?.[0] as { Provider?: string; Body?: string };
      const secondCtx = getReplySpy.mock.calls[1]?.[0] as { Provider?: string; Body?: string };
      expect(firstCtx.Provider).toBe("cron-event");
      expect(firstCtx.Body).toContain("Cron: QMD maintenance completed");
      expect(secondCtx.Provider).toBe("heartbeat");
      expect(secondCtx.Body).toContain("Read HEARTBEAT.md");
      expect(secondCtx.Body).not.toContain("Cron: QMD maintenance completed");
    });
  });

  it("uses an internal-only cron prompt when delivery target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-internal-",
      replyText: "Handled internally",
      reason: "cron:reminder-job",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Reminder: Rotate API keys", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("Handle this reminder internally");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("relays exec-event completions to the last session when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-internal-",
      replyText: "Handled follow-up",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: deploy succeeded", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(calledCtx?.Body).not.toContain("Handle the result internally");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toBe("Handled follow-up");
  });

  it("relays target-none exec batches only when every pending event shares one delivery context", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-shared-context-batch-",
      replyText: "Handled follow-up",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: follow up in the same topic", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(calledCtx).toMatchObject({
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-100155462274:topic:47",
      MessageThreadId: 47,
    });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:-100155462274:topic:47",
      "Handled follow-up",
      expect.objectContaining({ messageThreadId: 47 }),
    );
  });

  it("treats numeric and string thread ids as the same exec fallback route", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-shared-context-thread-types-",
      replyText: "Handled follow-up",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: follow up in the same topic", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
            threadId: "47",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "-100155462274",
      "Handled follow-up",
      expect.objectContaining({ messageThreadId: 47 }),
    );
  });

  it("preserves same-route reminders in the HEARTBEAT_OK exec fallback", async () => {
    const { result, sendTelegram, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-shared-context-fallback-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: follow up in the same topic", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:-100155462274:topic:47",
      expect.stringContaining("The task completed successfully (exit code 0)."),
      expect.objectContaining({ messageThreadId: 47 }),
    );
    expect(sendTelegram.mock.calls[0]?.[1]).toContain("Reminder: follow up in the same topic");
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("HEARTBEAT_OK");
  });

  it("preserves same-route task updates in the HEARTBEAT_OK exec fallback", async () => {
    const { result, sendTelegram, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-task-fallback-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Task update: uploaded the review bundle", {
          sessionKey,
          contextKey: "task:review-bundle",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:-100155462274:topic:47",
      expect.stringContaining("The task completed successfully (exit code 0)."),
      expect.objectContaining({ messageThreadId: 47 }),
    );
    expect(sendTelegram.mock.calls[0]?.[1]).toContain("Task update: uploaded the review bundle");
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("HEARTBEAT_OK");
  });

  it("does not dedupe identical exec fallback text across different Telegram topics", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      const getReplySpy = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" });

      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100155462274:topic:47",
          threadId: 47,
        },
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100155462274:topic:48",
          threadId: 48,
        },
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(sendTelegram).toHaveBeenNthCalledWith(
        1,
        "telegram:-100155462274:topic:47",
        "The task completed successfully (exit code 0).",
        expect.objectContaining({ messageThreadId: 47 }),
      );
      expect(sendTelegram).toHaveBeenNthCalledWith(
        2,
        "telegram:-100155462274:topic:48",
        "The task completed successfully (exit code 0).",
        expect.objectContaining({ messageThreadId: 48 }),
      );
    });
  });

  it("does not dedupe a normal heartbeat after a routed exec fallback with the same text", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const targetNoneCfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const targetTelegramCfg: OpenClawConfig = {
        ...targetNoneCfg,
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
      };
      const sessionKey = await seedMainSessionStore(storePath, targetNoneCfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });

      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100155462274:topic:47",
          threadId: 47,
        },
      });
      await runHeartbeatOnce({
        cfg: targetNoneCfg,
        agentId: "main",
        reason: "exec-event",
        deps: {
          getReplyFromConfig: vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" }),
          telegram: sendTelegram,
        },
      });

      enqueueSystemEvent("Reminder: review queue ready", {
        sessionKey,
        contextKey: "reminder:review-queue",
      });
      await runHeartbeatOnce({
        cfg: targetTelegramCfg,
        agentId: "main",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: vi
            .fn()
            .mockResolvedValue({ text: "The task completed successfully (exit code 0)." }),
          telegram: sendTelegram,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(sendTelegram).toHaveBeenNthCalledWith(
        1,
        "telegram:-100155462274:topic:47",
        "The task completed successfully (exit code 0).",
        expect.objectContaining({ messageThreadId: 47 }),
      );
      expect(sendTelegram).toHaveBeenNthCalledWith(
        2,
        "-100155462274",
        "The task completed successfully (exit code 0).",
        expect.objectContaining({ verbose: false }),
      );
    });
  });

  it("keeps unrouted reminders out of the HEARTBEAT_OK exec fallback", async () => {
    const { result, sendTelegram, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-unrouted-reminder-fallback-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: follow up in the same topic", {
          sessionKey,
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toContain(
      "The task completed successfully (exit code 0).",
    );
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("Reminder: follow up in the same topic");
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("HEARTBEAT_OK");
  });

  it("keeps mixed exec and routed non-exec batches internal when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-followup-route-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: follow up on topic 52 separately", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:52",
            threadId: 52,
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("keeps mixed-route explicit exec replies internal when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-explicit-followup-route-",
      replyText: "Handled follow-up",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: follow up on topic 52 separately", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:52",
            threadId: 52,
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("keeps unrouted bystander events internal when target-none exec fallback has one shared route", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-followup-unrouted-bystander-",
      replyText: "Handled follow-up",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Gateway restart ok", {
          sessionKey,
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("keeps mixed-context exec batches internal when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-mixed-contexts-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-a, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Exec completed (review-b, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:52",
            threadId: 52,
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("treats encoded and decoded Telegram topic routes as the same exec fallback destination", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-topic-route-equivalence-",
      replyText: "Handled follow-up",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-a, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Exec completed (review-b, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
            threadId: "47",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:-100155462274:topic:47",
      "Handled follow-up",
      expect.objectContaining({ messageThreadId: 47 }),
    );
  });

  it("keeps exec fallback internal when one route omits a non-encoded thread id", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-thread-mismatch-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-a, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Reminder: parent chat only", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("keeps exec fallback internal when one route omits account scope", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-account-mismatch-",
      replyText: "HEARTBEAT_OK",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-a, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
            accountId: "primary",
          },
        });
        enqueueSystemEvent("Reminder: same chat without account scope", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("keeps contextless exec completions internal when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-no-context-",
      replyText: "Handled internally",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (review-run, code 0)", {
          sessionKey,
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(calledCtx?.Body).not.toContain("Please relay the command output to the user");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("classifies hook:wake exec completions as exec-event prompts", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-",
      replyText: "Handled follow-up",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: webhook-triggered backup completed", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(calledCtx?.Body).not.toContain("Handle the result internally");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toBe("Handled follow-up");
  });

  it("does not classify base-session hook:wake exec completions as exec-event prompts when isolated sessions are enabled", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-isolated-",
      replyText: "Handled internally",
      reason: "hook:wake",
      target: "none",
      isolatedSession: true,
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: webhook-triggered backup completed", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("heartbeat");
    expect(calledCtx?.SessionKey).toContain(":heartbeat");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(false);
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("falls back to the exec event text when a wake run returns HEARTBEAT_OK", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-fallback-",
      replyText: "HEARTBEAT_OK",
      reason: "hook:wake",
      enqueue: (sessionKey) => {
        enqueueSystemEvent(
          "exec finished: blocked - background task failed after waiting in the temp repo, with no file changes",
          { sessionKey },
        );
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toContain(
      "The background task needs attention. background task failed after waiting in the temp repo, with no file changes.",
    );
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("HEARTBEAT_OK");
  });

  it("falls back to the exec event text when a wake run returns no content", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-empty-fallback-",
      replyText: "",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent(
          "exec finished: blocked - background task failed after waiting in the temp repo, with no file changes",
          {
            sessionKey,
            deliveryContext: {
              channel: "telegram",
              to: "-100155462274",
            },
          },
        );
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toContain(
      "The background task needs attention. background task failed after waiting in the temp repo, with no file changes.",
    );
  });

  it("humanizes exec completion fallback text for successful exits", async () => {
    const { result, sendTelegram, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-fallback-success-",
      replyText: "HEARTBEAT_OK",
      reason: "hook:wake",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (reviewrun, code 0)", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toContain(
      "The task completed successfully (exit code 0).",
    );
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("Exec completed (");
  });

  it("humanizes exec denial fallback text for wake-triggered relays", async () => {
    const { result, sendTelegram, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-denied-fallback-",
      replyText: "HEARTBEAT_OK",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec denied (node=ios-node-1 id=run-7, permission:camera): ffmpeg", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toContain(
      "The background task was denied (permission:camera).",
    );
    expect(sendTelegram.mock.calls[0]?.[1]).toContain("Command: ffmpeg");
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("HEARTBEAT_OK");
  });

  it("keeps arbitrary system-status noise out of the HEARTBEAT_OK exec fallback", async () => {
    const { result, sendTelegram, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-fallback-non-reminder-bystander-",
      replyText: "HEARTBEAT_OK",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec completed (reviewrun, code 0)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
        enqueueSystemEvent("Gateway restart ok", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100155462274:topic:47",
            threadId: 47,
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toContain(
      "The task completed successfully (exit code 0).",
    );
    expect(sendTelegram.mock.calls[0]?.[1]).not.toContain("Gateway restart ok");
  });

  it("relays wake-triggered exec completions even when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-target-none-",
      replyText: "Handled follow-up",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: blocked - background task needs attention", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(calledCtx?.Body).not.toContain("Handle the result internally");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toBe("Handled follow-up");
  });

  it("relays wake-triggered exec denials even when heartbeat target is none", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-denied-target-none-",
      replyText: "Handled denial follow-up",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Exec denied (node=ios-node-1 id=run-7, permission:camera)", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
          },
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("Please relay the command output to the user");
    expect(calledCtx?.Body).not.toContain("Handle the result internally");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0]?.[1]).toBe("Handled denial follow-up");
  });

  it("forces owner downgrade for untrusted hook:wake system events", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-hook-untrusted-",
      reason: "hook:wake",
      forceSenderIsOwnerFalse: true,
    });
  });

  it("forces owner downgrade for untrusted interval events", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-interval-untrusted-",
      reason: "interval",
      forceSenderIsOwnerFalse: true,
    });
  });

  it("does not force owner downgrade for untrusted hook:wake events with isolated sessions", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-hook-untrusted-isolated-",
      reason: "hook:wake",
      isolatedSession: true,
      forceSenderIsOwnerFalse: false,
    });
  });

  it("does not force owner downgrade for isolated interval runs with only base-session untrusted events", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-interval-untrusted-isolated-",
      reason: "interval",
      isolatedSession: true,
      forceSenderIsOwnerFalse: false,
    });
  });

  it("routes wake-triggered heartbeat replies using queued system-event delivery context", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
          threadId: 42,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "-100155462274",
        "Restart complete",
        expect.objectContaining({ messageThreadId: 42 }),
      );
    });
  });

  it("does not reuse stale turn-source routing for isolated wake runs", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, { lastTo: "-100155462274" });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "-100999999999",
          threadId: 42,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: `${sessionKey}:heartbeat`,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram.mock.calls[0]?.[0]).toBe("-100155462274");
      const options = sendTelegram.mock.calls[0]?.[2] as { messageThreadId?: number } | undefined;
      expect(options?.messageThreadId).toBeUndefined();
    });
  });
  it("keeps exec-event delivery pinned to the original Telegram topic when session route drifts", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "telegram:-1003774691294:topic:2175",
            lastThreadId: 2175,
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-1003774691294",
      });
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "The review-worker spawn finished successfully.",
      });
      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        trusted: false,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "telegram:-1003774691294:topic:47",
        "The review-worker spawn finished successfully.",
        expect.objectContaining({ messageThreadId: 47 }),
      );
    });
  });

  it("keeps exec-event delivery pinned to the event route when heartbeat is pinned elsewhere", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
              to: "-1009999999999",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "-100155462274",
            chatType: "group",
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "Handled follow-up",
      });
      enqueueSystemEvent("Exec finished (node=node-1 id=approval-1, code 0)\nok", {
        sessionKey,
        trusted: false,
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram.mock.calls[0]?.[0]).toBe("-100155462274");
      expect(sendTelegram.mock.calls[0]?.[1]).toBe("Handled follow-up");
    });
  });

  it("keeps isolated exec fallback delivery pinned to the original Telegram topic", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
              isolatedSession: true,
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "-100155462274",
            chatType: "group",
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Handled follow-up" });
      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        trusted: false,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100155462274:topic:47",
          threadId: 47,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "exec-event",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: `${sessionKey}:heartbeat`,
          MessageThreadId: 47,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "telegram:-100155462274:topic:47",
        "Handled follow-up",
        expect.objectContaining({ messageThreadId: 47 }),
      );
    });
  });

  it("keeps Telegram topic routing for isolated scheduled heartbeats", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "-100155462274",
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
          threadId: 42,
        },
        chatType: "group",
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Topic heartbeat" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "timer",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: `${sessionKey}:heartbeat`,
          MessageThreadId: 42,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "-100155462274",
        "Topic heartbeat",
        expect.objectContaining({ messageThreadId: 42 }),
      );
    });
  });
});
