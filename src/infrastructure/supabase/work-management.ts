import { supabase } from "./client.js";

// Work Management owns Work Items (docs/ARCHITECTURE.md). Other modules ask this
// interface for active blockers instead of querying work_items directly.
export async function getActiveInvoiceBlockers(invoiceIds: string[]): Promise<Map<string, string>> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = invoiceIds.length
    ? await supabase
      .from("work_items")
      .select("record_id, blocker_code, status")
      .eq("record_type", "INVOICE")
      .in("record_id", invoiceIds)
      .in("status", ["OPEN", "WAITING_FOR_EVIDENCE"])
    : { data: [], error: null };
  if (error) throw new Error(`Unable to load invoice review blockers: ${error.message}`);
  const blockers = new Map<string, string>();
  for (const item of data ?? []) {
    const recordId = item.record_id as string;
    if (!blockers.has(recordId)) blockers.set(recordId, item.blocker_code as string);
  }
  return blockers;
}
