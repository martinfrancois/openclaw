import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import { type ExecHost, loadExecApprovals, maxAsk, minSecurity } from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { SafeOpenError, readFileWithinRoot } from "../infra/fs-safe.js";
import { sanitizeHostExecEnvWithDiagnostics } from "../infra/host-env-security.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  type ExecProcessOutcome,
  applyPathPrepend,
  applyShellPath,
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
  normalizePathPrepend,
  resolveExecTarget,
  resolveApprovalRunningNoticeMs,
  runExecProcess,
  execSchema,
} from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import { type AgentToolWithMeta, failedTextResult, textResult } from "./tools/common.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  if (params.outcome.status === "failed") {
    return failedTextResult(`${warningText}${params.outcome.reason}`, {
      status: "failed",
      exitCode: params.outcome.exitCode ?? null,
      durationMs: params.outcome.durationMs,
      aggregated: params.outcome.aggregated,
      timedOut: params.outcome.timedOut,
      cwd: params.cwd,
    });
  }
  return textResult(`${warningText}${params.outcome.aggregated || "(no output)"}`, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
    cwd: params.cwd,
  });
}

const PREFLIGHT_ENV_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);

const SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "EINVAL",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code);
}

function shouldSkipScriptPreflightPathError(error: unknown): boolean {
  if (error instanceof SafeOpenError) {
    return true;
  }
  const errorCode = getNodeErrorCode(error);
  return !!(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}

function resolvePreflightRelativePath(params: { rootDir: string; absPath: string }): string | null {
  const root = path.resolve(params.rootDir);
  const candidate = path.resolve(params.absPath);
  const relative = path.relative(root, candidate);
  if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) {
    return null;
  }
  // Preserve literal "~" path segments under the workdir. `readFileWithinRoot`
  // expands home prefixes for relative paths, so normalize `~/...` to `./~/...`.
  return /^~(?:$|[\\/])/u.test(relative) ? `.${path.sep}${relative}` : relative;
}

function isShellEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function isEnvExecutableToken(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const base = normalizeOptionalLowercaseString(token.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedBase = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return normalizedBase === "env";
}

function stripPreflightEnvPrefix(argv: string[]): string[] {
  if (argv.length === 0) {
    return argv;
  }
  let idx = 0;
  while (idx < argv.length && isShellEnvAssignmentToken(argv[idx])) {
    idx += 1;
  }
  if (!isEnvExecutableToken(argv[idx])) {
    return argv;
  }
  idx += 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (token === "--") {
      idx += 1;
      break;
    }
    if (isShellEnvAssignmentToken(token)) {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
    const option = token.split("=", 1)[0];
    if (
      PREFLIGHT_ENV_OPTIONS_WITH_VALUES.has(option) &&
      !token.includes("=") &&
      idx < argv.length
    ) {
      idx += 1;
    }
  }
  return argv.slice(idx);
}

function findFirstPythonScriptArg(tokens: string[]): string | null {
  const optionsWithSeparateValue = new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      const next = tokens[i + 1];
      return normalizeLowercaseStringOrEmpty(next).endsWith(".py") ? next : null;
    }
    if (token === "-") {
      return null;
    }
    if (token === "-c" || token === "-m") {
      return null;
    }
    if ((token.startsWith("-c") || token.startsWith("-m")) && token.length > 2) {
      return null;
    }
    if (optionsWithSeparateValue.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return normalizeLowercaseStringOrEmpty(token).endsWith(".py") ? token : null;
  }
  return null;
}

function findNodeScriptArgs(tokens: string[]): string[] {
  const optionsWithSeparateValue = new Set(["-r", "--require", "--import"]);
  const preloadScripts: string[] = [];
  let entryScript: string | null = null;
  let hasInlineEvalOrPrint = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      if (!hasInlineEvalOrPrint && !entryScript) {
        const next = tokens[i + 1];
        if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
          entryScript = next;
        }
      }
      break;
    }
    if (
      token === "-e" ||
      token === "-p" ||
      token === "--eval" ||
      token === "--print" ||
      token.startsWith("--eval=") ||
      token.startsWith("--print=") ||
      ((token.startsWith("-e") || token.startsWith("-p")) && token.length > 2)
    ) {
      hasInlineEvalOrPrint = true;
      if (token === "-e" || token === "-p" || token === "--eval" || token === "--print") {
        i += 1;
      }
      continue;
    }
    if (optionsWithSeparateValue.has(token)) {
      const next = tokens[i + 1];
      if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
        preloadScripts.push(next);
      }
      i += 1;
      continue;
    }
    if (
      (token.startsWith("-r") && token.length > 2) ||
      token.startsWith("--require=") ||
      token.startsWith("--import=")
    ) {
      const inlineValue = token.startsWith("-r")
        ? token.slice(2)
        : token.slice(token.indexOf("=") + 1);
      if (normalizeLowercaseStringOrEmpty(inlineValue).endsWith(".js")) {
        preloadScripts.push(inlineValue);
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (
      !hasInlineEvalOrPrint &&
      !entryScript &&
      normalizeLowercaseStringOrEmpty(token).endsWith(".js")
    ) {
      entryScript = token;
    }
    break;
  }
  const targets = [...preloadScripts];
  if (entryScript) {
    targets.push(entryScript);
  }
  return targets;
}

function extractInterpreterScriptTargetFromArgv(
  argv: string[] | null,
): { kind: "python"; relOrAbsPaths: string[] } | { kind: "node"; relOrAbsPaths: string[] } | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  let commandIdx = 0;
  while (commandIdx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx])) {
    commandIdx += 1;
  }
  const executable = normalizeOptionalLowercaseString(argv[commandIdx]);
  if (!executable) {
    return null;
  }
  const args = argv.slice(commandIdx + 1);
  if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
    const script = findFirstPythonScriptArg(args);
    if (script) {
      return { kind: "python", relOrAbsPaths: [script] };
    }
    return null;
  }
  if (executable === "node") {
    const scripts = findNodeScriptArgs(args);
    if (scripts.length > 0) {
      return { kind: "node", relOrAbsPaths: scripts };
    }
    return null;
  }
  return null;
}

function extractInterpreterScriptPathsFromSegment(rawSegment: string): string[] {
  const argv = splitShellArgs(rawSegment.trim());
  if (!argv || argv.length === 0) {
    return [];
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  const target = extractInterpreterScriptTargetFromArgv(
    stripPreflightEnvPrefix(withoutLeadingKeyword),
  );
  return target?.relOrAbsPaths ?? [];
}

function extractScriptTargetFromCommand(
  command: string,
): { kind: "python"; relOrAbsPaths: string[] } | { kind: "node"; relOrAbsPaths: string[] } | null {
  const raw = command.trim();
  const splitShellArgsPreservingBackslashes = (value: string): string[] | null => {
    const tokens: string[] = [];
    let buf = "";
    let inSingle = false;
    let inDouble = false;

    const pushToken = () => {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
    };

    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (/\s/.test(ch)) {
        pushToken();
        continue;
      }
      buf += ch;
    }

    if (inSingle || inDouble) {
      return null;
    }
    pushToken();
    return tokens;
  };
  const shouldUseWindowsPathTokenizer =
    process.platform === "win32" &&
    /(?:^|[\s"'`])(?:[A-Za-z]:\\|\\\\|[^\s"'`|&;()<>]+\\[^\s"'`|&;()<>]+)/.test(raw);
  const candidateArgv = shouldUseWindowsPathTokenizer
    ? [splitShellArgsPreservingBackslashes(raw)]
    : [splitShellArgs(raw)];

  for (const argv of candidateArgv) {
    const attempts = [argv, argv ? stripPreflightEnvPrefix(argv) : null];
    for (const attempt of attempts) {
      const target = extractInterpreterScriptTargetFromArgv(attempt);
      if (target) {
        return target;
      }
    }
  }
  return null;
}

function extractUnquotedShellText(raw: string): string | null {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      if (!inSingle && !inDouble) {
        // Preserve escapes outside quotes so downstream heuristics can distinguish
        // escaped literals (e.g. `\|`) from executable shell operators.
        out += `\\${ch}`;
      }
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      if (ch === "\\" && next && /[\\'"$`\n\r]/.test(next)) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    out += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  return out;
}

function splitShellSegmentsOutsideQuotes(
  rawText: string,
  params: { splitPipes: boolean },
): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushSegment = () => {
    if (buf.trim().length > 0) {
      segments.push(buf);
    }
    buf = "";
  };

  for (let i = 0; i < rawText.length; i += 1) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }

    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      buf += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      pushSegment();
      continue;
    }
    if (ch === ";") {
      pushSegment();
      continue;
    }
    if (ch === "&" && next === "&") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      pushSegment();
      i += 1;
      continue;
    }
    if (params.splitPipes && ch === "|") {
      pushSegment();
      continue;
    }

    buf += ch;
  }
  pushSegment();
  return segments;
}

