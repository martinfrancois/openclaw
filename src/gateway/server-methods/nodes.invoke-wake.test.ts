import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberNodeExecDeliveryContext,
  resetNodeExecDeliveryContextRegistryForTests,
  resolveNodeExecDeliveryContext,
} from "../../infra/node-exec-delivery-context.js";
import {
  classifyDuplicateExecFinished,
  markExecFinishedDelivered,
  resetExecFinishedDeduplicationForTests,
} from "../node-exec-finished-dedupe.js";
import { ErrorCodes } from "../protocol/index.js";
import {
  clearNodeWakeState,
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  nodeHandlers,
} from "./nodes.js";

type MockNodeCommandPolicyParams = {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
};

type MockExtractDeliveryInfoResult = {
  deliveryContext?:
    | {
        channel: string;
        to: string;
        accountId?: string;
        threadId?: string | number;
      }
    | undefined;
  threadId?: string | number;
};

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  extractDeliveryInfo: vi.fn<() => MockExtractDeliveryInfoResult>(() => ({
    deliveryContext: {
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    },
    threadId: "99",
  })),
  resolveNodeCommandAllowlist: vi.fn<() => Set<string>>(() => new Set()),
  isNodeCommandAllowed: vi.fn<
    (params: MockNodeCommandPolicyParams) => { ok: true } | { ok: false; reason: string }
  >(() => ({ ok: true })),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(({ rawParams }: { rawParams: unknown }) => ({
    ok: true,
    params: rawParams,
  })),
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

const runtimeMocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(() => true),
  requestHeartbeatNow: vi.fn(),
  scopedHeartbeatWakeOptions: vi.fn((sessionKey: string, opts: { reason: string }) => ({
    sessionKey,
    ...opts,
  })),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
}));

vi.mock("../node-invoke-sanitize.js", () => ({
  sanitizeNodeInvokeParamsForForwarding: mocks.sanitizeNodeInvokeParamsForForwarding,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: mocks.clearApnsRegistrationIfCurrent,
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelayConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
  sendApnsAlert: mocks.sendApnsAlert,
  shouldClearStoredApnsRegistration: mocks.shouldClearStoredApnsRegistration,
}));

vi.mock("../server-node-events.runtime.js", () => ({
  enqueueSystemEvent: runtimeMocks.enqueueSystemEvent,
  requestHeartbeatNow: runtimeMocks.requestHeartbeatNow,
  scopedHeartbeatWakeOptions: runtimeMocks.scopedHeartbeatWakeOptions,
}));

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

type TestNodeSession = {
  nodeId: string;
  commands: string[];
  platform?: string;
};

const WAKE_WAIT_TIMEOUT_MS = 3_001;
const DEFAULT_RELAY_CONFIG = {
  baseUrl: "https://relay.example.com",
  timeoutMs: 1000,
} as const;
type WakeResultOverrides = Partial<{
  ok: boolean;
  status: number;
  reason: string;
  tokenSuffix: string;
  topic: string;
  environment: "sandbox" | "production";
  transport: "direct" | "relay";
}>;

function directRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "direct" as const,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox" as const,
    updatedAtMs: 1,
  };
}

function relayRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "relay" as const,
    relayHandle: "relay-handle-123",
    sendGrant: "send-grant-123",
    installationId: "install-123",
    topic: "ai.openclaw.ios",
    environment: "production" as const,
    distribution: "official" as const,
    updatedAtMs: 1,
    tokenDebugSuffix: "abcd1234",
  };
}

function mockDirectWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue({
    ok: true,
    value: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
    },
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    transport: "direct",
    ...overrides,
  });
}

function mockRelayWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadConfig.mockReturnValue({
    gateway: {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    },
  });
  mocks.loadApnsRegistration.mockResolvedValue(relayRegistration(nodeId));
  mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
    ok: true,
    value: DEFAULT_RELAY_CONFIG,
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "abcd1234",
    topic: "ai.openclaw.ios",
    environment: "production",
    transport: "relay",
    ...overrides,
  });
}

function makeNodeInvokeParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeId: "ios-node-1",
    command: "camera.capture",
    params: { quality: "high" },
    timeoutMs: 5000,
    idempotencyKey: "idem-node-invoke",
    ...overrides,
  };
}

