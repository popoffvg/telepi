import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";

/**
 * Controls which Pi skills are loaded into TelePi sessions.
 *
 * - "none"      — No skills loaded (default; safest for remote use)
 * - "all"       — Load all discovered skills (same as Pi CLI)
 * - string[]    — Allowlist: only load skills whose names are in the list
 */
export type SkillsMode = "none" | "all" | string[];

export interface TelePiConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  workspace: string;
  piSessionPath?: string;
  piModel?: string;
  toolVerbosity: ToolVerbosity;
  piSkills: SkillsMode;
}

export function loadConfig(): TelePiConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const workspace = resolveWorkspace();
  const piSessionPath = optionalString(process.env.PI_SESSION_PATH);
  const piModel = optionalString(process.env.PI_MODEL);
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const piSkills = parseSkillsMode(optionalString(process.env.PI_SKILLS));

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    workspace,
    piSessionPath,
    piModel,
    toolVerbosity,
    piSkills,
  };
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd() (same as running Pi normally)
 */
function resolveWorkspace(): string {
  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
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

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`
      );
      return "summary";
  }
}

/**
 * Parse PI_SKILLS env var.
 *
 * - unset / empty / "none" → "none" (no skills, default)
 * - "all"                  → "all"  (load all discovered skills)
 * - "skill1,skill2"        → ["skill1", "skill2"] (allowlist)
 */
function parseSkillsMode(raw: string | undefined): SkillsMode {
  if (!raw) {
    return "none";
  }

  const lower = raw.toLowerCase();
  if (lower === "none") {
    return "none";
  }

  if (lower === "all") {
    return "all";
  }

  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 ? "none" : list;
}
