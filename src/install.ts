import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { parseAllowedUserIds } from "./config.js";
import { getDefaultTelePiConfigPath, getHomeDirectory, resolvePathFromCwd } from "./paths.js";

export const TELEPI_LAUNCHD_LABEL = "com.telepi";
const TELEPI_LAUNCH_AGENT_FILENAME = `${TELEPI_LAUNCHD_LABEL}.plist`;
const TELEPI_EXTENSION_FILENAME = "telepi-handoff.ts";
const TELEPI_SETUP_PLACEHOLDER_BOT_TOKEN = "your-bot-token-here";
const TELEPI_SETUP_PLACEHOLDER_ALLOWED_USER_IDS = "123456789";
const TELEPI_SETUP_PLACEHOLDER_WORKSPACE = "/absolute/path/to/your/main/project";

type LaunchctlResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export interface TelePiInstallContext {
  packageRoot: string;
  cliEntrypointPath: string;
  envExamplePath: string;
  launchdTemplatePath: string;
  extensionSourcePath: string;
  configPath: string;
  launchAgentPath: string;
  launchAgentLabel: string;
  launchAgentDomain: string | undefined;
  launchAgentServiceTarget: string | undefined;
  launchAgentLogsDirectory: string;
  launchAgentStdoutPath: string;
  launchAgentStderrPath: string;
  extensionDestinationPath: string;
  nodeExecutablePath: string;
  workingDirectory: string;
  pathEnvironment: string | undefined;
  version: string;
}

export interface LaunchAgentStatus {
  plistExists: boolean;
  loaded: boolean;
  state: string | undefined;
  pid: number | undefined;
  detail: string;
  error: string | undefined;
}

export type ExtensionInstallMode = "missing" | "symlink" | "copy" | "custom";

export interface ExtensionStatus {
  exists: boolean;
  mode: ExtensionInstallMode;
  detail: string;
  targetPath: string | undefined;
}

export type TelePiStatusConfigSource = "launchd-env" | "launchd-cwd" | "installed-default";

export interface TelePiStatus {
  version: string;
  resolvedConfigPath: string;
  configExists: boolean;
  configSource: TelePiStatusConfigSource;
  launchAgent: LaunchAgentStatus;
  extension: ExtensionStatus;
}

export interface TelePiSetupOptions {
  telegramBotToken?: string;
  telegramAllowedUserIds?: string;
  workspace?: string;
  stdin?: NodeJS.ReadableStream & {
    isTTY?: boolean;
  };
  stdout?: NodeJS.WritableStream & {
    isTTY?: boolean;
  };
  prompt?: (question: string) => Promise<string>;
}

export interface TelePiConfigSetupValues {
  telegramBotToken: string;
  telegramAllowedUserIds: string;
  workspace: string;
}

export interface TelePiConfigSetupResult {
  created: boolean;
  updated: boolean;
  values: TelePiConfigSetupValues;
}

export interface TelePiSetupResult {
  context: TelePiInstallContext;
  configCreated: boolean;
  configUpdated: boolean;
  launchAgentUpdated: boolean;
  extensionInstalledAs: "symlink" | "copy";
  launchdActions: string[];
  launchdWarning: string | undefined;
}

