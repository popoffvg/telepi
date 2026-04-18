import { readFileSync } from "node:fs";

import { parseFrontmatter, type SlashCommandInfo } from "@mariozechner/pi-coding-agent";

import { trimLine } from "./message-rendering.js";

export const TELEPI_BOT_COMMANDS = [
  { command: "start", description: "Welcome and session info" },
  { command: "help", description: "Show commands and usage tips" },
  { command: "commands", description: "Browse TelePi and Pi commands" },
  { command: "new", description: "Start a new session" },
  { command: "retry", description: "Retry the last prompt in this chat/topic" },
  { command: "handback", description: "Hand session back to Pi CLI" },
  { command: "abort", description: "Cancel current operation" },
  { command: "session", description: "Current session details" },
  { command: "sessions", description: "List and switch sessions (or /sessions <path|id>)" },
  { command: "model", description: "Switch AI model" },
  { command: "tree", description: "View and navigate the session tree" },
  { command: "branch", description: "Navigate to a tree entry (/branch <id>)" },
  { command: "label", description: "Label an entry (/label [name] or /label <id> <name>)" },
] as const;

export const TELEPI_LOCAL_COMMAND_NAMES = new Set<string>([
  ...TELEPI_BOT_COMMANDS.map((command) => command.command),
  "switch",
]);

export type NormalizedSlashCommand = {
  name: string;
  text: string;
};

export type CommandPickerFilter = "all" | "telepi" | "pi";

export type CommandPickerEntry =
  | {
      id: number;
      kind: "telepi";
      command: string;
      description: string;
      label: string;
      commandText: string;
    }
  | {
      id: number;
      kind: "pi";
      name: string;
      description: string;
      label: string;
      commandText: string;
      source: string;
    };

export function normalizeSlashCommand(text: string, botUsername?: string): NormalizedSlashCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const rawCommand = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).slice(1);
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
  const atIndex = rawCommand.indexOf("@");
  const rawName = atIndex === -1 ? rawCommand : rawCommand.slice(0, atIndex);
  const addressedBot = atIndex === -1 ? undefined : rawCommand.slice(atIndex + 1);

  if (!rawName) {
    return undefined;
  }

  if (addressedBot && botUsername && addressedBot.toLowerCase() !== botUsername.toLowerCase()) {
    return undefined;
  }

  return {
    name: rawName,
    text: args ? `/${rawName} ${args}` : `/${rawName}`,
  };
}

type SlashCommandInfoWithMetadata = SlashCommandInfo & {
  argumentHint?: string;
  path?: string;
  sourceInfo?: {
    path?: string;
  };
};

function normalizeArgumentHint(argumentHint: unknown): string | undefined {
  if (typeof argumentHint !== "string") {
    return undefined;
  }

  const trimmed = argumentHint.trim();
  return trimmed ? trimmed : undefined;
}

function getSlashCommandSourcePath(command: SlashCommandInfoWithMetadata): string | undefined {
  const sourceInfoPath = typeof command.sourceInfo?.path === "string" ? command.sourceInfo.path.trim() : "";
  if (sourceInfoPath) {
    return sourceInfoPath;
  }

  const legacyPath = typeof command.path === "string" ? command.path.trim() : "";
  return legacyPath || undefined;
}

function getSlashCommandArgumentHint(command: SlashCommandInfo): string | undefined {
  const commandWithMetadata = command as SlashCommandInfoWithMetadata;
  const directHint = normalizeArgumentHint(commandWithMetadata.argumentHint);
  if (directHint) {
    return directHint;
  }

  if (command.source !== "prompt") {
    return undefined;
  }

  const sourcePath = getSlashCommandSourcePath(commandWithMetadata);
  if (!sourcePath) {
    return undefined;
  }

  try {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(sourcePath, "utf8"));
    return normalizeArgumentHint(frontmatter["argument-hint"]);
  } catch {
    return undefined;
  }
}

function getPiSlashCommandDisplayText(command: SlashCommandInfo): string {
  const argumentHint = getSlashCommandArgumentHint(command);
  return argumentHint ? `/${command.name} ${argumentHint}` : `/${command.name}`;
}

function getPiSlashCommandLabel(command: SlashCommandInfo): string {
  const displayText = getPiSlashCommandDisplayText(command);

  switch (command.source) {
    case "prompt":
      return `📝 ${displayText}`;
    case "skill":
      return `🧰 ${displayText}`;
    case "extension":
      return `🧩 ${displayText}`;
    default:
      return `⚡ ${displayText}`;
  }
}

export function getCommandPickerFilterName(filter: CommandPickerFilter): string {
  switch (filter) {
    case "telepi":
      return "TelePi";
    case "pi":
      return "Pi";
    case "all":
    default:
      return "All";
  }
}

export function getCommandPickerCounts(entries: CommandPickerEntry[]): Record<CommandPickerFilter, number> {
  return {
    all: entries.length,
    telepi: entries.filter((entry) => entry.kind === "telepi").length,
    pi: entries.filter((entry) => entry.kind === "pi").length,
  };
}

export function filterCommandPickerEntries(
  entries: CommandPickerEntry[],
  filter: CommandPickerFilter,
): CommandPickerEntry[] {
  if (filter === "all") {
    return entries;
  }

  return entries.filter((entry) => entry.kind === filter);
}

export function buildCommandPickerEntries(slashCommands: SlashCommandInfo[]): CommandPickerEntry[] {
  const telepiEntries = TELEPI_BOT_COMMANDS
    .filter((command) => command.command !== "commands")
    .map((command, index) => ({
      id: index,
      kind: "telepi" as const,
      command: command.command,
      description: command.description,
      label: `📱 /${command.command}`,
      commandText: `/${command.command}`,
    }));

  const piEntries = slashCommands.map((command, index) => ({
    id: telepiEntries.length + index,
    kind: "pi" as const,
    name: command.name,
    description: command.description ?? command.source,
    label: getPiSlashCommandLabel(command),
    commandText: `/${command.name}`,
    source: command.source,
  }));

  return [...telepiEntries, ...piEntries];
}

function isTelegramNativeCommandName(name: string): boolean {
  return /^[a-z0-9_]{1,32}$/.test(name);
}

export function buildChatScopedCommands(
  slashCommands: SlashCommandInfo[],
): Array<{ command: string; description: string }> {
  const commands: Array<{ command: string; description: string }> = TELEPI_BOT_COMMANDS.map((command) => ({
    command: command.command,
    description: command.description,
  }));
  const seen = new Set(TELEPI_LOCAL_COMMAND_NAMES);

  for (const slashCommand of slashCommands) {
    const name = slashCommand.name.replace(/^\/+/, "").trim().toLowerCase();
    if (!isTelegramNativeCommandName(name) || seen.has(name)) {
      continue;
    }

    seen.add(name);
    commands.push({
      command: name,
      description: trimLine(`Pi: ${slashCommand.description ?? slashCommand.source}`, 256),
    });
  }

  if (commands.length > 100) {
    console.warn(`Telegram supports at most 100 commands per scope; truncating ${commands.length} commands to 100.`);
  }

  return commands.slice(0, 100);
}

export function buildChatScopedCommandSignature(commands: Array<{ command: string; description: string }>): string {
  return JSON.stringify(commands);
}
