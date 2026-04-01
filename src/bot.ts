import { unlink } from "node:fs/promises";

import { InlineKeyboard, Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";

import type { TelePiConfig } from "./config.js";
import { formatError } from "./errors.js";
import { escapeHTML } from "./format.js";
import {
  getWorkspaceShortName,
  isMessageNotModifiedError,
  renderFailedText,
  renderHelpHTML,
  renderHelpPlain,
  renderPrefixedError,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
  renderVoiceSupportHTML,
  renderVoiceSupportPlain,
  stripHtml,
  trimLine,
  type RenderedText,
} from "./bot/message-rendering.js";
import {
  appendKeyboardItems,
  paginateKeyboard,
  splitTreeKeyboardItems,
  type KeyboardItem,
  KEYBOARD_PAGE_SIZE,
  NOOP_PAGE_CALLBACK_DATA,
} from "./bot/keyboard.js";
import {
  buildChatScopedCommands,
  buildChatScopedCommandSignature,
  buildCommandPickerEntries,
  filterCommandPickerEntries,
  getCommandPickerCounts,
  getCommandPickerFilterName,
  normalizeSlashCommand,
  TELEPI_BOT_COMMANDS,
  TELEPI_LOCAL_COMMAND_NAMES,
  type CommandPickerEntry,
  type CommandPickerFilter,
} from "./bot/slash-command.js";
import {
  downloadTelegramFile,
  getTelegramTarget,
  safeEditMessage,
  safeReply,
  sendChatAction,
  sendTextMessage,
} from "./bot/telegram-transport.js";
import { createExtensionDialogManager } from "./bot/extension-dialogs.js";
import { createBotChatState } from "./bot/chat-state.js";
import { createPromptHandler } from "./bot/prompt-handler.js";
import { createBasicCommandHandlers } from "./bot/commands/basic.js";
import { createSessionCommandHandlers } from "./bot/commands/sessions.js";
import { createModelCommandHandlers } from "./bot/commands/model.js";
import { createTreeCommandHandlers } from "./bot/commands/tree.js";
import {
  type PiSessionContext,
  getPiSessionContextKey,
  type PiSessionModelOption,
  type PiSessionRegistry,
  type PiSessionService,
} from "./pi-session.js";
import {
  renderBranchConfirmation,
  renderTree,
  truncateText,
  type TreeFilterMode,
} from "./tree.js";
import { getVoiceBackendStatus, transcribeAudio } from "./voice.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const EXTENSION_UI_TIMEOUT_MS = 60_000;

type TelegramChatId = number | string;
type ContextKey = string;

type PendingCommandPicker = {
  messageId: number;
  entries: CommandPickerEntry[];
  filter: CommandPickerFilter;
  page: number;
};

export function createBot(config: TelePiConfig, sessionRegistry: PiSessionRegistry): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  const chatState = createBotChatState();

  const pendingSessionPicks = new Map<ContextKey, Array<{ path: string; cwd: string }>>();
  const pendingSessionButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingWorkspacePicks = new Map<ContextKey, string[]>();
  const pendingWorkspaceButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingModelPicks = new Map<ContextKey, PiSessionModelOption[]>();
  const pendingModelButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingModelExtraButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingTreeNavs = new Map<ContextKey, string>();
  const pendingTreeButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingTreeFilterButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingBranchButtons = new Map<ContextKey, KeyboardItem[]>();
  const pendingCommandPickers = new Map<ContextKey, PendingCommandPicker>();
  const chatScopedCommandSignatures = new Map<TelegramChatId, string>();

  const getContextKey = (target: PiSessionContext): ContextKey => getPiSessionContextKey(target);
  const getExistingSession = (target: PiSessionContext): PiSessionService | undefined => sessionRegistry.get(target);
  const getOrCreateSession = async (target: PiSessionContext): Promise<PiSessionService> =>
    sessionRegistry.getOrCreate(target);

  const extensionDialogs = createExtensionDialogManager({
    getContextKey,
    sendTextMessage: (target, text, options) => sendTextMessage(bot.api, target, text, options),
    editMessage: (target, messageId, text, options) => safeEditMessage(bot, target, messageId, text, options),
    defaultTimeoutMs: EXTENSION_UI_TIMEOUT_MS,
  });

  const buildKeyboard = (
    items: KeyboardItem[],
    page: number,
    prefix: string,
    extraItems: KeyboardItem[] = [],
  ): InlineKeyboard => {
    const { keyboard } = paginateKeyboard(items, page, prefix);
    return appendKeyboardItems(keyboard, extraItems);
  };

  const syncChatScopedCommands = async (
    target: PiSessionContext,
    slashCommands: SlashCommandInfo[],
  ): Promise<void> => {
    const commands = buildChatScopedCommands(slashCommands);
    const signature = buildChatScopedCommandSignature(commands);
    const previousSignature = chatScopedCommandSignatures.get(target.chatId);
    if (signature === previousSignature) {
      return;
    }

    // Telegram command scopes are chat-scoped, not topic-scoped, so messageThreadId
    // is intentionally ignored here. In forum chats, the most recently synced topic wins.
    await bot.api.setMyCommands(commands, {
      scope: {
        type: "chat",
        chat_id: target.chatId,
      },
    });
    chatScopedCommandSignatures.set(target.chatId, signature);
  };

  const refreshChatScopedCommands = async (
    target: PiSessionContext,
    piSession: PiSessionService,
  ): Promise<void> => {
    try {
      const slashCommands = await piSession.listSlashCommands();
      await syncChatScopedCommands(target, slashCommands);
    } catch (error) {
      console.error("Failed to sync chat-scoped Telegram commands", error);
    }
  };

  const setPendingTreeKeyboard = (contextKey: ContextKey, buttons: KeyboardItem[]): InlineKeyboard => {
    const { navButtons, filterButtons } = splitTreeKeyboardItems(buttons);
    pendingTreeButtons.set(contextKey, navButtons);
    pendingTreeFilterButtons.set(contextKey, filterButtons);
    return buildKeyboard(navButtons, 0, "tree", filterButtons);
  };

  const clearPendingTreeKeyboard = (contextKey: ContextKey): void => {
    pendingTreeButtons.delete(contextKey);
    pendingTreeFilterButtons.delete(contextKey);
  };

  const clearContextPickers = (contextKey: ContextKey): void => {
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);
    pendingModelPicks.delete(contextKey);
    pendingModelButtons.delete(contextKey);
    pendingModelExtraButtons.delete(contextKey);
    pendingTreeNavs.delete(contextKey);
    pendingTreeButtons.delete(contextKey);
    pendingTreeFilterButtons.delete(contextKey);
    pendingBranchButtons.delete(contextKey);
    pendingCommandPickers.delete(contextKey);
  };

  const clearContextPromptMemory = (target: PiSessionContext): void => {
    chatState.clearPromptMemory(target);
  };

  const isBusy = (target: PiSessionContext): boolean => {
    const piSession = getExistingSession(target);
    return chatState.isLocallyBusy(target) || piSession?.isStreaming() === true;
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    const target = getTelegramTarget(ctx);
    const pendingDialogKind = target ? extensionDialogs.getPendingKind(target) : undefined;
    const message = pendingDialogKind === "input"
      ? "Please answer the pending prompt above or use /abort."
      : pendingDialogKind
        ? "Please answer the pending dialog above."
        : "Still working on previous message...";
    await safeReply(ctx, escapeHTML(message), {
      fallbackText: message,
    }, target);
  };

  const ensureActiveSession = async (ctx: Context, target: PiSessionContext): Promise<PiSessionService | undefined> => {
    const existing = getExistingSession(target);
    if (existing?.hasActiveSession()) {
      return existing;
    }

    try {
      const piSession = existing ?? (await getOrCreateSession(target));
      if (!piSession.hasActiveSession()) {
        await piSession.newSession();
      }
      return piSession;
    } catch (error) {
      const failure = renderPrefixedError("Failed to create session", error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return undefined;
    }
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<ContextKey, KeyboardItem[]>,
    expiredMessage: string,
    extraButtonsMap?: Map<ContextKey, KeyboardItem[]>,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const target = getTelegramTarget(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);

      if (!target || !messageId || Number.isNaN(page)) {
        return;
      }

      const contextKey = getContextKey(target);
      const buttons = buttonsMap.get(contextKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }

      await ctx.answerCallbackQuery();

      try {
        const keyboard = buildKeyboard(buttons, page, prefix, extraButtonsMap?.get(contextKey) ?? []);
        await bot.api.editMessageReplyMarkup(target.chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  const handleUserPrompt = createPromptHandler({
    bot,
    toolVerbosity: config.toolVerbosity,
    editDebounceMs: EDIT_DEBOUNCE_MS,
    typingIntervalMs: TYPING_INTERVAL_MS,
    isBusy,
    beginProcessing: (target, promptText) => chatState.beginProcessing(target, promptText),
    endProcessing: (target) => chatState.endProcessing(target),
    ensureActiveSession,
    syncChatScopedCommands,
    refreshChatScopedCommands,
    extensionDialogs,
    sendBusyReply,
  });

  const renderCommandPickerState = (picker: PendingCommandPicker): RenderedText & {
    replyMarkup: InlineKeyboard;
    page: number;
    filteredEntries: CommandPickerEntry[];
  } => {
    const filteredEntries = filterCommandPickerEntries(picker.entries, picker.filter);
    const totalPages = Math.max(1, Math.ceil(filteredEntries.length / KEYBOARD_PAGE_SIZE));
    const page = Math.max(0, Math.min(picker.page, totalPages - 1));
    const pageEntries = filteredEntries.slice(page * KEYBOARD_PAGE_SIZE, (page + 1) * KEYBOARD_PAGE_SIZE);
    const counts = getCommandPickerCounts(picker.entries);

    const keyboard = new InlineKeyboard();
    for (const entry of pageEntries) {
      keyboard.text(trimLine(entry.label, 48), `cmd_pick_${entry.id}`).row();
    }

    if (totalPages > 1) {
      if (page > 0) {
        keyboard.text("◀️ Prev", `cmd_page_${page - 1}`);
      }
      keyboard.text(`${page + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
      if (page < totalPages - 1) {
        keyboard.text("Next ▶️", `cmd_page_${page + 1}`);
      }
      keyboard.row();
    }

    const filterButtons: Array<{ filter: CommandPickerFilter; icon: string }> = [
      { filter: "all", icon: "🧭" },
      { filter: "telepi", icon: "📱" },
      { filter: "pi", icon: "⚡" },
    ];
    for (const button of filterButtons) {
      const active = picker.filter === button.filter;
      const label = `${active ? "✅ " : ""}${button.icon} ${getCommandPickerFilterName(button.filter)} ${counts[button.filter]}`;
      keyboard.text(label, `cmd_filter_${button.filter}`);
    }
    keyboard.row();

    const summary = filteredEntries.length === 0
      ? `No ${getCommandPickerFilterName(picker.filter)} commands available.`
      : `Showing ${page * KEYBOARD_PAGE_SIZE + 1}-${page * KEYBOARD_PAGE_SIZE + pageEntries.length} of ${filteredEntries.length} ${getCommandPickerFilterName(picker.filter)} commands.`;

    const plainLines = [
      "Command picker",
      `Filter: ${getCommandPickerFilterName(picker.filter)}`,
      `Page: ${page + 1}/${totalPages}`,
      summary,
      "",
      ...(pageEntries.length > 0
        ? pageEntries.map((entry) => {
          const detail = entry.kind === "pi" ? `${entry.description} [${entry.source}]` : entry.description;
          return `${entry.label.replace(/^[^/]+\s*/, "") } — ${detail}`;
        })
        : [picker.filter === "pi" ? "No Pi commands found in this session." : "No commands found for this filter."]),
      "",
      "Tap a button below to run a command.",
    ];

    const htmlLines = [
      "<b>Command picker</b>",
      `<i>Filter:</i> <b>${escapeHTML(getCommandPickerFilterName(picker.filter))}</b>`,
      `<i>Page:</i> ${page + 1}/${totalPages}`,
      `<i>${escapeHTML(summary)}</i>`,
      "",
      ...(pageEntries.length > 0
        ? pageEntries.map((entry) => entry.kind === "pi"
          ? `${escapeHTML(entry.label)} — ${escapeHTML(entry.description)} <i>(${escapeHTML(entry.source)})</i>`
          : `${escapeHTML(entry.label)} — ${escapeHTML(entry.description)}`)
        : [picker.filter === "pi" ? "<i>No Pi commands found in this session.</i>" : "<i>No commands found for this filter.</i>"]),
      "",
      "Tap a button below to run a command.",
    ];

    return {
      text: htmlLines.join("\n"),
      fallbackText: plainLines.join("\n"),
      parseMode: "HTML",
      replyMarkup: keyboard,
      page,
      filteredEntries,
    };
  };

  const openCommandPicker = async (
    ctx: Context,
    target: PiSessionContext,
    options?: { messageId?: number; filter?: CommandPickerFilter; page?: number },
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const piSession = await getOrCreateSession(target);

    let slashCommands: SlashCommandInfo[];
    try {
      slashCommands = await piSession.listSlashCommands();
    } catch (error) {
      const failure = renderPrefixedError("Failed to load commands", error);
      if (options?.messageId) {
        await safeEditMessage(bot, target, options.messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
      return;
    }

    try {
      await syncChatScopedCommands(target, slashCommands);
    } catch (error) {
      console.error("Failed to sync chat-scoped Telegram commands", error);
    }

    const picker: PendingCommandPicker = {
      messageId: options?.messageId ?? 0,
      entries: buildCommandPickerEntries(slashCommands),
      filter: options?.filter ?? "all",
      page: options?.page ?? 0,
    };
    const rendered = renderCommandPickerState(picker);
    picker.page = rendered.page;

    if (options?.messageId) {
      await safeEditMessage(bot, target, options.messageId, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
        replyMarkup: rendered.replyMarkup,
      });
      picker.messageId = options.messageId;
      pendingCommandPickers.set(contextKey, picker);
      return;
    }

    const message = await sendTextMessage(ctx.api, target, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: rendered.replyMarkup,
    });
    picker.messageId = message.message_id;
    pendingCommandPickers.set(contextKey, picker);
  };

  const getPendingCommandPicker = (
    target: PiSessionContext,
    messageId?: number,
  ): { contextKey: ContextKey; picker: PendingCommandPicker } | undefined => {
    if (!messageId) {
      return undefined;
    }

    const contextKey = getContextKey(target);
    const picker = pendingCommandPickers.get(contextKey);
    if (!picker || picker.messageId !== messageId) {
      return undefined;
    }

    return { contextKey, picker };
  };

  const basicCommandHandlers = createBasicCommandHandlers({
    sessionRegistry,
    getExistingSession,
    getOrCreateSession,
    refreshChatScopedCommands,
    openCommandPicker,
    handleUserPrompt,
    getLastPrompt: (target) => chatState.getLastPrompt(target),
    extensionDialogs,
    getVoiceBackendStatus,
    safeReply,
  });
  const {
    handleStartCommand,
    handleHelpCommand,
    handleCommandsCommand,
    handleAbortCommand,
    handleSessionCommand,
    handleRetryCommand,
  } = basicCommandHandlers;

  const sessionCommandHandlers = createSessionCommandHandlers({
    getContextKey,
    getOrCreateSession,
    getExistingSession,
    isBusy,
    beginSwitching: (target) => chatState.beginSwitching(target),
    endSwitching: (target) => chatState.endSwitching(target),
    buildKeyboard,
    clearContextPickers,
    clearContextPromptMemory,
    refreshChatScopedCommands,
    syncChatScopedCommands,
    setChatCommandSignature: (chatId, signature) => {
      if (signature === undefined) {
        chatScopedCommandSignatures.delete(chatId);
      } else {
        chatScopedCommandSignatures.set(chatId, signature);
      }
    },
    removeSession: (target) => sessionRegistry.remove(target),
    pendingSessionPicks,
    pendingSessionButtons,
    pendingWorkspacePicks,
    pendingWorkspaceButtons,
    safeReply,
  });
  const { handleSessionsCommand, handleNewCommand, handleHandbackCommand } = sessionCommandHandlers;

  const modelCommandHandlers = createModelCommandHandlers({
    getContextKey,
    getOrCreateSession,
    isBusy,
    refreshChatScopedCommands,
    pendingModelPicks,
    pendingModelButtons,
    pendingModelExtraButtons,
    buildKeyboard,
    safeReply,
    safeEditMessage: (target, messageId, text, options) => safeEditMessage(bot, target, messageId, text, options),
  });
  const { renderModelPicker, handleModelCommand } = modelCommandHandlers;

  const treeCommandHandlers = createTreeCommandHandlers({
    getContextKey,
    getExistingSession,
    isBusy,
    pendingTreeNavs,
    pendingBranchButtons,
    clearPendingTreeKeyboard,
    setPendingTreeKeyboard,
    buildKeyboard,
    safeReply,
  });
  const { collectLabelsMap, handleTreeCommand, handleBranchCommand, handleLabelCommand } = treeCommandHandlers;

  const runTelePiPickerCommand = async (
    ctx: Context,
    target: PiSessionContext,
    command: string,
  ): Promise<void> => {
    switch (command) {
      case "start":
        await handleStartCommand(ctx, target);
        return;
      case "help":
        await handleHelpCommand(ctx, target);
        return;
      case "abort":
        await handleAbortCommand(ctx, target);
        return;
      case "session":
        await handleSessionCommand(ctx, target);
        return;
      case "sessions":
        await handleSessionsCommand(ctx, target, "/sessions");
        return;
      case "new":
        await handleNewCommand(ctx, target);
        return;
      case "handback":
        await handleHandbackCommand(ctx, target);
        return;
      case "model":
        await handleModelCommand(ctx, target);
        return;
      case "tree":
        await handleTreeCommand(ctx, target, "/tree");
        return;
      case "branch":
        await safeReply(ctx, escapeHTML("Use /branch <entry-id> with an ID from /tree."), {
          fallbackText: "Use /branch <entry-id> with an ID from /tree.",
        }, target);
        return;
      case "label":
        await handleLabelCommand(ctx, target, "/label");
        return;
      case "retry":
        await handleRetryCommand(ctx, target);
        return;
      default:
        await safeReply(ctx, escapeHTML(`Command not available from picker: /${command}`), {
          fallbackText: `Command not available from picker: /${command}`,
        }, target);
        return;
    }
  };

  bot.command("start", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleStartCommand(ctx, target);
  });

  bot.command("help", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleHelpCommand(ctx, target);
  });

  bot.command("commands", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleCommandsCommand(ctx, target);
  });

  bot.command("abort", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleAbortCommand(ctx, target);
  });

  bot.command("session", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleSessionCommand(ctx, target);
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleSessionsCommand(ctx, target);
  });

  bot.command("new", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleNewCommand(ctx, target);
  });

  bot.command("handback", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleHandbackCommand(ctx, target);
  });

  bot.command("model", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleModelCommand(ctx, target);
  });

  bot.command("tree", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleTreeCommand(ctx, target);
  });

  bot.command("branch", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleBranchCommand(ctx, target);
  });

  bot.command("label", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleLabelCommand(ctx, target);
  });

  bot.command("retry", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    await handleRetryCommand(ctx, target);
  });

  bot.callbackQuery("pi_abort", async (ctx) => {
    const target = getTelegramTarget(ctx);
    await ctx.answerCallbackQuery({ text: "Aborting..." });
    if (!target) {
      return;
    }

    await getExistingSession(target)?.abort();
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^ui_sel_([a-z0-9]+)_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const dialogId = ctx.match?.[1];
    const optionIndex = Number.parseInt(ctx.match?.[2] ?? "", 10);
    if (!target || !dialogId || Number.isNaN(optionIndex)) {
      return;
    }

    const result = await extensionDialogs.resolveSelect(
      target,
      dialogId,
      ctx.callbackQuery.message?.message_id,
      optionIndex,
    );
    await ctx.answerCallbackQuery({ text: result.callbackText });
    await result.afterAnswer?.();
  });

  bot.callbackQuery(/^ui_cfm_([a-z0-9]+)_(yes|no)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const dialogId = ctx.match?.[1];
    const answer = ctx.match?.[2];
    if (!target || !dialogId || !answer) {
      return;
    }

    const result = await extensionDialogs.resolveConfirm(
      target,
      dialogId,
      ctx.callbackQuery.message?.message_id,
      answer === "yes",
    );
    await ctx.answerCallbackQuery({ text: result.callbackText });
    await result.afterAnswer?.();
  });

  bot.callbackQuery(/^ui_x_([a-z0-9]+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const dialogId = ctx.match?.[1];
    if (!target || !dialogId) {
      return;
    }

    const result = await extensionDialogs.resolveCancel(
      target,
      dialogId,
      ctx.callbackQuery.message?.message_id,
    );
    await ctx.answerCallbackQuery({ text: result.callbackText });
    await result.afterAnswer?.();
  });

  handlePageCallback(/^switch_page_(\d+)$/, "switch", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^newws_page_(\d+)$/, "newws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again", pendingModelExtraButtons);
  handlePageCallback(
    /^tree_page_(\d+)$/,
    "tree",
    pendingTreeButtons,
    "Expired, run /tree again",
    pendingTreeFilterButtons,
  );
  handlePageCallback(/^branch_page_(\d+)$/, "branch", pendingBranchButtons, "Expired, run /branch again");

  bot.callbackQuery(/^cmd_page_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || !messageId || Number.isNaN(page)) {
      return;
    }

    const activePicker = getPendingCommandPicker(target, messageId);
    if (!activePicker) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    activePicker.picker.page = page;
    const rendered = renderCommandPickerState(activePicker.picker);
    activePicker.picker.page = rendered.page;
    pendingCommandPickers.set(activePicker.contextKey, activePicker.picker);

    await ctx.answerCallbackQuery();
    await safeEditMessage(bot, target, messageId, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: rendered.replyMarkup,
    });
  });

  bot.callbackQuery(/^cmd_filter_(all|telepi|pi)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const filter = ctx.match?.[1] as CommandPickerFilter | undefined;

    if (!target || !messageId || !filter) {
      return;
    }

    const activePicker = getPendingCommandPicker(target, messageId);
    if (!activePicker) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    activePicker.picker.filter = filter;
    activePicker.picker.page = 0;
    const rendered = renderCommandPickerState(activePicker.picker);
    activePicker.picker.page = rendered.page;
    pendingCommandPickers.set(activePicker.contextKey, activePicker.picker);

    await ctx.answerCallbackQuery({ text: `Showing ${getCommandPickerFilterName(filter)} commands` });
    await safeEditMessage(bot, target, messageId, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: rendered.replyMarkup,
    });
  });

  bot.callbackQuery(/^cmd_pick_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || !messageId || Number.isNaN(index)) {
      return;
    }

    const activePicker = getPendingCommandPicker(target, messageId);
    if (!activePicker) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    const entry = activePicker.picker.entries.find((item) => item.id === index);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Expired, run /commands again" });
      return;
    }

    if (entry.kind === "pi") {
      if (isBusy(target)) {
        await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
        return;
      }

      pendingCommandPickers.delete(activePicker.contextKey);
      await ctx.answerCallbackQuery({ text: `Running ${trimLine(entry.commandText, 32)}` });
      await handleUserPrompt(ctx, target, entry.commandText);
      return;
    }

    pendingCommandPickers.delete(activePicker.contextKey);
    await ctx.answerCallbackQuery({ text: `Opening ${trimLine(entry.commandText, 32)}` });
    await runTelePiPickerCommand(ctx, target, entry.command);
  });

  bot.callbackQuery(/^switch_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || Number.isNaN(index)) {
      return;
    }

    const contextKey = getContextKey(target);
    const sessions = pendingSessionPicks.get(contextKey);
    if (!sessions || !sessions[index]) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const piSession = await getOrCreateSession(target);
    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const resolvedSession = await piSession.resolveSessionReference(sessions[index].path);
      const info = await piSession.switchSession(resolvedSession.path, resolvedSession.cwd);
      await refreshChatScopedCommands(target, piSession);
      clearPendingTreeKeyboard(contextKey);
      clearContextPromptMemory(target);
      const workspaceNotePlain = resolvedSession.workspaceWarning
        ? `\n\nWorkspace note: ${resolvedSession.workspaceWarning}`
        : "";
      const workspaceNoteHTML = resolvedSession.workspaceWarning
        ? `\n\n<b>Workspace note:</b> ${escapeHTML(resolvedSession.workspaceWarning)}`
        : "";
      const plainText = `Switched!${workspaceNotePlain}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched!</b>${workspaceNoteHTML}\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plainText });
        return;
      }

      await safeReply(ctx, html, { fallbackText: plainText }, target);
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery(/^newws_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || Number.isNaN(index)) {
      return;
    }

    const contextKey = getContextKey(target);
    const workspaces = pendingWorkspacePicks.get(contextKey);
    if (!workspaces || !workspaces[index]) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const piSession = await getOrCreateSession(target);
    await ctx.answerCallbackQuery({ text: "Creating session..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const { info, created } = await piSession.newSession(workspaces[index]);
      if (!created) {
        const html = escapeHTML("New session was cancelled.");
        if (messageId) {
          await safeEditMessage(bot, target, messageId, html, { fallbackText: "New session was cancelled." });
        }
        return;
      }

      await refreshChatScopedCommands(target, piSession);
      clearPendingTreeKeyboard(contextKey);
      clearContextPromptMemory(target);
      const plainText = `New session created.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>New session created.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plainText });
        return;
      }

      await safeReply(ctx, html, { fallbackText: plainText }, target);
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery("model_show_all", async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;

    if (!target || !messageId) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);
    const models = pendingModelPicks.get(contextKey);
    if (!models || models.length === 0 || !piSession) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Loading all models..." });
    await renderModelPicker(ctx, target, piSession, { showAll: true, messageId });
  });

  bot.callbackQuery(/^model_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || Number.isNaN(index)) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);
    const models = pendingModelPicks.get(contextKey);
    if (!models || !models[index] || !piSession) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching model..." });
    pendingModelPicks.delete(contextKey);
    pendingModelButtons.delete(contextKey);
    pendingModelExtraButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const modelName = await piSession.setModel(models[index].provider, models[index].id, models[index].thinkingLevel);
      const html = `<b>Model switched to:</b> <code>${escapeHTML(modelName)}</code>`;
      const plainText = `Model switched to: ${modelName}`;

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText }, target);
      }
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
        return;
      }

      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery(/^tree_nav_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!target || !entryId) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await ctx.answerCallbackQuery({ text: "No active session" });
      return;
    }

    const entry = piSession.getEntry(entryId);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Entry not found" });
      return;
    }

    const leafId = piSession.getLeafId();
    if (entry.id === leafId) {
      await ctx.answerCallbackQuery({ text: "Already at this point" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Loading..." });

    const confirmation = renderBranchConfirmation(
      entry,
      piSession.getChildren(entry.id),
      leafId,
      collectLabelsMap(piSession),
    );
    pendingTreeNavs.set(contextKey, entry.id);
    pendingBranchButtons.set(contextKey, confirmation.buttons);

    const keyboard = buildKeyboard(confirmation.buttons, 0, "branch");

    if (messageId) {
      await safeEditMessage(bot, target, messageId, confirmation.text, {
        fallbackText: stripHtml(confirmation.text),
        replyMarkup: keyboard,
      });
    } else {
      await safeReply(ctx, confirmation.text, {
        fallbackText: stripHtml(confirmation.text),
        replyMarkup: keyboard,
      }, target);
    }
  });

  bot.callbackQuery(/^tree_go_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!target || !entryId) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const pendingId = pendingTreeNavs.get(contextKey);
    if (pendingId !== entryId || !piSession) {
      await ctx.answerCallbackQuery({ text: "Confirmation expired. Use /branch again." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Navigating..." });
    pendingTreeNavs.delete(contextKey);
    pendingBranchButtons.delete(contextKey);
    pendingTreeButtons.delete(contextKey);
    pendingTreeFilterButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const result = await piSession.navigateTree(entryId);
      if (result.cancelled) {
        const html = escapeHTML("Navigation cancelled.");
        if (messageId) {
          await safeEditMessage(bot, target, messageId, html, { fallbackText: "Navigation cancelled." });
        } else {
          await safeReply(ctx, "Navigation cancelled.", { fallbackText: "Navigation cancelled.", parseMode: undefined }, target);
        }
        return;
      }

      let html = `<b>✅ Navigated to</b> <code>${escapeHTML(entryId.slice(0, 8))}</code>`;
      let plain = `✅ Navigated to ${entryId.slice(0, 8)}`;
      if (result.editorText) {
        html += `\n\nRe-submit: <i>${escapeHTML(truncateText(result.editorText, 200))}</i>`;
        plain += `\n\nRe-submit: ${truncateText(result.editorText, 200)}`;
      }
      html += "\n\nSend your next message to create a new branch from this point.";
      plain += "\n\nSend your next message to create a new branch from this point.";

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain }, target);
      }
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery(/^tree_sum_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!target || !entryId) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const pendingId = pendingTreeNavs.get(contextKey);
    if (pendingId !== entryId || !piSession) {
      await ctx.answerCallbackQuery({ text: "Confirmation expired. Use /branch again." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Navigating with summary..." });
    pendingTreeNavs.delete(contextKey);
    pendingBranchButtons.delete(contextKey);
    pendingTreeButtons.delete(contextKey);
    pendingTreeFilterButtons.delete(contextKey);

    chatState.beginSwitching(target);
    try {
      const result = await piSession.navigateTree(entryId, { summarize: true });
      if (result.cancelled) {
        const html = escapeHTML("Navigation cancelled.");
        if (messageId) {
          await safeEditMessage(bot, target, messageId, html, { fallbackText: "Navigation cancelled." });
        } else {
          await safeReply(ctx, "Navigation cancelled.", { fallbackText: "Navigation cancelled.", parseMode: undefined }, target);
        }
        return;
      }

      let html = `<b>✅ Navigated to</b> <code>${escapeHTML(entryId.slice(0, 8))}</code>\n📝 Branch summary saved.`;
      let plain = `✅ Navigated to ${entryId.slice(0, 8)}\n📝 Branch summary saved.`;
      if (result.editorText) {
        html += `\n\nRe-submit: <i>${escapeHTML(truncateText(result.editorText, 200))}</i>`;
        plain += `\n\nRe-submit: ${truncateText(result.editorText, 200)}`;
      }
      html += "\n\nSend your next message to create a new branch from this point.";
      plain += "\n\nSend your next message to create a new branch from this point.";

      if (messageId) {
        await safeEditMessage(bot, target, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain }, target);
      }
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(bot, target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      chatState.endSwitching(target);
    }
  });

  bot.callbackQuery("tree_cancel", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (target) {
      const contextKey = getContextKey(target);
      pendingTreeNavs.delete(contextKey);
      pendingBranchButtons.delete(contextKey);
      pendingTreeButtons.delete(contextKey);
      pendingTreeFilterButtons.delete(contextKey);
    }
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    const messageId = ctx.callbackQuery.message?.message_id;
    if (target && messageId) {
      await safeEditMessage(bot, target, messageId, escapeHTML("Navigation cancelled."), {
        fallbackText: "Navigation cancelled.",
      });
    }
  });

  bot.callbackQuery(/^tree_mode_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    const mode = ctx.match?.[1];
    if (!target || !messageId) {
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await ctx.answerCallbackQuery({ text: "No active session" });
      return;
    }

    await ctx.answerCallbackQuery();

    let filterMode: TreeFilterMode = "default";
    if (mode === "all") {
      filterMode = "all-with-buttons";
    } else if (mode === "user") {
      filterMode = "user-only";
    }

    const result = renderTree(piSession.getTree(), piSession.getLeafId(), { mode: filterMode });
    const keyboard = result.buttons.length > 0 ? setPendingTreeKeyboard(contextKey, result.buttons) : undefined;

    if (!keyboard) {
      clearPendingTreeKeyboard(contextKey);
    }

    await safeEditMessage(bot, target, messageId, result.text, {
      fallbackText: stripHtml(result.text),
      replyMarkup: keyboard,
    });
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText) {
      return;
    }

    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    const contextKey = getContextKey(target);
    const normalizedSlashCommand = normalizeSlashCommand(userText, bot.botInfo?.username);
    if (normalizedSlashCommand && TELEPI_LOCAL_COMMAND_NAMES.has(normalizedSlashCommand.name)) {
      return;
    }
    if (!normalizedSlashCommand && userText.startsWith("/")) {
      return;
    }

    if (await extensionDialogs.consumeInput(target, userText)) {
      return;
    }

    if (extensionDialogs.hasPending(target)) {
      await safeReply(ctx, escapeHTML("Please answer the pending dialog above."), {
        fallbackText: "Please answer the pending dialog above.",
      }, target);
      return;
    }

    if (normalizedSlashCommand) {
      const piSession = await getOrCreateSession(target);
      const slashCommands = await piSession.listSlashCommands();
      void syncChatScopedCommands(target, slashCommands).catch((error) => {
        console.error("Failed to sync chat-scoped Telegram commands", error);
      });
      const knownSlashCommands = new Set(slashCommands.map((command) => command.name));
      if (!knownSlashCommands.has(normalizedSlashCommand.name)) {
        await safeReply(ctx, escapeHTML("Unknown command. Use /commands to see available Pi slash commands."), {
          fallbackText: "Unknown command. Use /commands to see available Pi slash commands.",
        }, target);
        return;
      }

      await handleUserPrompt(ctx, target, normalizedSlashCommand.text, slashCommands);
      return;
    }

    await handleUserPrompt(ctx, target, userText);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) {
      return;
    }

    const contextKey = getContextKey(target);
    if (isBusy(target)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    chatState.beginTranscribing(target);
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await sendChatAction(ctx.api, target, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        }, target);
        return;
      }

      const preview = truncateText(transcript.replace(/\s+/g, " "), 240);
      await safeReply(
        ctx,
        `🎤 ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎤 ${preview} (via ${result.backend})` },
        target,
      );
    } catch (error) {
      const failure = renderPrefixedError("Transcription failed", error, true);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return;
    } finally {
      chatState.endTranscribing(target);
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    await handleUserPrompt(ctx, target, transcript);
  });

  bot.catch((error) => {
    console.error("Telegram bot error:", formatError(error.error));
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([...TELEPI_BOT_COMMANDS]);
}