function findShellCommandSubstitutionEnd(source: string, startIndex: number): number | null {
  if (
    source[startIndex] !== "$" ||
    source[startIndex + 1] !== "(" ||
    source[startIndex + 2] === "("
  ) {
    return null;
  }

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let arithmeticDepth = 0;
  let parameterExpansionDepth = 0;
  let commandSubstitutionDepth = 1;

  for (let i = startIndex + 2; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    const nextNext = source[i + 2];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }

    if (arithmeticDepth > 0) {
      if ((ch === "$" && next === "(" && nextNext === "(") || (ch === "(" && next === "(")) {
        arithmeticDepth += 1;
        if (ch === "$") {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === ")" && next === ")") {
        arithmeticDepth = Math.max(0, arithmeticDepth - 1);
        i += 1;
      }
      continue;
    }

    if (parameterExpansionDepth > 0) {
      if (ch === "\\" && next) {
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        parameterExpansionDepth += 1;
        i += 1;
        continue;
      }
      if (ch === "}") {
        parameterExpansionDepth = Math.max(0, parameterExpansionDepth - 1);
      }
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      if (ch === "$" && next === "(") {
        if (nextNext === "(") {
          arithmeticDepth += 1;
          i += 2;
        } else {
          commandSubstitutionDepth += 1;
          i += 1;
        }
        continue;
      }
      if (ch === "$" && next === "{") {
        parameterExpansionDepth += 1;
        i += 1;
        continue;
      }
      if (ch === ")") {
        commandSubstitutionDepth -= 1;
        if (commandSubstitutionDepth === 0) {
          return i;
        }
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if ((ch === "$" && next === "(" && nextNext === "(") || (ch === "(" && next === "(")) {
      arithmeticDepth += 1;
      if (ch === "$") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "$" && next === "{") {
      parameterExpansionDepth += 1;
      i += 1;
      continue;
    }

    if (ch === "$" && next === "(") {
      commandSubstitutionDepth += 1;
      i += 1;
      continue;
    }

    if (ch === ")") {
      commandSubstitutionDepth -= 1;
      if (commandSubstitutionDepth === 0) {
        return i;
      }
    }
  }

  return null;
}

function findBacktickCommandSubstitutionEnd(source: string, startIndex: number): number | null {
  if (source[startIndex] !== "`") {
    return null;
  }

  let escaped = false;
  for (let i = startIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") {
      return i;
    }
  }
  return null;
}

const SHELL_FUNCTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function findShellFunctionDefinitionBodyStart(
  source: string,
  startIndex: number,
  candidateName: string | null | undefined,
): number | null {
  if (
    source[startIndex] !== "(" ||
    !candidateName ||
    !SHELL_FUNCTION_NAME_PATTERN.test(candidateName)
  ) {
    return null;
  }

  let i = startIndex + 1;
  while (i < source.length && /\s/u.test(source[i] ?? "")) {
    i += 1;
  }
  if (source[i] !== ")") {
    return null;
  }

  i += 1;
  while (i < source.length && /\s/u.test(source[i] ?? "")) {
    i += 1;
  }
  return source[i] === "{" ? i : null;
}

function findShellBraceGroupEnd(source: string, startIndex: number): number | null {
  if (source[startIndex] !== "{") {
    return null;
  }

  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let escaped = false;
  let arithmeticDepth = 0;
  let parameterExpansionDepth = 0;
  let braceDepth = 1;

  for (let i = startIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    const nextNext = source[i + 2];

    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }

    if (arithmeticDepth > 0) {
      if ((ch === "$" && next === "(" && nextNext === "(") || (ch === "(" && next === "(")) {
        arithmeticDepth += 1;
        if (ch === "$") {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === ")" && next === ")") {
        arithmeticDepth = Math.max(0, arithmeticDepth - 1);
        i += 1;
      }
      continue;
    }

    if (parameterExpansionDepth > 0) {
      if (ch === "\\" && next) {
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        parameterExpansionDepth += 1;
        i += 1;
        continue;
      }
      if (ch === "}") {
        parameterExpansionDepth = Math.max(0, parameterExpansionDepth - 1);
      }
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      if (ch === "$" && next === "(") {
        if (nextNext === "(") {
          arithmeticDepth += 1;
          i += 2;
        } else {
          const substitutionEnd = findShellCommandSubstitutionEnd(source, i);
          if (substitutionEnd !== null) {
            i = substitutionEnd;
          }
        }
        continue;
      }
      if (ch === "$" && next === "{") {
        parameterExpansionDepth += 1;
        i += 1;
        continue;
      }
      if (ch === "`") {
        const substitutionEnd = findBacktickCommandSubstitutionEnd(source, i);
        if (substitutionEnd !== null) {
          i = substitutionEnd;
        }
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (isShellCommentStart(source, i)) {
      inComment = true;
      continue;
    }

    if (ch === "$" && next === "(" && nextNext !== "(") {
      const substitutionEnd = findShellCommandSubstitutionEnd(source, i);
      if (substitutionEnd !== null) {
        i = substitutionEnd;
        continue;
      }
    }

    if (ch === "`") {
      const substitutionEnd = findBacktickCommandSubstitutionEnd(source, i);
      if (substitutionEnd !== null) {
        i = substitutionEnd;
        continue;
      }
    }

    if ((ch === "$" && next === "(" && nextNext === "(") || (ch === "(" && next === "(")) {
      arithmeticDepth += 1;
      if (ch === "$") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "$" && next === "{") {
      parameterExpansionDepth += 1;
      i += 1;
      continue;
    }

    if (ch === "{") {
      braceDepth += 1;
      continue;
    }

    if (ch === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return i;
      }
    }
  }

  return null;
}

function resolveCapturedBackgroundPidVariableName(value: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+)?=(.*)$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  return match[2] === "$!" ? match[1] : null;
}

function resolveAssignedShellVariableName(value: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+)?=.*$/u.exec(value.trim());
  return match?.[1] ?? null;
}

function resolveAssignedCapturedBackgroundPidCount(
  value: string,
  capturedBackgroundPidCounts: ReadonlyMap<string, number>,
): { append: boolean; name: string; count: number } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+)?=(.*)$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, name, appendOperator, rhs] = match;
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < rhs.length; i += 1) {
    const ch = rhs[i];
    if (!ch) {
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || ch !== "$") {
      continue;
    }
    const next = rhs[i + 1];
    if (next === "!") {
      count += 1;
      i += 1;
      continue;
    }
    if (next === "{") {
      const end = rhs.indexOf("}", i + 2);
      if (end > i + 2) {
        const varName = rhs.slice(i + 2, end);
        count += capturedBackgroundPidCounts.get(varName) ?? 0;
        i = end;
      }
      continue;
    }
    if (!next || !/[A-Za-z_]/u.test(next)) {
      continue;
    }
    let end = i + 2;
    while (end < rhs.length && /[A-Za-z0-9_]/u.test(rhs[end] ?? "")) {
      end += 1;
    }
    const varName = rhs.slice(i + 1, end);
    count += capturedBackgroundPidCounts.get(varName) ?? 0;
    i = end - 1;
  }
  return { append: appendOperator === "+", name, count };
}

