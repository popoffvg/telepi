import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export interface SessionTreeNodeLike {
  entry: SessionEntry;
  children: SessionTreeNodeLike[];
  label?: string;
}

import { escapeHTML } from "./format.js";

const DEFAULT_TREE_LIMIT = 10;
const TELEGRAM_TREE_TEXT_LIMIT = 3900;
const ENTRY_DESCRIPTION_LIMIT = 50;
const BUTTON_LABEL_DESCRIPTION_LIMIT = 28;

type TreeEntryLike = { type: string; id?: string; [key: string]: any };

type DisplayNode = {
  node: SessionTreeNodeLike;
  children: DisplayNode[];
};

type FlatDisplayNode = {
  node: SessionTreeNodeLike;
  depth: number;
  isLast: boolean;
  ancestorHasNext: boolean[];
};

export interface TreeButton {
  label: string;
  callbackData: string;
}

export interface TreeRenderResult {
  text: string;
  buttons: TreeButton[];
  totalEntries: number;
  shownEntries: number;
}

export type TreeFilterMode = "default" | "user-only" | "all-with-buttons";

export function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) {
    return "";
  }

  if (text.length <= maxLen) {
    return text;
  }

  if (maxLen === 1) {
    return "…";
  }

  return `${text.slice(0, maxLen - 1)}…`;
}

export function describeEntry(entry: TreeEntryLike): string {
  switch (entry.type) {
    case "message": {
      const role = entry.message?.role;
      if (role === "user") {
        return `user: ${formatQuotedText(extractTextContent(entry.message?.content))}`;
      }

      if (role === "assistant") {
        const text = extractTextContent(entry.message?.content);
        if (text) {
          return `assistant: ${formatQuotedText(text)}`;
        }

        const toolName = extractToolCallName(entry.message?.content);
        if (toolName) {
          return `assistant: [tool ${toolName}]`;
        }

        return "assistant: [no text]";
      }

      if (role === "toolResult") {
        return `toolResult: ${entry.message?.toolName ?? "tool"}`;
      }

      if (role) {
        return `[${role}]`;
      }

      return "[message]";
    }
    case "compaction":
      return "[compaction]";
    case "branch_summary":
      return "[branch summary]";
    case "model_change":
      return `[model ${entry.provider ?? "unknown"}/${entry.modelId ?? "unknown"}]`;
    case "thinking_level_change":
      return `[thinking level ${entry.thinkingLevel ?? "unknown"}]`;
    case "custom":
    case "custom_message":
      return `[custom ${entry.customType ?? "unknown"}]`;
    case "label":
      return `[label ${entry.label ?? ""}]`;
    case "session_info":
      return `[session ${entry.name ?? "unnamed"}]`;
    default:
      return `[${entry.type}]`;
  }
}

export function renderTree(
  tree: SessionTreeNodeLike[],
  leafId: string | null,
  options: {
    mode?: TreeFilterMode;
    limit?: number;
  } = {},
): TreeRenderResult {
  if (tree.length === 0) {
    return {
      text: "Session tree is empty.",
      buttons: [],
      totalEntries: 0,
      shownEntries: 0,
    };
  }

  const mode = options.mode ?? "default";
  const limit = Math.max(1, options.limit ?? DEFAULT_TREE_LIMIT);
  const displayTree = buildDisplayTree(tree, mode);
  const flattened = flattenDisplayTree(displayTree);

  if (flattened.length === 0) {
    return {
      text: wrapTreeText("No matching entries."),
      buttons: buildFilterButtons(mode),
      totalEntries: 0,
      shownEntries: 0,
    };
  }

  const totalEntries = flattened.length;
  let visibleNodes = flattened.slice(-limit);
  let omittedByLimit = totalEntries - visibleNodes.length;
  let omittedByLength = 0;

  const renderedLines = (): string[] => visibleNodes.map((flatNode) => renderTreeLine(flatNode, leafId));

  let html = buildTreeHtml(renderedLines(), totalEntries, visibleNodes.length, omittedByLimit, omittedByLength, mode);
  while (html.length > TELEGRAM_TREE_TEXT_LIMIT && visibleNodes.length > 1) {
    visibleNodes = visibleNodes.slice(1);
    omittedByLength += 1;
    html = buildTreeHtml(renderedLines(), totalEntries, visibleNodes.length, omittedByLimit, omittedByLength, mode);
  }

  const buttons = buildTreeButtons(visibleNodes, leafId, mode);

  return {
    text: html,
    buttons,
    totalEntries,
    shownEntries: visibleNodes.length,
  };
}

