import { describe, expect, it, vi } from "vitest";
import { loadExtractionWorkerConfig, processExtractionBatch, runExtractionWorker, validateExtractionResult, type DocumentExtractor, type ExtractionBackend, type ExtractionJob } from "../src/workers/extraction-worker.js";

const job: ExtractionJob = { id: "job-1", aggregateId: "artifact-1", lockToken: "lease-1" };
const validResult = {
  provider: "fixture",
  modelVersion: "model-v1",
  promptVersion: "prompt-v1",
  startedAt: "2026-09-22T12:00:00.000Z",
  observations: [{ fieldName: "invoiceNumber", value: "INV-42", sourceLocation: { page: 1 }, confidence: 0.97 }],
};

function backend(jobs: ExtractionJob[]): ExtractionBackend & { complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn().mockResolvedValue(jobs), download: vi.fn().mockResolvedValue(new Blob(["invoice"])), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) };
}

describe("extraction worker", () => {
  it("persists schema-valid observations with run metadata", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockResolvedValue(validResult) };
    expect(await processExtractionBatch(store, extractor, "worker-1")).toBe(1);
    expect(store.complete).toHaveBeenCalledWith(job, validResult);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("rejects out-of-range confidence before persistence", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockResolvedValue({ ...validResult, observations: [{ ...validResult.observations[0], confidence: 1.1 }] }) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "INVALID_EXTRACTION_RESPONSE");
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("rejects more than 200 observations", () => {
    expect(() => validateExtractionResult({ ...validResult, observations: Array.from({ length: 201 }, () => validResult.observations[0]) })).toThrow("observation count");
  });

  it("rejects unsupported fields and malformed field values", () => {
    expect(() => validateExtractionResult({ ...validResult, observations: [{ ...validResult.observations[0], fieldName: "secretInstructions" }] })).toThrow("unsupported field");
    expect(() => validateExtractionResult({ ...validResult, observations: [{ fieldName: "invoiceDate", value: "2026-02-31", sourceLocation: { page: 1 }, confidence: 0.9 }] })).toThrow("invalid invoiceDate");
    expect(() => validateExtractionResult({ ...validResult, observations: [{ fieldName: "total", value: "USD 12.00", sourceLocation: { page: 1 }, confidence: 0.9 }] })).toThrow("invalid total");
  });

  it("requires a real source page and validates optional normalized boxes", () => {
    expect(() => validateExtractionResult({ ...validResult, observations: [{ ...validResult.observations[0], sourceLocation: { page: 0 } }] })).toThrow("invalid source page");
    expect(() => validateExtractionResult({ ...validResult, observations: [{ ...validResult.observations[0], sourceLocation: { page: 1, boundingBox: { x: 0.9, y: 0.1, width: 0.2, height: 0.1 } } }] })).toThrow("invalid source bounding box");
    expect(validateExtractionResult({ ...validResult, observations: [{ ...validResult.observations[0], sourceLocation: { page: 1, boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } } }] }).observations[0]?.sourceLocation).toMatchObject({ page: 1 });
  });

  it("records provider outages as retryable failures", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockRejectedValue(new Error("extractor unavailable (503)")) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "EXTRACTOR_UNAVAILABLE");
  });

  it("records non-invoice validation as a terminal rejection code", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockRejectedValue(new Error("NOT_AN_INVOICE")) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "NOT_AN_INVOICE");
  });

  it("records multiple invoices as a terminal user-action code", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockRejectedValue(new Error("MULTIPLE_INVOICES")) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "MULTIPLE_INVOICES");
  });

  it("treats extractor timeouts as provider outages", async () => {
    const store = backend([job]);
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    const extractor: DocumentExtractor = { extract: vi.fn().mockRejectedValue(timeout) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "EXTRACTOR_UNAVAILABLE");
  });

  it("requires server credentials and extractor configuration", () => {
    expect(() => loadExtractionWorkerConfig({})).toThrow(
      "Missing extraction worker environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENT_EXTRACTOR_URL, DOCUMENT_EXTRACTOR_TOKEN",
    );
  });

  it("validates URLs and polling limits before startup", () => {
    const environment = {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      DOCUMENT_EXTRACTOR_URL: "file:///extract",
      DOCUMENT_EXTRACTOR_TOKEN: "extractor-token",
    };
    expect(() => loadExtractionWorkerConfig(environment)).toThrow("DOCUMENT_EXTRACTOR_URL must be an HTTP(S) URL");
    expect(() => loadExtractionWorkerConfig({ ...environment, DOCUMENT_EXTRACTOR_URL: "https://extract.example", EXTRACTION_WORKER_BATCH_SIZE: "26" }))
      .toThrow("EXTRACTION_WORKER_BATCH_SIZE must be an integer between 1 and 25");
  });

  it("polls again after an idle cycle", async () => {
    const store = backend([]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const cycles: number[] = [];
    await runExtractionWorker(store, { extract: vi.fn() }, "worker-1", {
      maxCycles: 2,
      idleDelayMs: 125,
      sleep,
      onCycle: ({ processed }) => cycles.push(processed),
    });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(125, undefined);
    expect(cycles).toEqual([0, 0]);
  });

  it("backs off after a queue claim error and continues", async () => {
    const store = backend([]);
    vi.mocked(store.claim).mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce([]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const errors: string[] = [];
    await runExtractionWorker(store, { extract: vi.fn() }, "worker-1", {
      maxCycles: 2,
      errorDelayMs: 900,
      sleep,
      onCycle: ({ error }) => { if (error) errors.push(error.message); },
    });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(900, undefined);
    expect(errors).toEqual(["database unavailable"]);
  });

  it("stops without another poll when aborted during a cycle", async () => {
    const controller = new AbortController();
    const store = backend([]);
    await runExtractionWorker(store, { extract: vi.fn() }, "worker-1", {
      signal: controller.signal,
      onCycle: () => controller.abort(),
      sleep: vi.fn(),
    });
    expect(store.claim).toHaveBeenCalledTimes(1);
  });
});