function findShellArrayAssignmentEnd(source: string, startIndex: number): number | null {
  if (source[startIndex] !== "(") {
    return null;
  }
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = startIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (!ch) {
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

function resolveWaitOperandCapturedPidVariable(
  waitOperand: string,
): { expandsAll: boolean; name: string; quoted: boolean } | null {
  const trimmed = waitOperand.trim();
  const bareArrayMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}$/u.exec(trimmed);
  if (bareArrayMatch) {
    return { expandsAll: true, name: bareArrayMatch[1], quoted: false };
  }
  const bareMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(trimmed);
  if (bareMatch) {
    return { expandsAll: false, name: bareMatch[1], quoted: false };
  }
  const bracedMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(trimmed);
  if (bracedMatch) {
    return { expandsAll: false, name: bracedMatch[1], quoted: false };
  }
  const quotedBareMatch = /^"\$([A-Za-z_][A-Za-z0-9_]*)"$/u.exec(trimmed);
  if (quotedBareMatch) {
    return { expandsAll: false, name: quotedBareMatch[1], quoted: true };
  }
  const quotedArrayMatch = /^"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"$/u.exec(trimmed);
  if (quotedArrayMatch) {
    return { expandsAll: true, name: quotedArrayMatch[1], quoted: true };
  }
  const quotedBracedMatch = /^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/u.exec(trimmed);
  if (quotedBracedMatch) {
    return { expandsAll: false, name: quotedBracedMatch[1], quoted: true };
  }
  return null;
}

function isJobsPidCommandSubstitution(waitOperand: string): boolean {
  const trimmed = waitOperand.trim();
  return /^(?:"\$\(\s*jobs\s+-p\s*\)"|\$\(\s*jobs\s+-p\s*\))$/u.test(trimmed);
}

function parseWaitArgs(waitArgs: string[]): { operands: string[]; waitsForAny: boolean } | null {
  let waitsForAny = false;
  let index = 0;
  while (index < waitArgs.length) {
    const arg = waitArgs[index];
    if (arg === "--") {
      return { operands: waitArgs.slice(index + 1), waitsForAny };
    }
    if (!arg || !/^-[A-Za-z]+$/u.test(arg)) {
      break;
    }
    const optionFlags = arg.slice(1);
    for (let optionIndex = 0; optionIndex < optionFlags.length; optionIndex += 1) {
      const option = optionFlags[optionIndex];
      if (option === "n") {
        waitsForAny = true;
        continue;
      }
      if (option === "f") {
        continue;
      }
      if (option === "p") {
        const inlineName = optionFlags.slice(optionIndex + 1);
        if (!inlineName) {
          index += 1;
          if (index >= waitArgs.length) {
            return null;
          }
        }
        break;
      }
      return null;
    }
    index += 1;
  }
  return { operands: waitArgs.slice(index), waitsForAny };
}

function stripOuterShellQuotes(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isPosixInlineShellCommandName(commandName: string | null): boolean {
  if (!commandName) {
    return false;
  }
  return /(^|\/)(sh|bash|dash|fish|ksh|zsh|ash)$/u.test(commandName);
}

type ShellBackgroundingAnalysis = {
  hasDetached: boolean;
  outstandingJobs: number;
};

function analyzeShellBackgrounding(segment: string): ShellBackgroundingAnalysis {
  let token = "";
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let escaped = false;
  let arithmeticDepth = 0;
  let parameterExpansionDepth = 0;
  const pendingBackgroundJobsByBlock = [0];
  let awaitingCommandName = true;
  let tokenIsCommandName = false;
  let currentCommandName: string | null = null;
  let currentCommandArgs: string[] = [];
  const capturedBackgroundPidCounts = new Map<string, number>();
  const controlFlowFrames: Array<{
    terminator: "done" | "esac" | "fi";
    kind: "case" | "if" | "loop";
    waitFloor: number;
  }> = [];
  const functionBackgroundingByName = new Map<string, ShellBackgroundingAnalysis>();

  const previousSignificantChar = (index: number): string | undefined => {
    for (let i = index; i >= 0; i -= 1) {
      const candidate = segment[i];
      if (!candidate || /\s/u.test(candidate)) {
        continue;
      }
      return candidate;
    }
    return undefined;
  };

  const isStandaloneBraceGroupBoundary = (index: number): boolean => {
    if (segment[index] !== "{" && segment[index] !== "}") {
      return false;
    }
    if (token.trim() || currentCommandName !== null || currentCommandArgs.length > 0) {
      return false;
    }
    if (!awaitingCommandName) {
      return false;
    }
    if (segment[index] === "{") {
      const previous = segment[index - 1];
      const next = segment[index + 1];
      return (!previous || /[\s;|&(){}]/u.test(previous)) && Boolean(next && /\s/u.test(next));
    }
    const previous = previousSignificantChar(index - 1);
    const next = segment[index + 1];
    return (!previous || /[;|&(){}]/u.test(previous)) && (!next || /[\s;|&(){}]/u.test(next));
  };

  const beginToken = () => {
    if (!token) {
      tokenIsCommandName = awaitingCommandName;
    }
  };

  const flushToken = () => {
    const trimmed = token.trim();
    if (!trimmed) {
      token = "";
      tokenIsCommandName = false;
      return;
    }
    if (tokenIsCommandName) {
      currentCommandName = trimmed;
      currentCommandArgs = [];
    } else if (currentCommandName) {
      currentCommandArgs.push(trimmed);
    }
    awaitingCommandName = false;
    token = "";
    tokenIsCommandName = false;
  };

  const currentBlockPendingJobs = () =>
    pendingBackgroundJobsByBlock[pendingBackgroundJobsByBlock.length - 1] ?? 0;
  let shortCircuitWaitFloor = 0;
  let shortCircuitChainActive = false;
  const resetShortCircuitWaitFloor = () => {
    shortCircuitWaitFloor = 0;
    shortCircuitChainActive = false;
  };
  const currentControlFlowWaitFloor = () =>
    Math.max(
      controlFlowFrames[controlFlowFrames.length - 1]?.waitFloor ?? 0,
      shortCircuitChainActive ? shortCircuitWaitFloor : 0,
    );
  const detachedAnalysis = (): ShellBackgroundingAnalysis => ({
    hasDetached: true,
    outstandingJobs: currentBlockPendingJobs(),
  });
  const isCasePatternContext = () =>
    token.trim().length > 0 &&
    ((currentCommandName === "case" && currentCommandArgs.includes("in")) ||
      (controlFlowFrames.at(-1)?.kind === "case" &&
        currentCommandName === null &&
        currentCommandArgs.length === 0));

  const resolveTargetedWaitOperandJobCount = (waitOperand: string): number => {
    if (waitOperand === "$!" || waitOperand === '"$!"' || /^%[\w.+-]*$/u.test(waitOperand)) {
      return 1;
    }
    const capturedVar = resolveWaitOperandCapturedPidVariable(waitOperand);
    if (!capturedVar) {
      return 0;
    }
    const capturedCount = capturedBackgroundPidCounts.get(capturedVar.name) ?? 0;
    if (capturedCount <= 0) {
      return 0;
    }
    if (capturedVar.expandsAll) {
      return capturedCount;
    }
    return capturedVar.quoted ? (capturedCount === 1 ? 1 : 0) : capturedCount;
  };

  const resolveWaitJoinedJobCount = () => {
    const waitArgs = resolveWaitCommandArgs();
    if (!waitArgs) {
      return 0;
    }
    const joinablePendingJobs = Math.max(
      0,
      currentBlockPendingJobs() - currentControlFlowWaitFloor(),
    );
    if (joinablePendingJobs <= 0) {
      return 0;
    }
    const parsedWaitArgs = parseWaitArgs(waitArgs);
    if (!parsedWaitArgs) {
      return 0;
    }
    const { operands: waitOperands, waitsForAny } = parsedWaitArgs;
    if (waitOperands.length === 0) {
      return waitsForAny ? 1 : joinablePendingJobs;
    }
    if (waitsForAny) {
      if (waitOperands.length === 0) {
        return 1;
      }
      return waitOperands.every(
        (operand) =>
          isJobsPidCommandSubstitution(operand) || resolveTargetedWaitOperandJobCount(operand) > 0,
      )
        ? 1
        : 0;
    }
    const joinedJobCount = waitOperands.reduce((total, operand) => {
      if (isJobsPidCommandSubstitution(operand)) {
        return total + joinablePendingJobs;
      }
      const operandJobCount = resolveTargetedWaitOperandJobCount(operand);
      return operandJobCount > 0 ? total + operandJobCount : total;
    }, 0);
    if (
      joinedJobCount <= 0 ||
      waitOperands.some(
        (operand) =>
          !isJobsPidCommandSubstitution(operand) &&
          resolveTargetedWaitOperandJobCount(operand) <= 0,
      )
    ) {
      return 0;
    }
    return Math.min(joinablePendingJobs, joinedJobCount);
  };

  const resolveAssignmentTokens = (): string[] => {
    const tokens: string[] = [];
    if (currentCommandArgs.length === 0 && currentCommandName) {
      tokens.push(currentCommandName);
      return tokens;
    }
    if (
      !currentCommandName ||
      !/^(?:declare|export|local|readonly|typeset)$/u.test(currentCommandName)
    ) {
      return tokens;
    }
    const assignmentArgs =
      currentCommandArgs[0] === "--" ? currentCommandArgs.slice(1) : currentCommandArgs;
    for (const arg of assignmentArgs) {
      if (!arg || (!arg.includes("=") && arg.startsWith("-"))) {
        continue;
      }
      if (resolveAssignedShellVariableName(arg)) {
        tokens.push(arg);
      }
    }
    return tokens;
  };

  const resolveInlineShellCommand = (): string | null => {
    const argv = stripInlineShellWrapperPrefixes([currentCommandName ?? "", ...currentCommandArgs]);
    const [executable, ...args] = argv;
    if (!isPosixInlineShellCommandName(executable)) {
      return null;
    }
    const match = resolveInlineCommandMatch(
      [executable ?? "", ...args],
      POSIX_INLINE_COMMAND_FLAGS,
      { allowCombinedC: true },
    );
    return match.command ? stripOuterShellQuotes(match.command) : null;
  };

  const resolveWaitCommandArgs = (): string[] | null => {
    if (currentCommandName === "wait") {
      return currentCommandArgs;
    }
    if (currentCommandName === "builtin" && currentCommandArgs[0] === "wait") {
      return currentCommandArgs.slice(1);
    }
    if (currentCommandName === "command") {
      const args =
        currentCommandArgs[0] === "--" ? currentCommandArgs.slice(1) : currentCommandArgs;
      if (args[0] === "wait") {
        return args.slice(1);
      }
    }
    return null;
  };

  const finalizeCurrentCommand = (options?: { isFunctionDefinition?: boolean }): boolean => {
    const inlineShellCommand = resolveInlineShellCommand();
    if (inlineShellCommand) {
      const inlineShellAnalysis = analyzeShellBackgrounding(inlineShellCommand);
      if (inlineShellAnalysis.hasDetached || inlineShellAnalysis.outstandingJobs > 0) {
        return true;
      }
    }
    if (currentCommandName === "coproc") {
      return true;
    }
    const functionAnalysis = currentCommandName
      ? functionBackgroundingByName.get(currentCommandName)
      : undefined;
    if (!options?.isFunctionDefinition && functionAnalysis?.hasDetached) {
      return true;
    }
    const joinedJobCount = resolveWaitJoinedJobCount();
    if (joinedJobCount > 0) {
      pendingBackgroundJobsByBlock[pendingBackgroundJobsByBlock.length - 1] = Math.max(
        0,
        currentBlockPendingJobs() - joinedJobCount,
      );
    }
    for (const assignmentToken of resolveAssignmentTokens()) {
      const assignedVarName = resolveAssignedShellVariableName(assignmentToken);
      if (!assignedVarName) {
        continue;
      }
      const capturedPidAssignment = resolveAssignedCapturedBackgroundPidCount(
        assignmentToken,
        capturedBackgroundPidCounts,
      );
      if ((capturedPidAssignment?.count ?? 0) > 0) {
        const existingCount = capturedBackgroundPidCounts.get(assignedVarName) ?? 0;
        capturedBackgroundPidCounts.set(
          assignedVarName,
          capturedPidAssignment?.append
            ? existingCount + (capturedPidAssignment?.count ?? 0)
            : (capturedPidAssignment?.count ?? 0),
        );
        continue;
      }
      const capturedPidVarName = resolveCapturedBackgroundPidVariableName(assignmentToken);
      if (capturedPidVarName) {
        capturedBackgroundPidCounts.set(capturedPidVarName, 1);
      } else {
        capturedBackgroundPidCounts.delete(assignedVarName);
      }
    }
    if (
      !options?.isFunctionDefinition &&
      functionAnalysis &&
      functionAnalysis.outstandingJobs > 0
    ) {
      // Invoking a function whose body leaves detached jobs outstanding should
      // behave like starting a background job in the current shell: a later
      // top-level `wait` can still join it before the shell exits.
      pendingBackgroundJobsByBlock[pendingBackgroundJobsByBlock.length - 1] +=
        functionAnalysis.outstandingJobs;
    }
    if (currentCommandName === "if") {
      controlFlowFrames.push({
        terminator: "fi",
        kind: "if",
        waitFloor: currentControlFlowWaitFloor(),
      });
    } else if (currentCommandName === "then" && controlFlowFrames.at(-1)?.kind === "if") {
      controlFlowFrames[controlFlowFrames.length - 1].waitFloor = currentBlockPendingJobs();
    } else if (
      (currentCommandName === "else" || currentCommandName === "elif") &&
      controlFlowFrames.at(-1)?.kind === "if"
    ) {
      controlFlowFrames[controlFlowFrames.length - 1].waitFloor =
        currentCommandName === "elif" ? currentControlFlowWaitFloor() : currentBlockPendingJobs();
    } else if (currentCommandName === "case") {
      controlFlowFrames.push({
        terminator: "esac",
        kind: "case",
        waitFloor: currentBlockPendingJobs(),
      });
    } else if (currentCommandName === "while" || currentCommandName === "until") {
      controlFlowFrames.push({
        terminator: "done",
        kind: "loop",
        waitFloor: currentControlFlowWaitFloor(),
      });
    } else if (currentCommandName === "for" || currentCommandName === "select") {
      controlFlowFrames.push({
        terminator: "done",
        kind: "loop",
        waitFloor: currentBlockPendingJobs(),
      });
    } else if (currentCommandName === "do" && controlFlowFrames.at(-1)?.kind === "loop") {
      controlFlowFrames[controlFlowFrames.length - 1].waitFloor = currentBlockPendingJobs();
    } else if (controlFlowFrames.at(-1)?.terminator === currentCommandName) {
      controlFlowFrames.pop();
    }
    currentCommandName = null;
    currentCommandArgs = [];
    return false;
  };

  const closeCurrentBlock = () => {
    if (pendingBackgroundJobsByBlock.length <= 1) {
      return false;
    }
    return (pendingBackgroundJobsByBlock.pop() ?? 0) > 0;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    const next = segment[i + 1];
    const nextNext = segment[i + 2];

    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
        flushToken();
        if (finalizeCurrentCommand()) {
          return detachedAnalysis();
        }
        awaitingCommandName = true;
      }
      continue;
    }

    if (escaped) {
      beginToken();
      token += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      beginToken();
      token += ch;
      escaped = true;
      continue;
    }

    if (arithmeticDepth > 0) {
      if ((ch === "$" && next === "(" && nextNext === "(") || (ch === "(" && next === "(")) {
        arithmeticDepth += 1;
        beginToken();
        token += ch;
        token += next ?? "";
        if (ch === "$") {
          token += nextNext ?? "";
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === ")" && next === ")") {
        arithmeticDepth = Math.max(0, arithmeticDepth - 1);
        beginToken();
        token += ch;
        token += next;
        i += 1;
        continue;
      }
      beginToken();
      token += ch;
      continue;
    }

    if (parameterExpansionDepth > 0) {
      if (ch === "$" && next === "(" && nextNext !== "(") {
        const substitutionEnd = findShellCommandSubstitutionEnd(segment, i);
        if (substitutionEnd !== null) {
          const substitutionAnalysis = analyzeShellBackgrounding(
            segment.slice(i + 2, substitutionEnd),
          );
          if (substitutionAnalysis.hasDetached || substitutionAnalysis.outstandingJobs > 0) {
            return detachedAnalysis();
          }
          beginToken();
          token += segment.slice(i, substitutionEnd + 1);
          i = substitutionEnd;
          continue;
        }
      }
      if (ch === "`") {
        const substitutionEnd = findBacktickCommandSubstitutionEnd(segment, i);
        if (substitutionEnd !== null) {
          const substitutionAnalysis = analyzeShellBackgrounding(
            segment.slice(i + 1, substitutionEnd),
          );
          if (substitutionAnalysis.hasDetached || substitutionAnalysis.outstandingJobs > 0) {
            return detachedAnalysis();
          }
          beginToken();
          token += segment.slice(i, substitutionEnd + 1);
          i = substitutionEnd;
          continue;
        }
      }
      beginToken();
      token += ch;
      if (ch === "\\") {
        if (next) {
          token += next;
          i += 1;
        }
        continue;
      }
      if (ch === "$" && next === "{") {
        parameterExpansionDepth += 1;
        token += next;
        i += 1;
        continue;
      }
      if (ch === "}") {
        parameterExpansionDepth = Math.max(0, parameterExpansionDepth - 1);
      }
      continue;
    }

    if (inSingle) {
      beginToken();
      token += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === "$" && next === "(" && nextNext !== "(") {
        const substitutionEnd = findShellCommandSubstitutionEnd(segment, i);
        if (substitutionEnd !== null) {
          const substitutionAnalysis = analyzeShellBackgrounding(
            segment.slice(i + 2, substitutionEnd),
          );
          if (substitutionAnalysis.hasDetached || substitutionAnalysis.outstandingJobs > 0) {
            return detachedAnalysis();
          }
          beginToken();
          token += segment.slice(i, substitutionEnd + 1);
          i = substitutionEnd;
          continue;
        }
      }
      if (ch === "`") {
        const substitutionEnd = findBacktickCommandSubstitutionEnd(segment, i);
        if (substitutionEnd !== null) {
          const substitutionAnalysis = analyzeShellBackgrounding(
            segment.slice(i + 1, substitutionEnd),
          );
          if (substitutionAnalysis.hasDetached || substitutionAnalysis.outstandingJobs > 0) {
            return detachedAnalysis();
          }
          beginToken();
          token += segment.slice(i, substitutionEnd + 1);
          i = substitutionEnd;
          continue;
        }
      }
      beginToken();
      token += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      beginToken();
      token += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      beginToken();
      token += ch;
      continue;
    }

    if (isShellCommentStart(segment, i)) {
      inComment = true;
      flushToken();
      continue;
    }

    if ((ch === "$" && next === "(" && nextNext === "(") || (ch === "(" && next === "(")) {
      arithmeticDepth += 1;
      token += ch;
      token += next ?? "";
      if (ch === "$") {
        token += nextNext ?? "";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "$" && next === "{") {
      parameterExpansionDepth += 1;
      beginToken();
      token += ch;
      token += next;
      i += 1;
      continue;
    }

    if (ch === "$" && next === "(" && nextNext !== "(") {
      const substitutionEnd = findShellCommandSubstitutionEnd(segment, i);
      if (substitutionEnd !== null) {
        const substitutionAnalysis = analyzeShellBackgrounding(
          segment.slice(i + 2, substitutionEnd),
        );
        if (substitutionAnalysis.hasDetached || substitutionAnalysis.outstandingJobs > 0) {
          return detachedAnalysis();
        }
        beginToken();
        token += segment.slice(i, substitutionEnd + 1);
        i = substitutionEnd;
        continue;
      }
    }

    if (ch === "`") {
      const substitutionEnd = findBacktickCommandSubstitutionEnd(segment, i);
      if (substitutionEnd !== null) {
        const substitutionAnalysis = analyzeShellBackgrounding(
          segment.slice(i + 1, substitutionEnd),
        );
        if (substitutionAnalysis.hasDetached || substitutionAnalysis.outstandingJobs > 0) {
          return detachedAnalysis();
        }
        beginToken();
        token += segment.slice(i, substitutionEnd + 1);
        i = substitutionEnd;
        continue;
      }
    }

    if (ch === "&") {
      if (next === "&") {
        flushToken();
        if (finalizeCurrentCommand()) {
          return detachedAnalysis();
        }
        shortCircuitWaitFloor = shortCircuitChainActive
          ? Math.max(shortCircuitWaitFloor, currentBlockPendingJobs())
          : currentBlockPendingJobs();
        shortCircuitChainActive = true;
        awaitingCommandName = true;
        i += 1;
        continue;
      }
      if (next === "!" || next === "|") {
        return detachedAnalysis();
      }
      if (segment[i - 1] === ";") {
        awaitingCommandName = true;
        continue;
      }
      const previous = previousSignificantChar(i - 1);
      if (next === ">" || previous === ">" || previous === "<" || previous === "|") {
        token += ch;
        continue;
      }
      if (isCasePatternContext()) {
        token += ch;
        continue;
      }
      flushToken();
      if (finalizeCurrentCommand()) {
        return detachedAnalysis();
      }
      resetShortCircuitWaitFloor();
      pendingBackgroundJobsByBlock[pendingBackgroundJobsByBlock.length - 1] += 1;
      awaitingCommandName = true;
      continue;
    }

    if (ch === "|" && next === "|") {
      flushToken();
      if (finalizeCurrentCommand()) {
        return detachedAnalysis();
      }
      shortCircuitWaitFloor = shortCircuitChainActive
        ? Math.max(shortCircuitWaitFloor, currentBlockPendingJobs())
        : currentBlockPendingJobs();
      shortCircuitChainActive = true;
      awaitingCommandName = true;
      i += 1;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      flushToken();
      if (finalizeCurrentCommand()) {
        return detachedAnalysis();
      }
      resetShortCircuitWaitFloor();
      awaitingCommandName = true;
      continue;
    }

    if (/\s/u.test(ch)) {
      flushToken();
      if (
        currentCommandArgs.length === 0 &&
        /^(?:do|elif|else|if|then|until|while)$/u.test(currentCommandName ?? "")
      ) {
        if (finalizeCurrentCommand()) {
          return detachedAnalysis();
        }
        awaitingCommandName = true;
      }
      continue;
    }

    if (
      ch === "{" &&
      currentCommandName === "function" &&
      currentCommandArgs.length === 1 &&
      SHELL_FUNCTION_NAME_PATTERN.test(currentCommandArgs[0] ?? "")
    ) {
      const functionName = currentCommandArgs[0];
      const functionBodyEnd = findShellBraceGroupEnd(segment, i);
      if (functionBodyEnd !== null) {
        functionBackgroundingByName.set(
          functionName ?? "",
          analyzeShellBackgrounding(segment.slice(i + 1, functionBodyEnd)),
        );
        finalizeCurrentCommand({ isFunctionDefinition: true });
        i = functionBodyEnd;
        continue;
      }
    }

    if (isStandaloneBraceGroupBoundary(i)) {
      awaitingCommandName = true;
      continue;
    }

    if (ch === "(" && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/u.test(token.trim())) {
      const arrayAssignmentEnd = findShellArrayAssignmentEnd(segment, i);
      if (arrayAssignmentEnd !== null) {
        beginToken();
        token += segment.slice(i, arrayAssignmentEnd + 1);
        i = arrayAssignmentEnd;
        continue;
      }
    }

    if (ch === "(") {
      const trimmedToken = token.trim();
      const functionNameCandidate =
        trimmedToken && (currentCommandName === null || currentCommandName === "function")
          ? trimmedToken
          : !trimmedToken && currentCommandArgs.length === 0
            ? currentCommandName
            : null;
      const functionBodyStart = findShellFunctionDefinitionBodyStart(
        segment,
        i,
        functionNameCandidate,
      );
      if (functionBodyStart !== null) {
        const functionName = functionNameCandidate ?? "";
        flushToken();
        const functionBodyEnd = findShellBraceGroupEnd(segment, functionBodyStart);
        if (functionBodyEnd !== null) {
          functionBackgroundingByName.set(
            functionName,
            analyzeShellBackgrounding(segment.slice(functionBodyStart + 1, functionBodyEnd)),
          );
          finalizeCurrentCommand({ isFunctionDefinition: true });
          i = functionBodyEnd;
          continue;
        }
      }
    }

    if (ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      flushToken();
      if (finalizeCurrentCommand()) {
        return detachedAnalysis();
      }
      if (ch !== "(") {
        resetShortCircuitWaitFloor();
      }
      if (ch === "(") {
        pendingBackgroundJobsByBlock.push(0);
      } else if (ch === ")" && closeCurrentBlock()) {
        return detachedAnalysis();
      }
      if (ch === "|" || ch === ";" || ch === "(") {
        awaitingCommandName = true;
      }
      continue;
    }

    beginToken();
    token += ch;
  }

  flushToken();
  if (finalizeCurrentCommand()) {
    return detachedAnalysis();
  }
  const outstandingJobs = pendingBackgroundJobsByBlock.reduce((sum, count) => sum + count, 0);
  return { hasDetached: false, outstandingJobs };
}

function hasDetachedShellBackgrounding(segment: string): boolean {
  const analysis = analyzeShellBackgrounding(segment);
  return analysis.hasDetached || analysis.outstandingJobs > 0;
}

function isShellCommentStart(source: string, index: number): boolean {
  if (source[index] !== "#") {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const previous = source[index - 1];
  return Boolean(previous && (/\s/u.test(previous) || /[;|&()<>]/u.test(previous)));
}

function parseHeredocDelimiter(
  source: string,
  start: number,
): { delimiter: string; end: number; expandable: boolean } | null {
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) {
    i += 1;
  }
  if (i >= source.length) {
    return null;
  }

  const first = source[i];
  if (first === "'" || first === '"') {
    const quote = first;
    i += 1;
    let delimiter = "";
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\n" || ch === "\r") {
        return null;
      }
      if (quote === '"' && ch === "\\" && i + 1 < source.length) {
        delimiter += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        return delimiter ? { delimiter, end: i + 1, expandable: false } : null;
      }
      delimiter += ch;
      i += 1;
    }
    return null;
  }

  let delimiter = "";
  let escapedDelimiter = false;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/u.test(ch) || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") {
      break;
    }
    if (ch === "\\" && i + 1 < source.length) {
      escapedDelimiter = true;
      delimiter += source[i + 1];
      i += 2;
      continue;
    }
    delimiter += ch;
    i += 1;
  }
  return delimiter ? { delimiter, end: i, expandable: !escapedDelimiter } : null;
}

