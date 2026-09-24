import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace session query contract", () => {
  it("names the direct membership-to-tenant foreign key", async () => {
    const source = await readFile(new URL("../src/infrastructure/supabase/session.ts", import.meta.url), "utf8");
    expect(source).toContain("tenants!tenant_memberships_tenant_id_fkey!inner(name)");
    expect(source).not.toContain('tenants!inner(name)');
  });
});
