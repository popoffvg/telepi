import type { Context } from "grammy";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionService } from "../../pi-session.js";
import { renderBranchConfirmation, renderLabels, renderTree, type TreeFilterMode } from "../../tree.js";
import { stripHtml } from "../message-rendering.js";
import type { KeyboardItem } from "../keyboard.js";
import type { TextOptions } from "../telegram-transport.js";

export function createTreeCommandHandlers(deps: {
  getContextKey: (target: PiSessionContext) => string;
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  isBusy: (target: PiSessionContext) => boolean;
  pendingTreeNavs: Map<string, string>;
  pendingBranchButtons: Map<string, KeyboardItem[]>;
  clearPendingTreeKeyboard: (contextKey: string) => void;
  setPendingTreeKeyboard: (contextKey: string, buttons: KeyboardItem[]) => any;
  buildKeyboard: (items: KeyboardItem[], page: number, prefix: string, extraItems?: KeyboardItem[]) => any;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
}) {
  const {
    getContextKey,
    getExistingSession,
    isBusy,
    pendingTreeNavs,
    pendingBranchButtons,
    clearPendingTreeKeyboard,
    setPendingTreeKeyboard,
    buildKeyboard,
    safeReply,
  } = deps;

  const collectLabelsMap = (piSession: PiSessionService): Map<string, string> => {
    const labels = new Map<string, string>();
    const walk = (node: { entry: { id: string }; children: any[]; label?: string }): void => {
      if (node.label) {
        labels.set(node.entry.id, node.label);
      }
      for (const child of node.children) {
        walk(child);
      }
    };

    for (const root of piSession.getTree()) {
      walk(root);
    }

    return labels;
  };

  const handleTreeCommand = async (
    ctx: Context,
    target: PiSessionContext,
    commandText?: string,
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await safeReply(ctx, escapeHTML("Cannot view tree while a prompt is running."), {
        fallbackText: "Cannot view tree while a prompt is running.",
      }, target);
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session. Send a message to start one."), {
        fallbackText: "No active session. Send a message to start one.",
      }, target);
      return;
    }

    const rawText = commandText ?? ctx.message?.text ?? "";
    const arg = rawText.replace(/^\/tree(?:@\w+)?\s*/, "").trim().toLowerCase();
    let mode: TreeFilterMode = "default";
    if (arg === "all") {
      mode = "all-with-buttons";
    } else if (arg === "user") {
      mode = "user-only";
    }

    const tree = piSession.getTree();
    const leafId = piSession.getLeafId();
    const result = renderTree(tree, leafId, { mode });

    if (result.buttons.length === 0) {
      clearPendingTreeKeyboard(contextKey);
      await safeReply(ctx, result.text, { fallbackText: stripHtml(result.text) }, target);
      return;
    }

    const keyboard = setPendingTreeKeyboard(contextKey, result.buttons);

    await safeReply(ctx, result.text, {
      fallbackText: stripHtml(result.text),
      replyMarkup: keyboard,
    }, target);
  };

  const handleBranchCommand = async (
    ctx: Context,
    target: PiSessionContext,
    commandText?: string,
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await safeReply(ctx, escapeHTML("Cannot navigate while a prompt is running."), {
        fallbackText: "Cannot navigate while a prompt is running.",
      }, target);
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session."), { fallbackText: "No active session." }, target);
      return;
    }

    const rawText = commandText ?? ctx.message?.text ?? "";
    const entryId = rawText.replace(/^\/branch(?:@\w+)?\s*/, "").trim();
    if (!entryId) {
      await safeReply(ctx, escapeHTML("Usage: /branch <entry-id>\nUse /tree to see entry IDs."), {
        fallbackText: "Usage: /branch <entry-id>\nUse /tree to see entry IDs.",
      }, target);
      return;
    }

    const entry = piSession.getEntry(entryId);
    if (!entry) {
      await safeReply(ctx, escapeHTML(`Entry not found: ${entryId}`), {
        fallbackText: `Entry not found: ${entryId}`,
      }, target);
      return;
    }

    const leafId = piSession.getLeafId();
    if (entry.id === leafId) {
      await safeReply(ctx, escapeHTML("You're already at this point."), {
        fallbackText: "You're already at this point.",
      }, target);
      return;
    }

    const children = piSession.getChildren(entry.id);
    const confirmation = renderBranchConfirmation(entry, children, leafId, collectLabelsMap(piSession));

    pendingTreeNavs.set(contextKey, entry.id);
    pendingBranchButtons.set(contextKey, confirmation.buttons);

    await safeReply(ctx, confirmation.text, {
      fallbackText: stripHtml(confirmation.text),
      replyMarkup: buildKeyboard(confirmation.buttons, 0, "branch"),
    }, target);
  };

  const handleLabelCommand = async (
    ctx: Context,
    target: PiSessionContext,
    commandText?: string,
  ): Promise<void> => {
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await safeReply(ctx, escapeHTML("Cannot label entries while a prompt is running."), {
        fallbackText: "Cannot label entries while a prompt is running.",
      }, target);
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session."), { fallbackText: "No active session." }, target);
      return;
    }

    const rawText = commandText ?? ctx.message?.text ?? "";
    const args = rawText.replace(/^\/label(?:@\w+)?\s*/, "").trim();

    if (!args) {
      const labelsText = renderLabels(piSession.getTree());
      await safeReply(ctx, labelsText, { fallbackText: stripHtml(labelsText) }, target);
      return;
    }

    const clearMatch = args.match(/^clear\s+(\S+)/i);
    if (clearMatch) {
      const targetId = clearMatch[1];
      const entry = piSession.getEntry(targetId);
      if (!entry) {
        await safeReply(ctx, escapeHTML(`Entry not found: ${targetId}`), {
          fallbackText: `Entry not found: ${targetId}`,
        }, target);
        return;
      }

      piSession.setLabel(targetId, "");
      await safeReply(ctx, `🏷️ Label cleared on <code>${escapeHTML(targetId)}</code>`, {
        fallbackText: `🏷️ Label cleared on ${targetId}`,
      }, target);
      return;
    }

    const parts = args.split(/\s+/);
    if (parts.length >= 2) {
      const maybeId = parts[0];
      const entry = piSession.getEntry(maybeId);
      if (entry) {
        const labelName = parts.slice(1).join(" ");
        piSession.setLabel(maybeId, labelName);
        await safeReply(
          ctx,
          `🏷️ Label <b>${escapeHTML(labelName)}</b> set on <code>${escapeHTML(maybeId)}</code>`,
          {
            fallbackText: `🏷️ Label "${labelName}" set on ${maybeId}`,
          },
          target,
        );
        return;
      }
    }

    const leafId = piSession.getLeafId();
    if (!leafId) {
      await safeReply(ctx, escapeHTML("No current leaf to label. Send a message first."), {
        fallbackText: "No current leaf to label. Send a message first.",
      }, target);
      return;
    }

    piSession.setLabel(leafId, args);
    await safeReply(
      ctx,
      `🏷️ Label <b>${escapeHTML(args)}</b> set on current leaf <code>${escapeHTML(leafId)}</code>`,
      {
        fallbackText: `🏷️ Label "${args}" set on current leaf ${leafId}`,
      },
      target,
    );
  };

  return {
    collectLabelsMap,
    handleTreeCommand,
    handleBranchCommand,
    handleLabelCommand,
  };
}
