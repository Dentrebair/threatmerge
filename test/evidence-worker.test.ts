import { describe, expect, it, vi } from "vitest";
import {
  loadEvidenceWorkerConfig,
  processEvidenceBatch,
  runEvidenceWorker,
  type MalwareScanner,
  type ScanJob,
  type WorkerBackend,
} from "../src/workers/evidence-worker.js";

function backend(jobs: ScanJob[]): WorkerBackend & { complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn().mockResolvedValue(jobs), download: vi.fn().mockResolvedValue(new Blob(["invoice"])), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) };
}

describe("evidence worker", () => {
  const job = { id: "job-1", aggregateId: "artifact-1", lockToken: "lease-1" };
  it("completes a clean scan", async () => {
    const store = backend([job]);
    const scanner: MalwareScanner = { scan: vi.fn().mockResolvedValue({ safe: true }) };
    expect(await processEvidenceBatch(store, scanner, "worker-1")).toBe(1);
    expect(store.complete).toHaveBeenCalledWith(job, { safe: true });
    expect(store.fail).not.toHaveBeenCalled();
  });
  it("passes quarantine reasons through without enqueue decisions in worker code", async () => {
    const store = backend([job]);
    const scanner: MalwareScanner = { scan: vi.fn().mockResolvedValue({ safe: false, reason: "MALWARE_DETECTED" }) };
    await processEvidenceBatch(store, scanner, "worker-1");
    expect(store.complete).toHaveBeenCalledWith(job, { safe: false, reason: "MALWARE_DETECTED" });
  });
  it("records scanner outages instead of completing the job", async () => {
    const store = backend([job]);
    const scanner: MalwareScanner = { scan: vi.fn().mockRejectedValue(new Error("scanner unavailable")) };
    await processEvidenceBatch(store, scanner, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "SCANNER_UNAVAILABLE");
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("waits between idle polls instead of busy-looping", async () => {
    const store = backend([]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runEvidenceWorker(store, { scan: vi.fn() }, "worker-1", { maxCycles: 2, idleDelayMs: 250, sleep });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250, undefined);
  });

  it("backs off after a claim failure and recovers on the next cycle", async () => {
    const store = backend([]);
    vi.mocked(store.claim).mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce([job]);
    const scanner: MalwareScanner = { scan: vi.fn().mockResolvedValue({ safe: true }) };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onCycle = vi.fn();
    await runEvidenceWorker(store, scanner, "worker-1", { maxCycles: 2, errorDelayMs: 500, sleep, onCycle });
    expect(sleep).toHaveBeenCalledWith(500, undefined);
    expect(store.complete).toHaveBeenCalledWith(job, { safe: true });
    expect(onCycle.mock.calls[0]?.[0].error.message).toBe("database unavailable");
  });

  it("does not claim work after shutdown was requested", async () => {
    const store = backend([job]);
    const controller = new AbortController();
    controller.abort();
    await runEvidenceWorker(store, { scan: vi.fn() }, "worker-1", { signal: controller.signal });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("validates required configuration and operational bounds", () => {
    expect(() => loadEvidenceWorkerConfig({})).toThrow("SUPABASE_URL");
    expect(() => loadEvidenceWorkerConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "server-only",
      MALWARE_SCANNER_URL: "https://scanner.example.test",
      MALWARE_SCANNER_TOKEN: "scanner-token",
      EVIDENCE_WORKER_BATCH_SIZE: "0",
    })).toThrow("EVIDENCE_WORKER_BATCH_SIZE");
  });
});
