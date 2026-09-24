import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export interface ScanJob { id: string; aggregateId: string; lockToken: string }
export interface ScanResult { safe: boolean; reason?: string }
export interface WorkerBackend {
  claim(workerId: string, limit: number): Promise<ScanJob[]>;
  download(evidenceArtifactId: string): Promise<Blob>;
  complete(job: ScanJob, result: ScanResult): Promise<void>;
  fail(job: ScanJob, code: string): Promise<void>;
}
export interface MalwareScanner { scan(content: Blob): Promise<ScanResult> }

export interface EvidenceWorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  scannerMode: "remote" | "development";
  scannerUrl: string;
  scannerToken: string;
  batchSize: number;
  idleDelayMs: number;
  errorDelayMs: number;
}

export interface WorkerCycleResult {
  processed: number;
  error?: Error;
}

export interface WorkerLoopOptions {
  batchSize?: number;
  idleDelayMs?: number;
  errorDelayMs?: number;
  signal?: AbortSignal;
  maxCycles?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onCycle?: (result: WorkerCycleResult) => void;
}

function readPositiveInteger(name: string, value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

export function loadEvidenceWorkerConfig(environment: NodeJS.ProcessEnv): EvidenceWorkerConfig {
  const scannerMode = environment.EVIDENCE_SCANNER_MODE?.trim() || "remote";
  if (!(["remote", "development"] as const).includes(scannerMode as "remote" | "development")) {
    throw new Error("EVIDENCE_SCANNER_MODE must be remote or development");
  }
  if (scannerMode === "development" && environment.DEVELOPMENT_FILE_VALIDATION_ENABLED !== "true") {
    throw new Error("Development file validation requires DEVELOPMENT_FILE_VALIDATION_ENABLED=true");
  }
  if (scannerMode === "development" && environment.NODE_ENV === "production") {
    throw new Error("Development file validation is not allowed in production");
  }
  const required = scannerMode === "remote"
    ? ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MALWARE_SCANNER_URL", "MALWARE_SCANNER_TOKEN"] as const
    : ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing worker environment: ${missing.join(", ")}`);

  return {
    supabaseUrl: environment.SUPABASE_URL!.trim(),
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    scannerMode: scannerMode as "remote" | "development",
    scannerUrl: environment.MALWARE_SCANNER_URL?.trim() ?? "",
    scannerToken: environment.MALWARE_SCANNER_TOKEN?.trim() ?? "",
    batchSize: readPositiveInteger("EVIDENCE_WORKER_BATCH_SIZE", environment.EVIDENCE_WORKER_BATCH_SIZE, 5, 25),
    idleDelayMs: readPositiveInteger("EVIDENCE_WORKER_IDLE_DELAY_MS", environment.EVIDENCE_WORKER_IDLE_DELAY_MS, 2_000, 300_000),
    errorDelayMs: readPositiveInteger("EVIDENCE_WORKER_ERROR_DELAY_MS", environment.EVIDENCE_WORKER_ERROR_DELAY_MS, 10_000, 300_000),
  };
}

export function waitForWorker(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function processEvidenceBatch(backend: WorkerBackend, scanner: MalwareScanner, workerId: string, limit = 5): Promise<number> {
  const jobs = await backend.claim(workerId, limit);
  await Promise.all(jobs.map(async (job) => {
    try {
      const content = await backend.download(job.aggregateId);
      const result = await scanner.scan(content);
      await backend.complete(job, result);
    } catch (reason) {
      const code = reason instanceof Error && reason.message.includes("scanner") ? "SCANNER_UNAVAILABLE" : "SCAN_PROCESSING_FAILED";
      await backend.fail(job, code);
    }
  }));
  return jobs.length;
}

export async function runEvidenceWorker(
  backend: WorkerBackend,
  scanner: MalwareScanner,
  workerId: string,
  options: WorkerLoopOptions = {},
): Promise<void> {
  const batchSize = options.batchSize ?? 5;
  const idleDelayMs = options.idleDelayMs ?? 2_000;
  const errorDelayMs = options.errorDelayMs ?? 10_000;
  const sleep = options.sleep ?? waitForWorker;
  let cycles = 0;

  while (!options.signal?.aborted && (options.maxCycles === undefined || cycles < options.maxCycles)) {
    cycles += 1;
    let delayMs = 0;
    try {
      const processed = await processEvidenceBatch(backend, scanner, workerId, batchSize);
      options.onCycle?.({ processed });
      if (processed === 0) delayMs = idleDelayMs;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      options.onCycle?.({ processed: 0, error });
      delayMs = errorDelayMs;
    }

    const finished = options.signal?.aborted || (options.maxCycles !== undefined && cycles >= options.maxCycles);
    if (!finished && delayMs > 0) await sleep(delayMs, options.signal);
  }
}

export class SupabaseWorkerBackend implements WorkerBackend {
  constructor(private readonly client: SupabaseClient) {}

  async claim(workerId: string, limit: number): Promise<ScanJob[]> {
    const { data, error } = await this.client.rpc("claim_processing_jobs", { worker_id: workerId, accepted_job_types: ["SCAN_EVIDENCE"], batch_size: limit });
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

  async complete(job: ScanJob, result: ScanResult): Promise<void> {
    const { error } = await this.client.rpc("complete_evidence_scan", { target_job: job.id, target_lock_token: job.lockToken, is_safe: result.safe, failure_reason: result.reason ?? null });
    if (error) throw new Error(error.message);
  }

  async fail(job: ScanJob, code: string): Promise<void> {
    const { error } = await this.client.rpc("fail_processing_job", { target_job: job.id, target_lock_token: job.lockToken, error_code: code });
    if (error) throw new Error(error.message);
  }
}

export class HttpMalwareScanner implements MalwareScanner {
  constructor(private readonly endpoint: string, private readonly token: string) {}
  async scan(content: Blob): Promise<ScanResult> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" }, body: content });
    if (!response.ok) throw new Error(`scanner unavailable (${response.status})`);
    const result = await response.json() as { safe?: unknown; reason?: unknown };
    if (typeof result.safe !== "boolean") throw new Error("scanner returned an invalid response");
    return { safe: result.safe, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
  }
}

export class DevelopmentFileValidator implements MalwareScanner {
  async scan(content: Blob): Promise<ScanResult> {
    if (content.size === 0) return { safe: false, reason: "EMPTY_FILE" };
    const bytes = new Uint8Array(await content.slice(0, 8).arrayBuffer());
    const matchesPdf = bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
    const matchesJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const matchesPng = bytes.length >= png.length && png.every((value, index) => bytes[index] === value);
    return matchesPdf || matchesJpeg || matchesPng
      ? { safe: true }
      : { safe: false, reason: "FILE_SIGNATURE_MISMATCH" };
  }
}

export function createEvidenceScanner(config: EvidenceWorkerConfig): MalwareScanner {
  return config.scannerMode === "development"
    ? new DevelopmentFileValidator()
    : new HttpMalwareScanner(config.scannerUrl, config.scannerToken);
}

async function main() {
  if (existsSync(".env.worker.local")) loadEnvFile(".env.worker.local");
  const config = loadEvidenceWorkerConfig(process.env);
  if (config.scannerMode === "remote" && process.env.MALWARE_SCANNING_ENABLED !== "true") {
    throw new Error("Malware scanning is deferred. Set MALWARE_SCANNING_ENABLED=true only after configuring an approved scanner.");
  }
  const workerId = `evidence-${process.pid}`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const backend = new SupabaseWorkerBackend(createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } }));
  console.log(`Evidence worker ${workerId} started`);
  await runEvidenceWorker(backend, createEvidenceScanner(config), workerId, {
    batchSize: config.batchSize,
    idleDelayMs: config.idleDelayMs,
    errorDelayMs: config.errorDelayMs,
    signal: controller.signal,
    onCycle: ({ processed, error }) => {
      if (error) console.error(`Evidence worker cycle failed: ${error.message}`);
      else if (processed > 0) console.log(`Processed ${processed} evidence scan job${processed === 1 ? "" : "s"}`);
    },
  });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  console.log(`Evidence worker ${workerId} stopped`);
}

if (process.env.RUN_EVIDENCE_WORKER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
