import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type StrictInlineEvalBoundary =
  typeof import("./bash-tools.exec-host-shared.js").enforceStrictInlineEvalApprovalBoundary;

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const preparedPlan = vi.hoisted(() => ({
  argv: ["bun", "./script.ts"],
  cwd: "/tmp/work",
  commandText: "bun ./script.ts",
  commandPreview: "bun ./script.ts",
  agentId: "prepared-agent",
  sessionKey: "prepared-session",
  mutableFileOperand: {
    argvIndex: 1,
    path: "/tmp/work/script.ts",
    sha256: "abc123",
  },
}));

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const parsePreparedSystemRunPayloadMock = vi.hoisted(() => vi.fn());
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "full",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null | undefined> => "allow-once"),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    }),
  ),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() => vi.fn(async () => undefined));
const enforceStrictInlineEvalApprovalBoundaryMock = vi.hoisted(() =>
  vi.fn<StrictInlineEvalBoundary>((value) => ({
    approvedByAsk: value.approvedByAsk,
    deniedReason: value.deniedReason,
  })),
);
const registerExecApprovalRequestForHostOrThrowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn(
    (): {
      executable: string;
      normalizedExecutable: string;
      flag: string;
      argv: string[];
    } | null => null,
  ),
);

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: false,
    segments: [{ resolution: null, argv: ["bun", "./script.ts"] }],
    segmentAllowlistEntries: [],
  })),
  hasDurableExecApproval: vi.fn(() => false),
  requiresExecApproval: requiresExecApprovalMock,
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  resolveExecApprovalsFromFile: vi.fn(() => ({
    allowlist: [],
    file: { version: 1, agents: {} },
  })),
}));

