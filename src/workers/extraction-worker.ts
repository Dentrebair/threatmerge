import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
      const code = message.includes("extractor unavailable") ? "EXTRACTOR_UNAVAILABLE"
        : message.includes("extractor returned") || message.includes("extractor response") ? "INVALID_EXTRACTION_RESPONSE"
          : "EXTRACTION_PROCESSING_FAILED";
      await backend.fail(job, code);
    }
  }));
  return jobs.length;
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
  constructor(private readonly endpoint: string, private readonly token: string) {}
  async extract(content: Blob): Promise<ExtractionResult> {
    const form = new FormData();
    form.set("document", content, "evidence");
    const response = await fetch(this.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, body: form });
    if (!response.ok) throw new Error(`extractor unavailable (${response.status})`);
    return validateExtractionResult(await response.json());
  }
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const extractorUrl = process.env.DOCUMENT_EXTRACTOR_URL;
  const extractorToken = process.env.DOCUMENT_EXTRACTOR_TOKEN;
  if (!url || !serviceKey || !extractorUrl || !extractorToken) throw new Error("Extraction worker environment is incomplete");
  const backend = new SupabaseExtractionBackend(createClient(url, serviceKey, { auth: { persistSession: false } }));
  const processed = await processExtractionBatch(backend, new HttpDocumentExtractor(extractorUrl, extractorToken), `extraction-${process.pid}`);
  console.log(`Processed ${processed} evidence extraction jobs`);
}

if (process.env.RUN_EXTRACTION_WORKER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
