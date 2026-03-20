import {
  describeEntry,
  renderBranchConfirmation,
  renderLabels,
  renderTree,
  type SessionTreeNodeLike as SessionTreeNode,
} from "../src/tree.js";

function makeNode(
  overrides: Partial<any> & { type: string; id: string },
  children: SessionTreeNode[] = [],
  label?: string,
): SessionTreeNode {
  return {
    entry: {
      type: overrides.type,
      id: overrides.id,
      parentId: overrides.parentId ?? null,
      timestamp: overrides.timestamp ?? "2025-01-01T00:00:00Z",
      ...overrides,
    },
    children,
    label,
  } as SessionTreeNode;
}

function makeMessageNode(
  id: string,
  role: string,
  content: string | any[],
  parentId: string | null = null,
  children: SessionTreeNode[] = [],
  label?: string,
  messageOverrides: Record<string, unknown> = {},
): SessionTreeNode {
  return makeNode(
    {
      type: "message",
      id,
      parentId,
      message: { role, content, timestamp: Date.now(), ...messageOverrides },
    },
    children,
    label,
  );
}

describe("tree rendering", () => {
  describe("describeEntry", () => {
    it("describes user and assistant messages", () => {
      expect(
        describeEntry({
          type: "message",
          message: { role: "user", content: "Help me refactor this function please" },
        }),
      ).toBe('user: "Help me refactor this function please"');

      expect(
        describeEntry({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "First block" }, { type: "text", text: "Second block" }],
          },
        }),
      ).toBe('user: "First block Second block"');

      expect(
        describeEntry({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Here is a clean approach" }] },
        }),
      ).toBe('assistant: "Here is a clean approach"');
    });

    it("handles assistant tool calls, tool results, and other entry types", () => {
      expect(
        describeEntry({
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        }),
      ).toBe("assistant: [tool read]");

      expect(
        describeEntry({
          type: "message",
          message: { role: "toolResult", toolName: "bash", content: [] },
        }),
      ).toBe("toolResult: bash");

      expect(describeEntry({ type: "compaction" })).toBe("[compaction]");
      expect(describeEntry({ type: "branch_summary" })).toBe("[branch summary]");
      expect(
        describeEntry({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" }),
      ).toBe("[model anthropic/claude-sonnet-4-5]");
      expect(describeEntry({ type: "unknownType" })).toBe("[unknownType]");
    });
  });

  describe("renderTree", () => {
    it("returns an empty message for an empty tree", () => {
      const result = renderTree([], null);

      expect(result).toEqual({
        text: "Session tree is empty.",
        buttons: [],
        totalEntries: 0,
        shownEntries: 0,
      });
    });

    it("renders a linear tree with filter buttons only", () => {
      const tree = [
        makeMessageNode(
          "aaaa1111",
          "user",
          "Start here",
          null,
          [makeMessageNode("bbbb2222", "assistant", "Sure", "aaaa1111", [makeMessageNode("cccc3333", "user", "Next", "bbbb2222")])],
        ),
      ];

      const result = renderTree(tree, "cccc3333");

      expect(result.text).toContain("<pre>");
      expect(result.text).toContain("aaaa user: \"Start here\"");
      expect(result.text).toContain("└─ bbbb assistant");
      expect(result.text).toContain("← active");
      expect(result.buttons.map((button) => button.callbackData)).toEqual(["tree_mode_all", "tree_mode_user"]);
    });

    it("renders branch buttons, labels, pagination notes, and active markers", () => {
      const tree = [
        makeMessageNode(
          "root0001",
          "user",
          "Start",
          null,
          [
            makeMessageNode(
              "asst0002",
              "assistant",
              "Choose a path",
              "root0001",
              [
                makeMessageNode("usr00003", "user", "Path A", "asst0002"),
                makeMessageNode("usr00004", "user", "Path B", "asst0002", [], "checkpoint"),
              ],
            ),
          ],
        ),
      ];

      const result = renderTree(tree, "usr00003");
      const callbackData = result.buttons.map((button) => button.callbackData);

      expect(result.text).toContain("├─ usr0 user: \"Path A\" ← active");
      expect(result.text).toContain("└─ usr0 user: \"Path B\" [checkpoint]");
      expect(result.text).toContain("└─ asst assistant: \"Choose a path\"");
      expect(callbackData).toContain("tree_nav_asst0002");
      expect(callbackData).toContain("tree_nav_usr00004");
    });

    it("supports pagination, user-only mode, and all-with-buttons mode", () => {
      const tree = [
        makeMessageNode(
          "u0000001",
          "user",
          "one",
          null,
          [
            makeMessageNode("a0000002", "assistant", "two", "u0000001", [
              makeMessageNode("u0000003", "user", "three", "a0000002", [
                makeNode({ type: "compaction", id: "c0000004", parentId: "u0000003", tokensBefore: 12345, summary: "Short" }, [
                  makeMessageNode("u0000005", "user", "four", "c0000004", [
                    makeMessageNode("a0000006", "assistant", "five", "u0000005", [
                      makeMessageNode("u0000007", "user", "six", "a0000006"),
                    ]),
                  ]),
                ]),
              ]),
            ]),
          ],
        ),
      ];

      const paged = renderTree(tree, "u0000007", { limit: 3 });
      expect(paged.totalEntries).toBe(7);
      expect(paged.shownEntries).toBe(3);
      expect(paged.text).toContain("Showing 3 of 7 entries.");

      const userOnly = renderTree(tree, "u0000007", { mode: "user-only", limit: 10 });
      expect(userOnly.text).toContain("Filter: user messages only.");
      expect(userOnly.text).toContain('user: "one"');
      expect(userOnly.text).not.toContain('assistant: "two"');
      expect(userOnly.buttons.some((button) => button.callbackData === "tree_nav_u0000001")).toBe(true);

      const allMode = renderTree(tree, "u0000007", { mode: "all-with-buttons", limit: 10 });
      expect(allMode.text).toContain("Filter: all entries with navigation buttons.");
      expect(allMode.buttons.some((button) => button.callbackData === "tree_nav_u0000001")).toBe(true);
      expect(allMode.buttons.some((button) => button.callbackData === "tree_nav_a0000002")).toBe(true);
      expect(allMode.buttons.some((button) => button.callbackData === "tree_nav_c0000004")).toBe(true);
    });

    it("renders a realistic complex tree", () => {
      const tree = [
        makeMessageNode(
          "1111aaaa",
          "user",
          "Investigate production latency spike",
          null,
          [
            makeMessageNode(
              "2222bbbb",
              "assistant",
              "I'll inspect the logs and recent deploys",
              "1111aaaa",
              [
                makeNode({ type: "model_change", id: "3333cccc", parentId: "2222bbbb", provider: "anthropic", modelId: "claude-sonnet-4-5" }, [
                  makeMessageNode("4444dddd", "user", "Focus on API timeouts first", "3333cccc", [], "api-timeouts"),
                  makeNode({ type: "branch_summary", id: "5555eeee", parentId: "3333cccc", fromId: "4444dddd", summary: "Abandoned infra angle" }, [
                    makeMessageNode("6666ffff", "user", "Now check database saturation", "5555eeee"),
                  ]),
                ]),
              ],
            ),
          ],
        ),
      ];

      const result = renderTree(tree, "6666ffff", { mode: "all-with-buttons" });

      expect(result.text).toContain('1111 user: "Investigate production latency spike"');
      expect(result.text).toContain("[model anthropic/claude-sonnet-4-5]");
      expect(result.text).toContain("[branch summary]");
      expect(result.text).toContain("[api-timeouts]");
      expect(result.text).toContain("← active");
      expect(result.buttons.some((button) => button.callbackData === "tree_nav_5555eeee")).toBe(true);
    });
  });

  describe("renderBranchConfirmation", () => {
    it("shows entry details, children, labels, and action buttons", () => {
      const result = renderBranchConfirmation(
        { type: "message", id: "aaaa1111", message: { role: "user", content: "Branch from here" } },
        [
          { type: "message", id: "bbbb2222", message: { role: "assistant", content: "Active child" } },
          { type: "message", id: "cccc3333", message: { role: "user", content: "Named child" } },
        ],
        "bbbb2222",
        new Map([["cccc3333", "saved"]]),
      );

      expect(result.text).toContain("Navigate to this point?");
      expect(result.text).toContain("Branch from here");
      expect(result.text).toContain("Children");
      expect(result.text).toContain("← active");
      expect(result.text).toContain("[saved]");
      expect(result.buttons).toEqual([
        { label: "🔀 Navigate here", callbackData: "tree_go_aaaa1111" },
        { label: "📝 Navigate + Summarize", callbackData: "tree_sum_aaaa1111" },
        { label: "❌ Cancel", callbackData: "tree_cancel" },
      ]);
    });
  });

  describe("renderLabels", () => {
    it("returns a fallback when there are no labels", () => {
      expect(renderLabels([makeMessageNode("aaaa1111", "user", "No labels yet")])).toBe("No labels set.");
    });

    it("renders multiple labels", () => {
      const tree = [
        makeMessageNode(
          "aaaa1111",
          "user",
          "Start",
          null,
          [
            makeMessageNode("bbbb2222", "assistant", "Middle", "aaaa1111", [makeMessageNode("cccc3333", "user", "End", "bbbb2222", [], "done")], "checkpoint"),
          ],
        ),
      ];

      const rendered = renderLabels(tree);
      expect(rendered).toContain("🏷️ <code>bbbb</code> <b>[checkpoint]</b>");
      expect(rendered).toContain("🏷️ <code>cccc</code> <b>[done]</b>");
      expect(rendered).toContain("assistant");
      expect(rendered).toContain("user");
    });
  });
});
