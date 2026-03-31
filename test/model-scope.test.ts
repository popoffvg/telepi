import { describe, expect, it, vi } from "vitest";

import { resolveInitialScopedModelSelection, resolveScopedModels } from "../src/model-scope.js";

const models = [
  { provider: "anthropic", id: "claude-sonnet-4-5-20250514", name: "Claude Sonnet" },
  { provider: "anthropic", id: "claude-sonnet-latest", name: "Claude Sonnet Latest" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o Mini" },
] as any;

describe("model-scope helpers", () => {
  it("resolves exact, glob, and thinking-level scoped models without duplicates", async () => {
    const settingsManager = {
      getEnabledModels: vi.fn().mockReturnValue([
        "anthropic/claude-sonnet-*",
        "gpt-4o:high",
        "gpt-4o",
        "  ",
      ]),
    } as any;
    const modelRegistry = {
      getAvailable: vi.fn().mockResolvedValue(models),
    } as any;

    await expect(resolveScopedModels(settingsManager, modelRegistry)).resolves.toEqual([
      { model: models[0], thinkingLevel: undefined },
      { model: models[1], thinkingLevel: undefined },
      { model: models[2], thinkingLevel: "high" },
    ]);
  });

  it("warns when no models match a configured pattern", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const settingsManager = {
      getEnabledModels: vi.fn().mockReturnValue(["missing-model", "missing-*:high"]),
    } as any;
    const modelRegistry = {
      getAvailable: vi.fn().mockResolvedValue(models),
    } as any;

    await expect(resolveScopedModels(settingsManager, modelRegistry)).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("prefers configured and default scoped models when choosing the initial model", () => {
    const settingsManager = {
      getDefaultProvider: vi.fn().mockReturnValue("openai"),
      getDefaultModel: vi.fn().mockReturnValue("gpt-4o"),
    } as any;
    const modelRegistry = {
      find: vi.fn().mockReturnValue(models[2]),
    } as any;
    const scopedModels = [
      { model: models[0], thinkingLevel: undefined },
      { model: models[2], thinkingLevel: "high" },
    ];

    expect(resolveInitialScopedModelSelection({
      configuredModel: undefined,
      scopedModels,
      settingsManager,
      modelRegistry,
      hasExistingSession: false,
    })).toEqual({ model: models[2], thinkingLevel: "high" });

    expect(resolveInitialScopedModelSelection({
      configuredModel: models[1],
      scopedModels,
      settingsManager,
      modelRegistry,
      hasExistingSession: false,
    })).toEqual({ model: models[1], thinkingLevel: undefined });

    expect(resolveInitialScopedModelSelection({
      configuredModel: undefined,
      scopedModels,
      settingsManager,
      modelRegistry,
      hasExistingSession: true,
    })).toEqual({ model: undefined, thinkingLevel: undefined });
  });

  it("falls back to aliases and partial name matches", async () => {
    const settingsManager = {
      getEnabledModels: vi.fn().mockReturnValue(["sonnet", "mini"]),
    } as any;
    const modelRegistry = {
      getAvailable: vi.fn().mockResolvedValue(models),
    } as any;

    await expect(resolveScopedModels(settingsManager, modelRegistry)).resolves.toEqual([
      { model: models[1], thinkingLevel: undefined },
      { model: models[3], thinkingLevel: undefined },
    ]);
  });
});
