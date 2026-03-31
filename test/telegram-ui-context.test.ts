import { describe, expect, it, vi } from "vitest";

import { createTelegramUIContext } from "../src/telegram-ui-context.js";

describe("createTelegramUIContext", () => {
  it("forwards notifications to the provided callback", () => {
    const notify = vi.fn();
    const ui = createTelegramUIContext({ notify });

    ui.notify("Something happened", "warning");

    expect(notify).toHaveBeenCalledWith("Something happened", "warning");
  });

  it("delegates interactive UI methods when handlers are provided", async () => {
    const ui = createTelegramUIContext({
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue("b"),
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn().mockResolvedValue("Bene"),
    });

    await expect(ui.select("Pick one", ["a", "b"]))
      .resolves.toBe("b");
    await expect(ui.confirm("Confirm", "Continue?"))
      .resolves.toBe(true);
    await expect(ui.input("Name"))
      .resolves.toBe("Bene");
  });

  it("fails clearly for unsupported interactive UI methods", async () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });

    await expect(ui.select("Pick one", ["a", "b"]))
      .rejects.toThrow("TelePi does not yet support extension UI method 'select'.");
    await expect(ui.confirm("Confirm", "Continue?"))
      .rejects.toThrow("TelePi does not yet support extension UI method 'confirm'.");
    await expect(ui.input("Name"))
      .rejects.toThrow("TelePi does not yet support extension UI method 'input'.");
  });
});
