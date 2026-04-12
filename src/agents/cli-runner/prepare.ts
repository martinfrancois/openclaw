import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import { resolveAgentMainSessionKey, resolveMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveGatewayScopedTools } from "../../gateway/tool-resolution.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  analyzeBootstrapBudget,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../pi-embedded-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveSkillsPromptForRun } from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { CLI_BUNDLED_PROMPT_TOOL_NAMES, CLI_NATIVE_PROMPT_TOOL_NAMES } from "../tool-catalog.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  buildCliSystemPromptReportToolsFromPrompt,
  buildSystemPrompt,
  normalizeCliModel,
  resolveCliSystemPromptToolNames,
} from "./helpers.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  resolveGatewayScopedTools,
  resolveOpenClawDocsPath: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawDocsPath>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawDocsPath(params),
};

export function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

function resolveCliLoopbackSessionKey(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const explicitSessionKey = params.sessionKey?.trim();
  if (explicitSessionKey) {
    const normalizedExplicitSessionKey = normalizeMainKey(explicitSessionKey);
    if (
      params.config &&
      (normalizedExplicitSessionKey === "main" ||
        normalizedExplicitSessionKey === normalizeMainKey(params.config.session?.mainKey))
    ) {
      return resolveMainSessionKey(params.config);
    }
    return explicitSessionKey;
  }
  if (!params.config) {
    return params.agentId
      ? resolveAgentMainSessionKey({
          cfg: params.config,
          agentId: params.agentId,
        })
      : undefined;
  }
  return params.config.session?.scope === "global"
    ? resolveMainSessionKey(params.config)
    : params.agentId
      ? resolveAgentMainSessionKey({
          cfg: params.config,
          agentId: params.agentId,
        })
      : resolveMainSessionKey(params.config);
}

function resolveCliPromptToolNames(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  messageProvider?: string;
  accountId?: string;
  senderIsOwner?: boolean;
  bundleMcp: boolean;
  loopbackRuntimeActive: boolean;
}): string[] {
  if (!params.bundleMcp || !params.loopbackRuntimeActive) {
    return [...CLI_NATIVE_PROMPT_TOOL_NAMES];
  }
  if (!params.config) {
    return [...CLI_BUNDLED_PROMPT_TOOL_NAMES];
  }
  const sessionKey = resolveCliLoopbackSessionKey(params);
  if (!sessionKey) {
    return [...CLI_BUNDLED_PROMPT_TOOL_NAMES];
  }
  const loopbackToolNames = prepareDeps
    .resolveGatewayScopedTools({
      cfg: params.config,
      sessionKey,
      messageProvider: params.messageProvider,
      accountId: params.accountId,
      senderIsOwner: params.senderIsOwner,
      surface: "loopback",
      excludeToolNames: CLI_NATIVE_PROMPT_TOOL_NAMES,
    })
    .tools.map((tool) => tool.name);
  return resolveCliSystemPromptToolNames({
    tools: [],
    fallbackToolNames: [...CLI_NATIVE_PROMPT_TOOL_NAMES, ...loopbackToolNames],
  });
}

