import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface AssemblyJob { id: string; lockToken: string }
export interface AssemblyBackend {
  claim(workerId: string, limit: number): Promise<AssemblyJob[]>;
  complete(job: AssemblyJob): Promise<string | null>;
  fail(job: AssemblyJob, code: string): Promise<void>;
}

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
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Assembly worker environment is incomplete");
  const backend = new SupabaseAssemblyBackend(createClient(url, serviceKey, { auth: { persistSession: false } }));
  const processed = await processAssemblyBatch(backend, `assembly-${process.pid}`);
  console.log(`Processed ${processed} invoice assembly jobs`);
}

if (process.env.RUN_ASSEMBLY_WORKER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
