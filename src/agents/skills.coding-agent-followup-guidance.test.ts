import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILL_PATH = path.join(REPO_ROOT, "skills", "coding-agent", "SKILL.md");

describe("bundled coding-agent follow-up guidance", () => {
  it("requires a blocker follow-up when a later update was promised", () => {
    const content = fs.readFileSync(SKILL_PATH, "utf8");

    expect(content).toContain("If you promise a later update");
    expect(content).toContain("covers both success and blocker/failure");
    expect(content).toContain("Use the standardized `exec finished:` prefix");
    expect(content).toContain('openclaw system event --text "exec finished: completed -');
    expect(content).toContain('openclaw system event --text "exec finished: blocked -');
    expect(content).toContain("If you told the user “I’ll update you,” this is required");
  });
});
