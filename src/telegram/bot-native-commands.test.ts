import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "../config/telegram-custom-commands.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import { createNativeCommandTestParams } from "./bot-native-commands.test-helpers.js";

const { listSkillCommandsForAgents } = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));
const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));
const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(async () => ({
    snapshot: { config: {} },
    writeOptions: {},
  })),
  writeConfigFile: vi.fn(async () => undefined),
}));

vi.mock("../auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/skill-commands.js")>();
  return {
    ...actual,
    listSkillCommandsForAgents,
  };
});
vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configMocks.readConfigFileSnapshotForWrite,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

describe("registerTelegramNativeCommands", () => {
  type RegisteredCommand = {
    command: string;
    description: string;
  };

  async function waitForRegisteredCommands(
    setMyCommands: ReturnType<typeof vi.fn>,
  ): Promise<RegisteredCommand[]> {
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });
    return setMyCommands.mock.calls[0]?.[0] as RegisteredCommand[];
  }

  beforeEach(() => {
    listSkillCommandsForAgents.mockClear();
    listSkillCommandsForAgents.mockReturnValue([]);
    pluginCommandMocks.getPluginCommandSpecs.mockClear();
    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([]);
    pluginCommandMocks.matchPluginCommand.mockClear();
    pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
    pluginCommandMocks.executePluginCommand.mockClear();
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" });
    deliveryMocks.deliverReplies.mockClear();
    deliveryMocks.deliverReplies.mockResolvedValue({ delivered: true });
    configMocks.readConfigFileSnapshotForWrite.mockClear();
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { config: {} },
      writeOptions: {},
    });
    configMocks.writeConfigFile.mockClear();
    configMocks.writeConfigFile.mockResolvedValue(undefined);
  });

  const buildParams = (cfg: OpenClawConfig, accountId = "default") =>
    createNativeCommandTestParams({
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as RuntimeEnv,
      accountId,
      telegramCfg: {} as TelegramAccountConfig,
    });

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("scopes skill commands to default agent without a matching binding (#15599)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["main"],
    });
  });

  it("truncates Telegram command registration to 100 commands", async () => {
    const cfg: OpenClawConfig = {
      commands: { native: false },
    };
    const customCommands = Array.from({ length: 120 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index}`,
    }));
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    registerTelegramNativeCommands({
      ...buildParams(cfg),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      runtime: { log: runtimeLog } as unknown as RuntimeEnv,
      telegramCfg: { customCommands } as TelegramAccountConfig,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(100);
    expect(registeredCommands).toEqual(customCommands.slice(0, 100));
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram limits bots to 100 commands. 120 configured; registering first 100. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.",
    );
  });

  it("registers /topic when native commands are disabled and no custom/plugin commands exist", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    registerTelegramNativeCommands({
      ...buildParams({}, "work"),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      telegramCfg: {},
      nativeEnabled: false,
      nativeSkillsEnabled: false,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(1);
    expect(registeredCommands).toEqual([
      {
        command: "topic",
        description: "Map this topic to a named session.",
      },
    ]);
  });

  it("keeps /topic in Telegram autocompletion under command list truncation", async () => {
    const customCommands = Array.from({ length: 120 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index}`,
    }));
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    registerTelegramNativeCommands({
      ...buildParams({}, "work"),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      telegramCfg: {
        customCommands,
      } as TelegramAccountConfig,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(100);
    expect(registeredCommands[0].command).toBe("topic");
  });

  it("normalizes hyphenated native command names for Telegram registration", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const command = vi.fn();

    registerTelegramNativeCommands({
      ...buildParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command,
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.some((entry) => entry.command === "export_session")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "export-session")).toBe(false);

    const registeredHandlers = command.mock.calls.map(([name]) => name);
    expect(registeredHandlers).toContain("export_session");
    expect(registeredHandlers).not.toContain("export-session");
  });

  it("registers only Telegram-safe command names across native, custom, and plugin sources", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      { name: "plugin-status", description: "Plugin status" },
      { name: "plugin@bad", description: "Bad plugin command" },
    ] as never);

    registerTelegramNativeCommands({
      ...buildParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      telegramCfg: {
        customCommands: [
          { command: "custom-backup", description: "Custom backup" },
          { command: "custom!bad", description: "Bad custom command" },
        ],
      } as TelegramAccountConfig,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);

    expect(registeredCommands.length).toBeGreaterThan(0);
    for (const entry of registeredCommands) {
      expect(entry.command.includes("-")).toBe(false);
      expect(TELEGRAM_COMMAND_NAME_PATTERN.test(entry.command)).toBe(true);
    }

    expect(registeredCommands.some((entry) => entry.command === "export_session")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "custom_backup")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "plugin_status")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "plugin-status")).toBe(false);
    expect(registeredCommands.some((entry) => entry.command === "custom-bad")).toBe(false);
  });

  it("passes agent-scoped media roots for plugin command replies with media", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
      bindings: [{ agentId: "work", match: { channel: "telegram", accountId: "default" } }],
    };

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "plug",
        description: "Plugin command",
      },
    ] as never);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "plug", requireAuth: false },
      args: undefined,
    } as never);
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "with media",
      mediaUrl: "/tmp/workspace-work/render.png",
    } as never);

    registerTelegramNativeCommands({
      ...buildParams(cfg),
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.({
      match: "",
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("registers native /topic command", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    registerTelegramNativeCommands({
      ...buildParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.some((entry) => entry.command === "topic")).toBe(true);
  });

  it("/topic maps DM topics to a named session key in account scope", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const writeOptions = { envSnapshotForRestore: { TEST: "1" } };

    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              direct: {
                "123": {
                  topics: {
                    "9": {
                      sessionKey: "agent:main:main:thread:123:legacy",
                    },
                  },
                },
              },
              accounts: {
                work: {
                  direct: {
                    "123": {
                      topics: {
                        "7": {
                          sessionKey: "agent:main:main:thread:123:existing",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      writeOptions,
    });

    registerTelegramNativeCommands({
      ...buildParams({}, "work"),
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("topic");
    expect(handler).toBeTruthy();

    await handler?.({
      match: "Ops",
      message: {
        message_id: 1,
        message_thread_id: 42,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const [writtenConfig, writtenOptions] = configMocks.writeConfigFile.mock.calls[0] as [
      OpenClawConfig,
      Record<string, unknown>,
    ];
    expect(writtenOptions).toEqual(writeOptions);
    expect(
      writtenConfig.channels?.telegram?.accounts?.work?.direct?.["123"]?.topics?.["42"]?.sessionKey,
    ).toBe("agent:main:main:thread:123:ops");
    expect(writtenConfig.channels?.telegram?.direct?.["123"]?.topics?.["42"]).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      123,
      'Mapped topic "Ops" to session agent:main:main:thread:123:ops. Config path: channels.telegram.accounts."work".direct."123".topics."42".sessionKey.',
      { message_thread_id: 42 },
    );
  });

  it("/topic clears mapping on empty input and does not reserve literal off", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  direct: {
                    "123": {
                      topics: {
                        "42": {
                          sessionKey: "agent:main:main:thread:123:ops",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      writeOptions: {},
    });

    registerTelegramNativeCommands({
      ...buildParams({}, "work"),
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("topic");
    expect(handler).toBeTruthy();

    await handler?.({
      match: " ",
      message: {
        message_id: 1,
        message_thread_id: 42,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const [writtenConfig] = configMocks.writeConfigFile.mock.calls[0] as [OpenClawConfig];
    expect(
      writtenConfig.channels?.telegram?.accounts?.work?.direct?.["123"]?.topics?.["42"]?.sessionKey,
    ).toBeUndefined();
    expect(writtenConfig.channels?.telegram?.accounts?.work).toBeUndefined();
    expect(writtenConfig.channels?.telegram?.accounts).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      123,
      'Cleared topic mapping. Using default session key agent:main:main:thread:123:42. Config path: channels.telegram.accounts."work".direct."123".topics."42".sessionKey.',
      { message_thread_id: 42 },
    );

    await handler?.({
      match: "off",
      message: {
        message_id: 2,
        message_thread_id: 42,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(sendMessage).toHaveBeenLastCalledWith(
      123,
      'Mapped topic "off" to session agent:main:main:thread:123:off. Config path: channels.telegram.accounts."work".direct."123".topics."42".sessionKey.',
      { message_thread_id: 42 },
    );
  });

  it("/topic respects configWrites=false and skips writes", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  configWrites: false,
                },
              },
            },
          },
        },
      },
      writeOptions: {},
    });

    registerTelegramNativeCommands({
      ...buildParams({}, "work"),
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("topic");
    expect(handler).toBeTruthy();

    await handler?.({
      match: "Ops",
      message: {
        message_id: 1,
        message_thread_id: 42,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Config writes are disabled for this Telegram account.",
      { message_thread_id: 42 },
    );
  });
});
