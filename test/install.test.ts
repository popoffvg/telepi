import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildLaunchAgentPlist,
  ensureTelePiConfig,
  getTelePiStatus,
  resolveTelePiInstallContext,
  setupTelePi,
} from "../src/install.js";

describe("install helpers", () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let tempDir: string;
  let homeDir: string;
  let packageRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-install-"));
    homeDir = path.join(tempDir, "home");
    packageRoot = path.join(tempDir, "package");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    mkdirSync(path.join(packageRoot, "launchd"), { recursive: true });
    mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });

    writeFileSync(path.join(packageRoot, "package.json"), '{"version":"9.9.9"}\n');
    writeFileSync(
      path.join(packageRoot, ".env.example"),
      [
        "TELEGRAM_BOT_TOKEN=your-bot-token-here",
        "TELEGRAM_ALLOWED_USER_IDS=123456789",
        "# TELEPI_WORKSPACE=/absolute/path/to/your/main/project",
        "# TOOL_VERBOSITY=summary",
        "# OPENAI_API_KEY=sk-...",
      ].join("\n") + "\n",
    );
    writeFileSync(
      path.join(packageRoot, "launchd", "com.telepi.plist"),
      [
        "<plist>",
        "/ABSOLUTE/PATH/TO/WORKDIR",
        "/ABSOLUTE/PATH/TO/node",
        "/ABSOLUTE/PATH/TO/TelePi/dist/cli.js",
        "__TELEPI_PATH_ENV_BLOCK__",
        "/ABSOLUTE/PATH/TO/telepi.out.log",
        "/ABSOLUTE/PATH/TO/telepi.err.log",
        "</plist>",
      ].join("\n"),
    );
    writeFileSync(path.join(packageRoot, "extensions", "telepi-handoff.ts"), "export default {};\n");
    writeFileSync(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");

    process.chdir(packageRoot);
    process.env = {
      ...originalEnv,
      HOME: homeDir,
      PATH: "/opt/homebrew/bin:/usr/bin",
      UID: "501",
    };
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it("resolves installed-mode paths from the CLI entrypoint", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    const context = resolveTelePiInstallContext(cliModuleUrl);

    expect(context.packageRoot).toBe(packageRoot);
    expect(context.cliEntrypointPath).toBe(path.join(packageRoot, "dist", "cli.js"));
    expect(context.configPath).toBe(path.join(homeDir, ".config", "telepi", "config.env"));
    expect(context.launchAgentPath).toBe(
      path.join(homeDir, "Library", "LaunchAgents", "com.telepi.plist"),
    );
    expect(context.extensionDestinationPath).toBe(
      path.join(homeDir, ".pi", "agent", "extensions", "telepi-handoff.ts"),
    );
    expect(context.version).toBe("9.9.9");
  });

  it("renders a launchd plist that starts the CLI via node", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const plist = buildLaunchAgentPlist(context);

    expect(plist).toContain(context.workingDirectory);
    expect(plist).toContain(context.nodeExecutablePath);
    expect(plist).toContain(context.cliEntrypointPath);
    expect(plist).toContain(context.launchAgentStdoutPath);
    expect(plist).toContain(context.launchAgentStderrPath);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>TELEPI_CONFIG</key>");
    expect(plist).toContain(context.configPath);
    expect(plist).toContain("/opt/homebrew/bin:/usr/bin");
    expect(plist).not.toContain("__TELEPI_PATH_ENV_BLOCK__");
  });

  it("writes required setup values from fast setup args into a new config file", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const result = await ensureTelePiConfig(context, {
      telegramBotToken: "12345:ABCDEF",
      telegramAllowedUserIds: "11, 22",
      workspace: "../workspace",
    });
    const contents = readFileSync(context.configPath, "utf8");

    expect(result.created).toBe(true);
    expect(result.updated).toBe(true);
    const expectedWorkspace = path.resolve(process.cwd(), "..", "workspace");

    expect(result.values).toEqual({
      telegramBotToken: "12345:ABCDEF",
      telegramAllowedUserIds: "11, 22",
      workspace: expectedWorkspace,
    });
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=12345:ABCDEF");
    expect(contents).toContain('TELEGRAM_ALLOWED_USER_IDS="11, 22"');
    expect(contents).toContain(`TELEPI_WORKSPACE=${expectedWorkspace}`);
    expect(contents).toContain("# TOOL_VERBOSITY=summary");
    expect(contents).toContain("# OPENAI_API_KEY=sk-...");
    expect(contents).not.toContain("your-bot-token-here");
  });

  it("preserves optional config values when updating required setup values", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    mkdirSync(path.dirname(context.configPath), { recursive: true });
    writeFileSync(
      context.configPath,
      [
        "TELEGRAM_BOT_TOKEN=old-token",
        "TELEGRAM_ALLOWED_USER_IDS=111",
        "TELEPI_WORKSPACE=/old/workspace",
        "TOOL_VERBOSITY=errors-only",
        "OPENAI_API_KEY=sk-existing",
      ].join("\n") + "\n",
    );

    const result = await ensureTelePiConfig(context, {
      telegramBotToken: "new-token",
      telegramAllowedUserIds: "222,333",
      workspace: "/new/workspace",
    });
    const contents = readFileSync(context.configPath, "utf8");

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=new-token");
    expect(contents).toContain("TELEGRAM_ALLOWED_USER_IDS=222,333");
    expect(contents).toContain("TELEPI_WORKSPACE=/new/workspace");
    expect(contents).toContain("TOOL_VERBOSITY=errors-only");
    expect(contents).toContain("OPENAI_API_KEY=sk-existing");
  });

  it("prompts for setup values in interactive mode when no args are provided", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);
    const prompt = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("prompt-token")
      .mockResolvedValueOnce("444,555")
      .mockResolvedValueOnce("../interactive-workspace");

    const result = await ensureTelePiConfig(context, {
      stdin: createTtyStub(true) as NodeJS.ReadableStream & { isTTY: boolean },
      stdout: createTtyStub(true) as NodeJS.WritableStream & { isTTY: boolean },
      prompt,
    });
    const contents = readFileSync(context.configPath, "utf8");

    const expectedWorkspace = path.resolve(process.cwd(), "..", "interactive-workspace");

    expect(result.values).toEqual({
      telegramBotToken: "prompt-token",
      telegramAllowedUserIds: "444,555",
      workspace: expectedWorkspace,
    });
    expect(prompt.mock.calls).toEqual([
      ["TELEGRAM_BOT_TOKEN: "],
      ["TELEGRAM_ALLOWED_USER_IDS: "],
      ["TELEPI_WORKSPACE: "],
    ]);
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=prompt-token");
    expect(contents).toContain("TELEGRAM_ALLOWED_USER_IDS=444,555");
    expect(contents).toContain(`TELEPI_WORKSPACE=${expectedWorkspace}`);
  });

  it("does not treat template example setup values as interactive defaults", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const prompt = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await expect(
      ensureTelePiConfig(context, {
        stdin: createTtyStub(true) as NodeJS.ReadableStream & { isTTY: boolean },
        stdout: createTtyStub(true) as NodeJS.WritableStream & { isTTY: boolean },
        prompt,
      }),
    ).rejects.toThrow(
      "Missing required TelePi setup values: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEPI_WORKSPACE.",
    );
    expect(prompt.mock.calls).toEqual([
      ["TELEGRAM_BOT_TOKEN: "],
      ["TELEGRAM_ALLOWED_USER_IDS: "],
      ["TELEPI_WORKSPACE: "],
    ]);
  });

  it("keeps persisted TELEGRAM_ALLOWED_USER_IDS values even when they match the example", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    mkdirSync(path.dirname(context.configPath), { recursive: true });
    writeFileSync(
      context.configPath,
      [
        "TELEGRAM_BOT_TOKEN=existing-token",
        "TELEGRAM_ALLOWED_USER_IDS=123456789",
        "TELEPI_WORKSPACE=/real/workspace",
      ].join("\n") + "\n",
    );

    const prompt = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const result = await ensureTelePiConfig(context, {
      stdin: createTtyStub(true) as NodeJS.ReadableStream & { isTTY: boolean },
      stdout: createTtyStub(true) as NodeJS.WritableStream & { isTTY: boolean },
      prompt,
    });

    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.values).toEqual({
      telegramBotToken: "existing-token",
      telegramAllowedUserIds: "123456789",
      workspace: "/real/workspace",
    });
    expect(prompt.mock.calls).toEqual([
      ["TELEGRAM_BOT_TOKEN [press enter to keep current]: "],
      ["TELEGRAM_ALLOWED_USER_IDS [123456789]: "],
      ["TELEPI_WORKSPACE [/real/workspace]: "],
    ]);
  });

  it("fails clearly in non-interactive mode when required setup values are missing", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    await expect(
      ensureTelePiConfig(context, {
        stdin: createTtyStub(false) as NodeJS.ReadableStream & { isTTY: boolean },
        stdout: createTtyStub(false) as NodeJS.WritableStream & { isTTY: boolean },
      }),
    ).rejects.toThrow(
      "Missing required TelePi setup values: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEPI_WORKSPACE.",
    );
    expect(() => readFileSync(context.configPath, "utf8")).toThrow();
  });

  it("reports the launchd TELEPI_CONFIG path instead of the caller cwd", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);
    const callerCwd = path.join(tempDir, "caller-cwd");

    mkdirSync(callerCwd, { recursive: true });
    mkdirSync(path.dirname(context.configPath), { recursive: true });
    mkdirSync(path.dirname(context.launchAgentPath), { recursive: true });
    writeFileSync(path.join(callerCwd, ".env"), "TELEGRAM_BOT_TOKEN=from-caller\n");
    writeFileSync(context.configPath, "TELEGRAM_BOT_TOKEN=from-installed\n");
    writeFileSync(context.launchAgentPath, buildLaunchAgentPlist(context));
    process.chdir(callerCwd);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const status = getTelePiStatus(cliModuleUrl);

    expect(status.resolvedConfigPath).toBe(context.configPath);
    expect(status.configExists).toBe(true);
    expect(status.configSource).toBe("launchd-env");
  });

  it("requires dist/cli.js before telepi setup when invoked from src/cli.ts", async () => {
    const srcCliPath = path.join(packageRoot, "src", "cli.ts");
    mkdirSync(path.dirname(srcCliPath), { recursive: true });
    writeFileSync(srcCliPath, "#!/usr/bin/env node\n");
    rmSync(path.join(packageRoot, "dist", "cli.js"));
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    await expect(setupTelePi(pathToFileURL(srcCliPath).href)).rejects.toThrow(
      `telepi setup requires a built CLI entrypoint at ${path.join(packageRoot, "dist", "cli.js")}`,
    );
  });
});

function createTtyStub(isTTY: boolean): { isTTY: boolean } {
  return { isTTY };
}