function hasDetachedShellBackgroundingInExpandableText(source: string): boolean {
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "$" && source[i + 1] === "(" && source[i + 2] !== "(") {
      const substitutionEnd = findShellCommandSubstitutionEnd(source, i);
      if (substitutionEnd !== null) {
        if (hasDetachedShellBackgrounding(source.slice(i + 2, substitutionEnd))) {
          return true;
        }
        i = substitutionEnd;
      }
      continue;
    }
    if (source[i] === "`") {
      const substitutionEnd = findBacktickCommandSubstitutionEnd(source, i);
      if (substitutionEnd !== null) {
        if (hasDetachedShellBackgrounding(source.slice(i + 1, substitutionEnd))) {
          return true;
        }
        i = substitutionEnd;
      }
    }
  }
  return false;
}

function hasDetachedShellBackgroundingInExpandableHeredocBodies(command: string): boolean {
  type PendingHeredoc = {
    delimiter: string;
    stripTabs: boolean;
    expandable: boolean;
  };

  const pendingHeredocs: PendingHeredoc[] = [];
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let escaped = false;
  let inHeredocBody = false;
  let heredocLine = "";
  let currentExpandableBody = "";

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (inHeredocBody) {
      if (ch === "\n" || ch === "\r") {
        const current = pendingHeredocs[0];
        const line = current?.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
        const lineBreak = ch === "\r" && next === "\n" ? "\r\n" : ch;
        const isDelimiter = current != null && line === current.delimiter;
        if (current?.expandable && !isDelimiter) {
          currentExpandableBody += `${heredocLine}${lineBreak}`;
        }
        if (isDelimiter) {
          if (
            current?.expandable &&
            hasDetachedShellBackgroundingInExpandableText(currentExpandableBody)
          ) {
            return true;
          }
          pendingHeredocs.shift();
          currentExpandableBody = "";
        }
        heredocLine = "";
        if (ch === "\r" && next === "\n") {
          i += 1;
        }
        if (pendingHeredocs.length === 0) {
          inHeredocBody = false;
        }
      } else {
        heredocLine += ch;
      }
      continue;
    }

    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (isShellCommentStart(command, i)) {
      inComment = true;
      continue;
    }

    if ((ch === "\n" || ch === "\r") && pendingHeredocs.length > 0) {
      inHeredocBody = true;
      heredocLine = "";
      currentExpandableBody = "";
      continue;
    }

    if (ch === "<" && next === "<") {
      let scanIndex = i + 2;
      let stripTabs = false;
      if (command[scanIndex] === "-") {
        stripTabs = true;
        scanIndex += 1;
      }
      const parsed = parseHeredocDelimiter(command, scanIndex);
      if (parsed) {
        pendingHeredocs.push({
          delimiter: parsed.delimiter,
          stripTabs,
          expandable: parsed.expandable,
        });
        i = parsed.end - 1;
      }
    }
  }

  if (inHeredocBody && pendingHeredocs.length > 0) {
    const current = pendingHeredocs[0];
    const line = current?.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
    if (current?.expandable) {
      if (line !== current.delimiter && heredocLine) {
        currentExpandableBody += heredocLine;
      }
      if (hasDetachedShellBackgroundingInExpandableText(currentExpandableBody)) {
        return true;
      }
    }
  }

  return false;
}

