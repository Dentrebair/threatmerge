import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface ApprovalJob { id: string; lockToken: string }
export interface ApprovalBackend {
  claim(workerId: string, limit: number): Promise<ApprovalJob[]>;
  route(job: ApprovalJob): Promise<"PENDING_REVIEW" | "VERIFIED">;
  fail(job: ApprovalJob, code: string): Promise<void>;
}

export async function processApprovalBatch(backend: ApprovalBackend, workerId: string, limit = 5): Promise<number> {
  const jobs = await backend.claim(workerId, limit);
  await Promise.all(jobs.map(async (job) => {
    try { await backend.route(job); }
    catch { await backend.fail(job, "APPROVAL_ROUTING_FAILED"); }
  }));
  return jobs.length;
}

export class SupabaseApprovalBackend implements ApprovalBackend {
  constructor(private readonly client: SupabaseClient) {}
  async claim(workerId: string, limit: number): Promise<ApprovalJob[]> {
    const { data, error } = await this.client.rpc("claim_processing_jobs", { worker_id: workerId, accepted_job_types: ["ROUTE_INVOICE_APPROVAL"], batch_size: limit });
    if (error) throw new Error(error.message);
    return (data as Array<{ id: string; lock_token: string }>).map((job) => ({ id: job.id, lockToken: job.lock_token }));
  }
  async route(job: ApprovalJob): Promise<"PENDING_REVIEW" | "VERIFIED"> {
    const { data, error } = await this.client.rpc("route_invoice_approval", { target_job: job.id, target_lock_token: job.lockToken });
    if (error) throw new Error(error.message);
    return data as "PENDING_REVIEW" | "VERIFIED";
  }
  async fail(job: ApprovalJob, code: string): Promise<void> {
    const { error } = await this.client.rpc("fail_processing_job", { target_job: job.id, target_lock_token: job.lockToken, error_code: code });
    if (error) throw new Error(error.message);
  }
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Approval worker environment is incomplete");
  const backend = new SupabaseApprovalBackend(createClient(url, serviceKey, { auth: { persistSession: false } }));
  const processed = await processApprovalBatch(backend, `approval-${process.pid}`);
  console.log(`Processed ${processed} approval routing jobs`);
}

if (process.env.RUN_APPROVAL_WORKER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
