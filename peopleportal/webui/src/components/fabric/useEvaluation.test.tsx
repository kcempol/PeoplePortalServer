import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEvaluation } from "./useEvaluation";
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const options = { teamPk: "team", applicationId: "app", preference: { role: "Engineer", subteamPk: "sub" }, refresh: 0, onConfigured: vi.fn() };
const response = (status: string) => ({ ok: true, json: async () => ({ configured: true, label: "Experimental", evaluation: { status } }) });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("initial load errors are visible and manual retry recovers without terminal polling", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(response("scored"));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useEvaluation(options));
    await act(async () => {});
    expect(result.current.error).toContain("Could not load"); expect(result.current.result).toBeNull();
    await act(async () => { result.current.retryLoad(); });
    expect(result.current.error).toBeNull(); expect(result.current.result?.evaluation?.status).toBe("scored");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
});

test("polling waits for completion and stops at a terminal result", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(response("failed"));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useEvaluation(options));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(response("processing")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(result.current.result?.evaluation?.status).toBe("failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
});

test("changing application aborts the old request and ignores its late response", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(response("stale"));
    vi.stubGlobal("fetch", fetch);
    const { result, rerender } = renderHook(({ applicationId }) => useEvaluation({ ...options, applicationId }), { initialProps: { applicationId: "old" } });
    const oldSignal = fetch.mock.calls[0][1].signal;
    rerender({ applicationId: "new" }); await act(async () => {});
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolve(response("scored")); });
    expect(result.current.result?.evaluation?.status).toBe("stale");
});

test("refresh during a deferred queue action does not leave the panel busy", async () => {
    let finish!: (value: unknown) => void;
    const fetch = vi.fn((_url, init) => init.method === "POST" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response("scored")));
    vi.stubGlobal("fetch", fetch);
    const { result, rerender } = renderHook(({ refresh }) => useEvaluation({ ...options, refresh }), { initialProps: { refresh: 0 } });
    await act(async () => {});
    let queued!: Promise<void>;
    act(() => { queued = result.current.queue(false); }); expect(result.current.busy).toBe(true);
    rerender({ refresh: 1 }); await act(async () => {});
    await act(async () => { finish(response("queued")); await queued; });
    expect(result.current.busy).toBe(false);
});

const rejectOnAbort = (signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
});

test("load timeouts abort requests and retry attempts are capped", async () => {
    const fetch = vi.fn((_url, init) => rejectOnAbort(init.signal));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useEvaluation(options));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(result.current.error).toContain("Could not load");
    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
    expect(fetch).toHaveBeenCalledTimes(5);
});

test("queue timeout clears busy state", async () => {
    const fetch = vi.fn((_url, init) => init.method === "POST" ? rejectOnAbort(init.signal) : Promise.resolve(response("scored")));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useEvaluation(options)); await act(async () => {});
    let queued!: Promise<void>; act(() => { queued = result.current.queue(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); await queued; });
    expect(result.current.busy).toBe(false);
});

test("switching application during a POST ignores its late queue result", async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn((_url, init) => init.method === "POST" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response("scored"))));
    const { result, rerender } = renderHook(({ applicationId }) => useEvaluation({ ...options, applicationId }), { initialProps: { applicationId: "old" } });
    await act(async () => {});
    let queued!: Promise<void>; act(() => { queued = result.current.queue(false); });
    rerender({ applicationId: "new" }); await act(async () => {});
    await act(async () => { finish(response("queued")); await queued; });
    expect(result.current.result?.evaluation?.status).toBe("scored"); expect(result.current.busy).toBe(false);
});