export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    cliBackendLog.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const authEpoch = await resolveCliAuthEpoch({
    provider: params.provider,
    authProfileId: params.authProfileId,
  });
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const extraSystemPromptHash = hashCliSessionText(extraSystemPrompt);
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
  const modelDisplay = `${params.provider}/${modelId}`;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: prepareDeps.makeBootstrapWarn({
      sessionLabel,
      warn: (message) => cliBackendLog.warn(message),
    }),
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const cliLoopbackSessionKey = resolveCliLoopbackSessionKey({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: sessionAgentId,
  });
  let mcpLoopbackRuntime = backendResolved.bundleMcp
    ? prepareDeps.getActiveMcpLoopbackRuntime()
    : undefined;
  if (backendResolved.bundleMcp && !mcpLoopbackRuntime) {
    try {
      await prepareDeps.ensureMcpLoopbackServer();
    } catch (error) {
      cliBackendLog.warn(`mcp loopback server failed to start: ${String(error)}`);
    }
    mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
  }
  const preparedBackend = await prepareCliBundleMcpConfig({
    enabled: backendResolved.bundleMcp,
    mode: backendResolved.bundleMcpMode,
    backend: backendResolved.config,
    workspaceDir,
    config: params.config,
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    env: mcpLoopbackRuntime
      ? {
          OPENCLAW_MCP_TOKEN: mcpLoopbackRuntime.token,
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_SESSION_KEY: cliLoopbackSessionKey ?? "",
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageProvider ?? "",
          OPENCLAW_MCP_SENDER_IS_OWNER: params.senderIsOwner === true ? "true" : "false",
        }
      : undefined,
    warn: (message) => cliBackendLog.warn(message),
  });
  const reusableCliSession = params.cliSessionBinding
    ? resolveCliSessionReuse({
        binding: params.cliSessionBinding,
        authProfileId: params.authProfileId,
        authEpoch,
        extraSystemPromptHash,
        mcpConfigHash: preparedBackend.mcpConfigHash,
      })
    : params.cliSessionId
      ? { sessionId: params.cliSessionId }
      : {};
  if (reusableCliSession.invalidatedReason) {
    cliBackendLog.info(
      `cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}`,
    );
  }
  const heartbeatPrompt = resolveHeartbeatPromptForSystemPrompt({
    config: params.config,
    agentId: sessionAgentId,
    defaultAgentId,
  });
  const promptToolNames = resolveCliPromptToolNames({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: sessionAgentId,
    messageProvider: params.messageProvider,
    accountId: params.agentAccountId,
    senderIsOwner: params.senderIsOwner,
    bundleMcp: backendResolved.bundleMcp,
    loopbackRuntimeActive: Boolean(mcpLoopbackRuntime),
  });
  const docsPath = await prepareDeps.resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir,
    config: params.config,
    agentId: sessionAgentId,
  });
  const builtSystemPrompt =
    resolveSystemPromptOverride({
      config: params.config,
      agentId: sessionAgentId,
    }) ??
    buildSystemPrompt({
      workspaceDir,
      config: params.config,
      defaultThinkLevel: params.thinkLevel,
      extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      heartbeatPrompt,
      docsPath: docsPath ?? undefined,
      skillsPrompt,
      tools: [],
      toolNames: promptToolNames,
      bundleMcp: backendResolved.bundleMcp,
      contextFiles,
      modelDisplay,
      agentId: sessionAgentId,
    });
  const transformedSystemPrompt =
    backendResolved.transformSystemPrompt?.({
      config: params.config,
      workspaceDir,
      provider: params.provider,
      modelId,
      modelDisplay,
      agentId: sessionAgentId,
      systemPrompt: builtSystemPrompt,
    }) ?? builtSystemPrompt;
  const systemPrompt = applyPluginTextReplacements(
    transformedSystemPrompt,
    backendResolved.textTransforms?.input,
  );
  const { tools: reportTools, toolListPromptText } = buildCliSystemPromptReportToolsFromPrompt({
    tools: [],
    systemPrompt,
  });
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: modelId,
    workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warningMode: bootstrapPromptWarningMode,
      warning: bootstrapPromptWarning,
    }),
    sandbox: { mode: "off", sandboxed: false },
    systemPrompt,
    bootstrapFiles,
    injectedFiles: contextFiles,
    skillsPrompt,
    tools: reportTools,
    toolListPromptText,
  });

  return {
    params,
    started,
    workspaceDir,
    backendResolved,
    preparedBackend,
    reusableCliSession,
    modelId,
    normalizedModel,
    systemPrompt,
    systemPromptReport,
    bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
    heartbeatPrompt,
    authEpoch,
    extraSystemPromptHash,
  };
}