export function renderBranchConfirmation(
  entry: { type: string; id: string; [key: string]: any },
  children: Array<{ type: string; id: string; [key: string]: any }>,
  leafId: string | null,
  labels: Map<string, string>,
): { text: string; buttons: TreeButton[] } {
  const lines = [
    "<b>Navigate to this point?</b>",
    "",
    `${renderEntryRef(entry.id)} ${escapeHTML(describeEntry(entry))}`,
  ];

  if (children.length > 0) {
    lines.push("", "<b>Children</b>");
    for (const child of children) {
      const active = child.id === leafId ? " ← active" : "";
      const label = labels.get(child.id);
      const labelText = label ? ` <b>[${escapeHTML(label)}]</b>` : "";
      lines.push(`${renderEntryRef(child.id)} ${escapeHTML(describeEntry(child))}${labelText}${escapeHTML(active)}`);
    }
  }

  lines.push("", "Choose how to navigate:");

  return {
    text: lines.join("\n"),
    buttons: [
      { label: "🔀 Navigate here", callbackData: `tree_go_${entry.id}` },
      { label: "📝 Navigate + Summarize", callbackData: `tree_sum_${entry.id}` },
      { label: "❌ Cancel", callbackData: "tree_cancel" },
    ],
  };
}

export function renderLabels(tree: SessionTreeNodeLike[]): string {
  const labeled: string[] = [];

  const walk = (node: SessionTreeNodeLike): void => {
    if (node.label) {
      labeled.push(
        `🏷️ ${renderEntryRef(node.entry.id)} <b>[${escapeHTML(node.label)}]</b> — ${escapeHTML(describeEntry(node.entry))}`,
      );
    }

    for (const child of node.children) {
      walk(child);
    }
  };

  for (const root of tree) {
    walk(root);
  }

  if (labeled.length === 0) {
    return "No labels set.";
  }

  return labeled.join("\n");
}

function buildDisplayTree(tree: SessionTreeNodeLike[], mode: TreeFilterMode): DisplayNode[] {
  const result: DisplayNode[] = [];

  for (const node of tree) {
    const visibleChildren = buildDisplayTree(node.children, mode);
    if (shouldIncludeEntry(node.entry, mode)) {
      result.push({ node, children: visibleChildren });
    } else {
      result.push(...visibleChildren);
    }
  }

  return result;
}

function flattenDisplayTree(nodes: DisplayNode[], depth = 0, ancestorHasNext: boolean[] = []): FlatDisplayNode[] {
  const result: FlatDisplayNode[] = [];

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    result.push({
      node: node.node,
      depth,
      isLast,
      ancestorHasNext,
    });
    result.push(...flattenDisplayTree(node.children, depth + 1, [...ancestorHasNext, !isLast]));
  });

  return result;
}

function shouldIncludeEntry(entry: SessionEntry, mode: TreeFilterMode): boolean {
  if (mode === "user-only") {
    return entry.type === "message" && entry.message.role === "user";
  }

  return true;
}

function renderTreeLine(flatNode: FlatDisplayNode, leafId: string | null): string {
  const { node, depth, isLast, ancestorHasNext } = flatNode;
  const indent = ancestorHasNext.map((hasNext) => (hasNext ? "│  " : "   ")).join("");
  const connector = depth === 0 ? "" : isLast ? "└─ " : "├─ ";
  const shortId = node.entry.id.slice(0, 4);
  const label = node.label ? ` [${node.label}]` : "";
  const active = node.entry.id === leafId ? " ← active" : "";
  return `${indent}${connector}${shortId} ${describeEntry(node.entry)}${label}${active}`;
}