async function invokeNode(params: {
  nodeRegistry: {
    get: (nodeId: string) => TestNodeSession | undefined;
    invoke: (payload: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
    }) => Promise<{
      ok: boolean;
      payload?: unknown;
      payloadJSON?: string | null;
      error?: { code?: string; message?: string } | null;
    }>;
  };
  requestParams?: Partial<Record<string, unknown>>;
  client?: unknown;
}) {
  const respond = vi.fn();
  const logGateway = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  await nodeHandlers["node.invoke"]({
    params: makeNodeInvokeParams(params.requestParams),
    respond: respond as never,
    context: {
      nodeRegistry: params.nodeRegistry,
      execApprovalManager: undefined,
      logGateway,
    } as never,
    client: (params.client ?? null) as never,
    req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
    isWebchatConnect: () => false,
  });
  return respond;
}

function createNodeClient(nodeId: string, commands?: string[]) {
  return {
    connect: {
      ...(commands ? { commands } : {}),
      role: "node" as const,
      client: {
        id: nodeId,
        mode: "node" as const,
        name: "ios-test",
        platform: "iOS 26.4.0",
        version: "test",
      },
    },
  };
}

function createBackendClient() {
  return {
    connect: {
      client: {
        id: "agent-backend-test",
        mode: "backend" as const,
        name: "agent",
        platform: process.platform,
        version: "test",
      },
    },
  };
}

async function pullPending(nodeId: string, commands?: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.pull"]({
    params: {},
    respond: respond as never,
    context: {} as never,
    client: createNodeClient(nodeId, commands) as never,
    req: { type: "req", id: "req-node-pending", method: "node.pending.pull" },
    isWebchatConnect: () => false,
  });
  return respond;
}

