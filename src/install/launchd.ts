import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolvePathFromCwd } from "../paths.js";
import type {
  LaunchAgentStatus,
  LaunchctlResult,
  TelePiInstallContext,
} from "./shared.js";

export function buildLaunchAgentPlist(context: TelePiInstallContext): string {
  const template = readFileSync(context.launchdTemplatePath, "utf8");
  const replacements: Array<[string, string]> = [
    ["/ABSOLUTE/PATH/TO/WORKDIR", escapeXml(context.workingDirectory)],
    ["/ABSOLUTE/PATH/TO/node", escapeXml(context.nodeExecutablePath)],
    ["/ABSOLUTE/PATH/TO/TelePi/dist/cli.js", escapeXml(context.cliEntrypointPath)],
    ["/ABSOLUTE/PATH/TO/telepi.out.log", escapeXml(context.launchAgentStdoutPath)],
    ["/ABSOLUTE/PATH/TO/telepi.err.log", escapeXml(context.launchAgentStderrPath)],
    ["__TELEPI_PATH_ENV_BLOCK__", buildEnvironmentVariablesBlock(context)],
  ];

  return replacements.reduce(
    (content, [placeholder, value]) => content.replace(placeholder, value),
    template,
  );
}

export function writeLaunchAgentPlist(context: TelePiInstallContext): boolean {
  const nextContents = buildLaunchAgentPlist(context);
  const previousContents = existsSync(context.launchAgentPath)
    ? readFileSync(context.launchAgentPath, "utf8")
    : undefined;

  if (previousContents === nextContents) {
    return false;
  }

  writeFileSync(context.launchAgentPath, nextContents, "utf8");
  return true;
}

export function reconcileLaunchAgent(context: TelePiInstallContext): {
  actions: string[];
  warning: string | undefined;
} {
  const actions: string[] = [];

  if (process.platform !== "darwin") {
    return { actions, warning: "launchd is only available on macOS." };
  }

  if (!context.launchAgentDomain || !context.launchAgentServiceTarget) {
    return {
      actions,
      warning:
        "Could not determine the current user launchd domain. Load the agent manually with launchctl bootstrap.",
    };
  }

  const launchctlCheck = runCommand("launchctl", ["help"]);
  if (launchctlCheck.error) {
    return {
      actions,
      warning: `launchctl is unavailable: ${launchctlCheck.error.message}`,
    };
  }

  runCommand("launchctl", ["bootout", context.launchAgentDomain, context.launchAgentPath]);
  actions.push(`bootout ${context.launchAgentDomain} ${context.launchAgentPath}`);

  const bootstrap = runCommand("launchctl", [
    "bootstrap",
    context.launchAgentDomain,
    context.launchAgentPath,
  ]);
  if (bootstrap.status !== 0) {
    return {
      actions,
      warning: formatLaunchctlFailure("bootstrap", bootstrap),
    };
  }
  actions.push(`bootstrap ${context.launchAgentDomain} ${context.launchAgentPath}`);

  const enable = runCommand("launchctl", ["enable", context.launchAgentServiceTarget]);
  if (enable.status === 0) {
    actions.push(`enable ${context.launchAgentServiceTarget}`);
  }

  const kickstart = runCommand("launchctl", ["kickstart", "-k", context.launchAgentServiceTarget]);
  if (kickstart.status === 0) {
    actions.push(`kickstart -k ${context.launchAgentServiceTarget}`);
    return { actions, warning: undefined };
  }

  return {
    actions,
    warning: formatLaunchctlFailure("kickstart", kickstart),
  };
}

