import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

export type TelegramExtensionNoticeType = "info" | "warning" | "error";

export interface CreateTelegramUIContextOptions {
  notify: (message: string, type?: TelegramExtensionNoticeType) => void;
  select?: (title: string, options: string[], dialogOptions?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
  confirm?: (title: string, message: string, dialogOptions?: { signal?: AbortSignal; timeout?: number }) => Promise<boolean>;
  input?: (title: string, placeholder?: string, dialogOptions?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
}

function unsupported(method: string): never {
  throw new Error(`TelePi does not yet support extension UI method '${method}'.`);
}

export function createTelegramUIContext(options: CreateTelegramUIContextOptions): ExtensionUIContext {
  return {
    async select(title, choices, dialogOptions) {
      if (!options.select) {
        unsupported("select");
      }
      return options.select(title, choices, dialogOptions);
    },
    async confirm(title, message, dialogOptions) {
      if (!options.confirm) {
        unsupported("confirm");
      }
      return options.confirm(title, message, dialogOptions);
    },
    async input(title, placeholder, dialogOptions) {
      if (!options.input) {
        unsupported("input");
      }
      return options.input(title, placeholder, dialogOptions);
    },
    notify(message, type) {
      options.notify(message, type);
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus() {},
    setWorkingMessage() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() {
      unsupported("custom");
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    async editor() {
      unsupported("editor");
    },
    setEditorComponent() {},
    theme: {} as any,
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "TelePi does not support theme switching through extension UI." };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
}
