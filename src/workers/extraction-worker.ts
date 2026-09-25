import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export interface ExtractionJob { id: string; aggregateId: string; lockToken: string }
export interface ExtractedObservation {
  fieldName: string;
  value: unknown;
  sourceLocation: Record<string, unknown>;
  confidence: number;
}
export interface ExtractionResult {
  provider: string;
  modelVersion: string;
  promptVersion: string;
  startedAt: string;
  observations: ExtractedObservation[];
}
export interface ExtractionBackend {
  claim(workerId: string, limit: number): Promise<ExtractionJob[]>;
  download(evidenceArtifactId: string): Promise<Blob>;
  complete(job: ExtractionJob, result: ExtractionResult): Promise<void>;
  fail(job: ExtractionJob, code: string): Promise<void>;
}
export interface DocumentExtractor { extract(content: Blob): Promise<ExtractionResult> }
export interface ExtractionWorkerConfig { supabaseUrl: string; serviceRoleKey: string; extractorUrl: string; extractorToken: string; batchSize: number; idleDelayMs: number; errorDelayMs: number; requestTimeoutMs: number }
export interface ExtractionWorkerLoopOptions { batchSize?: number; idleDelayMs?: number; errorDelayMs?: number; signal?: AbortSignal; maxCycles?: number; sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>; onCycle?: (result: { processed: number; error?: Error }) => void }

function positiveInteger(name: string, value: string | undefined, fallback: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return parsed;
}

export function loadExtractionWorkerConfig(environment: NodeJS.ProcessEnv): ExtractionWorkerConfig {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DOCUMENT_EXTRACTOR_URL", "DOCUMENT_EXTRACTOR_TOKEN"] as const;
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`Missing extraction worker environment: ${missing.join(", ")}`);
  const extractorUrl = environment.DOCUMENT_EXTRACTOR_URL!.trim();
  try { const parsed = new URL(extractorUrl); if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) throw new Error(); }
  catch { throw new Error("DOCUMENT_EXTRACTOR_URL must be an HTTP(S) URL"); }
  return { supabaseUrl: environment.SUPABASE_URL!.trim(), serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY!.trim(), extractorUrl,
    extractorToken: environment.DOCUMENT_EXTRACTOR_TOKEN!.trim(), batchSize: positiveInteger("EXTRACTION_WORKER_BATCH_SIZE", environment.EXTRACTION_WORKER_BATCH_SIZE, 5, 25),
    idleDelayMs: positiveInteger("EXTRACTION_WORKER_IDLE_DELAY_MS", environment.EXTRACTION_WORKER_IDLE_DELAY_MS, 2_000, 300_000),
    errorDelayMs: positiveInteger("EXTRACTION_WORKER_ERROR_DELAY_MS", environment.EXTRACTION_WORKER_ERROR_DELAY_MS, 10_000, 300_000),
    requestTimeoutMs: positiveInteger("EXTRACTION_REQUEST_TIMEOUT_MS", environment.EXTRACTION_REQUEST_TIMEOUT_MS, 60_000, 300_000) };
}

export function waitForExtractionWorker(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => { const timeout = setTimeout(done, delayMs); function done() { clearTimeout(timeout); signal?.removeEventListener("abort", done); resolve(); } signal?.addEventListener("abort", done, { once: true }); });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateExtractionResult(value: unknown): ExtractionResult {
  if (!isRecord(value)) throw new Error("extractor returned an invalid response");
  const { provider, modelVersion, promptVersion, startedAt, observations } = value;
  if (typeof provider !== "string" || !provider.trim() || typeof modelVersion !== "string" || !modelVersion.trim() || typeof promptVersion !== "string" || !promptVersion.trim()) {
    throw new Error("extractor response is missing version metadata");
  }
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) throw new Error("extractor response has an invalid start time");
  if (!Array.isArray(observations) || observations.length > 200) throw new Error("extractor response has an invalid observation count");
  const validated = observations.map((observation) => {
    if (!isRecord(observation) || typeof observation.fieldName !== "string" || !observation.fieldName.trim()
      || !isRecord(observation.sourceLocation) || typeof observation.confidence !== "number"
      || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1
      || !("value" in observation)) throw new Error("extractor returned an invalid observation");
    return {
      fieldName: observation.fieldName,
      value: observation.value,
      sourceLocation: observation.sourceLocation,
      confidence: observation.confidence,
    };
  });
  return { provider, modelVersion, promptVersion, startedAt, observations: validated };
}

