import { createExtensionDialogManager } from "../../src/bot/extension-dialogs.js";
import type { PiSessionContext } from "../../src/pi-session.js";

describe("extension dialog manager", () => {
  const target: PiSessionContext = { chatId: 123 };

  function createManager() {
    const sendTextMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = createExtensionDialogManager({
      getContextKey: (ctx) => `${String(ctx.chatId)}::${ctx.messageThreadId ?? "root"}`,
      sendTextMessage,
      editMessage,
      defaultTimeoutMs: 50,
    });

    return { manager, sendTextMessage, editMessage };
  }

  it("opens and resolves select dialogs after the callback answer step", async () => {
    const { manager, sendTextMessage, editMessage } = createManager();

    const pendingChoice = manager.openSelect(target, "Pick one", ["Alpha", "Beta"]);
    await Promise.resolve();

    expect(sendTextMessage).toHaveBeenCalledWith(target, "<b>Pick one</b>", expect.objectContaining({
      fallbackText: "Pick one",
    }));

    const result = await manager.resolveSelect(target, "1", 1, 1);
    expect(result.callbackText).toBe("Selected Beta");
    expect(editMessage).not.toHaveBeenCalled();

    await result.afterAnswer?.();

    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      "<b>Pick one</b>\n<i>Selected:</i> Beta",
      expect.objectContaining({ fallbackText: "Pick one\nSelected: Beta" }),
    );
    await expect(pendingChoice).resolves.toBe("Beta");
  });

  it("times out dialogs and finalizes them in Telegram", async () => {
    const { manager, editMessage } = createManager();

    const pendingInput = manager.openInput(target, "Name", "Your name", { timeout: 5 });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(pendingInput).resolves.toBeUndefined();
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      "Dialog timed out.",
      expect.objectContaining({ fallbackText: "Dialog timed out." }),
    );
  });

  it("consumes input replies and can cancel pending dialogs", async () => {
    const { manager, editMessage } = createManager();

    expect(await manager.consumeInput(target, "Bene")).toBe(false);

    const pendingInput = manager.openInput(target, "Name", "Your name");
    await Promise.resolve();
    expect(manager.getPendingKind(target)).toBe("input");

    await expect(manager.consumeInput(target, "Bene")).resolves.toBe(true);
    await expect(pendingInput).resolves.toBe("Bene");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      "<b>Name</b>\n<i>Received:</i> Bene",
      expect.objectContaining({ fallbackText: "Name\nReceived: Bene" }),
    );

    const pendingConfirm = manager.openConfirm(target, "Confirm deploy", "Ship it?");
    await Promise.resolve();
    await expect(manager.cancelPending(target)).resolves.toBe(true);
    await expect(pendingConfirm).resolves.toBe(false);
    expect(editMessage).toHaveBeenLastCalledWith(
      target,
      1,
      "Dialog cancelled.",
      expect.objectContaining({ fallbackText: "Dialog cancelled." }),
    );
  });

  it("resolves confirm and cancel callbacks after the callback answer step", async () => {
    const { manager, editMessage } = createManager();

    const pendingConfirm = manager.openConfirm(target, "Confirm deploy", "Ship it?");
    await Promise.resolve();

    const confirmResult = await manager.resolveConfirm(target, "1", 1, true);
    expect(confirmResult.callbackText).toBe("Confirmed");
    expect(editMessage).not.toHaveBeenCalled();
    await confirmResult.afterAnswer?.();
    await expect(pendingConfirm).resolves.toBe(true);
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      "<b>Confirm deploy</b>\n<i>Confirmed</i>",
      expect.objectContaining({ fallbackText: "Confirm deploy\nConfirmed" }),
    );

    const pendingSelect = manager.openSelect(target, "Pick one", ["Alpha"]);
    await Promise.resolve();
    const cancelResult = await manager.resolveCancel(target, "2", 1);
    expect(cancelResult.callbackText).toBe("Cancelled");
    await cancelResult.afterAnswer?.();
    await expect(pendingSelect).resolves.toBeUndefined();
  });

  it("still resolves extension promises when finalizing the dialog message fails", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const editMessage = vi.fn().mockRejectedValue(new Error("telegram down"));
    const manager = createExtensionDialogManager({
      getContextKey: (ctx) => `${String(ctx.chatId)}::${ctx.messageThreadId ?? "root"}`,
      sendTextMessage,
      editMessage,
      defaultTimeoutMs: 50,
    });

    const pendingChoice = manager.openSelect(target, "Pick one", ["Alpha"]);
    await Promise.resolve();

    const result = await manager.resolveSelect(target, "1", 1, 0);
    await expect(result.afterAnswer?.()).rejects.toThrow("telegram down");
    await expect(pendingChoice).resolves.toBe("Alpha");
  });
});