export function resolveTelePiInstallContext(cliModuleUrl: string): TelePiInstallContext {
  const rawCliEntrypointPath = fileURLToPath(cliModuleUrl);
  const packageRoot = path.resolve(path.dirname(rawCliEntrypointPath), "..");
  const cliEntrypointPath = resolveInstalledCliEntrypointPath(packageRoot, rawCliEntrypointPath);
  const homeDirectory = getHomeDirectory();
  const launchAgentDomain = resolveLaunchAgentDomain();

  return {
    packageRoot,
    cliEntrypointPath,
    envExamplePath: path.join(packageRoot, ".env.example"),
    launchdTemplatePath: path.join(packageRoot, "launchd", TELEPI_LAUNCH_AGENT_FILENAME),
    extensionSourcePath: path.join(packageRoot, "extensions", TELEPI_EXTENSION_FILENAME),
    configPath: getDefaultTelePiConfigPath(homeDirectory),
    launchAgentPath: path.join(homeDirectory, "Library", "LaunchAgents", TELEPI_LAUNCH_AGENT_FILENAME),
    launchAgentLabel: TELEPI_LAUNCHD_LABEL,
    launchAgentDomain,
    launchAgentServiceTarget: launchAgentDomain
      ? `${launchAgentDomain}/${TELEPI_LAUNCHD_LABEL}`
      : undefined,
    launchAgentLogsDirectory: path.join(homeDirectory, "Library", "Logs", "TelePi"),
    launchAgentStdoutPath: path.join(homeDirectory, "Library", "Logs", "TelePi", "telepi.out.log"),
    launchAgentStderrPath: path.join(homeDirectory, "Library", "Logs", "TelePi", "telepi.err.log"),
    extensionDestinationPath: path.join(
      homeDirectory,
      ".pi",
      "agent",
      "extensions",
      TELEPI_EXTENSION_FILENAME,
    ),
    nodeExecutablePath: process.execPath,
    workingDirectory: homeDirectory,
    pathEnvironment: process.env.PATH,
    version: readPackageVersion(packageRoot),
  };
}

export function getTelePiStatus(cliModuleUrl: string): TelePiStatus {
  const context = resolveTelePiInstallContext(cliModuleUrl);
  const configInfo = getInstalledConfigStatus(context);

  return {
    version: context.version,
    resolvedConfigPath: configInfo.resolvedPath,
    configExists: existsSync(configInfo.resolvedPath),
    configSource: configInfo.source,
    launchAgent: getLaunchAgentStatus(context),
    extension: getExtensionStatus(context),
  };
}

export async function setupTelePi(
  cliModuleUrl: string,
  options: TelePiSetupOptions = {},
): Promise<TelePiSetupResult> {
  if (process.platform !== "darwin") {
    throw new Error("telepi setup is currently only supported on macOS.");
  }

  const context = resolveTelePiInstallContext(cliModuleUrl);
  ensureInstallInputsExist(context);

  mkdirSync(path.dirname(context.configPath), { recursive: true });
  mkdirSync(path.dirname(context.launchAgentPath), { recursive: true });
  mkdirSync(context.launchAgentLogsDirectory, { recursive: true });
  mkdirSync(path.dirname(context.extensionDestinationPath), { recursive: true });

  const configResult = await ensureTelePiConfig(context, options);
  const launchAgentUpdated = writeLaunchAgentPlist(context);
  const extensionInstalledAs = installExtension(context);
  const { actions: launchdActions, warning: launchdWarning } = reconcileLaunchAgent(context);

  return {
    context,
    configCreated: configResult.created,
    configUpdated: configResult.updated,
    launchAgentUpdated,
    extensionInstalledAs,
    launchdActions,
    launchdWarning,
  };
}

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