function stripHeredocBodiesForBackgroundCheck(command: string): string {
  type PendingHeredoc = {
    delimiter: string;
    stripTabs: boolean;
  };

  const output: string[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let escaped = false;
  let inHeredocBody = false;
  let heredocLine = "";

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (inHeredocBody) {
      if (ch === "\n" || ch === "\r") {
        const current = pendingHeredocs[0];
        if (current) {
          const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
          if (line === current.delimiter) {
            pendingHeredocs.shift();
          }
        }
        heredocLine = "";
        output.push(ch);
        if (ch === "\r" && next === "\n") {
          output.push(next);
          i += 1;
        }
        if (pendingHeredocs.length === 0) {
          inHeredocBody = false;
        }
      } else {
        heredocLine += ch;
      }
      continue;
    }

    output.push(ch);

    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (isShellCommentStart(command, i)) {
      inComment = true;
      continue;
    }

    if ((ch === "\n" || ch === "\r") && pendingHeredocs.length > 0) {
      inHeredocBody = true;
      heredocLine = "";
      continue;
    }

    if (ch === "<" && next === "<") {
      let scanIndex = i + 2;
      let stripTabs = false;
      if (command[scanIndex] === "-") {
        stripTabs = true;
        scanIndex += 1;
      }
      const parsed = parseHeredocDelimiter(command, scanIndex);
      if (parsed) {
        pendingHeredocs.push({ delimiter: parsed.delimiter, stripTabs });
        i = parsed.end - 1;
      }
    }
  }

  return output.join("");
}

function rejectDetachedShellBackgrounding(command: string): void {
  if (process.platform === "win32") {
    return;
  }

  if (
    !hasDetachedShellBackgroundingInExpandableHeredocBodies(command) &&
    !hasDetachedShellBackgrounding(stripHeredocBodiesForBackgroundCheck(command))
  ) {
    return;
  }

  throw new Error(
    "exec preflight: detached shell backgrounding detected. Use exec background=true or yieldMs so OpenClaw can register a pollable process session, and keep shell-managed background jobs paired with wait before the shell exits.",
  );
}

function buildBackgroundExecFollowUpHint(params: {
  notifyOnExit: boolean;
  notifyOnExitEmptySuccess: boolean;
}): string {
  if (!params.notifyOnExit) {
    return (
      "Use process (list/poll/log/write/kill/clear/remove) for logs, status, or intervention. " +
      "Completion notifications are disabled for this exec session, so wait for process status instead of an automatic follow-up."
    );
  }

  if (params.notifyOnExitEmptySuccess) {
    return (
      "Use process (list/poll/log/write/kill/clear/remove) for logs, status, or intervention. " +
      "Completion notifications stay enabled for this exec session, including quiet successful exits without output."
    );
  }
  return (
    "Use process (list/poll/log/write/kill/clear/remove) for logs, status, or intervention. " +
    "Quiet successful exits without output can finish without another user-visible message, so confirm completion with process."
  );
}

function isInterpreterExecutable(executable: string | undefined): boolean {
  if (!executable) {
    return false;
  }
  return /^python(?:3(?:\.\d+)?)?$/i.test(executable) || executable === "node";
}

function hasUnescapedSequence(raw: string, sequence: string): boolean {
  if (sequence.length === 0) {
    return false;
  }
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (raw.startsWith(sequence, i)) {
      return true;
    }
  }
  return false;
}

function hasUnquotedScriptHint(raw: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let token = "";

  const flushToken = (): boolean => {
    const normalizedToken = normalizeLowercaseStringOrEmpty(token);
    if (normalizedToken.endsWith(".py") || normalizedToken.endsWith(".js")) {
      return true;
    }
    token = "";
    return false;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      if (!inSingle && !inDouble) {
        token += ch;
      }
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      if (flushToken()) {
        return true;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      if (flushToken()) {
        return true;
      }
      inDouble = true;
      continue;
    }
    if (/\s/u.test(ch) || "|&;()<>".includes(ch)) {
      if (flushToken()) {
        return true;
      }
      continue;
    }
    token += ch;
  }
  return flushToken();
}

