import { supabase } from "./client.js";

const supportedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const maxBytes = 5 * 1024 * 1024;

export interface IntakeReceipt {
  evidenceArtifactId: string;
  ingestionEventId: string;
  processingJobId: string;
}

export interface IntakeQueueItem {
  ingestionEventId: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  safetyStatus: "PENDING" | "SAFE" | "QUARANTINED";
  quarantineReason: string | null;
  processingStage: "SCAN_EVIDENCE" | "EXTRACT_EVIDENCE" | "ASSEMBLE_INVOICE" | null;
  processingStatus: "QUEUED" | "RUNNING" | "RETRY_SCHEDULED" | "SUCCEEDED" | "FAILED" | "CANCEL_REQUESTED" | "CANCELLED" | null;
  receivedAt: string;
}

export async function cancelIntakeScan(input: { tenantId: string; ingestionEventId: string; actorId: string }): Promise<"CANCEL_REQUESTED" | "CANCELLED"> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("cancel_manual_intake_scan", {
    target_tenant: input.tenantId,
    target_ingestion_event: input.ingestionEventId,
    actor: input.actorId,
  });
  if (error) throw new Error(`Unable to cancel scan: ${error.message}`);
  return data as "CANCEL_REQUESTED" | "CANCELLED";
}

export async function listIntakeReceipts(tenantId: string): Promise<IntakeQueueItem[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("list_manual_intake_pipeline", { target_tenant: tenantId });
  if (error) throw new Error(`Unable to load intake receipts: ${error.message}`);
  return (data as Array<Record<string, unknown>>).map((row) => ({
    ingestionEventId: row.ingestion_event_id as string,
    fileName: row.file_name as string,
    mediaType: row.media_type as string,
    byteSize: Number(row.byte_size),
    safetyStatus: row.safety_status as IntakeQueueItem["safetyStatus"],
    quarantineReason: row.quarantine_reason as string | null,
    processingStage: row.processing_stage as IntakeQueueItem["processingStage"],
    processingStatus: row.processing_status as IntakeQueueItem["processingStatus"],
    receivedAt: row.received_at as string,
  }));
}

export async function uploadEvidence(input: {
  tenantId: string;
  actorId: string;
  file: File;
}): Promise<IntakeReceipt> {
  if (!supabase) throw new Error("Supabase is not configured");
  if (!supportedTypes.has(input.file.type)) throw new Error("Upload a PDF, JPEG, or PNG file.");
  if (input.file.size <= 0 || input.file.size > maxBytes) throw new Error("Files must be between 1 byte and 5 MB.");

  const transportIdentity = crypto.randomUUID();
  const safeName = input.file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${input.tenantId}/${transportIdentity}/${safeName}`;
  const sha256 = await checksum(input.file);
  const { error: uploadError } = await supabase.storage.from("evidence").upload(storagePath, input.file, {
    contentType: input.file.type,
    upsert: false,
  });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data, error } = await supabase.rpc("register_manual_upload", {
    target_tenant: input.tenantId,
    target_storage_path: storagePath,
    target_media_type: input.file.type,
    target_byte_size: input.file.size,
    target_sha256: sha256,
    target_transport_identity: transportIdentity,
    actor: input.actorId,
  });
  if (error) {
    const { error: cleanupError } = await supabase.storage.from("evidence").remove([storagePath]);
    if (cleanupError) throw new Error("Upload could not be registered or removed. Contact support with the upload time.");
    throw new Error(`Upload could not be registered. Please try again: ${error.message}`);
  }
  const receipt = (data as Array<{ evidence_artifact_id: string; ingestion_event_id: string; processing_job_id: string }>)[0];
  if (!receipt) throw new Error("Receipt registration returned no result");
  return { evidenceArtifactId: receipt.evidence_artifact_id, ingestionEventId: receipt.ingestion_event_id, processingJobId: receipt.processing_job_id };
}

async function checksum(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
