import { supabase } from "./client.js";
import { getDisplayProvenance, type InvoiceFieldProvenance } from "./document-understanding.js";
import { getActiveInvoiceBlockers } from "./work-management.js";

export interface PersistedInvoice {
  id: string;
  issuer: string;
  origin: "Captured" | "Generated";
  lifecycle: string;
  linkageStatus: "UNLINKED" | "AMBIGUOUS" | "LINKED";
  transactionFileId: string | null;
  sourceInvoiceNumber: string;
  officialInvoiceNumber: string;
  currency: string;
  total: number | null;
  version: number;
  updatedAt: string;
  fields: Record<string, unknown>;
  sourceUrl: string | null;
  sourceMediaType: string | null;
  blockerCode: string | null;
  provenance: Record<string, InvoiceFieldProvenance>;
}

export type { InvoiceFieldProvenance };

interface InvoiceCommand {
  invoiceId: string;
  expectedVersion: number;
  actorId: string;
}

export async function listInvoices(): Promise<PersistedInvoice[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const client = supabase;
  const { data, error } = await client
    .from("invoice_candidates")
    .select("id, origin, lifecycle, linkage_status, transaction_file_id, source_invoice_number, official_invoice_number, currency, total, version, updated_at, issuers!inner(legal_name), invoice_field_values(field_name,resolved_value), evidence_links(relationship,evidence_artifacts(storage_path,media_type,extracted_observations(field_name,claimed_value,source_location,confidence,provider,model_version,schema_version,created_at)))")
    .neq("lifecycle", "DISMISSED")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Unable to load invoices: ${error.message}`);
  const invoiceIds = data.map((row) => row.id as string);
  const blockers = await getActiveInvoiceBlockers(invoiceIds);
  return Promise.all(data.map(async (row) => {
    const links = row.evidence_links as unknown as Array<{ relationship: string; evidence_artifacts: { storage_path: string; media_type: string; extracted_observations: Array<{ field_name: string; claimed_value: unknown; source_location: unknown; confidence: number | null; provider: string; model_version: string; schema_version: string; created_at: string }> } | null }>;
    const source = links.find((link) => link.relationship === "SOURCE_DOCUMENT")?.evidence_artifacts ?? null;
    let sourceUrl: string | null = null;
    if (source) {
      const { data: signed } = await client.storage.from("evidence").createSignedUrl(source.storage_path, 3600);
      sourceUrl = signed?.signedUrl ?? null;
    }
    const provenance = getDisplayProvenance(source?.extracted_observations ?? []);
    return {
    id: row.id as string,
    issuer: (row.issuers as unknown as { legal_name: string }).legal_name,
    origin: row.origin === "GENERATED" ? "Generated" : "Captured",
    lifecycle: row.lifecycle as string,
    linkageStatus: row.linkage_status as PersistedInvoice["linkageStatus"],
    transactionFileId: (row.transaction_file_id as string | null) ?? null,
    sourceInvoiceNumber: (row.source_invoice_number as string | null) ?? "",
    officialInvoiceNumber: (row.official_invoice_number as string | null) ?? "",
    currency: row.currency as string,
    total: row.total === null ? null : Number(row.total),
    version: row.version as number,
    updatedAt: row.updated_at as string,
    fields: Object.fromEntries((row.invoice_field_values as Array<{ field_name: string; resolved_value: unknown }>).map((field) => [field.field_name, field.resolved_value])),
    sourceUrl,
    sourceMediaType: source?.media_type ?? null,
    blockerCode: blockers.get(row.id as string) ?? null,
    provenance,
    };
  }));
}

export async function reprocessInvoice(input: InvoiceCommand): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.rpc("request_invoice_reprocessing", {
    target_invoice: input.invoiceId,
    expected_version: input.expectedVersion,
    actor: input.actorId,
  });
  if (error) throw commandError(error.message);
}

export async function dismissInvoice(input: InvoiceCommand): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.rpc("dismiss_invoice_candidate", {
    target_invoice: input.invoiceId,
    expected_version: input.expectedVersion,
    actor: input.actorId,
  });
  if (error) throw commandError(error.message);
}

export async function saveInvoiceField(input: InvoiceCommand & {
  field: string;
  value: unknown;
}): Promise<number> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("record_invoice_field_value", {
    target_invoice: input.invoiceId,
    expected_version: input.expectedVersion,
    target_field: input.field,
    target_value: input.value,
    actor: input.actorId,
  });
  if (error) throw commandError(error.message);
  return data as number;
}

export async function verifyInvoice(input: InvoiceCommand & {
  origin: "Captured" | "Generated";
}): Promise<string> {
  if (!supabase) throw new Error("Supabase is not configured");
  const functionName = input.origin === "Generated" ? "finalize_generated_invoice" : "verify_captured_invoice";
  const { data, error } = await supabase.rpc(functionName, {
    target_invoice: input.invoiceId,
    expected_version: input.expectedVersion,
    actor: input.actorId,
  });
  if (error) throw commandError(error.message);
  return String(data);
}

const COMMAND_ERROR_RULES: Array<{ matches: (message: string) => boolean; friendlyMessage: string }> = [
  {
    matches: (message) => message.includes("dismiss_invoice_candidate") && message.includes("schema cache"),
    friendlyMessage: "Invoice removal is not installed in this workspace. Run migration 049, then refresh the page.",
  },
  {
    matches: (message) => message.includes("stale invoice version"),
    friendlyMessage: "This invoice changed in another session. Refresh before continuing.",
  },
  {
    matches: (message) => message.includes("not eligible for captured verification") || message.includes("not eligible for generated finalization"),
    friendlyMessage: "This invoice is not ready for approval. Refresh and confirm processing is complete.",
  },
  {
    matches: (message) => message.includes("role cannot"),
    friendlyMessage: "Your role cannot perform this invoice action.",
  },
  {
    matches: (message) => message.includes("linked invoice"),
    friendlyMessage: "Unlink this invoice from its Transaction File before removing it from the queue.",
  },
];

function commandError(message: string): Error {
  const rule = COMMAND_ERROR_RULES.find((candidate) => candidate.matches(message));
  return new Error(rule?.friendlyMessage ?? message);
}
