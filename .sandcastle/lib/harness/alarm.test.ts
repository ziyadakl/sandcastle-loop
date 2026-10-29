import { describe, expect, it, vi } from "vitest";

import { raiseAlarm } from "./alarm.js";

describe("raiseAlarm", () => {
  it("always logs loudly, even when NTFY_TOPIC is unset", async () => {
    const logError = vi.fn();
    const result = await raiseAlarm(
      { title: "Could not grade", body: "the page never settled", issueNumber: 912 },
      { topic: undefined, logError },
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("NTFY_TOPIC unset");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("ALARM: [issue=912] Could not grade — the page never settled"),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("ntfy push skipped: NTFY_TOPIC unset"),
    );
  });

  it("pushes a real HTTP request to https://ntfy.sh/<topic> when a topic is configured", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const logError = vi.fn();
    const result = await raiseAlarm(
      { title: "Could not grade", body: "the page never settled" },
      { topic: "test-topic-123", fetchImpl, logError },
    );
    expect(result.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/test-topic-123");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Title).toBe("Could not grade");
    expect(init.body).toBe("the page never settled");
  });

  it("reports (and logs) a non-ok ntfy response as not sent, without throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    const logError = vi.fn();
    const result = await raiseAlarm(
      { title: "x", body: "y" },
      { topic: "t", fetchImpl, logError },
    );
    expect(result).toEqual({ sent: false, reason: "ntfy HTTP 500" });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("ntfy push failed: ntfy HTTP 500"));
  });

  it("reports a network failure as not sent, without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const logError = vi.fn();
    const result = await raiseAlarm(
      { title: "x", body: "y" },
      { topic: "t", fetchImpl, logError },
    );
    expect(result).toEqual({ sent: false, reason: "network unreachable" });
  });

  it("passes an abort signal that actually fires — a wedged endpoint cannot stall this forever", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Never resolves on its own — only the abort signal this call
          // was given can end it. If `raiseAlarm` stopped passing a
          // signal, this promise (and the test) would hang until the
          // suite's own timeout, not resolve in time.
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const logError = vi.fn();
    const result = await raiseAlarm(
      { title: "x", body: "y" },
      { topic: "t", fetchImpl, logError, timeoutMs: 20 },
    );
    expect(result.sent).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("strips CR/LF from the title before it reaches an HTTP header", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const logError = vi.fn();
    await raiseAlarm(
      { title: "Ticket stopped: stopped:could-not-grade\r\nX-Injected: evil", body: "y" },
      { topic: "t", fetchImpl, logError },
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const title = (init.headers as Record<string, string>).Title;
    expect(title).not.toContain("\r");
    expect(title).not.toContain("\n");
    expect(title).toBe(
      "Ticket stopped: stopped:could-not-grade X-Injected: evil",
    );
  });
});
