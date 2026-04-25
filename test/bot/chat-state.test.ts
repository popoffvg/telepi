import { createBotChatState } from "../../src/bot/chat-state.js";

describe("bot chat state", () => {
  it("tracks busy state and prompt memory per chat/topic", () => {
    const state = createBotChatState();
    const root = { chatId: 123 };
    const topic = { chatId: 123, messageThreadId: 456 };

    expect(state.isLocallyBusy(root)).toBe(false);
    expect(state.getLastPrompt(root)).toBeUndefined();

    state.beginProcessing(root, "hello");
    expect(state.isLocallyBusy(root)).toBe(true);
    expect(state.getLastPrompt(root)).toBe("hello");
    expect(state.isLocallyBusy(topic)).toBe(false);
    expect(state.getLastPrompt(topic)).toBeUndefined();

    state.endProcessing(root);
    expect(state.isLocallyBusy(root)).toBe(false);

    state.beginSwitching(topic);
    expect(state.isLocallyBusy(topic)).toBe(true);
    state.endSwitching(topic);
    expect(state.isLocallyBusy(topic)).toBe(false);

    state.beginTranscribing(topic);
    expect(state.isLocallyBusy(topic)).toBe(true);
    state.endTranscribing(topic);
    expect(state.isLocallyBusy(topic)).toBe(false);

    state.clearPromptMemory(root);
    expect(state.getLastPrompt(root)).toBeUndefined();
  });
});
