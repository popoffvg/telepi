import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { parseAllowedUserIds } from "../config.js";
import { resolvePathFromCwd } from "../paths.js";
import type {
  TelePiConfigSetupResult,
  TelePiConfigSetupValues,
  TelePiInstallContext,
  TelePiSetupOptions,
} from "./shared.js";
import {
  TELEPI_SETUP_PLACEHOLDER_ALLOWED_USER_IDS,
  TELEPI_SETUP_PLACEHOLDER_BOT_TOKEN,
  TELEPI_SETUP_PLACEHOLDER_WORKSPACE,
} from "./shared.js";

export async function ensureTelePiConfig(
  context: TelePiInstallContext,
  options: TelePiSetupOptions = {},
): Promise<TelePiConfigSetupResult> {
  const configExists = existsSync(context.configPath);
  const previousContents = configExists
    ? readFileSync(context.configPath, "utf8")
    : readFileSync(context.envExamplePath, "utf8");
  const currentValuesSource = configExists ? "config" : "template";
  const currentValues = readEnvAssignments(previousContents);
  const nextValues = await resolveTelePiSetupValues(currentValues, currentValuesSource, options);
  const nextContents = buildTelePiConfigContents(previousContents, nextValues);
  const updated = !configExists || nextContents !== previousContents;

  if (updated) {
    mkdirSync(path.dirname(context.configPath), { recursive: true });
    writeFileSync(context.configPath, nextContents, "utf8");
  }

  return {
    created: !configExists,
    updated,
    values: nextValues,
  };
}

export function buildTelePiConfigContents(contents: string, values: TelePiConfigSetupValues): string {
  let nextContents = contents;
  nextContents = setEnvAssignment(nextContents, "TELEGRAM_BOT_TOKEN", values.telegramBotToken);
  nextContents = setEnvAssignment(
    nextContents,
    "TELEGRAM_ALLOWED_USER_IDS",
    values.telegramAllowedUserIds,
  );
  nextContents = setEnvAssignment(nextContents, "TELEPI_WORKSPACE", values.workspace);
  return nextContents;
}

export function readEnvAssignments(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value.replace(/\\n/g, "\n");
  }

  return values;
}

function setEnvAssignment(contents: string, key: string, value: string): string {
  const assignment = `${key}=${formatEnvValue(value)}`;

  for (const pattern of [
    new RegExp(`^(\\s*)(?:export\\s+)?${escapeRegExp(key)}\\s*=.*$`, "m"),
    new RegExp(`^(\\s*)#\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=.*$`, "m"),
  ]) {
    if (pattern.test(contents)) {
      return contents.replace(pattern, `$1${assignment}`);
    }
  }

  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  return `${contents}${separator}${assignment}\n`;
}

