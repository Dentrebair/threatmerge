import { supabase } from "./client.js";

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
}

export async function listInvoices(): Promise<PersistedInvoice[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase
    .from("invoice_candidates")
    .select("id, origin, lifecycle, linkage_status, transaction_file_id, source_invoice_number, official_invoice_number, currency, total, version, updated_at, issuers!inner(legal_name), invoice_field_values(field_name,resolved_value)")
    .neq("lifecycle", "DISMISSED")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Unable to load invoices: ${error.message}`);
  return data.map((row) => ({
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
  }));
}

export async function reprocessInvoice(input: { invoiceId: string; expectedVersion: number; actorId: string }): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.rpc("request_invoice_reprocessing", {
    target_invoice: input.invoiceId,
    expected_version: input.expectedVersion,
    actor: input.actorId,
  });
  if (error) throw commandError(error.message);
}

export async function saveInvoiceField(input: {
  invoiceId: string;
  expectedVersion: number;
  field: string;
  value: unknown;
  actorId: string;
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

export async function verifyInvoice(input: {
  invoiceId: string;
  expectedVersion: number;
  origin: "Captured" | "Generated";
  actorId: string;
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

function commandError(message: string): Error {
  if (message.includes("stale invoice version")) return new Error("This invoice changed in another session. Refresh before continuing.");
  if (message.includes("not eligible for captured verification") || message.includes("not eligible for generated finalization")) {
    return new Error("This invoice is not ready for approval. Refresh and confirm processing is complete.");
  }
  if (message.includes("role cannot")) return new Error("Your role cannot perform this invoice action.");
  return new Error(message);
}