function resolveLeadingShellSegmentExecutable(rawSegment: string): string | undefined {
  const segment = (extractUnquotedShellText(rawSegment) ?? rawSegment).trim();
  const argv = splitShellArgs(segment);
  if (!argv || argv.length === 0) {
    return undefined;
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  if (withoutLeadingKeyword.length === 0) {
    return undefined;
  }
  const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
  let commandIdx = 0;
  while (
    commandIdx < normalizedArgv.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")
  ) {
    commandIdx += 1;
  }
  return normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
}

function analyzeInterpreterHeuristicsFromUnquoted(raw: string): {
  hasPython: boolean;
  hasNode: boolean;
  hasComplexSyntax: boolean;
  hasProcessSubstitution: boolean;
  hasScriptHint: boolean;
} {
  const hasPython = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some((segment) =>
    /^python(?:3(?:\.\d+)?)?$/i.test(resolveLeadingShellSegmentExecutable(segment) ?? ""),
  );
  const hasNode = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some(
    (segment) => resolveLeadingShellSegmentExecutable(segment) === "node",
  );
  const hasProcessSubstitution = hasUnescapedSequence(raw, "<(") || hasUnescapedSequence(raw, ">(");
  const hasComplexSyntax =
    hasUnescapedSequence(raw, "|") ||
    hasUnescapedSequence(raw, "&&") ||
    hasUnescapedSequence(raw, "||") ||
    hasUnescapedSequence(raw, ";") ||
    raw.includes("\n") ||
    raw.includes("\r") ||
    hasUnescapedSequence(raw, "$(") ||
    hasUnescapedSequence(raw, "`") ||
    hasProcessSubstitution;
  const hasScriptHint = hasUnquotedScriptHint(raw);

  return { hasPython, hasNode, hasComplexSyntax, hasProcessSubstitution, hasScriptHint };
}

function extractShellWrappedCommandPayload(
  executable: string | undefined,
  args: string[],
): string | null {
  if (!executable) {
    return null;
  }
  const executableBase = normalizeOptionalLowercaseString(executable.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedExecutable = executableBase.endsWith(".exe")
    ? executableBase.slice(0, -4)
    : executableBase;
  if (!/^(?:bash|dash|fish|ksh|sh|zsh)$/i.test(normalizedExecutable)) {
    return null;
  }
  const shortOptionsWithSeparateValue = new Set(["-O", "-o"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      return null;
    }
    if (arg === "-c") {
      return args[i + 1] ?? null;
    }
    if (/^-[A-Za-z]+$/u.test(arg)) {
      if (arg.includes("c")) {
        return args[i + 1] ?? null;
      }
      if (shortOptionsWithSeparateValue.has(arg)) {
        i += 1;
      }
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) {
      if (!arg.includes("=")) {
        const next = args[i + 1];
        if (next && next !== "--" && !next.startsWith("-")) {
          i += 1;
        }
      }
      continue;
    }
    return null;
  }
  return null;
}

const TIMEOUT_WRAPPER_OPTIONS_WITH_VALUES = new Set(["-k", "-s", "--kill-after", "--signal"]);
const SUDO_WRAPPER_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-D",
  "-g",
  "-p",
  "-R",
  "-T",
  "-U",
  "-u",
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const SUDO_WRAPPER_STANDALONE_OPTIONS = new Set(["-A", "-E", "--askpass", "--preserve-env"]);

function normalizeInlineWrapperExecutable(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeOptionalLowercaseString(token.split(/[\\/]/u).at(-1)) ?? "";
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function stripInlineTimeoutWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
    const option = token.split("=", 1)[0];
    if (
      TIMEOUT_WRAPPER_OPTIONS_WITH_VALUES.has(option) &&
      !token.includes("=") &&
      idx < argv.length
    ) {
      idx += 1;
    }
  }
  return idx >= argv.length ? [] : argv.slice(idx + 1);
}

function stripInlineSudoWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
    const option = token.split("=", 1)[0];
    if (SUDO_WRAPPER_STANDALONE_OPTIONS.has(option)) {
      continue;
    }
    if (SUDO_WRAPPER_OPTIONS_WITH_VALUES.has(option) && !token.includes("=") && idx < argv.length) {
      idx += 1;
    }
  }
  return idx >= argv.length ? [] : argv.slice(idx);
}

function stripInlineNiceWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (/^-\d+$/u.test(token) || /^-n\d+$/u.test(token) || /^--adjustment=.+$/u.test(token)) {
      idx += 1;
      continue;
    }
    if (token === "-n" || token === "--adjustment") {
      idx += 2;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
  }
  return idx >= argv.length ? [] : argv.slice(idx);
}

function stripInlineSetsidWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const option = token.split("=", 1)[0];
    if (
      option !== "-c" &&
      option !== "-f" &&
      option !== "-w" &&
      option !== "--ctty" &&
      option !== "--fork" &&
      option !== "--wait"
    ) {
      return argv;
    }
    idx += 1;
  }
  return idx >= argv.length ? [] : argv.slice(idx);
}

function stripInlineStdbufWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    if (/^-[ioe].+/u.test(token) || /^--(?:input|output|error)=.+$/u.test(token)) {
      idx += 1;
      continue;
    }
    const option = token.split("=", 1)[0];
    if (
      (option === "-i" ||
        option === "-o" ||
        option === "-e" ||
        option === "--input" ||
        option === "--output" ||
        option === "--error") &&
      !token.includes("=") &&
      idx + 1 < argv.length
    ) {
      idx += 2;
      continue;
    }
    return argv;
  }
  return idx >= argv.length ? [] : argv.slice(idx);
}

function stripInlineCommandWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    if (token !== "-p") {
      return argv;
    }
    idx += 1;
  }
  return idx >= argv.length ? [] : argv.slice(idx);
}

function stripInlineExecWrapperPrefix(argv: string[]): string[] {
  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      break;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const option = token.split("=", 1)[0];
    idx += 1;
    if (option === "-c" || option === "-l") {
      continue;
    }
    if (option === "-a" && !token.includes("=") && idx < argv.length) {
      idx += 1;
      continue;
    }
    return argv;
  }
  return idx >= argv.length ? [] : argv.slice(idx);
}

function stripInlineShellWrapperPrefixes(argv: string[]): string[] {
  let remaining = stripPreflightEnvPrefix(argv);
  while (remaining.length > 0) {
    const wrapper = normalizeInlineWrapperExecutable(remaining[0]);
    if (wrapper === "command") {
      const stripped = stripInlineCommandWrapperPrefix(remaining);
      if (stripped === remaining) {
        return remaining;
      }
      remaining = stripped;
      continue;
    }
    if (wrapper === "exec") {
      const stripped = stripInlineExecWrapperPrefix(remaining);
      if (stripped === remaining) {
        return remaining;
      }
      remaining = stripped;
      continue;
    }
    if (wrapper === "timeout") {
      remaining = stripInlineTimeoutWrapperPrefix(remaining);
      continue;
    }
    if (wrapper === "sudo") {
      remaining = stripInlineSudoWrapperPrefix(remaining);
      continue;
    }
    if (wrapper === "nice") {
      remaining = stripInlineNiceWrapperPrefix(remaining);
      continue;
    }
    if (wrapper === "setsid") {
      const stripped = stripInlineSetsidWrapperPrefix(remaining);
      if (stripped === remaining) {
        return remaining;
      }
      remaining = stripped;
      continue;
    }
    if (wrapper === "stdbuf") {
      const stripped = stripInlineStdbufWrapperPrefix(remaining);
      if (stripped === remaining) {
        return remaining;
      }
      remaining = stripped;
      continue;
    }
    if (wrapper === "nohup") {
      remaining = remaining[1] === "--" ? remaining.slice(2) : remaining.slice(1);
      continue;
    }
    return remaining;
  }
  return remaining;
}

