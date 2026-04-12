import { describe, expect, it } from "vitest";
import {
  CLI_BUNDLED_PROMPT_TOOL_NAMES,
  CLI_NATIVE_PROMPT_TOOL_NAMES,
  resolveCoreToolProfilePolicy,
} from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("includes code_execution, web_search, x_search, web_fetch, and update_plan in the coding profile policy", () => {
    const policy = resolveCoreToolProfilePolicy("coding");
    expect(policy).toBeDefined();
    expect(policy!.allow).toContain("code_execution");
    expect(policy!.allow).toContain("web_search");
    expect(policy!.allow).toContain("x_search");
    expect(policy!.allow).toContain("web_fetch");
    expect(policy!.allow).toContain("image_generate");
    expect(policy!.allow).toContain("music_generate");
    expect(policy!.allow).toContain("video_generate");
    expect(policy!.allow).toContain("update_plan");
  });

  it("exposes CLI prompt fallback inventories from the shared catalog surface", () => {
    expect([...CLI_NATIVE_PROMPT_TOOL_NAMES]).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "grep",
      "find",
      "ls",
      "exec",
      "process",
    ]);
    expect([...CLI_BUNDLED_PROMPT_TOOL_NAMES]).toEqual(
      expect.arrayContaining(["read", "exec", "session_status", "subagents", "message"]),
    );
  });
});