export function getLaunchAgentStatus(context: TelePiInstallContext): LaunchAgentStatus {
  const plistExists = existsSync(context.launchAgentPath);

  if (process.platform !== "darwin") {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "launchd unavailable on this platform",
      error: undefined,
    };
  }

  if (!context.launchAgentServiceTarget) {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "launchd domain unavailable",
      error: "Could not determine the current user launchd domain.",
    };
  }

  const result = runCommand("launchctl", ["print", context.launchAgentServiceTarget]);
  if (result.error) {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "launchctl unavailable",
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      plistExists,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: plistExists ? "installed but not loaded" : "not installed",
      error: cleanCommandOutput(result.stderr) || cleanCommandOutput(result.stdout) || undefined,
    };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return {
    plistExists,
    loaded: true,
    state: matchValue(output, /\bstate = ([^\n]+)/),
    pid: parseNumericValue(matchValue(output, /\bpid = (\d+)/)),
    detail: "loaded",
    error: undefined,
  };
}

export function readLaunchAgentPlist(context: TelePiInstallContext): string | undefined {
  if (!existsSync(context.launchAgentPath)) {
    return undefined;
  }

  return readFileSync(context.launchAgentPath, "utf8");
}

export function readLaunchAgentWorkingDirectory(plistContents: string): string | undefined {
  return readLaunchAgentStringValue(plistContents, "WorkingDirectory");
}

export function readLaunchAgentEnvironmentVariables(plistContents: string): Record<string, string> {
  const environmentBlock = plistContents.match(
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
  )?.[1];
  if (!environmentBlock) {
    return {};
  }

  const values: Record<string, string> = {};
  const pattern = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;

  for (const match of environmentBlock.matchAll(pattern)) {
    const key = decodeXml(match[1] ?? "").trim();
    const value = decodeXml(match[2] ?? "").trim();
    if (key) {
      values[key] = value;
    }
  }

  return values;
}

export function getInstalledConfigStatus(context: TelePiInstallContext): {
  resolvedPath: string;
  source: "launchd-env" | "launchd-cwd" | "installed-default";
} {
  const plistContents = readLaunchAgentPlist(context);
  if (!plistContents) {
    return {
      resolvedPath: context.configPath,
      source: "installed-default",
    };
  }

  const workingDirectory = readLaunchAgentWorkingDirectory(plistContents) ?? context.workingDirectory;
  const envVars = readLaunchAgentEnvironmentVariables(plistContents);
  const explicitConfigPath = envVars.TELEPI_CONFIG
    ? resolvePathFromCwd(envVars.TELEPI_CONFIG, workingDirectory)
    : undefined;

  if (explicitConfigPath) {
    return {
      resolvedPath: explicitConfigPath,
      source: "launchd-env",
    };
  }

  const localConfigPath = path.join(workingDirectory, ".env");
  if (existsSync(localConfigPath)) {
    return {
      resolvedPath: localConfigPath,
      source: "launchd-cwd",
    };
  }

  return {
    resolvedPath: context.configPath,
    source: "installed-default",
  };
}

function buildEnvironmentVariablesBlock(context: TelePiInstallContext): string {
  const entries: Array<[string, string]> = [["TELEPI_CONFIG", context.configPath]];
  if (context.pathEnvironment) {
    entries.push(["PATH", context.pathEnvironment]);
  }

  return [
    "",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...entries.flatMap(([key, value]) => [
      `    <key>${key}</key>`,
      `    <string>${escapeXml(value)}</string>`,
    ]),
    "  </dict>",
  ].join("\n");
}

function readLaunchAgentStringValue(plistContents: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<key>${escapeRegExp(key)}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`,
  );
  const value = plistContents.match(pattern)?.[1];
  return value ? decodeXml(value).trim() : undefined;
}

function runCommand(command: string, args: string[]): LaunchctlResult {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function formatLaunchctlFailure(action: string, result: LaunchctlResult): string {
  const detail = cleanCommandOutput(result.stderr) || cleanCommandOutput(result.stdout);
  return detail ? `launchctl ${action} failed: ${detail}` : `launchctl ${action} failed.`;
}

function cleanCommandOutput(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function matchValue(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1]?.trim();
}

function parseNumericValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
