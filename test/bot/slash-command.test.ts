import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";

import {
  TELEPI_BOT_COMMANDS,
  buildChatScopedCommands,
  buildChatScopedCommandSignature,
  buildCommandPickerEntries,
  filterCommandPickerEntries,
  getCommandPickerCounts,
  getCommandPickerFilterName,
  normalizeSlashCommand,
} from "../../src/bot/slash-command.js";

describe("bot slash-command helpers", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("normalizes slash commands and respects addressed bot usernames", () => {
    expect(normalizeSlashCommand("/review foo bar")).toEqual({
      name: "review",
      text: "/review foo bar",
    });

    expect(normalizeSlashCommand("/review@TelePiBot foo", "telepibot")).toEqual({
      name: "review",
      text: "/review foo",
    });

    expect(normalizeSlashCommand("/review@OtherBot foo", "telepibot")).toBeUndefined();
    expect(normalizeSlashCommand("not a command", "telepibot")).toBeUndefined();
    expect(normalizeSlashCommand("/", "telepibot")).toBeUndefined();
  });

  it("builds command picker entries with TelePi commands first and source labels for Pi commands", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-slash-command-"));
    const reviewPromptPath = path.join(tempDir, "review.md");
    writeFileSync(
      reviewPromptPath,
      [
        "---",
        "description: Review recent changes",
        'argument-hint: "<PR-URL>"',
        "---",
        "Review changes.",
        "",
      ].join("\n"),
    );

    const slashCommands: SlashCommandInfo[] = [
      {
        name: "review",
        description: "Review recent changes",
        source: "prompt",
        sourceInfo: { path: reviewPromptPath, source: "local", scope: "project", origin: "top-level" },
      },
      {
        name: "skill:browser-tools",
        description: "Browser tools",
        source: "skill",
        sourceInfo: { path: "/skills/browser.md", source: "local", scope: "project", origin: "top-level" },
      },
      {
        name: "deploy",
        description: "Deploy app",
        source: "extension",
        sourceInfo: { path: "/ext/deploy.ts", source: "local", scope: "project", origin: "top-level" },
      },
      {
        name: "agentic",
        description: "Agent action",
        source: "agent" as any,
        sourceInfo: { path: "/agentic", source: "local", scope: "project", origin: "top-level" },
      },
    ];

    const entries = buildCommandPickerEntries(slashCommands);

    expect(entries[0]).toMatchObject({
      kind: "telepi",
      command: "start",
      label: "📱 /start",
      commandText: "/start",
    });
    expect(entries.some((entry) => entry.kind === "telepi" && entry.command === "commands")).toBe(false);

    expect(entries.slice(-4)).toEqual([
      expect.objectContaining({
        kind: "pi",
        name: "review",
        label: "📝 /review <PR-URL>",
        commandText: "/review",
      }),
      expect.objectContaining({ kind: "pi", name: "skill:browser-tools", label: "🧰 /skill:browser-tools" }),
      expect.objectContaining({ kind: "pi", name: "deploy", label: "🧩 /deploy" }),
      expect.objectContaining({ kind: "pi", name: "agentic", label: "⚡ /agentic" }),
    ]);
  });

  it("gracefully skips argument hints when prompt metadata is unavailable", () => {
    const entries = buildCommandPickerEntries([
      {
        name: "review",
        description: "Review recent changes",
        source: "prompt",
        sourceInfo: { path: "/missing/review.md", source: "local", scope: "project", origin: "top-level" },
      },
      {
        name: "deploy",
        description: "Deploy app",
        source: "extension",
        sourceInfo: { path: "/ext/deploy.ts", source: "local", scope: "project", origin: "top-level" },
      },
    ]);

    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "review", label: "📝 /review" }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi", name: "deploy", label: "🧩 /deploy" }));
  });

  it("filters and counts command picker entries by kind", () => {
    const entries = buildCommandPickerEntries([
      { name: "review", description: "Review", source: "prompt" },
      { name: "deploy", description: "Deploy", source: "extension" },
    ]);

    expect(getCommandPickerFilterName("all")).toBe("All");
    expect(getCommandPickerFilterName("telepi")).toBe("TelePi");
    expect(getCommandPickerFilterName("pi")).toBe("Pi");

    expect(getCommandPickerCounts(entries)).toEqual({
      all: entries.length,
      telepi: TELEPI_BOT_COMMANDS.length - 1,
      pi: 2,
    });

    expect(filterCommandPickerEntries(entries, "telepi").every((entry) => entry.kind === "telepi")).toBe(true);
    expect(filterCommandPickerEntries(entries, "pi").every((entry) => entry.kind === "pi")).toBe(true);
    expect(filterCommandPickerEntries(entries, "all")).toEqual(entries);
  });

  it("builds chat-scoped commands for Telegram and filters unsupported or conflicting names", () => {
    const longDescription = "x".repeat(400);
    const commands = buildChatScopedCommands([
      { name: "review", description: longDescription, source: "prompt" },
      { name: "switch", description: "Conflicts with local command", source: "extension" },
      { name: "skill:browser-tools", description: "Not Telegram-native", source: "skill" },
      { name: "Review", description: "Duplicate after lowercasing", source: "prompt" },
    ]);

    expect(commands).toEqual([
      ...TELEPI_BOT_COMMANDS,
      {
        command: "review",
        description: `Pi: ${"x".repeat(251)}…`,
      },
    ]);

    expect(buildChatScopedCommandSignature(commands)).toBe(JSON.stringify(commands));
  });
});