function shouldFailClosedInterpreterPreflight(command: string): {
  hasInterpreterInvocation: boolean;
  hasComplexSyntax: boolean;
  hasProcessSubstitution: boolean;
  hasInterpreterSegmentScriptHint: boolean;
  hasInterpreterPipelineScriptHint: boolean;
  isDirectInterpreterCommand: boolean;
} {
  const raw = command.trim();
  const rawArgv = splitShellArgs(raw);
  const argv = rawArgv ? stripPreflightEnvPrefix(rawArgv) : null;
  let commandIdx = 0;
  if (argv) {
    while (
      commandIdx < argv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx] ?? "")
    ) {
      commandIdx += 1;
    }
  }
  const directExecutable = normalizeOptionalLowercaseString(argv?.[commandIdx]);
  const args = argv ? argv.slice(commandIdx + 1) : [];

  const isDirectPythonExecutable = Boolean(
    directExecutable && /^python(?:3(?:\.\d+)?)?$/i.test(directExecutable),
  );
  const isDirectNodeExecutable = directExecutable === "node";
  const isDirectInterpreterCommand = isDirectPythonExecutable || isDirectNodeExecutable;

  const unquotedRaw = extractUnquotedShellText(raw) ?? raw;
  const topLevel = analyzeInterpreterHeuristicsFromUnquoted(unquotedRaw);

  const shellWrappedPayload = extractShellWrappedCommandPayload(directExecutable, args);
  const nestedUnquoted = shellWrappedPayload
    ? (extractUnquotedShellText(shellWrappedPayload) ?? shellWrappedPayload)
    : "";
  const nested = shellWrappedPayload
    ? analyzeInterpreterHeuristicsFromUnquoted(nestedUnquoted)
    : {
        hasPython: false,
        hasNode: false,
        hasComplexSyntax: false,
        hasProcessSubstitution: false,
        hasScriptHint: false,
      };
  const hasInterpreterInvocationInSegment = (rawSegment: string): boolean =>
    isInterpreterExecutable(resolveLeadingShellSegmentExecutable(rawSegment));
  const isScriptExecutingInterpreterCommand = (rawCommand: string): boolean => {
    const argv = splitShellArgs(rawCommand.trim());
    if (!argv || argv.length === 0) {
      return false;
    }
    const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
      ? argv.slice(1)
      : argv;
    if (withoutLeadingKeyword.length === 0) {
      return false;
    }
    const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
    let commandIdx = 0;
    while (
      commandIdx < normalizedArgv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")
    ) {
      commandIdx += 1;
    }
    const executable = normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
    if (!executable) {
      return false;
    }
    const args = normalizedArgv.slice(commandIdx + 1);

    if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
      const pythonInfoOnlyFlags = new Set(["-V", "--version", "-h", "--help"]);
      if (args.some((arg) => pythonInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        args.some(
          (arg) =>
            arg === "-c" ||
            arg === "-m" ||
            arg.startsWith("-c") ||
            arg.startsWith("-m") ||
            arg === "--check-hash-based-pycs",
        )
      ) {
        return false;
      }
      return true;
    }

    if (executable === "node") {
      const nodeInfoOnlyFlags = new Set(["-v", "--version", "-h", "--help", "-c", "--check"]);
      if (args.some((arg) => nodeInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        args.some(
          (arg) =>
            arg === "-e" ||
            arg === "-p" ||
            arg === "--eval" ||
            arg === "--print" ||
            arg.startsWith("--eval=") ||
            arg.startsWith("--print=") ||
            ((arg.startsWith("-e") || arg.startsWith("-p")) && arg.length > 2),
        )
      ) {
        return false;
      }
      return true;
    }

    return false;
  };
  const hasScriptHintInSegment = (segment: string): boolean =>
    extractInterpreterScriptPathsFromSegment(segment).length > 0 || hasUnquotedScriptHint(segment);
  const hasInterpreterAndScriptHintInSameSegment = (rawText: string): boolean => {
    const segments = splitShellSegmentsOutsideQuotes(rawText, { splitPipes: true });
    return segments.some((segment) => {
      if (!isScriptExecutingInterpreterCommand(segment)) {
        return false;
      }
      return hasScriptHintInSegment(segment);
    });
  };
  const hasInterpreterPipelineScriptHintInSameSegment = (rawText: string): boolean => {
    const commandSegments = splitShellSegmentsOutsideQuotes(rawText, { splitPipes: false });
    return commandSegments.some((segment) => {
      const pipelineCommands = splitShellSegmentsOutsideQuotes(segment, { splitPipes: true });
      const hasScriptExecutingPipedInterpreter = pipelineCommands
        .slice(1)
        .some((pipelineCommand) => isScriptExecutingInterpreterCommand(pipelineCommand));
      if (!hasScriptExecutingPipedInterpreter) {
        return false;
      }
      return hasScriptHintInSegment(segment);
    });
  };
  const hasInterpreterSegmentScriptHint =
    hasInterpreterAndScriptHintInSameSegment(raw) ||
    (shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload));
  const hasInterpreterPipelineScriptHint =
    hasInterpreterPipelineScriptHintInSameSegment(raw) ||
    (shellWrappedPayload !== null &&
      hasInterpreterPipelineScriptHintInSameSegment(shellWrappedPayload));
  const hasShellWrappedInterpreterSegmentScriptHint =
    shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload);
  const hasShellWrappedInterpreterInvocation =
    (nested.hasPython || nested.hasNode) &&
    (hasShellWrappedInterpreterSegmentScriptHint ||
      nested.hasScriptHint ||
      nested.hasComplexSyntax ||
      nested.hasProcessSubstitution);
  const hasTopLevelInterpreterInvocation = splitShellSegmentsOutsideQuotes(raw, {
    splitPipes: true,
  }).some((segment) => hasInterpreterInvocationInSegment(segment));
  const hasInterpreterInvocation =
    isDirectInterpreterCommand ||
    hasShellWrappedInterpreterInvocation ||
    hasTopLevelInterpreterInvocation;

  return {
    hasInterpreterInvocation,
    hasComplexSyntax: topLevel.hasComplexSyntax || hasShellWrappedInterpreterInvocation,
    hasProcessSubstitution: topLevel.hasProcessSubstitution || nested.hasProcessSubstitution,
    hasInterpreterSegmentScriptHint,
    hasInterpreterPipelineScriptHint,
    isDirectInterpreterCommand,
  };
}

