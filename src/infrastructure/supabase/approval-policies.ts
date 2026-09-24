import { supabase } from "./client.js";

export type ApprovalMode = "MANDATORY" | "CONDITIONAL" | "AUTOMATIC";
export type ApprovalCondition =
  | { type: "TOTAL_ABOVE" | "LOW_CONFIDENCE"; value: number }
  | { type: "NEW_ISSUER" }
  | { type: "ORIGIN"; value: "CAPTURED" | "GENERATED" };
export interface ApprovalPolicy {
  id: string;
  version: number;
  mode: ApprovalMode;
  rules: { reviewWhen?: { operator: "AND" | "OR"; conditions: ApprovalCondition[] } };
  publishedAt: string;
}

export async function getCurrentApprovalPolicy(tenantId: string): Promise<ApprovalPolicy | null> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("approval_policy_versions")
    .select("id, version, mode, rules, published_at")
    .eq("tenant_id", tenantId).not("published_at", "is", null)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Unable to load approval policy: ${error.message}`);
  if (!data) return null;
  return { id: data.id as string, version: data.version as number, mode: data.mode as ApprovalMode,
    rules: data.rules as ApprovalPolicy["rules"], publishedAt: data.published_at as string };
}

export async function publishApprovalPolicy(input: { tenantId: string; mode: ApprovalMode; rules: ApprovalPolicy["rules"]; actorId: string }): Promise<ApprovalPolicy> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("publish_approval_policy", {
    target_tenant: input.tenantId, target_mode: input.mode, target_rules: input.rules, actor: input.actorId,
  });
  if (error) throw new Error(error.message);
  const row = data as unknown as { id: string; version: number; mode: ApprovalMode; rules: ApprovalPolicy["rules"]; published_at: string };
  return { id: row.id, version: row.version, mode: row.mode, rules: row.rules, publishedAt: row.published_at };
}
