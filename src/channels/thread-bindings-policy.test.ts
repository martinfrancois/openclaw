import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy.js";

describe("resolveThreadBindingSpawnPolicy", () => {
  it("defaults Telegram ACP thread spawns to enabled", () => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg: { channels: { telegram: {} } } as OpenClawConfig,
      channel: "telegram",
      accountId: "default",
      kind: "acp",
    });

    expect(policy.enabled).toBe(true);
    expect(policy.spawnEnabled).toBe(true);
  });

  it("respects explicit Telegram ACP thread spawn disable", () => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg: {
        channels: {
          telegram: {
            threadBindings: {
              spawnAcpSessions: false,
            },
          },
        },
      } as OpenClawConfig,
      channel: "telegram",
      accountId: "default",
      kind: "acp",
    });

    expect(policy.spawnEnabled).toBe(false);
  });
});