async function ackPending(nodeId: string, ids: string[], commands?: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.ack"]({
    params: { ids },
    respond: respond as never,
    context: {} as never,
    client: createNodeClient(nodeId, commands) as never,
    req: { type: "req", id: "req-node-pending-ack", method: "node.pending.ack" },
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("node.invoke APNs wake path", () => {
  beforeEach(() => {
    resetNodeExecDeliveryContextRegistryForTests();
    resetExecFinishedDeduplicationForTests();
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({});
    mocks.extractDeliveryInfo.mockClear();
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
        accountId: "trusted-account",
        threadId: "99",
      },
      threadId: "99",
    });
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set());
    mocks.isNodeCommandAllowed.mockClear();
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.sanitizeNodeInvokeParamsForForwarding.mockClear();
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => ({ ok: true, params: rawParams }),
    );
    mocks.loadApnsRegistration.mockClear();
    mocks.clearApnsRegistrationIfCurrent.mockClear();
    mocks.resolveApnsAuthConfigFromEnv.mockClear();
    mocks.resolveApnsRelayConfigFromEnv.mockClear();
    mocks.sendApnsBackgroundWake.mockClear();
    mocks.sendApnsAlert.mockClear();
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
    runtimeMocks.enqueueSystemEvent.mockClear();
    runtimeMocks.enqueueSystemEvent.mockReturnValue(true);
    runtimeMocks.requestHeartbeatNow.mockClear();
    runtimeMocks.scopedHeartbeatWakeOptions.mockClear();
    runtimeMocks.scopedHeartbeatWakeOptions.mockImplementation(
      (sessionKey: string, opts: { reason: string }) => ({
        sessionKey,
        ...opts,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing not-connected response when wake path is unavailable", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const respond = await invokeNode({ nodeRegistry });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("node not connected");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("records trusted system.run delivery context from the session store for deferred runs", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-1",
          deliveryContext: {
            channel: "telegram",
            to: "-100999",
            accountId: "spoofed-account",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-1",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("generates a runId for deferred system.run routes when callers omit one", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    const invokeParams = nodeRegistry.invoke.mock.calls[0]?.[0]?.params as
      | { runId?: unknown }
      | undefined;
    const runId = typeof invokeParams?.runId === "string" ? invokeParams.runId : undefined;
    expect(runId).toEqual(expect.any(String));
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: runId ?? "",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("keeps cached delivery context for successful inline system.run responses until follow-up delivery", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { success: true } }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-sync-success",
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-sync-success",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("keeps cached delivery context for successful routed system.run responses until follow-up delivery", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { success: true } }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-sync-routed-success",
          deliveryContext: {
            channel: "signal",
            to: "+15551234567",
            accountId: "trusted-account",
            threadId: "99",
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-sync-routed-success",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("preserves the originating thread when a deferred session thread has moved", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
        accountId: "trusted-account",
        threadId: "old-thread",
      },
      threadId: "old-thread",
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-thread-override",
          deliveryContext: {
            channel: "signal",
            to: "+15551234567",
            accountId: "trusted-account",
            threadId: "new-thread",
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-thread-override",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "new-thread",
    });
  });

  it("treats Telegram topic and base-chat routes as the same trusted session route", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "trusted-account",
      },
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-topic-merge",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100123:topic:47",
            accountId: "trusted-account",
            threadId: 47,
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-topic-merge",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "trusted-account",
      threadId: 47,
    });
  });

  it("preserves the originating Telegram topic when the deferred session thread has moved", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "trusted-account",
        threadId: 41,
      },
      threadId: 41,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-topic-mismatch",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100123:topic:47",
            accountId: "trusted-account",
            threadId: 47,
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-topic-mismatch",
      }),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-100123:topic:47",
      accountId: "trusted-account",
      threadId: 47,
    });
  });

  it("preserves explicit account and thread overrides when the trusted route lags them", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
      },
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-account-thread-override",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-account-thread-override",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: "topic-47",
    });
  });

  it("does not resurrect stripped deliveryContext thread or account overrides", async () => {
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => {
        if (!rawParams || typeof rawParams !== "object") {
          return { ok: true, params: rawParams };
        }
        const { deliveryContext: _deliveryContext, ...next } = rawParams as Record<string, unknown>;
        return { ok: true, params: next };
      },
    );
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
      },
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-sanitized-delivery-context",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        },
      },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
          },
        }),
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-sanitized-delivery-context",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
    });
  });

  it("preserves backend deliveryContext before sanitize strips it", async () => {
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => {
        if (!rawParams || typeof rawParams !== "object") {
          return { ok: true, params: rawParams };
        }
        const { deliveryContext: _deliveryContext, ...next } = rawParams as Record<string, unknown>;
        return { ok: true, params: next };
      },
    );
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
      },
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      client: createBackendClient(),
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-backend-delivery-context",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        },
      },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        }),
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-backend-delivery-context",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: "topic-47",
    });
  });

  it("keeps backend deliveryContext when no trusted session route exists yet", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      client: createBackendClient(),
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-backend-no-store",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        },
      },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        }),
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-backend-no-store",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: "topic-47",
    });
  });

  it("ignores stripped deliveryContext overrides that change the base route", async () => {
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => {
        if (!rawParams || typeof rawParams !== "object") {
          return { ok: true, params: rawParams };
        }
        const { deliveryContext: _deliveryContext, ...next } = rawParams as Record<string, unknown>;
        return { ok: true, params: next };
      },
    );
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
        accountId: "trusted-account",
        threadId: "99",
      },
      threadId: "99",
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-sanitized-route-override",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: "topic-47",
          },
        },
      },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliveryContext: {
            channel: "signal",
            to: "+15551234567",
            accountId: "trusted-account",
            threadId: "99",
          },
        }),
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-sanitized-route-override",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("preserves the originating account when a deferred session route switches accounts", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "trusted-account",
        threadId: "old-thread",
      },
      threadId: "old-thread",
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-account-mismatch",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "spoofed-account",
            threadId: "topic-47",
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-account-mismatch",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "trusted-account",
      threadId: "topic-47",
    });
  });

  it("preserves the thread parsed from the session key for deferred runs when the stored route has not persisted it yet", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
        accountId: "trusted-account",
      },
      threadId: "thread-from-session-key",
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main#thread-from-session-key",
          runId: "run-route-thread-from-session-key",
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main#thread-from-session-key",
        runId: "run-route-thread-from-session-key",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "thread-from-session-key",
    });
  });

  it("preserves the thread parsed from the session key over a newer stored thread", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
        accountId: "trusted-account",
        threadId: "newer-thread",
      },
      threadId: "thread-from-session-key",
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main#thread-from-session-key",
          runId: "run-route-thread-preserved-over-stored-thread",
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main#thread-from-session-key",
        runId: "run-route-thread-preserved-over-stored-thread",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "thread-from-session-key",
    });
  });

  it("uses agentId when canonicalizing relative session keys for deferred system.run routes", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          agentId: "ops",
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-agent-main",
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:ops:main",
        runId: "run-route-agent-main",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-agent-main",
      }),
    ).toBeUndefined();
  });

  it("keeps an explicit route available until the follow-up is delivered when no trusted session route exists", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { success: true } }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "synthetic-session",
          runId: "run-route-explicit-fallback",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:synthetic-session",
        runId: "run-route-explicit-fallback",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: 47,
    });
  });

  it("does not cache delivery context for suppressed system.run notifications", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { success: true } }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-suppressed",
          suppressNotifyOnExit: true,
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        command: "system.run",
        nodeId: "ios-node-1",
        ok: true,
        payload: { success: true },
      }),
      undefined,
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-suppressed",
      }),
    ).toBeUndefined();
  });

  it("clears stale cached delivery context when a suppressed run reuses the same run id", async () => {
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-suppressed-reused",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "primary",
        threadId: 47,
      },
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { success: true } }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-suppressed-reused",
          suppressNotifyOnExit: true,
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-suppressed-reused",
      }),
    ).toBeUndefined();
  });

  it("clears stale cached delivery context when a reused run id has no trusted session route", async () => {
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:synthetic-session",
      runId: "run-route-explicit-fallback-reused",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "primary",
        threadId: 47,
      },
    });
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { success: true } }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "synthetic-session",
          runId: "run-route-explicit-fallback-reused",
        },
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:synthetic-session",
        runId: "run-route-explicit-fallback-reused",
      }),
    ).toBeUndefined();
  });

  it("does not cache delivery context when system.run invoke fails", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "NODE_INVOKE_FAILED", message: "boom" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-failed",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-failed",
      }),
    ).toBeUndefined();
  });

  it("drops cached delivery context for immediate system.run denial results", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-denied",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-denied",
      }),
    ).toBeUndefined();
  });

  it("keeps routed system.run completions pending after replying to the caller", async () => {
    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-success",
        now: Date.now(),
      }),
    ).toBe("enqueue");
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
      }),
    };
    const respond = vi.fn();

    await nodeHandlers["node.invoke"]({
      params: makeNodeInvokeParams({
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-success",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      }),
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager: undefined,
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalled();
    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-success",
        now: Date.now(),
      }),
    ).toBe("enqueue");
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-success",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("clears stale exec-finished dedupe state before reusing a routed runId", async () => {
    markExecFinishedDelivered({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-reused",
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-reused",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-reused",
        now: Date.now(),
      }),
    ).toBe("enqueue");
  });

  it("queues a routed success fallback when replying with a routed success throws", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
      }),
    };
    let firstReply = true;
    const respond = vi.fn((ok: boolean) => {
      if (ok && firstReply) {
        firstReply = false;
        throw new Error("request socket closed");
      }
    });

    await nodeHandlers["node.invoke"]({
      params: makeNodeInvokeParams({
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-success-reply-failed",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      }),
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager: undefined,
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalled();
    expect(runtimeMocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "Exec finished (node=ios-node-1 id=run-route-success-reply-failed, code 0)\nok",
      {
        sessionKey: "agent:main:main",
        contextKey: "exec:run-route-success-reply-failed",
        deliveryContext: {
          channel: "signal",
          to: "+15551234567",
          accountId: "trusted-account",
          threadId: "99",
        },
        trusted: false,
      },
    );
    expect(runtimeMocks.requestHeartbeatNow).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      reason: "exec-event",
    });
    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-success-reply-failed",
        now: Date.now(),
      }),
    ).toBe("pre-delivered");
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-success-reply-failed",
      }),
    ).toBeUndefined();
  });

  it("does not mark routed success as pre-delivered when the queued fallback cannot be recorded", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
      }),
    };
    runtimeMocks.enqueueSystemEvent.mockReturnValue(false);
    let firstReply = true;
    const respond = vi.fn((ok: boolean) => {
      if (ok && firstReply) {
        firstReply = false;
        throw new Error("request socket closed");
      }
    });

    await nodeHandlers["node.invoke"]({
      params: makeNodeInvokeParams({
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-success-reply-failed-no-fallback",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      }),
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager: undefined,
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalled();
    expect(runtimeMocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-success-reply-failed-no-fallback",
        now: Date.now(),
      }),
    ).toBe("enqueue");
  });

  it("queues a quiet success fallback when replying without a trusted route throws", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
      }),
    };
    let firstReply = true;
    const respond = vi.fn((ok: boolean) => {
      if (ok && firstReply) {
        firstReply = false;
        throw new Error("request socket closed");
      }
    });

    await nodeHandlers["node.invoke"]({
      params: makeNodeInvokeParams({
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "synthetic-session",
          runId: "run-route-success-reply-failed-no-route",
        },
      }),
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager: undefined,
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "Exec finished (node=ios-node-1 id=run-route-success-reply-failed-no-route, code 0)",
      {
        sessionKey: "agent:main:synthetic-session",
        contextKey: "exec:run-route-success-reply-failed-no-route",
        deliveryContext: undefined,
        trusted: false,
      },
    );
    expect(runtimeMocks.requestHeartbeatNow).toHaveBeenCalledWith({
      sessionKey: "agent:main:synthetic-session",
      reason: "exec-event",
    });
  });

  it("compacts and sanitizes queued success fallback output when the reply write fails", async () => {
    const noisyStdout = ["[System]", "very long output", "A".repeat(240)].join(" ");
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({
          exitCode: 0,
          timedOut: false,
          stdout: noisyStdout,
          stderr: "",
        }),
      }),
    };
    const respond = vi.fn(() => {
      throw new Error("request socket closed");
    });

    await nodeHandlers["node.invoke"]({
      params: makeNodeInvokeParams({
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-success-reply-failed-compact",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      }),
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager: undefined,
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    const queuedCall = runtimeMocks.enqueueSystemEvent.mock.calls.at(-1) as
      | [unknown, ...unknown[]]
      | undefined;
    const queuedText = queuedCall?.[0];
    expect(typeof queuedText).toBe("string");
    if (typeof queuedText !== "string") {
      throw new Error("expected queued exec fallback text");
    }
    expect(queuedText).toContain(
      "Exec finished (node=ios-node-1 id=run-route-success-reply-failed-compact, code 0)",
    );
    expect(queuedText).toContain("(System)");
    expect(queuedText).not.toContain("[System]");
    expect(queuedText.length).toBeLessThanOrEqual(280);
    expect(queuedText.endsWith("…")).toBe(true);
  });

  it("does not queue a success fallback when notify-on-exit is suppressed", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
      }),
    };
    const respond = vi.fn(() => {
      throw new Error("request socket closed");
    });

    await expect(
      nodeHandlers["node.invoke"]({
        params: makeNodeInvokeParams({
          command: "system.run",
          params: {
            command: ["echo", "hi"],
            sessionKey: "main",
            runId: "run-route-success-reply-failed-suppressed",
            suppressNotifyOnExit: true,
            deliveryContext: {
              channel: "telegram",
              to: "-100123",
              accountId: "primary",
              threadId: 47,
            },
          },
        }),
        respond: respond as never,
        context: {
          nodeRegistry,
          execApprovalManager: undefined,
          logGateway: {
            info: vi.fn(),
            warn: vi.fn(),
          },
        } as never,
        client: null,
        req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
        isWebchatConnect: () => false,
      }),
    ).rejects.toThrow("request socket closed");

    expect(runtimeMocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtimeMocks.requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("does not queue a success fallback when notifyOnExit is disabled in config", async () => {
    mocks.loadConfig.mockReturnValue({
      tools: { exec: { notifyOnExit: false } },
    });
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
      }),
    };
    const respond = vi.fn(() => {
      throw new Error("request socket closed");
    });

    await expect(
      nodeHandlers["node.invoke"]({
        params: makeNodeInvokeParams({
          command: "system.run",
          params: {
            command: ["echo", "hi"],
            sessionKey: "main",
            runId: "run-route-success-reply-failed-config-suppressed",
            deliveryContext: {
              channel: "telegram",
              to: "-100123",
              accountId: "primary",
              threadId: 47,
            },
          },
        }),
        respond: respond as never,
        context: {
          nodeRegistry,
          execApprovalManager: undefined,
          logGateway: {
            info: vi.fn(),
            warn: vi.fn(),
          },
        } as never,
        client: null,
        req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
        isWebchatConnect: () => false,
      }),
    ).rejects.toThrow("request socket closed");

    expect(runtimeMocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtimeMocks.requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("keeps cached delivery context when system.run invoke times out", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-timeout",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-timeout",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("keeps cached delivery context when system.run is queued until foreground", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "QUEUED_UNTIL_FOREGROUND",
          message: "node command queued until iOS returns to foreground",
        },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-queued",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-queued",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("keeps cached delivery context when node invoke rejects after dispatch", async () => {
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockRejectedValue(new Error("node disconnected (system.run)")),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-rejected",
          deliveryContext: {
            channel: "telegram",
            to: "-100999",
            accountId: "primary",
            threadId: 88,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-rejected",
      }),
    ).toEqual({
      channel: "signal",
      to: "+15551234567",
      accountId: "trusted-account",
      threadId: "99",
    });
  });

  it("clears cached delivery context when a reused run id later succeeds", async () => {
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-reused",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "primary",
        threadId: 47,
      },
    });

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockImplementation(async () => {
        expect(
          resolveNodeExecDeliveryContext({
            nodeId: "ios-node-1",
            sessionKey: "agent:main:main",
            runId: "run-route-reused",
          }),
        ).toBeUndefined();
        return {
          ok: true,
          payload: { success: true, exitCode: 0 },
        };
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-reused",
          deliveryContext: {
            channel: "telegram",
            to: "-100999",
            accountId: "primary",
            threadId: 88,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        nodeId: "ios-node-1",
        command: "system.run",
      }),
      undefined,
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-reused",
      }),
    ).toBeUndefined();
  });

  it("drops cached delivery context when a reused pending run id switches to a different route", async () => {
    markExecFinishedDelivered({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-reused-pending-conflict",
    });
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-reused-pending-conflict",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "primary",
        threadId: 47,
      },
    });

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-reused-pending-conflict",
          deliveryContext: {
            channel: "telegram",
            to: "-100999",
            accountId: "primary",
            threadId: 88,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-reused-pending-conflict",
      }),
    ).toBeUndefined();
    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-reused-pending-conflict",
        now: Date.now(),
      }),
    ).toBe("pre-delivered");
  });

  it("clears older dedupe markers when a reused run is dispatched again", async () => {
    markExecFinishedDelivered({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-reused-pending",
    });

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-1",
        commands: ["system.run"],
        platform: process.platform,
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          sessionKey: "main",
          runId: "run-route-reused-pending",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "primary",
            threadId: 47,
          },
        },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
    expect(
      classifyDuplicateExecFinished({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-reused-pending",
        now: Date.now(),
      }),
    ).toBe("enqueue");
  });

  it("keeps node exec delivery routes available beyond one hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-long",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "primary",
        threadId: 47,
      },
    });

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-long",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: 47,
    });
  });

  it("does not evict older pending routes when newer runs are registered", () => {
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-oldest",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        accountId: "primary",
        threadId: 47,
      },
    });

    for (let i = 0; i < 1001; i += 1) {
      rememberNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: `run-route-${i}`,
        deliveryContext: {
          channel: "telegram",
          to: `-200${i}`,
          accountId: "primary",
          threadId: i,
        },
      });
    }

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-oldest",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: 47,
    });
  });

  it("keeps routes distinct when different nodes reuse the same run id", () => {
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-1",
      sessionKey: "agent:main:main",
      runId: "run-route-shared",
      deliveryContext: {
        channel: "telegram",
        to: "-100123",
        threadId: 47,
      },
    });
    rememberNodeExecDeliveryContext({
      nodeId: "ios-node-2",
      sessionKey: "agent:main:main",
      runId: "run-route-shared",
      deliveryContext: {
        channel: "telegram",
        to: "-100456",
        threadId: 88,
      },
    });

    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-1",
        sessionKey: "agent:main:main",
        runId: "run-route-shared",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: 47,
    });
    expect(
      resolveNodeExecDeliveryContext({
        nodeId: "ios-node-2",
        sessionKey: "agent:main:main",
        runId: "run-route-shared",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100456",
      threadId: 88,
    });
  });

  it("does not throttle repeated relay wake attempts when relay config is missing", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(relayRegistration("ios-node-relay-no-auth"));
    mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
      ok: false,
      error: "relay config missing",
    });

    const first = await maybeWakeNodeWithApns("ios-node-relay-no-auth");
    const second = await maybeWakeNodeWithApns("ios-node-relay-no-auth");

    expect(first).toMatchObject({
      available: false,
      throttled: false,
      path: "no-auth",
      apnsReason: "relay config missing",
    });
    expect(second).toMatchObject({
      available: false,
      throttled: false,
      path: "no-auth",
      apnsReason: "relay config missing",
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("clears wake and nudge throttle state when a node disconnects", async () => {
    mockDirectWakeConfig("ios-node-clear-wake");
    mocks.sendApnsAlert.mockResolvedValue({
      ok: true,
      status: 200,
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      transport: "direct",
    });

    await expect(maybeWakeNodeWithApns("ios-node-clear-wake")).resolves.toMatchObject({
      path: "sent",
      throttled: false,
    });
    await expect(maybeSendNodeWakeNudge("ios-node-clear-wake")).resolves.toMatchObject({
      sent: true,
      throttled: false,
    });
    await expect(maybeWakeNodeWithApns("ios-node-clear-wake")).resolves.toMatchObject({
      path: "throttled",
      throttled: true,
    });
    await expect(maybeSendNodeWakeNudge("ios-node-clear-wake")).resolves.toMatchObject({
      sent: false,
      throttled: true,
    });

    clearNodeWakeState("ios-node-clear-wake");

    await expect(maybeWakeNodeWithApns("ios-node-clear-wake")).resolves.toMatchObject({
      path: "sent",
      throttled: false,
    });
    await expect(maybeSendNodeWakeNudge("ios-node-clear-wake")).resolves.toMatchObject({
      sent: true,
      throttled: false,
    });
    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsAlert).toHaveBeenCalledTimes(2);
  });

  it("wakes and retries invoke after the node reconnects", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-reconnect");

    let connected = false;
    const session: TestNodeSession = { nodeId: "ios-node-reconnect", commands: ["camera.capture"] };
    const nodeRegistry = {
      get: vi.fn((nodeId: string) => {
        if (nodeId !== "ios-node-reconnect") {
          return undefined;
        }
        return connected ? session : undefined;
      }),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payload: { ok: true },
        payloadJSON: '{"ok":true}',
      }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-reconnect", idempotencyKey: "idem-reconnect" },
    });
    setTimeout(() => {
      connected = true;
    }, 300);

    await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
    const respond = await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node-reconnect",
        command: "camera.capture",
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, nodeId: "ios-node-reconnect" });
  });

  it("clears stale registrations after an invalid device token wake failure", async () => {
    const registration = directRegistration("ios-node-stale");
    mocks.loadApnsRegistration.mockResolvedValue(registration);
    mockDirectWakeConfig("ios-node-stale", {
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(true);
    const wake = await maybeWakeNodeWithApns("ios-node-stale", { force: true });

    expect(wake).toMatchObject({
      available: true,
      throttled: false,
      path: "send-error",
      apnsReason: "BadDeviceToken",
      apnsStatus: 400,
    });
    expect(mocks.clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
      nodeId: "ios-node-stale",
      registration,
    });
  });

  it("does not clear relay registrations from wake failures", async () => {
    const registration = relayRegistration("ios-node-relay");
    mockRelayWakeConfig("ios-node-relay", {
      ok: false,
      status: 410,
      reason: "Unregistered",
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
    const wake = await maybeWakeNodeWithApns("ios-node-relay", { force: true });

    expect(wake).toMatchObject({
      available: true,
      throttled: false,
      path: "send-error",
      apnsReason: "Unregistered",
      apnsStatus: 410,
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(process.env, {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    });
    expect(mocks.shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration,
      result: {
        ok: false,
        status: 410,
        reason: "Unregistered",
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      },
    });
    expect(mocks.clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });

  it("forces one retry wake when the first wake still fails to reconnect", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-throttle");

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-throttle", idempotencyKey: "idem-throttle-1" },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("queues iOS foreground-only command failures and keeps them until acked", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-queued",
        commands: ["canvas.navigate"],
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-queued",
        command: "canvas.navigate",
        params: { url: "http://example.com/" },
        idempotencyKey: "idem-queued",
      },
    });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("node command queued until iOS returns to foreground");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();

    const pullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/" }),
        }),
      ],
    });

    const repeatedPullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const repeatedPullCall = repeatedPullRespond.mock.calls[0] as RespondCall | undefined;
    expect(repeatedPullCall?.[0]).toBe(true);
    expect(repeatedPullCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/" }),
        }),
      ],
    });

    const queuedActionId = (pullCall?.[1] as { actions?: Array<{ id?: string }> } | undefined)
      ?.actions?.[0]?.id;
    expect(queuedActionId).toBeTruthy();

    const ackRespond = await ackPending("ios-node-queued", [queuedActionId!], ["canvas.navigate"]);
    const ackCall = ackRespond.mock.calls[0] as RespondCall | undefined;
    expect(ackCall?.[0]).toBe(true);
    expect(ackCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      ackedIds: [queuedActionId],
      remainingCount: 0,
    });

    const emptyPullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const emptyPullCall = emptyPullRespond.mock.calls[0] as RespondCall | undefined;
    expect(emptyPullCall?.[0]).toBe(true);
    expect(emptyPullCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      actions: [],
    });
  });

  it("drops queued actions that are no longer allowed at pull time", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);
    const allowlistedCommands = new Set(["camera.snap", "canvas.navigate"]);
    mocks.resolveNodeCommandAllowlist.mockImplementation(() => new Set(allowlistedCommands));
    mocks.isNodeCommandAllowed.mockImplementation(
      ({ command, declaredCommands, allowlist }: MockNodeCommandPolicyParams) => {
        if (!allowlist.has(command)) {
          return { ok: false, reason: "command not allowlisted" };
        }
        if (!declaredCommands?.includes(command)) {
          return { ok: false, reason: "command not declared by node" };
        }
        return { ok: true };
      },
    );

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-policy",
        commands: ["camera.snap", "canvas.navigate"],
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-policy",
        command: "camera.snap",
        params: { facing: "front" },
        idempotencyKey: "idem-policy",
      },
    });

    const preChangePullRespond = await pullPending("ios-node-policy", [
      "camera.snap",
      "canvas.navigate",
    ]);
    const preChangePullCall = preChangePullRespond.mock.calls[0] as RespondCall | undefined;
    expect(preChangePullCall?.[0]).toBe(true);
    expect(preChangePullCall?.[1]).toMatchObject({
      nodeId: "ios-node-policy",
      actions: [
        expect.objectContaining({
          command: "camera.snap",
          paramsJSON: JSON.stringify({ facing: "front" }),
        }),
      ],
    });

    allowlistedCommands.delete("camera.snap");

    const pullRespond = await pullPending("ios-node-policy", ["camera.snap", "canvas.navigate"]);
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      nodeId: "ios-node-policy",
      actions: [],
    });
  });

  it("dedupes queued foreground actions by idempotency key", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-dedupe",
        commands: ["canvas.navigate"],
        platform: "iPadOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-dedupe",
        command: "canvas.navigate",
        params: { url: "http://example.com/first" },
        idempotencyKey: "idem-dedupe",
      },
    });
    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-dedupe",
        command: "canvas.navigate",
        params: { url: "http://example.com/first" },
        idempotencyKey: "idem-dedupe",
      },
    });

    const pullRespond = await pullPending("ios-node-dedupe", ["canvas.navigate"]);
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      nodeId: "ios-node-dedupe",
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/first" }),
        }),
      ],
    });
    const actions = (pullCall?.[1] as { actions?: unknown[] } | undefined)?.actions ?? [];
    expect(actions).toHaveLength(1);
  });
});