function getInstalledConfigStatus(context: TelePiInstallContext): {
  resolvedPath: string;
  source: TelePiStatusConfigSource;
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

function ensureInstallInputsExist(context: TelePiInstallContext): void {
  if (path.extname(context.cliEntrypointPath) === ".ts") {
    throw new Error(
      `telepi setup requires a built CLI entrypoint at ${path.join(context.packageRoot, "dist", "cli.js")}. Run \`npm run build\` and rerun \`telepi setup\`.`,
    );
  }

  for (const filePath of [
    context.envExamplePath,
    context.launchdTemplatePath,
    context.extensionSourcePath,
    context.cliEntrypointPath,
  ]) {
    if (!existsSync(filePath)) {
      throw new Error(`Required install asset is missing: ${filePath}`);
    }
  }
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

function buildTelePiConfigContents(contents: string, values: TelePiConfigSetupValues): string {
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

function readEnvAssignments(contents: string): Record<string, string> {
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

function writeLaunchAgentPlist(context: TelePiInstallContext): boolean {
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

function installExtension(context: TelePiInstallContext): "symlink" | "copy" {
  const destinationPath = context.extensionDestinationPath;
  const existingStatus = getExtensionStatus(context);

  if (existingStatus.mode === "symlink" && existingStatus.targetPath === context.extensionSourcePath) {
    return "symlink";
  }

  rmSync(destinationPath, { force: true, recursive: true });

  try {
    symlinkSync(context.extensionSourcePath, destinationPath);
    return "symlink";
  } catch {
    copyFileSync(context.extensionSourcePath, destinationPath);
    return "copy";
  }
}

function reconcileLaunchAgent(context: TelePiInstallContext): {
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

function getLaunchAgentStatus(context: TelePiInstallContext): LaunchAgentStatus {
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

function getExtensionStatus(context: TelePiInstallContext): ExtensionStatus {
  const destinationPath = context.extensionDestinationPath;
  const sourcePath = context.extensionSourcePath;

  if (!existsSync(destinationPath)) {
    return {
      exists: false,
      mode: "missing",
      detail: "missing",
      targetPath: undefined,
    };
  }

  const stats = lstatSync(destinationPath);
  if (stats.isSymbolicLink()) {
    const rawTarget = readlinkSync(destinationPath);
    const resolvedTarget = path.resolve(path.dirname(destinationPath), rawTarget);
    if (resolvedTarget === sourcePath) {
      return {
        exists: true,
        mode: "symlink",
        detail: "symlinked",
        targetPath: resolvedTarget,
      };
    }

    return {
      exists: true,
      mode: "custom",
      detail: "symlinked elsewhere",
      targetPath: resolvedTarget,
    };
  }

  if (filesMatch(destinationPath, sourcePath)) {
    return {
      exists: true,
      mode: "copy",
      detail: "copied",
      targetPath: undefined,
    };
  }

  return {
    exists: true,
    mode: "custom",
    detail: "custom file",
    targetPath: undefined,
  };
}

function filesMatch(leftPath: string, rightPath: string): boolean {
  if (!existsSync(leftPath) || !existsSync(rightPath)) {
    return false;
  }

  return readFileSync(leftPath, "utf8") === readFileSync(rightPath, "utf8");
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

function readLaunchAgentPlist(context: TelePiInstallContext): string | undefined {
  if (!existsSync(context.launchAgentPath)) {
    return undefined;
  }

  return readFileSync(context.launchAgentPath, "utf8");
}

function readLaunchAgentWorkingDirectory(plistContents: string): string | undefined {
  return readLaunchAgentStringValue(plistContents, "WorkingDirectory");
}

function readLaunchAgentEnvironmentVariables(plistContents: string): Record<string, string> {
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

function readLaunchAgentStringValue(plistContents: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<key>${escapeRegExp(key)}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`,
  );
  const value = plistContents.match(pattern)?.[1];
  return value ? decodeXml(value).trim() : undefined;
}

function readPackageVersion(packageRoot: string): string {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return packageJson.version ?? "0.0.0";
}

function resolveInstalledCliEntrypointPath(packageRoot: string, rawCliEntrypointPath: string): string {
  if (path.extname(rawCliEntrypointPath) !== ".ts") {
    return rawCliEntrypointPath;
  }

  const builtCliEntrypointPath = path.join(packageRoot, "dist", "cli.js");
  return existsSync(builtCliEntrypointPath) ? builtCliEntrypointPath : rawCliEntrypointPath;
}

function resolveLaunchAgentDomain(): string | undefined {
  const uid = process.getuid?.();
  if (typeof uid === "number") {
    return `gui/${uid}`;
  }

  const rawUid = process.env.UID?.trim();
  if (!rawUid) {
    return undefined;
  }

  const parsedUid = Number(rawUid);
  return Number.isInteger(parsedUid) ? `gui/${parsedUid}` : undefined;
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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
