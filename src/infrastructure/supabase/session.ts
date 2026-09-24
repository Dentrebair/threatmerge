import type { Session } from "@supabase/supabase-js";
import { supabase } from "./client.js";

export interface WorkspaceSession {
  session: Session;
  tenantId: string;
  tenantName: string;
  role: "TENANT_ADMIN" | "REVIEWER" | "VIEWER" | "INTEGRATION";
}

export async function loadWorkspaceSession(session: Session): Promise<WorkspaceSession> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase
    .from("tenant_memberships")
    .select("tenant_id, role, tenants!tenant_memberships_tenant_id_fkey!inner(name)")
    .eq("user_id", session.user.id)
    .eq("active", true)
    .limit(2);

  if (error) throw new Error(`Unable to load workspace membership: ${error.message}`);
  if (data.length === 0) throw new Error("Your account has no active workspace membership");
  if (data.length > 1) throw new Error("Multiple workspace memberships require an explicit workspace selector");

  const membership = data[0]!;
  const tenant = membership.tenants as unknown as { name: string };
  return {
    session,
    tenantId: membership.tenant_id as string,
    tenantName: tenant.name,
    role: membership.role as WorkspaceSession["role"],
  };
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}
