import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { waitForExtractionWorker } from "./extraction-worker.js";

export interface AssemblyJob { id: string; lockToken: string }
export interface AssemblyBackend {
  claim(workerId: string, limit: number): Promise<AssemblyJob[]>;
  complete(job: AssemblyJob): Promise<string | null>;
  fail(job: AssemblyJob, code: string): Promise<void>;
}
export interface AssemblyWorkerOptions { signal?: AbortSignal; batchSize?: number; idleDelayMs?: number; errorDelayMs?: number; maxCycles?: number; sleep?: typeof waitForExtractionWorker; onCycle?: (result: { processed: number; error?: Error }) => void }

export async function processAssemblyBatch(backend: AssemblyBackend, workerId: string, limit = 5): Promise<number> {
  const jobs = await backend.claim(workerId, limit);
  await Promise.all(jobs.map(async (job) => {
    try {
      await backend.complete(job);
    } catch {
      await backend.fail(job, "INVOICE_ASSEMBLY_FAILED");
    }
  }));
  return jobs.length;
}

export async function runAssemblyWorker(backend: AssemblyBackend, workerId: string, options: AssemblyWorkerOptions = {}): Promise<void> {
  const sleep = options.sleep ?? waitForExtractionWorker;
  for (let cycle = 0; !options.signal?.aborted && (options.maxCycles === undefined || cycle < options.maxCycles); cycle += 1) {
    let delay = 0;
    try { const processed = await processAssemblyBatch(backend, workerId, options.batchSize ?? 5); options.onCycle?.({ processed }); if (!processed) delay = options.idleDelayMs ?? 2_000; }
    catch (reason) { const error = reason instanceof Error ? reason : new Error(String(reason)); options.onCycle?.({ processed: 0, error }); delay = options.errorDelayMs ?? 10_000; }
    if (!options.signal?.aborted && (options.maxCycles === undefined || cycle + 1 < options.maxCycles) && delay) await sleep(delay, options.signal);
  }
}

export class SupabaseAssemblyBackend implements AssemblyBackend {
  constructor(private readonly client: SupabaseClient) {}

  async claim(workerId: string, limit: number): Promise<AssemblyJob[]> {
    const { data, error } = await this.client.rpc("claim_processing_jobs", { worker_id: workerId, accepted_job_types: ["ASSEMBLE_INVOICE"], batch_size: limit });
    if (error) throw new Error(error.message);
    return (data as Array<{ id: string; lock_token: string }>).map((job) => ({ id: job.id, lockToken: job.lock_token }));
  }

  async complete(job: AssemblyJob): Promise<string | null> {
    const { data, error } = await this.client.rpc("complete_invoice_assembly", { target_job: job.id, target_lock_token: job.lockToken });
    if (error) throw new Error(error.message);
    return data as string | null;
  }

  async fail(job: AssemblyJob, code: string): Promise<void> {
    const { error } = await this.client.rpc("fail_processing_job", { target_job: job.id, target_lock_token: job.lockToken, error_code: code });
    if (error) throw new Error(error.message);
  }
}

async function main() {
  if (existsSync(".env.worker.local")) loadEnvFile(".env.worker.local");
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Assembly worker environment is incomplete");
  const backend = new SupabaseAssemblyBackend(createClient(url, serviceKey, { auth: { persistSession: false } }));
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const workerId = `assembly-${process.pid}`; console.log(`Assembly worker ${workerId} started`);
  await runAssemblyWorker(backend, workerId, { signal: controller.signal,
    onCycle: ({ processed, error }) => { if (error) console.error(`Assembly worker cycle failed: ${error.message}`); else if (processed) console.log(`Processed ${processed} invoice assembly job${processed === 1 ? "" : "s"}`); } });
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); console.log(`Assembly worker ${workerId} stopped`);
}

if (process.env.RUN_ASSEMBLY_WORKER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