function buildTreeHtml(
  lines: string[],
  totalEntries: number,
  shownEntries: number,
  omittedByLimit: number,
  omittedByLength: number,
  mode: TreeFilterMode,
): string {
  const notes: string[] = [];

  if (omittedByLimit > 0 && omittedByLength > 0) {
    notes.push(`Showing the latest ${shownEntries} of ${totalEntries} entries; ${omittedByLength} more omitted to fit Telegram.`);
  } else if (omittedByLimit > 0) {
    notes.push(`Showing ${shownEntries} of ${totalEntries} entries.`);
  } else if (omittedByLength > 0) {
    notes.push(`… ${omittedByLength} entries omitted to fit Telegram.`);
  }

  if (mode === "user-only") {
    notes.push("Filter: user messages only.");
  } else if (mode === "all-with-buttons") {
    notes.push("Filter: all entries with navigation buttons.");
  }

  const parts = [wrapTreeText(lines.join("\n"))];
  if (notes.length > 0) {
    parts.push(`<i>${escapeHTML(notes.join(" "))}</i>`);
  }

  return parts.join("\n");
}

function buildTreeButtons(
  visibleNodes: FlatDisplayNode[],
  leafId: string | null,
  mode: TreeFilterMode,
): TreeButton[] {
  const buttons: TreeButton[] = [];
  const seenIds = new Set<string>();

  for (const flatNode of visibleNodes) {
    const button = getNavButton(flatNode.node, leafId, mode);
    if (!button || seenIds.has(flatNode.node.entry.id)) {
      continue;
    }

    buttons.push(button);
    seenIds.add(flatNode.node.entry.id);
  }

  buttons.push(...buildFilterButtons(mode));
  return buttons;
}

function getNavButton(node: SessionTreeNodeLike, leafId: string | null, mode: TreeFilterMode): TreeButton | undefined {
  const shortId = node.entry.id.slice(0, 4);
  const description = truncateText(cleanTextForButton(describeEntry(node.entry)), BUTTON_LABEL_DESCRIPTION_LIMIT);

  if (mode === "all-with-buttons") {
    return {
      label: `🔀 ${shortId} — ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (mode === "user-only") {
    return {
      label: `👤 ${shortId} — ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (node.children.length >= 2) {
    return {
      label: `🔀 ${shortId} — ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (node.label) {
    return {
      label: `🏷️ ${shortId} — [${truncateText(node.label, 18)}]`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  if (node.children.length === 0 && node.entry.id !== leafId) {
    return {
      label: `🌿 ${shortId} — ${description}`,
      callbackData: `tree_nav_${node.entry.id}`,
    };
  }

  return undefined;
}

function buildFilterButtons(mode: TreeFilterMode): TreeButton[] {
  const buttons: TreeButton[] = [];

  if (mode !== "default") {
    buttons.push({ label: "🌲 Default view", callbackData: "tree_mode_default" });
  }

  if (mode !== "all-with-buttons") {
    buttons.push({ label: "📄 Show all", callbackData: "tree_mode_all" });
  }

  if (mode !== "user-only") {
    buttons.push({ label: "👤 User only", callbackData: "tree_mode_user" });
  }

  return buttons;
}

function wrapTreeText(text: string): string {
  return `<pre>${escapeHTML(text)}</pre>`;
}

function renderEntryRef(id: string): string {
  return `<code>${escapeHTML(id.slice(0, 4))}</code>`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return normalizeWhitespace(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const text = content
    .filter((item) => typeof item === "object" && item !== null && "type" in item && item.type === "text")
    .map((item) => String((item as { text?: unknown }).text ?? ""))
    .join(" ");

  return normalizeWhitespace(text);
}

function extractToolCallName(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const item of content) {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      continue;
    }

    if (item.type !== "toolCall") {
      continue;
    }

    const maybeName = (item as { name?: unknown }).name;
    if (typeof maybeName === "string" && maybeName.trim()) {
      return maybeName.trim();
    }
  }

  return undefined;
}

function formatQuotedText(text: string): string {
  return `"${truncateText(text || "", ENTRY_DESCRIPTION_LIMIT)}"`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanTextForButton(text: string): string {
  return text.replace(/[\[\]"]+/g, "").replace(/\s+/g, " ").trim();
}
