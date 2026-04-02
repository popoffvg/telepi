import { InlineKeyboard } from "grammy";

import { appendKeyboardItems, paginateKeyboard, type KeyboardItem } from "../../src/bot/keyboard.js";

describe("bot keyboard helpers", () => {
  it("paginates keyboard items and adds navigation controls", () => {
    const items: KeyboardItem[] = Array.from({ length: 8 }, (_, index) => ({
      label: `Item ${index + 1}`,
      callbackData: `item_${index + 1}`,
    }));

    const firstPage = paginateKeyboard(items, 0, "pick").keyboard;
    expect(firstPage.inline_keyboard.slice(0, 6).map((row) => row[0]?.text)).toEqual([
      "Item 1",
      "Item 2",
      "Item 3",
      "Item 4",
      "Item 5",
      "Item 6",
    ]);
    expect(firstPage.inline_keyboard[6]).toEqual([
      { text: "1/2", callback_data: "noop_page" },
      { text: "Next ▶️", callback_data: "pick_page_1" },
    ]);

    const secondPage = paginateKeyboard(items, 1, "pick").keyboard;
    expect(secondPage.inline_keyboard.slice(0, 2).map((row) => row[0]?.text)).toEqual(["Item 7", "Item 8"]);
    expect(secondPage.inline_keyboard[2]).toEqual([
      { text: "◀️ Prev", callback_data: "pick_page_0" },
      { text: "2/2", callback_data: "noop_page" },
    ]);
  });

  it("clamps requested page numbers into the valid range", () => {
    const items: KeyboardItem[] = Array.from({ length: 2 }, (_, index) => ({
      label: `Item ${index + 1}`,
      callbackData: `item_${index + 1}`,
    }));

    expect(paginateKeyboard(items, -10, "pick").keyboard.inline_keyboard[0][0]).toEqual({
      text: "Item 1",
      callback_data: "item_1",
    });
    expect(paginateKeyboard(items, 99, "pick").keyboard.inline_keyboard[1][0]).toEqual({
      text: "Item 2",
      callback_data: "item_2",
    });
  });

  it("appends extra keyboard items on separate rows", () => {
    const keyboard = new InlineKeyboard().text("Base", "base");

    appendKeyboardItems(keyboard, [
      { label: "Extra 1", callbackData: "extra_1" },
      { label: "Extra 2", callbackData: "extra_2" },
    ]);

    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "Base", callback_data: "base" },
        { text: "Extra 1", callback_data: "extra_1" },
      ],
      [{ text: "Extra 2", callback_data: "extra_2" }],
      [],
    ]);
  });

});