function formatEnvValue(value: string): string {
  if (/^[^\s"'#]+$/.test(value)) {
    return value;
  }

  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

function normalizeSetupValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeWorkspaceValue(value: string | undefined): string | undefined {
  const normalized = normalizeSetupValue(value);
  return normalized ? resolvePathFromCwd(normalized) : undefined;
}

function normalizeCurrentBotToken(
  value: string | undefined,
  ignoreTemplatePlaceholder: boolean,
): string | undefined {
  return normalizeCurrentSetupValue(value, isPlaceholderBotToken, ignoreTemplatePlaceholder);
}

function normalizeCurrentAllowedUserIds(
  value: string | undefined,
  ignoreTemplatePlaceholder: boolean,
): string | undefined {
  return normalizeCurrentSetupValue(value, isPlaceholderAllowedUserIds, ignoreTemplatePlaceholder);
}

function normalizeCurrentWorkspace(
  value: string | undefined,
  ignoreTemplatePlaceholder: boolean,
): string | undefined {
  return normalizeCurrentSetupValue(value, isPlaceholderWorkspace, ignoreTemplatePlaceholder);
}

function normalizeCurrentSetupValue(
  value: string | undefined,
  isPlaceholder: (value: string) => boolean,
  ignoreTemplatePlaceholder: boolean,
): string | undefined {
  const normalized = normalizeSetupValue(value);
  return normalized && (!ignoreTemplatePlaceholder || !isPlaceholder(normalized))
    ? normalized
    : undefined;
}

function isPlaceholderBotToken(value: string): boolean {
  return value === TELEPI_SETUP_PLACEHOLDER_BOT_TOKEN;
}

function isPlaceholderAllowedUserIds(value: string): boolean {
  return value === TELEPI_SETUP_PLACEHOLDER_ALLOWED_USER_IDS;
}

function isPlaceholderWorkspace(value: string): boolean {
  return value === TELEPI_SETUP_PLACEHOLDER_WORKSPACE;
}

function isInteractiveSetup(options: TelePiSetupOptions): boolean {
  const stdin = options.stdin ?? processStdin;
  const stdout = options.stdout ?? processStdout;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

async function resolveTelePiSetupValues(
  currentValues: Record<string, string>,
  currentValuesSource: "config" | "template",
  options: TelePiSetupOptions,
): Promise<TelePiConfigSetupValues> {
  const providedValues = {
    telegramBotToken: normalizeSetupValue(options.telegramBotToken),
    telegramAllowedUserIds: normalizeSetupValue(options.telegramAllowedUserIds),
    workspace: normalizeWorkspaceValue(options.workspace),
  };
  const providedAnyValue = Object.values(providedValues).some((value) => value !== undefined);
  const ignoreTemplatePlaceholders = currentValuesSource === "template";
  const currentSetupValues = {
    telegramBotToken: normalizeCurrentBotToken(
      currentValues.TELEGRAM_BOT_TOKEN,
      ignoreTemplatePlaceholders,
    ),
    telegramAllowedUserIds: normalizeCurrentAllowedUserIds(
      currentValues.TELEGRAM_ALLOWED_USER_IDS,
      ignoreTemplatePlaceholders,
    ),
    workspace: normalizeCurrentWorkspace(currentValues.TELEPI_WORKSPACE, ignoreTemplatePlaceholders),
  };

  const nextValues = {
    telegramBotToken: providedValues.telegramBotToken ?? currentSetupValues.telegramBotToken,
    telegramAllowedUserIds:
      providedValues.telegramAllowedUserIds ?? currentSetupValues.telegramAllowedUserIds,
    workspace: providedValues.workspace ?? currentSetupValues.workspace,
  };

  if (!providedAnyValue && isInteractiveSetup(options)) {
    const promptedValues = await promptForTelePiSetupValues(nextValues, options);
    nextValues.telegramBotToken = promptedValues.telegramBotToken;
    nextValues.telegramAllowedUserIds = promptedValues.telegramAllowedUserIds;
    nextValues.workspace = promptedValues.workspace;
  }

  const missingKeys: string[] = [];
  if (
    !nextValues.telegramBotToken ||
    (ignoreTemplatePlaceholders && isPlaceholderBotToken(nextValues.telegramBotToken))
  ) {
    missingKeys.push("TELEGRAM_BOT_TOKEN");
  }
  if (!nextValues.telegramAllowedUserIds) {
    missingKeys.push("TELEGRAM_ALLOWED_USER_IDS");
  }
  if (!nextValues.workspace) {
    missingKeys.push("TELEPI_WORKSPACE");
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required TelePi setup values: ${missingKeys.join(", ")}. Provide them as \`telepi setup <bot_token> <userids> <workspace>\` or rerun \`telepi setup\` in an interactive terminal.`,
    );
  }

  const telegramBotToken = nextValues.telegramBotToken!;
  const telegramAllowedUserIds = nextValues.telegramAllowedUserIds!;
  const workspace = nextValues.workspace!;

  parseAllowedUserIds(telegramAllowedUserIds);

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    workspace,
  };
}

async function promptForTelePiSetupValues(
  currentValues: {
    telegramBotToken: string | undefined;
    telegramAllowedUserIds: string | undefined;
    workspace: string | undefined;
  },
  options: TelePiSetupOptions,
): Promise<{
  telegramBotToken: string | undefined;
  telegramAllowedUserIds: string | undefined;
  workspace: string | undefined;
}> {
  const ask = options.prompt
    ? options.prompt
    : createReadlineSetupPrompt(options.stdin ?? processStdin, options.stdout ?? processStdout);

  try {
    return {
      telegramBotToken: await promptForSetupValue(
        ask,
        "TELEGRAM_BOT_TOKEN",
        currentValues.telegramBotToken,
      ),
      telegramAllowedUserIds: await promptForSetupValue(
        ask,
        "TELEGRAM_ALLOWED_USER_IDS",
        currentValues.telegramAllowedUserIds,
      ),
      workspace: normalizeWorkspaceValue(
        await promptForSetupValue(ask, "TELEPI_WORKSPACE", currentValues.workspace),
      ),
    };
  } finally {
    if (!options.prompt && "close" in ask && typeof ask.close === "function") {
      ask.close();
    }
  }
}

function createReadlineSetupPrompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ((question: string) => Promise<string>) & { close(): void } {
  const readline = createInterface({ input, output });
  const ask = (question: string) => readline.question(question);

  return Object.assign(ask, {
    close(): void {
      readline.close();
    },
  });
}

async function promptForSetupValue(
  prompt: (question: string) => Promise<string>,
  key: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_ALLOWED_USER_IDS" | "TELEPI_WORKSPACE",
  currentValue: string | undefined,
): Promise<string | undefined> {
  const question =
    key === "TELEGRAM_BOT_TOKEN"
      ? currentValue
        ? `${key} [press enter to keep current]: `
        : `${key}: `
      : currentValue
        ? `${key} [${currentValue}]: `
        : `${key}: `;
  const answer = normalizeSetupValue(await prompt(question));
  return answer ?? currentValue;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

