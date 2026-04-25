import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultTelePiConfigPath, getHomeDirectory } from "./paths.js";
import { ensureTelePiConfig } from "./install/config.js";
import { getExtensionStatus, installExtension } from "./install/extension.js";
import {
  buildLaunchAgentPlist,
  getInstalledConfigStatus,
  getLaunchAgentStatus,
  reconcileLaunchAgent,
  writeLaunchAgentPlist,
} from "./install/launchd.js";
import {
  TELEPI_EXTENSION_FILENAME,
  TELEPI_LAUNCH_AGENT_FILENAME,
  TELEPI_LAUNCHD_LABEL,
  type ExtensionInstallMode,
  type ExtensionStatus,
  type LaunchAgentStatus,
  type TelePiConfigSetupResult,
  type TelePiConfigSetupValues,
  type TelePiInstallContext,
  type TelePiSetupOptions,
  type TelePiSetupResult,
  type TelePiStatus,
  type TelePiStatusConfigSource,
} from "./install/shared.js";

export { TELEPI_LAUNCHD_LABEL } from "./install/shared.js";
export type {
  ExtensionInstallMode,
  ExtensionStatus,
  LaunchAgentStatus,
  TelePiConfigSetupResult,
  TelePiConfigSetupValues,
  TelePiInstallContext,
  TelePiSetupOptions,
  TelePiSetupResult,
  TelePiStatus,
  TelePiStatusConfigSource,
} from "./install/shared.js";
export { ensureTelePiConfig } from "./install/config.js";
export { buildLaunchAgentPlist } from "./install/launchd.js";

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