async function validateScriptFileForShellBleed(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  const target = extractScriptTargetFromCommand(params.command);
  if (!target) {
    const {
      hasInterpreterInvocation,
      hasComplexSyntax,
      hasProcessSubstitution,
      hasInterpreterSegmentScriptHint,
      hasInterpreterPipelineScriptHint,
      isDirectInterpreterCommand,
    } = shouldFailClosedInterpreterPreflight(params.command);
    if (
      hasInterpreterInvocation &&
      hasComplexSyntax &&
      (hasInterpreterSegmentScriptHint ||
        hasInterpreterPipelineScriptHint ||
        (hasProcessSubstitution && isDirectInterpreterCommand))
    ) {
      // Fail closed when interpreter-driven script execution is ambiguous; otherwise
      // attackers can route script content through forms our fast parser cannot validate.
      throw new Error(
        "exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation. " +
          "Use a direct `python <file>.py` or `node <file>.js` command.",
      );
    }
    return;
  }

  for (const relOrAbsPath of target.relOrAbsPaths) {
    const absPath = path.isAbsolute(relOrAbsPath)
      ? path.resolve(relOrAbsPath)
      : path.resolve(params.workdir, relOrAbsPath);
    const relativePath = resolvePreflightRelativePath({
      rootDir: params.workdir,
      absPath,
    });
    if (!relativePath) {
      continue;
    }

    // Best-effort: only validate files that safely resolve within workdir and
    // are reasonably small. This keeps preflight checks on a pinned file
    // identity instead of trusting mutable pathnames across multiple ops.
    // Use non-blocking open to avoid stalls if a path is swapped to a FIFO.
    let content: string;
    try {
      const safeRead = await readFileWithinRoot({
        rootDir: params.workdir,
        relativePath,
        nonBlockingRead: true,
        allowSymlinkTargetWithinRoot: true,
        maxBytes: 512 * 1024,
      });
      content = safeRead.buffer.toString("utf-8");
    } catch (error) {
      if (shouldSkipScriptPreflightPathError(error)) {
        // Preflight validation is best-effort: skip path/read failures and
        // continue to execute the command normally.
        continue;
      }
      throw error;
    }

    // Common failure mode: shell env var syntax leaking into Python/JS.
    // We deliberately match all-caps/underscore vars to avoid false positives with `$` as a JS identifier.
    const envVarRegex = /\$[A-Z_][A-Z0-9_]{1,}/g;
    const first = envVarRegex.exec(content);
    if (first) {
      const idx = first.index;
      const before = content.slice(0, idx);
      const line = before.split("\n").length;
      const token = first[0];
      throw new Error(
        [
          `exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(
            absPath,
          )}:${line}.`,
          target.kind === "python"
            ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.`
            : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
          "(If this is inside a string literal on purpose, escape it or restructure the code.)",
        ].join("\n"),
      );
    }

    // Another recurring pattern from the issue: shell commands accidentally emitted as JS.
    if (target.kind === "node") {
      const firstNonEmpty = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) {
        throw new Error(
          `exec preflight: JS file starts with shell syntax (${firstNonEmpty}). ` +
            `This looks like a shell command, not JavaScript.`,
        );
      }
    }
  }
}

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

function parseExecApprovalShellCommand(raw: string): ParsedExecApprovalCommand | null {
  const normalized = raw.trimStart();
  const match = normalized.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  return {
    approvalId: match[1],
    decision:
      normalizeLowercaseStringOrEmpty(match[2]) === "always"
        ? "allow-always"
        : (normalizeLowercaseStringOrEmpty(match[2]) as ParsedExecApprovalCommand["decision"]),
  };
}

function rejectExecApprovalShellCommand(command: string): void {
  const isEnvAssignmentToken = (token: string): boolean =>
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
  const shellWrappers = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
  const commandStandaloneOptions = new Set(["-p", "-v", "-V"]);
  const envOptionsWithValues = new Set([
    "-C",
    "-S",
    "-u",
    "--argv0",
    "--block-signal",
    "--chdir",
    "--default-signal",
    "--ignore-signal",
    "--split-string",
    "--unset",
  ]);
  const execOptionsWithValues = new Set(["-a"]);
  const execStandaloneOptions = new Set(["-c", "-l"]);
  const sudoOptionsWithValues = new Set([
    "-C",
    "-D",
    "-g",
    "-p",
    "-R",
    "-T",
    "-U",
    "-u",
    "--chdir",
    "--close-from",
    "--group",
    "--host",
    "--other-user",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]);
  const sudoStandaloneOptions = new Set(["-A", "-E", "--askpass", "--preserve-env"]);
  const extractEnvSplitStringPayload = (argv: string[]): string[] => {
    const remaining = [...argv];
    while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
      remaining.shift();
    }
    if (remaining[0] !== "env") {
      return [];
    }
    remaining.shift();
    const payloads: string[] = [];
    while (remaining.length > 0) {
      while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
        remaining.shift();
      }
      const token: string | undefined = remaining[0];
      if (!token) {
        break;
      }
      if (token === "--") {
        remaining.shift();
        continue;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      const option = remaining.shift()!;
      const normalized = option.split("=", 1)[0];
      if (normalized === "-S" || normalized === "--split-string") {
        const value = option.includes("=")
          ? option.slice(option.indexOf("=") + 1)
          : remaining.shift();
        if (value?.trim()) {
          payloads.push(value);
        }
        continue;
      }
      if (envOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
        remaining.shift();
      }
    }
    return payloads;
  };
  const stripApprovalCommandPrefixes = (argv: string[]): string[] => {
    const remaining = [...argv];
    while (remaining.length > 0) {
      while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
        remaining.shift();
      }

      const token = remaining[0];
      if (!token) {
        break;
      }
      if (token === "--") {
        remaining.shift();
        continue;
      }
      if (token === "env") {
        remaining.shift();
        while (remaining.length > 0) {
          while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
            remaining.shift();
          }
          const envToken = remaining[0];
          if (!envToken) {
            break;
          }
          if (envToken === "--") {
            remaining.shift();
            continue;
          }
          if (!envToken.startsWith("-") || envToken === "-") {
            break;
          }
          const option = remaining.shift()!;
          const normalized = option.split("=", 1)[0];
          if (envOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      if (token === "command" || token === "builtin") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          if (!commandStandaloneOptions.has(option.split("=", 1)[0])) {
            continue;
          }
        }
        continue;
      }
      if (token === "exec") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          const normalized = option.split("=", 1)[0];
          if (execStandaloneOptions.has(normalized)) {
            continue;
          }
          if (execOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      if (token === "sudo") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          const normalized = option.split("=", 1)[0];
          if (sudoStandaloneOptions.has(normalized)) {
            continue;
          }
          if (sudoOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      break;
    }
    return remaining;
  };
  const extractShellWrapperPayload = (argv: string[]): string[] => {
    const [commandName, ...rest] = argv;
    if (!commandName || !shellWrappers.has(path.basename(commandName))) {
      return [];
    }
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (!token) {
        continue;
      }
      if (token === "-c" || token === "-lc" || token === "-ic" || token === "-xc") {
        return rest[i + 1] ? [rest[i + 1]] : [];
      }
      if (/^-[^-]*c[^-]*$/u.test(token)) {
        return rest[i + 1] ? [rest[i + 1]] : [];
      }
    }
    return [];
  };
  const buildCandidates = (argv: string[]): string[] => {
    const envSplitCandidates = extractEnvSplitStringPayload(argv).flatMap((payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildCandidates(innerArgv) : [payload];
    });
    const stripped = stripApprovalCommandPrefixes(argv);
    const shellWrapperCandidates = extractShellWrapperPayload(stripped).flatMap((payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildCandidates(innerArgv) : [payload];
    });
    return [
      ...(stripped.length > 0 ? [stripped.join(" ")] : []),
      ...envSplitCandidates,
      ...shellWrapperCandidates,
    ];
  };

  const rawCommand = command.trim();
  const analysis = analyzeShellCommand({ command: rawCommand });
  const candidates = analysis.ok
    ? analysis.segments.flatMap((segment) => buildCandidates(segment.argv))
    : rawCommand
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const argv = splitShellArgs(line);
          return argv ? buildCandidates(argv) : [line];
        });
  for (const candidate of candidates) {
    if (!parseExecApprovalShellCommand(candidate)) {
      continue;
    }
    throw new Error(
      [
        "exec cannot run /approve commands.",
        "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
      ].join(" "),
    );
  }
}

export function createExecTool(
  defaults?: ExecToolDefaults,
): AgentToolWithMeta<typeof execSchema, ExecToolDetails> {
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (message) => {
      logInfo(message);
    },
  });
  if (unprofiledSafeBins.length > 0) {
    logInfo(
      `exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`,
    );
  }
  if (unprofiledInterpreterSafeBins.length > 0) {
    logInfo(
      `exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`,
    );
  }
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifyOnExitEmptySuccess = defaults?.notifyOnExitEmptySuccess === true;
  const notifySessionKey = normalizeOptionalString(defaults?.sessionKey);
  const notifyDeliveryContext = normalizeDeliveryContext({
    channel: defaults?.messageProvider,
    to: defaults?.currentChannelId,
    accountId: defaults?.accountId,
    threadId: defaults?.currentThreadTs,
  });
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return describeExecTool({ agentId, hasCronTool: defaults?.hasCronTool === true });
    },
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        pty?: boolean;
        elevated?: boolean;
        host?: string;
        security?: string;
        ask?: string;
        node?: string;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      let execCommandOverride: string | undefined;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = normalizeOptionalString(defaults?.messageProvider);
          const sessionKey = normalizeOptionalString(defaults?.sessionKey);
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }
      const target = resolveExecTarget({
        configuredTarget: defaults?.host,
        requestedTarget: normalizeExecTarget(params.host),
        elevatedRequested,
        sandboxAvailable: Boolean(defaults?.sandbox),
      });
      const host: ExecHost = target.effectiveHost;

      const approvalDefaults = loadExecApprovals().defaults;
      const configuredSecurity =
        defaults?.security ?? approvalDefaults?.security ?? (host === "sandbox" ? "deny" : "full");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      // Keep local exec defaults in sync with exec-approvals.json when tools.exec.* is unset.
      const configuredAsk = defaults?.ask ?? approvalDefaults?.ask ?? "off";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      if (target.selectedTarget === "sandbox" && !sandbox) {
        throw new Error(
          [
            "exec host=sandbox requires a sandbox runtime for this session.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or use host=auto/gateway/node.',
          ].join("\n"),
        );
      }
      const explicitWorkdir = normalizeOptionalString(params.workdir);
      const defaultWorkdir = normalizeOptionalString(defaults?.cwd);
      let workdir: string | undefined;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const sandboxWorkdir = explicitWorkdir ?? defaultWorkdir ?? process.cwd();
        const resolved = await resolveSandboxWorkdir({
          workdir: sandboxWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else if (host === "node") {
        // For remote node execution, only forward a cwd that was explicitly
        // requested on the tool call. The gateway's workspace root is wired in as a
        // local default, but it is not meaningful on the remote node and would
        // recreate the cross-platform approval failure this path is fixing.
        // When no explicit cwd was given, the gateway's own
        // process.cwd() is meaningless on the remote node (especially cross-platform,
        // e.g. Linux gateway + Windows node) and would cause
        // "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd".
        // Passing undefined lets the node use its own default working directory.
        workdir = explicitWorkdir;
      } else {
        const rawWorkdir = explicitWorkdir ?? defaultWorkdir ?? process.cwd();
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }
      rejectExecApprovalShellCommand(params.command);

      const inheritedBaseEnv = coerceEnv(process.env);
      const hostEnvResult =
        host === "sandbox"
          ? null
          : sanitizeHostExecEnvWithDiagnostics({
              baseEnv: inheritedBaseEnv,
              overrides: params.env,
              blockPathOverrides: true,
            });
      if (
        hostEnvResult &&
        params.env &&
        (hostEnvResult.rejectedOverrideBlockedKeys.length > 0 ||
          hostEnvResult.rejectedOverrideInvalidKeys.length > 0)
      ) {
        const blockedKeys = hostEnvResult.rejectedOverrideBlockedKeys;
        const invalidKeys = hostEnvResult.rejectedOverrideInvalidKeys;
        const pathBlocked = blockedKeys.includes("PATH");
        if (pathBlocked && blockedKeys.length === 1 && invalidKeys.length === 0) {
          throw new Error(
            "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
          );
        }
        if (blockedKeys.length === 1 && invalidKeys.length === 0) {
          throw new Error(
            `Security Violation: Environment variable '${blockedKeys[0]}' is forbidden during host execution.`,
          );
        }
        const details: string[] = [];
        if (blockedKeys.length > 0) {
          details.push(`blocked override keys: ${blockedKeys.join(", ")}`);
        }
        if (invalidKeys.length > 0) {
          details.push(`invalid non-portable override keys: ${invalidKeys.join(", ")}`);
        }
        const suffix = details.join("; ");
        if (pathBlocked) {
          throw new Error(
            `Security Violation: Custom 'PATH' variable is forbidden during host execution (${suffix}).`,
          );
        }
        throw new Error(`Security Violation: ${suffix}.`);
      }

      const env =
        sandbox && host === "sandbox"
          ? buildSandboxEnv({
              defaultPath: DEFAULT_PATH,
              paramsEnv: params.env,
              sandboxEnv: sandbox.env,
              containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
            })
          : (hostEnvResult?.env ?? inheritedBaseEnv);

      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }

      // `tools.exec.pathPrepend` is only meaningful when exec runs locally (gateway) or in the sandbox.
      // Node hosts intentionally ignore request-scoped PATH overrides, so don't pretend this applies.
      if (host === "node" && defaultPathPrepend.length > 0) {
        warnings.push(
          "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
        );
      } else {
        applyPathPrepend(env, defaultPathPrepend);
      }

      if (host === "node") {
        return executeNodeHostCommand({
          command: params.command,
          workdir,
          env,
          requestedEnv: params.env,
          requestedNode: params.node?.trim(),
          boundNode: defaults?.node?.trim(),
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          agentId,
          security,
          ask,
          strictInlineEval: defaults?.strictInlineEval,
          trigger: defaults?.trigger,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          approvalRunningNoticeMs,
          warnings,
          notifySessionKey,
          notifyOnExit,
          trustedSafeBinDirs,
        });
      }

      if (!workdir) {
        throw new Error("exec internal error: local execution requires a resolved workdir");
      }

      if (host === "gateway" && !bypassApprovals) {
        const gatewayResult = await processGatewayAllowlist({
          command: params.command,
          workdir,
          env,
          requestedEnv: params.env,
          pty: params.pty === true && !sandbox,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          security,
          ask,
          safeBins,
          safeBinProfiles,
          strictInlineEval: defaults?.strictInlineEval,
          trigger: defaults?.trigger,
          agentId,
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          scopeKey: defaults?.scopeKey,
          warnings,
          notifySessionKey,
          approvalRunningNoticeMs,
          maxOutput,
          pendingMaxOutput,
          trustedSafeBinDirs,
        });
        if (gatewayResult.pendingResult) {
          return gatewayResult.pendingResult;
        }
        execCommandOverride = gatewayResult.execCommandOverride;
        if (gatewayResult.allowWithoutEnforcedCommand) {
          execCommandOverride = undefined;
        }
      }

      const explicitTimeoutSec = typeof params.timeout === "number" ? params.timeout : null;
      const backgroundTimeoutBypass =
        allowBackground && explicitTimeoutSec === null && (backgroundRequested || yieldRequested);
      const effectiveTimeout = backgroundTimeoutBypass
        ? null
        : (explicitTimeoutSec ?? defaultTimeoutSec);
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;

      // Preflight: catch common model failure modes before we execute and burn tokens in cron loops.
      rejectDetachedShellBackgrounding(params.command);
      await validateScriptFileForShellBleed({ command: params.command, workdir });

      const run = await runExecProcess({
        command: params.command,
        execCommand: execCommandOverride,
        workdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        notifyOnExitEmptySuccess,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        notifyDeliveryContext,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        // Immediately suppress onUpdate calls so that any late stdout/stderr
        // from the still-running process cannot push a rejected Promise into
        // pi-agent-core's updateEvents after the agent run has ended (#62520).
        // Intentionally placed *before* the yielded/backgrounded guard: the
        // agent run is ending regardless, so no consumer exists for further
        // tool_execution_update events even for backgrounded sessions (which
        // retrieve output via process poll/log instead of onUpdate callbacks).
        run.disableUpdates();
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). ${buildBackgroundExecFollowUpHint({
                  notifyOnExit,
                  notifyOnExitEmptySuccess,
                })}`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });

        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            resolve(
              buildExecForegroundResult({
                outcome,
                cwd: run.session.cwd,
                warningText: getWarningText(),
              }),
            );
          })
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

export const execTool = createExecTool();

export const __testing = {
  validateScriptFileForShellBleed,
};
