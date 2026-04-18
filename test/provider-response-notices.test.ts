import { describe, expect, it, vi } from "vitest";

import {
  createProviderResponseNoticeExtension,
  getProviderResponseNotice,
} from "../src/provider-response-notices.js";

describe("getProviderResponseNotice", () => {
  it("returns an auth notice for provider 401 and 403 responses", () => {
    expect(getProviderResponseNotice({ status: 401, headers: {} })).toEqual({
      message: "Provider authentication failed (HTTP 401). Check API credentials or provider access.",
      type: "error",
    });
    expect(getProviderResponseNotice({ status: 403, headers: {} })).toEqual({
      message: "Provider authentication failed (HTTP 403). Check API credentials or provider access.",
      type: "error",
    });
  });

  it("includes retry-after hints for rate-limited responses", () => {
    expect(getProviderResponseNotice({
      status: 429,
      headers: {
        "Retry-After": "12",
      },
    })).toEqual({
      message: "Provider rate limit reached (HTTP 429). Please retry shortly. Retry after 12 seconds.",
      type: "warning",
    });
  });

  it("surfaces degraded upstream warnings from headers on failed responses", () => {
    expect(getProviderResponseNotice({
      status: 503,
      headers: {
        Warning: '199 api "Upstream service is degraded"',
      },
    })).toEqual({
      message: "Provider appears unavailable or degraded (HTTP 503). Please retry later. Provider warning: Upstream service is degraded.",
      type: "warning",
    });
  });

  it("keeps successful 2xx responses silent even when headers include warnings", () => {
    expect(getProviderResponseNotice({
      status: 204,
      headers: {
        warning: '199 api "degraded but recovered"',
      },
    })).toBeUndefined();
  });
});

describe("createProviderResponseNoticeExtension", () => {
  it("registers an after_provider_response hook that notifies Telegram only for provider issues", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on: vi.fn((event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
        handlers.set(event, handler);
      }),
    } as any;

    createProviderResponseNoticeExtension()(pi);

    expect(pi.on).toHaveBeenCalledWith("after_provider_response", expect.any(Function));

    const notify = vi.fn();
    const handler = handlers.get("after_provider_response");

    expect(handler).toBeTypeOf("function");

    await handler?.(
      {
        type: "after_provider_response",
        status: 429,
        headers: { "retry-after": "9" },
      },
      {
        ui: { notify },
      },
    );

    expect(notify).toHaveBeenCalledWith(
      "Provider rate limit reached (HTTP 429). Please retry shortly. Retry after 9 seconds.",
      "warning",
    );

    notify.mockClear();

    await handler?.(
      {
        type: "after_provider_response",
        status: 200,
        headers: { warning: '199 api "should stay silent"' },
      },
      {
        ui: { notify },
      },
    );

    expect(notify).not.toHaveBeenCalled();
  });
});
