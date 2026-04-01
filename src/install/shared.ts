export const TELEPI_LAUNCHD_LABEL = "com.telepi";
export const TELEPI_LAUNCH_AGENT_FILENAME = `${TELEPI_LAUNCHD_LABEL}.plist`;
export const TELEPI_EXTENSION_FILENAME = "telepi-handoff.ts";
export const TELEPI_SETUP_PLACEHOLDER_BOT_TOKEN = "your-bot-token-here";
export const TELEPI_SETUP_PLACEHOLDER_ALLOWED_USER_IDS = "123456789";
export const TELEPI_SETUP_PLACEHOLDER_WORKSPACE = "/absolute/path/to/your/main/project";

export type LaunchctlResult = {
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