vi.mock("../infra/exec-inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "inline-eval"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

vi.mock("../infra/node-shell.js", () => ({
  buildNodeShellCommand: vi.fn(() => ["bash", "-lc", "bun ./script.ts"]),
}));

vi.mock("../infra/system-run-approval-context.js", () => ({
  parsePreparedSystemRunPayload: parsePreparedSystemRunPayloadMock,
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostOrThrowMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
  buildExecApprovalFollowupTarget: vi.fn(() => ({ approvalId: "approval-1" })),
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value: string) => value),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: vi.fn(() => "node-1"),
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

let executeNodeHostCommand: typeof import("./bash-tools.exec-host-node.js").executeNodeHostCommand;

type MockNodeInvokeParams = {
  command?: string;
};

function createGatewayNodeInvokeTimeoutError(): Error & {
  gatewayCode: string;
  details: { nodeError: { code: string; message: string } };
} {
  return Object.assign(new Error("UNAVAILABLE: TIMEOUT: node invoke timed out"), {
    gatewayCode: "UNAVAILABLE",
    details: {
      nodeError: {
        code: "TIMEOUT",
        message: "node invoke timed out",
      },
    },
  });
}

function createQueuedUntilForegroundError(): Error & {
  code: string;
  details: { code: string; retryable: boolean };
} {
  return Object.assign(
    new Error("UNAVAILABLE: node command queued until iOS returns to foreground"),
    {
      code: "UNAVAILABLE",
      details: {
        code: "QUEUED_UNTIL_FOREGROUND",
        retryable: true,
      },
    },
  );
}

function createSystemRunDeniedError(message = "approval required"): Error & {
  code: string;
  details: { nodeError: { code: string; message: string } };
} {
  return Object.assign(new Error(`UNAVAILABLE: SYSTEM_RUN_DENIED: ${message}`), {
    code: "UNAVAILABLE",
    details: {
      nodeError: {
        code: "UNAVAILABLE",
        message: `SYSTEM_RUN_DENIED: ${message}`,
      },
    },
  });
}

function createNodeNotConnectedError(): Error & {
  code: string;
  message: string;
} {
  return Object.assign(new Error("node not connected"), {
    code: "UNAVAILABLE",
    message: "node not connected",
  });
}

describe("executeNodeHostCommand", () => {
  beforeAll(async () => {
    ({ executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js"));
  });

  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      { nodeId: "node-1", commands: ["system.run"], platform: process.platform },
    ]);
    parsePreparedSystemRunPayloadMock.mockReset();
    parsePreparedSystemRunPayloadMock.mockReturnValue({ plan: preparedPlan });
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(true);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockImplementation(async (args?: unknown) => {
      const register =
        args && typeof args === "object" && "register" in args
          ? (args as { register?: (approvalId: string) => Promise<void> }).register
          : undefined;
      await register?.("approval-1");
      return {
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        warningText: "",
        expiresAtMs: Date.now() + 60_000,
        preResolvedDecision: null,
        initiatingSurface: "origin",
        sentApproverDms: false,
        unavailableReason: null,
      };
    });
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    });
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) => ({
      approvedByAsk: value.approvedByAsk,
      deniedReason: value.deniedReason,
    }));
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    registerExecApprovalRequestForHostOrThrowMock.mockReset();
  });

  it("forwards prepared systemRunPlan on async node invoke after approval", async () => {
    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemRunPlan: preparedPlan,
      }),
    );

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        command: "system.run",
        params: expect.objectContaining({
          approved: true,
          approvalDecision: "allow-once",
          systemRunPlan: preparedPlan,
        }),
      }),
    );
    const asyncInvokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: {
        suppressNotifyOnExit?: boolean;
        deliveryContext?: unknown;
      };
    };
    expect(asyncInvokeParams.params?.suppressNotifyOnExit).toBeUndefined();
    expect(asyncInvokeParams.params?.deliveryContext).toBeUndefined();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("sends a direct completion followup for silent async node successes when notifyOnExit is disabled", async () => {
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      notifyOnExit: false,
    });

    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec finished (node=node-1 id=approval-1, code 0)",
      );
    });
  });

  it("sends a direct completion followup when deferred node delivery failed", async () => {
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              notifyDeliveryFailed: true,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
    });

    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec finished (node=node-1 id=approval-1, code 0)\nok",
      );
    });
  });

  it("keeps inline node invokes on the direct reply path while preserving exec.finished fallback", async () => {
    requiresExecApprovalMock.mockReturnValue(false);

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        command: "system.run",
      }),
    );
    const asyncInvokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: {
        suppressNotifyOnExit?: boolean;
        deliveryContext?: unknown;
      };
    };
    expect(asyncInvokeParams.params?.suppressNotifyOnExit).toBeUndefined();
    expect(asyncInvokeParams.params?.deliveryContext).toBeUndefined();
  });

  it("reports a non-terminal timeout when the async node invoke times out", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw new Error("gateway timeout after 35000ms");
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
      { approvalId: "approval-1" },
      expect.stringContaining("Exec pending (node=node-1 id=approval-1, gateway-timeout)"),
    );
    const invokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: {
        suppressNotifyOnExit?: boolean;
        deliveryContext?: {
          channel: string;
          to: string;
          accountId: string;
          threadId: number;
        };
      };
    };
    expect(invokeParams.params?.suppressNotifyOnExit).toBeUndefined();
    expect(invokeParams.params?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: 47,
    });
  });

  it("reports a non-terminal timeout when the gateway forwards a node TIMEOUT error", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw createGatewayNodeInvokeTimeoutError();
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
      { approvalId: "approval-1" },
      expect.stringContaining("Exec pending (node=node-1 id=approval-1, gateway-timeout)"),
    );
    const invokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: {
        suppressNotifyOnExit?: boolean;
        deliveryContext?: {
          channel: string;
          to: string;
          accountId: string;
          threadId: number;
        };
      };
    };
    expect(invokeParams.params?.suppressNotifyOnExit).toBeUndefined();
    expect(invokeParams.params?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: 47,
    });
  });

  it("keeps queued async node invokes pending until the deferred completion arrives", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw createQueuedUntilForegroundError();
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
      { approvalId: "approval-1" },
      expect.stringContaining("Exec pending (node=node-1 id=approval-1, invoke-unconfirmed)"),
    );
    const invokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: {
        suppressNotifyOnExit?: boolean;
        deliveryContext?: {
          channel: string;
          to: string;
          accountId: string;
          threadId: number;
        };
      };
    };
    expect(invokeParams.params?.suppressNotifyOnExit).toBeUndefined();
    expect(invokeParams.params?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "primary",
      threadId: 47,
    });
  });

  it("reports explicit system.run denials directly on the normal notifyOnExit path", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw createSystemRunDeniedError();
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
      { approvalId: "approval-1" },
      "Exec denied (node=node-1 id=approval-1, approval-required): bun ./script.ts",
    );
  });

  it("reports explicit system.run denials directly when notifyOnExit is disabled", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw createSystemRunDeniedError();
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      notifyOnExit: false,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-required): bun ./script.ts",
      );
    });
    const invokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: { suppressNotifyOnExit?: boolean };
    };
    expect(invokeParams.params?.suppressNotifyOnExit).toBe(true);
  });

  it("preserves specific post-approval deny reasons for async node invokes", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw createSystemRunDeniedError("approval cwd changed before execution");
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      notifyOnExit: false,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval cwd changed before execution): bun ./script.ts",
      );
    });
  });

  it("reports concrete dispatch failures immediately when no deferred result will arrive", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _options: unknown, params) => {
      if (method !== "node.invoke") {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      if (params?.command === "system.run.prepare") {
        return { payload: { plan: preparedPlan } };
      }
      if (params?.command === "system.run") {
        throw createNodeNotConnectedError();
      }
      throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
    });

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, invoke-failed): bun ./script.ts\nnode not connected",
      );
    });
  });

  it("keeps inline node invokes direct even when notifyOnExit is disabled", async () => {
    requiresExecApprovalMock.mockReturnValue(false);

    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      sessionKey: "requested-session",
      notifyOnExit: false,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "primary",
      turnSourceThreadId: 47,
    });

    expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        command: "system.run",
      }),
    );
    const syncInvokeParams = callGatewayToolMock.mock.calls[1]?.[2] as {
      params?: {
        suppressNotifyOnExit?: boolean;
        deliveryContext?: {
          channel: string;
          to: string;
          accountId: string;
          threadId: number;
        };
      };
    };
    expect(syncInvokeParams.params?.suppressNotifyOnExit).toBe(true);
    expect(syncInvokeParams.params?.deliveryContext).toBeUndefined();
  });

  it("denies timed-out inline-eval requests instead of invoking the node", async () => {
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "full",
    });

    const result = await executeNodeHostCommand({
      command: "python3 -c 'print(1)'",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      strictInlineEval: true,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });
});