export async function processExtractionBatch(backend: ExtractionBackend, extractor: DocumentExtractor, workerId: string, limit = 5): Promise<number> {
  const jobs = await backend.claim(workerId, limit);
  await Promise.all(jobs.map(async (job) => {
    try {
      const content = await backend.download(job.aggregateId);
      const result = validateExtractionResult(await extractor.extract(content));
      await backend.complete(job, result);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      const code = message.includes("extractor unavailable") || (reason instanceof Error && ["AbortError", "TimeoutError"].includes(reason.name)) ? "EXTRACTOR_UNAVAILABLE"
        : message.includes("extractor returned") || message.includes("extractor response") ? "INVALID_EXTRACTION_RESPONSE"
          : "EXTRACTION_PROCESSING_FAILED";
      await backend.fail(job, code);
    }
  }));
  return jobs.length;
}

export async function runExtractionWorker(backend: ExtractionBackend, extractor: DocumentExtractor, workerId: string, options: ExtractionWorkerLoopOptions = {}): Promise<void> {
  let cycles = 0; const sleep = options.sleep ?? waitForExtractionWorker;
  while (!options.signal?.aborted && (options.maxCycles === undefined || cycles < options.maxCycles)) {
    cycles += 1; let delay = 0;
    try { const processed = await processExtractionBatch(backend, extractor, workerId, options.batchSize ?? 5); options.onCycle?.({ processed }); if (!processed) delay = options.idleDelayMs ?? 2_000; }
    catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); options.onCycle?.({ processed: 0, error }); delay = options.errorDelayMs ?? 10_000; }
    if (!options.signal?.aborted && (options.maxCycles === undefined || cycles < options.maxCycles) && delay) await sleep(delay, options.signal);
  }
}

export class SupabaseExtractionBackend implements ExtractionBackend {
  constructor(private readonly client: SupabaseClient) {}

  async claim(workerId: string, limit: number): Promise<ExtractionJob[]> {
    const { data, error } = await this.client.rpc("claim_processing_jobs", { worker_id: workerId, accepted_job_types: ["EXTRACT_EVIDENCE"], batch_size: limit });
    if (error) throw new Error(error.message);
    return (data as Array<{ id: string; aggregate_id: string; lock_token: string }>).map((job) => ({ id: job.id, aggregateId: job.aggregate_id, lockToken: job.lock_token }));
  }

  async download(evidenceArtifactId: string): Promise<Blob> {
    const { data: artifact, error: lookupError } = await this.client.from("evidence_artifacts").select("storage_path").eq("id", evidenceArtifactId).single();
    if (lookupError) throw new Error(lookupError.message);
    const { data, error } = await this.client.storage.from("evidence").download(artifact.storage_path as string);
    if (error) throw new Error(error.message);
    return data;
  }

  async complete(job: ExtractionJob, result: ExtractionResult): Promise<void> {
    const { error } = await this.client.rpc("complete_evidence_extraction", {
      target_job: job.id,
      target_lock_token: job.lockToken,
      target_provider: result.provider,
      target_model_version: result.modelVersion,
      target_prompt_version: result.promptVersion,
      target_started_at: result.startedAt,
      target_observations: result.observations,
    });
    if (error) throw new Error(error.message);
  }

  async fail(job: ExtractionJob, code: string): Promise<void> {
    const { error } = await this.client.rpc("fail_processing_job", { target_job: job.id, target_lock_token: job.lockToken, error_code: code });
    if (error) throw new Error(error.message);
  }
}

export class HttpDocumentExtractor implements DocumentExtractor {
  constructor(private readonly endpoint: string, private readonly token: string, private readonly timeoutMs = 60_000) {}
  async extract(content: Blob): Promise<ExtractionResult> {
    const form = new FormData();
    form.set("document", content, "evidence");
    const response = await fetch(this.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`extractor unavailable (${response.status})`);
    return validateExtractionResult(await response.json());
  }
}

async function main() {
  if (existsSync(".env.worker.local")) loadEnvFile(".env.worker.local");
  const config = loadExtractionWorkerConfig(process.env); const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const backend = new SupabaseExtractionBackend(createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } }));
  const workerId = `extraction-${process.pid}`; console.log(`Extraction worker ${workerId} started`);
  await runExtractionWorker(backend, new HttpDocumentExtractor(config.extractorUrl, config.extractorToken, config.requestTimeoutMs), workerId,
    { batchSize: config.batchSize, idleDelayMs: config.idleDelayMs, errorDelayMs: config.errorDelayMs, signal: controller.signal,
      onCycle: ({ processed, error }) => { if (error) console.error(`Extraction worker cycle failed: ${error.message}`); else if (processed) console.log(`Claimed ${processed} extraction job${processed === 1 ? "" : "s"}`); } });
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); console.log(`Extraction worker ${workerId} stopped`);
}

if (process.env.RUN_EXTRACTION_WORKER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
