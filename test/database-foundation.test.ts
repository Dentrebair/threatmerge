import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const ids = {
  tenantA: "00000000-0000-4000-8000-000000000001",
  tenantB: "00000000-0000-4000-8000-000000000002",
  userA: "00000000-0000-4000-8000-000000000011",
  userB: "00000000-0000-4000-8000-000000000012",
  viewerA: "00000000-0000-4000-8000-000000000013",
  issuerA: "00000000-0000-4000-8000-000000000021",
  issuerB: "00000000-0000-4000-8000-000000000022",
  invoiceA: "00000000-0000-4000-8000-000000000031",
  transactionA: "00000000-0000-4000-8000-000000000061",
  transactionA2: "00000000-0000-4000-8000-000000000062",
  transactionB: "00000000-0000-4000-8000-000000000063",
};

async function database() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create role anon;
    create role authenticated;
    create role service_role;
  `);
  const migrations = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) await db.exec(await readFile(new URL(migration, migrationsUrl), "utf8"));
  await db.exec(`
    insert into tenants (id, name, slug, active) values
      ('${ids.tenantA}', 'Tenant A', 'tenant-a', true),
      ('${ids.tenantB}', 'Tenant B', 'tenant-b', true);
    insert into tenant_memberships (tenant_id, user_id, role) values
      ('${ids.tenantA}', '${ids.userA}', 'TENANT_ADMIN'),
      ('${ids.tenantA}', '${ids.viewerA}', 'VIEWER'),
      ('${ids.tenantB}', '${ids.userB}', 'TENANT_ADMIN');
    insert into issuers (id, tenant_id, legal_name, normalized_name) values
      ('${ids.issuerA}', '${ids.tenantA}', 'Issuer A', 'issuer a'),
      ('${ids.issuerB}', '${ids.tenantB}', 'Issuer B', 'issuer b');
  `);
  return db;
}

async function authenticate(db: PGlite, userId: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
}

describe("database foundation", () => {
  let db: PGlite;
  beforeEach(async () => { db = await database(); }, 30_000);

  it("isolates tenant rows through RLS", async () => {
    await authenticate(db, ids.userA);
    const result = await db.query<{ name: string }>("select name from tenants order by name");
    expect(result.rows).toEqual([{ name: "Tenant A" }]);
    await expect(db.exec(`insert into work_items (tenant_id, record_type, record_id, kind) values ('${ids.tenantB}', 'INVOICE', gen_random_uuid(), 'REVIEW')`)).rejects.toThrow();
  });

  it("rejects cross-tenant foreign-key associations", async () => {
    await expect(db.exec(`insert into invoice_candidates (tenant_id, issuer_id, origin, schema_fingerprint) values ('${ids.tenantA}', '${ids.issuerB}', 'CAPTURED', 'schema')`)).rejects.toThrow();
  });

  it("separates transport idempotency from content equality", async () => {
    const sha = "a".repeat(64);
    await db.exec(`
      insert into evidence_artifacts (id, tenant_id, storage_path, media_type, byte_size, sha256, safety_status) values
        ('00000000-0000-4000-8000-000000000041', '${ids.tenantA}', '${ids.tenantA}/one.pdf', 'application/pdf', 10, '${sha}', 'SAFE'),
        ('00000000-0000-4000-8000-000000000042', '${ids.tenantA}', '${ids.tenantA}/two.pdf', 'application/pdf', 10, '${sha}', 'SAFE');
      insert into ingestion_events (tenant_id, evidence_artifact_id, channel, transport_identity) values
        ('${ids.tenantA}', '00000000-0000-4000-8000-000000000041', 'MANUAL_UPLOAD', 'request-1'),
        ('${ids.tenantA}', '00000000-0000-4000-8000-000000000042', 'MANUAL_UPLOAD', 'request-2');
    `);
    await expect(db.exec(`insert into ingestion_events (tenant_id, evidence_artifact_id, channel, transport_identity) values ('${ids.tenantA}', '00000000-0000-4000-8000-000000000041', 'MANUAL_UPLOAD', 'request-1')`)).rejects.toThrow();
  });

  it("enforces quarantine metadata and append-only audit history", async () => {
    await expect(db.exec(`insert into evidence_artifacts (tenant_id, storage_path, media_type, byte_size, sha256, safety_status) values ('${ids.tenantA}', '${ids.tenantA}/bad.pdf', 'application/pdf', 10, '${"b".repeat(64)}', 'QUARANTINED')`)).rejects.toThrow();
    await db.exec(`insert into audit_events (id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type) values ('00000000-0000-4000-8000-000000000051', '${ids.tenantA}', 'INVOICE', '${ids.invoiceA}', 1, 'CREATED')`);
    await expect(db.exec(`delete from audit_events where id = '00000000-0000-4000-8000-000000000051'`)).rejects.toThrow(/append-only/);
  });

  it("atomically finalizes a generated invoice and rejects a stale retry", async () => {
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, schema_fingerprint, total) values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'GENERATED', 'PENDING_REVIEW', 'schema', 100);
      insert into official_number_sequences (tenant_id, issuer_id, prefix) values ('${ids.tenantA}', '${ids.issuerA}', 'CLI-2026-');
    `);
    await authenticate(db, ids.userA);
    await expect(db.query(`select finalize_generated_invoice('${ids.invoiceA}', 1, '${ids.userB}')`)).rejects.toThrow(/actor does not match/);
    const result = await db.query<{ number: string }>(`select finalize_generated_invoice('${ids.invoiceA}', 1, '${ids.userA}') as number`);
    expect(result.rows[0]?.number).toBe("CLI-2026-000001");
    await expect(db.query(`select finalize_generated_invoice('${ids.invoiceA}', 1, '${ids.userA}')`)).rejects.toThrow(/stale invoice version/);
    await db.exec("reset role");
    const jobs = await db.query<{ count: number }>("select count(*)::int as count from processing_jobs");
    expect(jobs.rows[0]?.count).toBe(1);
  });

  it("denies verification to a viewer", async () => {
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, schema_fingerprint, total) values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'GENERATED', 'PENDING_REVIEW', 'schema', 100);
      insert into official_number_sequences (tenant_id, issuer_id, prefix) values ('${ids.tenantA}', '${ids.issuerA}', 'CLI-2026-');
    `);
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select finalize_generated_invoice('${ids.invoiceA}', 1, '${ids.viewerA}')`)).rejects.toThrow(/role cannot review/);
  });

  it("rolls back number allocation and invoice state when outbox creation fails", async () => {
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, schema_fingerprint, total) values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'GENERATED', 'PENDING_REVIEW', 'schema', 100);
      insert into official_number_sequences (tenant_id, issuer_id, prefix) values ('${ids.tenantA}', '${ids.issuerA}', 'CLI-2026-');
      insert into processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key) values ('${ids.tenantA}', 'COMPILE_GENERATED_INVOICE_PDF', '${ids.invoiceA}', 'generated-invoice:${ids.invoiceA}:pdf:v1');
    `);
    await authenticate(db, ids.userA);
    await expect(db.query(`select finalize_generated_invoice('${ids.invoiceA}', 1, '${ids.userA}')`)).rejects.toThrow();
    await db.exec("reset role");
    const invoice = await db.query<{ lifecycle: string; official_invoice_number: string | null }>(`select lifecycle, official_invoice_number from invoice_candidates where id = '${ids.invoiceA}'`);
    const sequence = await db.query<{ next_value: number }>(`select next_value::int from official_number_sequences where tenant_id = '${ids.tenantA}' and issuer_id = '${ids.issuerA}'`);
    expect(invoice.rows[0]).toEqual({ lifecycle: "PENDING_REVIEW", official_invoice_number: null });
    expect(sequence.rows[0]?.next_value).toBe(1);
  });

  it("allows a generated invoice to retain its number when voided", async () => {
    await db.exec(`insert into invoice_candidates (tenant_id, issuer_id, origin, lifecycle, official_invoice_number, schema_fingerprint) values ('${ids.tenantA}', '${ids.issuerA}', 'GENERATED', 'VOIDED', 'CLI-2026-000099', 'schema')`);
  });

  it("records reviewer field edits with optimistic concurrency and audit history", async () => {
    await db.exec(`insert into invoice_candidates (id, tenant_id, issuer_id, origin, schema_fingerprint) values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'schema')`);
    await authenticate(db, ids.userA);
    const result = await db.query<{ version: number }>(`select record_invoice_field_value('${ids.invoiceA}', 1, 'billTo', '"Cedar Lane Realty"'::jsonb, '${ids.userA}') as version`);
    expect(result.rows[0]?.version).toBe(2);
    await expect(db.query(`select record_invoice_field_value('${ids.invoiceA}', 1, 'billTo', '"Other"'::jsonb, '${ids.userA}')`)).rejects.toThrow(/stale/);
    await db.exec("reset role");
    const audit = await db.query<{ event_type: string }>(`select event_type from audit_events where aggregate_id = '${ids.invoiceA}'`);
    expect(audit.rows).toEqual([{ event_type: "FIELD_VALUE_RECORDED" }]);
  });

  it("rejects incomplete captured verification and persists a canonical snapshot when complete", async () => {
    await db.exec(`insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, schema_fingerprint) values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'PENDING_REVIEW', 'schema')`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select verify_captured_invoice('${ids.invoiceA}', 1, '${ids.userA}')`)).rejects.toThrow(/incomplete/);
    await db.exec("reset role");
    await db.exec(`update invoice_candidates set source_invoice_number = 'SRC-1', total = 486 where id = '${ids.invoiceA}'`);
    await authenticate(db, ids.userA);
    await db.query(`select verify_captured_invoice('${ids.invoiceA}', 1, '${ids.userA}')`);
    await db.exec("reset role");
    const record = await db.query<{ origin: string; source_invoice_number: string; total: string }>(`select origin, source_invoice_number, total::text from verified_invoice_records where invoice_candidate_id = '${ids.invoiceA}'`);
    expect(record.rows).toEqual([{ origin: "CAPTURED", source_invoice_number: "SRC-1", total: "486.0000" }]);
    await expect(db.exec(`delete from verified_invoice_records where invoice_candidate_id = '${ids.invoiceA}'`)).rejects.toThrow(/append-only/);
  });

  it("timestamps invoice field creation and every correction", async () => {
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, schema_fingerprint)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'schema');
      insert into invoice_field_values
        (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, created_at, updated_at)
      values
        ('${ids.tenantA}', '${ids.invoiceA}', 'invoiceNumber', '"INV-1"', 'EXTRACTED',
          '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00');
      update invoice_field_values
        set resolved_value = '"INV-2"', created_at = '2010-01-01 00:00:00+00'
        where invoice_candidate_id = '${ids.invoiceA}' and field_name = 'invoiceNumber';
    `);
    const timestamps = await db.query<{ created_at: Date; updated_at: Date }>(`
      select created_at, updated_at from invoice_field_values
      where invoice_candidate_id = '${ids.invoiceA}' and field_name = 'invoiceNumber'
    `);
    expect(new Date(timestamps.rows[0]!.created_at).toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(new Date(timestamps.rows[0]!.updated_at).getTime()).toBeGreaterThan(new Date("2000-01-01T00:00:00Z").getTime());
  });

  it("prevents editing terminal invoices", async () => {
    await db.exec(`insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, source_invoice_number, schema_fingerprint, total) values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'VERIFIED', 'SRC-1', 'schema', 10)`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select record_invoice_field_value('${ids.invoiceA}', 1, 'total', '20'::jsonb, '${ids.userA}')`)).rejects.toThrow(/terminal/);
  });

  it("records explained linkage suggestions and accepts one atomically", async () => {
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, schema_fingerprint)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'schema');
      insert into transaction_files (id, tenant_id, property_address, lifecycle) values
        ('${ids.transactionA}', '${ids.tenantA}', '1847 Cypress Avenue', 'ACCUMULATING'),
        ('${ids.transactionA2}', '${ids.tenantA}', '1847 Cypress Avenue', 'ACCUMULATING'),
        ('${ids.transactionB}', '${ids.tenantB}', 'Other tenant', 'ACCUMULATING');
      set role service_role;
    `);
    const first = await db.query<{ id: string }>(`select record_transaction_linkage_proposal(
      '${ids.invoiceA}', 1, '${ids.transactionA}', .94,
      '[{"label":"Property address matches"}]'::jsonb, 'resolver-v1') as id`);
    const second = await db.query<{ id: string }>(`select record_transaction_linkage_proposal(
      '${ids.invoiceA}', 2, '${ids.transactionA2}', .91,
      '[{"label":"Reference number matches"}]'::jsonb, 'resolver-v1') as id`);
    await expect(db.query(`select record_transaction_linkage_proposal(
      '${ids.invoiceA}', 3, '${ids.transactionB}', .99,
      '[{"label":"Invalid cross-tenant match"}]'::jsonb, 'resolver-v1')`)).rejects.toThrow(/transaction file not found/);
    await db.exec("reset role");
    await authenticate(db, ids.userA);
    await expect(db.query(`select * from resolve_transaction_linkage_proposal(
      '${first.rows[0]!.id}', 2, 1, 'ACCEPT', '${ids.userA}')`)).rejects.toThrow(/invoice changed/);
    const accepted = await db.query<{ linkage_status: string }>(`select linkage_status::text from resolve_transaction_linkage_proposal(
      '${first.rows[0]!.id}', 3, 1, 'ACCEPT', '${ids.userA}')`);
    expect(accepted.rows[0]?.linkage_status).toBe("LINKED");
    await expect(db.query(`select * from resolve_transaction_linkage_proposal(
      '${first.rows[0]!.id}', 4, 2, 'ACCEPT', '${ids.userA}')`)).rejects.toThrow(/already been resolved/);
    await db.exec("reset role");
    const proposals = await db.query<{ status: string }>(`select status from transaction_linkage_proposals order by score desc`);
    expect(proposals.rows).toEqual([{ status: "ACCEPTED" }, { status: "SUPERSEDED" }]);
    const linked = await db.query<{ transaction_file_id: string }>(`select transaction_file_id from invoice_candidates where id = '${ids.invoiceA}'`);
    expect(linked.rows[0]?.transaction_file_id).toBe(ids.transactionA);
  });

  it("rejects a match suggestion without discarding the standalone invoice", async () => {
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, schema_fingerprint)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'schema');
      insert into transaction_files (id, tenant_id, property_address, lifecycle)
        values ('${ids.transactionA}', '${ids.tenantA}', '1847 Cypress Avenue', 'ACCUMULATING');
      set role service_role;
    `);
    await expect(db.query(`select record_transaction_linkage_proposal(
      '${ids.invoiceA}', 1, '${ids.transactionA}', .8, '[]'::jsonb, 'resolver-v1')`)).rejects.toThrow(/reasons/);
    const proposal = await db.query<{ id: string }>(`select record_transaction_linkage_proposal(
      '${ids.invoiceA}', 1, '${ids.transactionA}', .8,
      '[{"label":"Address resembles source"}]'::jsonb, 'resolver-v1') as id`);
    await db.exec("reset role");
    await authenticate(db, ids.userA);
    const rejected = await db.query<{ linkage_status: string }>(`select linkage_status::text from resolve_transaction_linkage_proposal(
      '${proposal.rows[0]!.id}', 2, 1, 'REJECT', '${ids.userA}')`);
    expect(rejected.rows[0]?.linkage_status).toBe("UNLINKED");
    await db.exec("reset role");
    const invoice = await db.query<{ linkage_status: string; transaction_file_id: string | null }>(
      `select linkage_status::text, transaction_file_id from invoice_candidates where id = '${ids.invoiceA}'`);
    expect(invoice.rows[0]).toEqual({ linkage_status: "UNLINKED", transaction_file_id: null });
  });

  it("registers manual uploads idempotently without treating checksum as identity", async () => {
    await authenticate(db, ids.userA);
    const args = `'${ids.tenantA}', '${ids.tenantA}/receipt-1/invoice.pdf', 'application/pdf', 100, '${"c".repeat(64)}', 'receipt-1', '${ids.userA}'`;
    const first = await db.query<{ evidence_artifact_id: string; ingestion_event_id: string }>(`select * from register_manual_upload(${args})`);
    const retry = await db.query<{ evidence_artifact_id: string; ingestion_event_id: string }>(`select * from register_manual_upload(${args})`);
    expect(retry.rows[0]).toMatchObject(first.rows[0]!);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/receipt-2/invoice.pdf', 'application/pdf', 100, '${"c".repeat(64)}', 'receipt-2', '${ids.userA}')`);
    await db.exec("reset role");
    const counts = await db.query<{ artifacts: number; receipts: number; jobs: number }>("select (select count(*)::int from evidence_artifacts) artifacts, (select count(*)::int from ingestion_events) receipts, (select count(*)::int from processing_jobs) jobs");
    expect(counts.rows[0]).toEqual({ artifacts: 2, receipts: 2, jobs: 2 });
  });

  it("rejects unsafe manual upload metadata and unauthorized roles", async () => {
    await authenticate(db, ids.userA);
    await expect(db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantB}/escape.pdf', 'application/pdf', 100, '${"d".repeat(64)}', 'bad-path', '${ids.userA}')`)).rejects.toThrow(/tenant scoped/);
    await expect(db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/script.html', 'text/html', 100, '${"d".repeat(64)}', 'bad-type', '${ids.userA}')`)).rejects.toThrow(/unsupported/);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/limit.pdf', 'application/pdf', 5242880, '${"d".repeat(64)}', 'at-limit', '${ids.userA}')`);
    await expect(db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/huge.pdf', 'application/pdf', 5242881, '${"d".repeat(64)}', 'too-large', '${ids.userA}')`)).rejects.toThrow(/5 MB/);
    await db.exec("reset role");
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/viewer.pdf', 'application/pdf', 100, '${"d".repeat(64)}', 'viewer', '${ids.viewerA}')`)).rejects.toThrow(/role cannot review/);
  });

  it("projects unlinked intake receipts without exposing another tenant", async () => {
    await authenticate(db, ids.userA);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/receipt/invoice.pdf', 'application/pdf', 100, '${"e".repeat(64)}', 'receipt', '${ids.userA}')`);
    const own = await db.query<{ file_name: string; safety_status: string; processing_status: string }>(`select file_name, safety_status, processing_status from list_manual_intake_receipts('${ids.tenantA}')`);
    expect(own.rows).toEqual([{ file_name: "invoice.pdf", safety_status: "PENDING", processing_status: "QUEUED" }]);
    await expect(db.query(`select * from list_manual_intake_receipts('${ids.tenantB}')`)).rejects.toThrow(/workspace not found/);
  });

  it("cancels a queued scan idempotently and removes it from the active intake queue", async () => {
    await authenticate(db, ids.userA);
    const receipt = await db.query<{ ingestion_event_id: string }>(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/cancel/invoice.pdf', 'application/pdf', 100, '${"f".repeat(64)}', 'cancel-me', '${ids.userA}')`);
    const eventId = receipt.rows[0]!.ingestion_event_id;
    const first = await db.query<{ status: string }>(`select cancel_manual_intake_scan('${ids.tenantA}', '${eventId}', '${ids.userA}')::text as status`);
    const retry = await db.query<{ status: string }>(`select cancel_manual_intake_scan('${ids.tenantA}', '${eventId}', '${ids.userA}')::text as status`);
    expect(first.rows[0]?.status).toBe("CANCELLED");
    expect(retry.rows[0]?.status).toBe("CANCELLED");
    const active = await db.query(`select * from list_manual_intake_receipts('${ids.tenantA}')`);
    expect(active.rows).toHaveLength(0);
  });

  it("rejects cancellation after successful processing", async () => {
    await authenticate(db, ids.userA);
    const receipt = await db.query<{ ingestion_event_id: string; processing_job_id: string }>(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/done/invoice.pdf', 'application/pdf', 100, '${"1".repeat(64)}', 'done', '${ids.userA}')`);
    await db.exec("reset role");
    await db.exec(`update processing_jobs set status = 'SUCCEEDED' where id = '${receipt.rows[0]!.processing_job_id}'`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select cancel_manual_intake_scan('${ids.tenantA}', '${receipt.rows[0]!.ingestion_event_id}', '${ids.userA}')`)).rejects.toThrow(/no longer/);
  });

  it("claims and safely completes a scan before enqueueing extraction", async () => {
    await authenticate(db, ids.userA);
    const receipt = await db.query<{ evidence_artifact_id: string }>(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/scan/invoice.pdf', 'application/pdf', 100, '${"2".repeat(64)}', 'scan', '${ids.userA}')`);
    await db.exec("reset role");
    const claimed = await db.query<{ id: string; lock_token: string; attempts: number }>(`select id, lock_token, attempts from claim_processing_jobs('worker-1', array['SCAN_EVIDENCE'], 1)`);
    expect(claimed.rows[0]?.attempts).toBe(1);
    await expect(db.query(`select complete_evidence_scan('${claimed.rows[0]!.id}', gen_random_uuid(), true, null)`)).rejects.toThrow(/stale worker lease/);
    await db.query(`select complete_evidence_scan('${claimed.rows[0]!.id}', '${claimed.rows[0]!.lock_token}', true, null)`);
    await db.exec("reset role");
    const artifact = await db.query<{ safety_status: string }>(`select safety_status from evidence_artifacts where id = '${receipt.rows[0]!.evidence_artifact_id}'`);
    const extraction = await db.query<{ count: number }>(`select count(*)::int as count from processing_jobs where job_type = 'EXTRACT_EVIDENCE'`);
    expect(artifact.rows[0]?.safety_status).toBe("SAFE");
    expect(extraction.rows[0]?.count).toBe(1);
  });

  it("quarantines unsafe evidence without enqueueing extraction", async () => {
    await authenticate(db, ids.userA);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/unsafe/invoice.pdf', 'application/pdf', 100, '${"3".repeat(64)}', 'unsafe', '${ids.userA}')`);
    await db.exec("reset role; set role service_role");
    const claimed = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('worker-1', array['SCAN_EVIDENCE'], 1)`);
    await db.query(`select complete_evidence_scan('${claimed.rows[0]!.id}', '${claimed.rows[0]!.lock_token}', false, 'MALWARE_DETECTED')`);
    await db.exec("reset role");
    const artifact = await db.query<{ safety_status: string; quarantine_reason: string }>("select safety_status, quarantine_reason from evidence_artifacts limit 1");
    expect(artifact.rows[0]).toEqual({ safety_status: "QUARANTINED", quarantine_reason: "MALWARE_DETECTED" });
    expect((await db.query("select id from processing_jobs where job_type = 'EXTRACT_EVIDENCE'")).rows).toHaveLength(0);
  });

  it("retries transient worker failures and rejects invalid claim sizes", async () => {
    await authenticate(db, ids.userA);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/retry/invoice.pdf', 'application/pdf', 100, '${"4".repeat(64)}', 'retry', '${ids.userA}')`);
    await db.exec("reset role; set role service_role");
    await expect(db.query("select * from claim_processing_jobs('worker-1', array['SCAN_EVIDENCE'], 0)")).rejects.toThrow(/batch size/);
    const claimed = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('worker-1', array['SCAN_EVIDENCE'], 1)`);
    const failed = await db.query<{ status: string }>(`select fail_processing_job('${claimed.rows[0]!.id}', '${claimed.rows[0]!.lock_token}', 'SCANNER_UNAVAILABLE')::text as status`);
    expect(failed.rows[0]?.status).toBe("RETRY_SCHEDULED");
  });

  it("persists provenance observations and queues assembly only after safe extraction", async () => {
    await authenticate(db, ids.userA);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/extract/invoice.pdf', 'application/pdf', 100, '${"5".repeat(64)}', 'extract', '${ids.userA}')`);
    await db.exec("reset role; set role service_role");
    const scan = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('worker-scan', array['SCAN_EVIDENCE'], 1)`);
    await db.query(`select complete_evidence_scan('${scan.rows[0]!.id}', '${scan.rows[0]!.lock_token}', true, null)`);
    const extraction = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('worker-extract', array['EXTRACT_EVIDENCE'], 1)`);
    const observations = JSON.stringify([{ fieldName: "total", value: "486.00", sourceLocation: { page: 1, region: [1, 2, 3, 4] }, confidence: 0.98 }]).replaceAll("'", "''");
    const run = await db.query<{ run_id: string }>(`select complete_evidence_extraction('${extraction.rows[0]!.id}', '${extraction.rows[0]!.lock_token}', 'fixture', 'model-v1', 'prompt-v1', now(), '${observations}'::jsonb) as run_id`);
    expect(run.rows[0]?.run_id).toBeTruthy();
    await db.exec("reset role");
    expect((await db.query("select id from extracted_observations where field_name = 'total'")).rows).toHaveLength(1);
    expect((await db.query("select id from processing_jobs where job_type = 'ASSEMBLE_INVOICE'")).rows).toHaveLength(1);
  });

  it("assembles a recognized invoice using the default schema and preserves missing-field blockers", async () => {
    await db.exec(`insert into invoice_schema_versions (tenant_id, version, scope, rules, published_at) values ('${ids.tenantA}', 1, 'BROKERAGE_DEFAULT', '{"fields":{"issuer":{"required":true},"invoiceNumber":{"required":true},"total":{"required":true}}}', now())`);
    await authenticate(db, ids.userA);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/assemble/invoice.pdf', 'application/pdf', 100, '${"6".repeat(64)}', 'assemble', '${ids.userA}')`);
    await db.exec("reset role; set role service_role");
    const scan = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('scan', array['SCAN_EVIDENCE'], 1)`);
    await db.query(`select complete_evidence_scan('${scan.rows[0]!.id}', '${scan.rows[0]!.lock_token}', true, null)`);
    const extraction = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('extract', array['EXTRACT_EVIDENCE'], 1)`);
    const observations = JSON.stringify([
      { fieldName: "documentType", value: "INVOICE", sourceLocation: { page: 1 }, confidence: 0.99 },
      { fieldName: "issuer", value: "Northstar Home Inspections", sourceLocation: { page: 1 }, confidence: 0.98 },
      { fieldName: "total", value: "486.00", sourceLocation: { page: 1 }, confidence: 0.97 },
    ]).replaceAll("'", "''");
    await db.query(`select complete_evidence_extraction('${extraction.rows[0]!.id}', '${extraction.rows[0]!.lock_token}', 'fixture', 'model-v1', 'prompt-v1', now(), '${observations}'::jsonb)`);
    const assembly = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('assemble', array['ASSEMBLE_INVOICE'], 1)`);
    const result = await db.query<{ invoice_id: string }>(`select complete_invoice_assembly('${assembly.rows[0]!.id}', '${assembly.rows[0]!.lock_token}') as invoice_id`);
    await db.exec("reset role");
    expect(result.rows[0]?.invoice_id).toBeTruthy();
    const invoice = await db.query<{ lifecycle: string; linkage_status: string; total: string }>(`select lifecycle, linkage_status, total::text from invoice_candidates where id = '${result.rows[0]!.invoice_id}'`);
    expect(invoice.rows[0]).toEqual({ lifecycle: "INCOMPLETE_DRAFT", linkage_status: "UNLINKED", total: "486.0000" });
    expect((await db.query(`select id from work_items where record_id = '${result.rows[0]!.invoice_id}' and blocker_code = 'MISSING:invoiceNumber'`)).rows).toHaveLength(1);
  });

  it("does not create an invoice for unrecognized evidence", async () => {
    await authenticate(db, ids.userA);
    await db.query(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/unknown/photo.png', 'image/png', 100, '${"7".repeat(64)}', 'unknown', '${ids.userA}')`);
    await db.exec("reset role; set role service_role");
    const scan = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('scan', array['SCAN_EVIDENCE'], 1)`);
    await db.query(`select complete_evidence_scan('${scan.rows[0]!.id}', '${scan.rows[0]!.lock_token}', true, null)`);
    const extraction = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('extract', array['EXTRACT_EVIDENCE'], 1)`);
    const observations = JSON.stringify([{ fieldName: "documentType", value: "PHOTO", sourceLocation: { page: 1 }, confidence: 0.99 }]).replaceAll("'", "''");
    await db.query(`select complete_evidence_extraction('${extraction.rows[0]!.id}', '${extraction.rows[0]!.lock_token}', 'fixture', 'model-v1', 'prompt-v1', now(), '${observations}'::jsonb)`);
    const assembly = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('assemble', array['ASSEMBLE_INVOICE'], 1)`);
    const result = await db.query<{ invoice_id: string | null }>(`select complete_invoice_assembly('${assembly.rows[0]!.id}', '${assembly.rows[0]!.lock_token}') as invoice_id`);
    expect(result.rows[0]?.invoice_id).toBeNull();
    await db.exec("reset role");
    expect((await db.query("select id from invoice_candidates")).rows).toHaveLength(0);
    expect((await db.query("select id from work_items where blocker_code = 'UNRECOGNIZED_INVOICE'")).rows).toHaveLength(1);
  });

  it("routes a ready invoice to human review under the mandatory policy", async () => {
    await db.exec(`
      insert into approval_policy_versions (tenant_id, version, mode, published_at) values ('${ids.tenantA}', 1, 'MANDATORY', now());
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, source_invoice_number, schema_fingerprint, total)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'READY_FOR_VERIFICATION', 'SRC-1', 'schema:v1', 100);
      insert into processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key)
        values ('${ids.tenantA}', 'ROUTE_INVOICE_APPROVAL', '${ids.invoiceA}', 'route:${ids.invoiceA}');
      set role service_role;
    `);
    const job = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('route', array['ROUTE_INVOICE_APPROVAL'], 1)`);
    const routed = await db.query<{ lifecycle: string }>(`select route_invoice_approval('${job.rows[0]!.id}', '${job.rows[0]!.lock_token}')::text as lifecycle`);
    expect(routed.rows[0]?.lifecycle).toBe("PENDING_REVIEW");
    await db.exec("reset role");
    const invoice = await db.query<{ approval_decision: string; approval_reason: string }>(`select approval_decision, approval_reason from invoice_candidates where id = '${ids.invoiceA}'`);
    expect(invoice.rows[0]).toEqual({ approval_decision: "HUMAN_REVIEW", approval_reason: "MANDATORY_POLICY" });
  });

  it("falls back to human review when automatic verification has no approved profile", async () => {
    await db.exec(`
      insert into approval_policy_versions (tenant_id, version, mode, published_at) values ('${ids.tenantA}', 1, 'AUTOMATIC', now());
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, source_invoice_number, schema_fingerprint, total)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'READY_FOR_VERIFICATION', 'SRC-2', 'schema:v1', 100);
      insert into processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key)
        values ('${ids.tenantA}', 'ROUTE_INVOICE_APPROVAL', '${ids.invoiceA}', 'route:${ids.invoiceA}');
      set role service_role;
    `);
    const job = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('route', array['ROUTE_INVOICE_APPROVAL'], 1)`);
    await db.query(`select route_invoice_approval('${job.rows[0]!.id}', '${job.rows[0]!.lock_token}')`);
    await db.exec("reset role");
    const invoice = await db.query<{ lifecycle: string; approval_reason: string }>(`select lifecycle, approval_reason from invoice_candidates where id = '${ids.invoiceA}'`);
    expect(invoice.rows[0]).toEqual({ lifecycle: "PENDING_REVIEW", approval_reason: "AUTOMATION_PROFILE_NOT_APPROVED" });
  });

  it("automatically verifies only against an exact approved extraction profile", async () => {
    const artifact = "00000000-0000-4000-8000-000000000091";
    await db.exec(`
      insert into approval_policy_versions (tenant_id, version, mode, published_at) values ('${ids.tenantA}', 1, 'AUTOMATIC', now());
      insert into evidence_artifacts (id, tenant_id, storage_path, media_type, byte_size, sha256, safety_status)
        values ('${artifact}', '${ids.tenantA}', '${ids.tenantA}/auto/invoice.pdf', 'application/pdf', 10, '${"8".repeat(64)}', 'SAFE');
      insert into extraction_runs (tenant_id, evidence_artifact_id, provider, model_version, prompt_version, started_at)
        values ('${ids.tenantA}', '${artifact}', 'fixture', 'model-v1', 'prompt-v1', now());
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, source_invoice_number, schema_fingerprint, total)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'READY_FOR_VERIFICATION', 'SRC-3', 'schema:v1', 100);
      insert into evidence_links (tenant_id, evidence_artifact_id, invoice_candidate_id, relationship)
        values ('${ids.tenantA}', '${artifact}', '${ids.invoiceA}', 'SOURCE_DOCUMENT');
      insert into automatic_verification_profiles (tenant_id, origin, document_class, provider, model_version, prompt_version, schema_fingerprint, evaluation_version, evaluation_metrics, approved_at)
        values ('${ids.tenantA}', 'CAPTURED', 'INVOICE', 'fixture', 'model-v1', 'prompt-v1', 'schema:v1', 'eval-v1', '{"precision":0.999}', now());
      insert into processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key)
        values ('${ids.tenantA}', 'ROUTE_INVOICE_APPROVAL', '${ids.invoiceA}', 'route:${ids.invoiceA}');
      set role service_role;
    `);
    const job = await db.query<{ id: string; lock_token: string }>(`select id, lock_token from claim_processing_jobs('route', array['ROUTE_INVOICE_APPROVAL'], 1)`);
    const routed = await db.query<{ lifecycle: string }>(`select route_invoice_approval('${job.rows[0]!.id}', '${job.rows[0]!.lock_token}')::text as lifecycle`);
    expect(routed.rows[0]?.lifecycle).toBe("VERIFIED");
    await db.exec("reset role");
    const record = await db.query<{ verification_method: string; verified_by: string | null }>(`select verification_method, verified_by from verified_invoice_records where invoice_candidate_id = '${ids.invoiceA}'`);
    expect(record.rows[0]).toEqual({ verification_method: "AUTOMATIC", verified_by: null });
  });

  it("publishes immutable prospective approval policy versions as a tenant administrator", async () => {
    await authenticate(db, ids.userA);
    const first = await db.query<{ version: number; mode: string }>(`select version, mode from publish_approval_policy('${ids.tenantA}', 'MANDATORY', '{}'::jsonb, '${ids.userA}')`);
    const rules = '{"reviewWhen":{"operator":"OR","conditions":[{"type":"TOTAL_ABOVE","value":1000},{"type":"NEW_ISSUER"}]}}';
    const second = await db.query<{ version: number; mode: string }>(`select version, mode from publish_approval_policy('${ids.tenantA}', 'CONDITIONAL', '${rules}'::jsonb, '${ids.userA}')`);
    expect(first.rows[0]).toEqual({ version: 1, mode: "MANDATORY" });
    expect(second.rows[0]).toEqual({ version: 2, mode: "CONDITIONAL" });
    await db.exec("reset role");
    expect((await db.query("select id from approval_policy_versions order by version")).rows).toHaveLength(2);
    expect((await db.query("select id from audit_events where event_type = 'APPROVAL_POLICY_PUBLISHED'")).rows).toHaveLength(2);
  });

  it("rejects approval policy publication by non-admins and malformed conditions", async () => {
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select publish_approval_policy('${ids.tenantA}', 'AUTOMATIC', '{}'::jsonb, '${ids.viewerA}')`)).rejects.toThrow(/only tenant administrators/);
    await db.exec("reset role");
    await authenticate(db, ids.userA);
    await expect(db.query(`select publish_approval_policy('${ids.tenantA}', 'CONDITIONAL', '{"reviewWhen":{"operator":"OR","conditions":[{"type":"TOTAL_ABOVE","value":-1}]}}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/valid reviewWhen/);
    await expect(db.query(`select publish_approval_policy('${ids.tenantA}', 'MANDATORY', '{"unexpected":true}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/only supported/);
  });

  it("converges and approves a transaction file only after every requirement is resolved", async () => {
    const reviewer2 = "00000000-0000-4000-8000-000000000014";
    await db.exec(`insert into tenant_memberships (tenant_id, user_id, role) values ('${ids.tenantA}', '${reviewer2}', 'REVIEWER')`);
    await authenticate(db, ids.userA);
    const requirements = '{"artifacts":["purchase-agreement"],"fields":["buyer-name"]}';
    const created = await db.query<{ transaction_id: string }>(`select create_transaction_file('${ids.tenantA}', 'TX-100', '1847 Cypress Ave', '${requirements}'::jsonb, '${ids.userA}') as transaction_id`);
    const transactionId = created.rows[0]!.transaction_id;
    await expect(db.query(`select evaluate_transaction_convergence('${transactionId}', 1, '${ids.userA}')`)).rejects.toThrow(/2 unresolved/);
    const artifact = await db.query<{ version: number }>(`select record_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'purchase-agreement', 'PRESENT', 0.99, '${ids.userA}') as version`);
    const field = await db.query<{ version: number }>(`select record_transaction_requirement('${transactionId}', ${artifact.rows[0]!.version}, 'FIELD', 'buyer-name', 'PRESENT', 0.98, '${ids.userA}') as version`);
    const converged = await db.query<{ lifecycle: string }>(`select evaluate_transaction_convergence('${transactionId}', ${field.rows[0]!.version}, '${ids.userA}')::text as lifecycle`);
    expect(converged.rows[0]?.lifecycle).toBe("CONVERGED");
    await db.exec(`reset role; update tenants set transaction_separation_of_duties = true where id = '${ids.tenantA}'`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select approve_transaction_file('${transactionId}', 4, '${ids.userA}')`)).rejects.toThrow(/another reviewer/);
    await db.exec("reset role");
    await authenticate(db, reviewer2);
    const approved = await db.query<{ lifecycle: string }>(`select approve_transaction_file('${transactionId}', 4, '${reviewer2}')::text as lifecycle`);
    expect(approved.rows[0]?.lifecycle).toBe("APPROVED");
  });

  it("rejects empty Transaction Files and blocks readiness without requirements", async () => {
    await authenticate(db, ids.userA);
    await expect(db.query(`select create_transaction_file('${ids.tenantA}', 'TX-EMPTY', '1847 Cypress Ave', '{"artifacts":[],"fields":[]}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/requirements are invalid/);
    await db.exec("reset role");
    await db.exec(`insert into transaction_files (id, tenant_id, external_reference, property_address, lifecycle)
      values ('${ids.transactionA}', '${ids.tenantA}', 'LEGACY-EMPTY', '1847 Cypress Ave', 'ACCUMULATING')`);
    await expect(db.exec(`update transaction_files set lifecycle = 'CONVERGED' where id = '${ids.transactionA}'`)).rejects.toThrow(/at least one/);
  });

  it("stores transaction details and reopens approval when a requirement is added", async () => {
    await authenticate(db, ids.userA);
    const created = await db.query<{ transaction_id: string }>(`select create_transaction_file_with_details(
      '${ids.tenantA}', 'TX-RICH', '1847 Cypress Ave', 'PURCHASE', 'Austin',
      '{"closingDate":"2026-10-15"}'::jsonb, '{"artifacts":["purchase-agreement"],"fields":[]}'::jsonb, '${ids.userA}') as transaction_id`);
    const transactionId = created.rows[0]!.transaction_id;
    await db.query(`select record_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'purchase-agreement', 'PRESENT', 1, '${ids.userA}')`);
    await db.query(`select evaluate_transaction_convergence('${transactionId}', 2, '${ids.userA}')`);
    await db.query(`select approve_transaction_file('${transactionId}', 3, '${ids.userA}')`);
    const next = await db.query<{ version: number }>(`select add_transaction_requirement('${transactionId}', 4, 'FIELD', 'Buyer phone', '${ids.userA}') as version`);
    expect(next.rows[0]?.version).toBe(5);
    await expect(db.query(`select add_transaction_requirement('${transactionId}', 4, 'FIELD', 'Other', '${ids.userA}')`)).rejects.toThrow(/changed/);
    await expect(db.query(`select add_transaction_requirement('${transactionId}', 5, 'FIELD', 'Buyer phone', '${ids.userA}')`)).rejects.toThrow(/already exists/);
    await db.exec("reset role");
    const file = await db.query<{ lifecycle: string; transaction_type: string; office: string; approved_at: string | null }>(`select lifecycle, transaction_type, office, approved_at::text from transaction_files where id = '${transactionId}'`);
    expect(file.rows[0]).toEqual({ lifecycle: "ACCUMULATING", transaction_type: "PURCHASE", office: "Austin", approved_at: null });
    const requirement = await db.query<{ status: string }>(`select status from transaction_requirement_statuses where transaction_file_id = '${transactionId}' and requirement_key = 'Buyer phone'`);
    expect(requirement.rows).toEqual([{ status: "MISSING" }]);
    expect((await db.query(`select id from audit_events where aggregate_id = '${transactionId}' and event_type = 'TRANSACTION_REQUIREMENT_ADDED'`)).rows).toHaveLength(1);
  });

  it("audits detail edits and requirement removal without allowing an empty file", async () => {
    await authenticate(db, ids.userA);
    const created = await db.query<{ transaction_id: string }>(`select create_transaction_file('${ids.tenantA}', 'TX-EDIT', 'Old address', '{"artifacts":["agreement","title"],"fields":[]}'::jsonb, '${ids.userA}') as transaction_id`);
    const transactionId = created.rows[0]!.transaction_id;
    await db.query(`select update_transaction_file_details('${transactionId}', 1, 'TX-EDIT-2', 'New address', 'SALE', 'Dallas', '2026-11-01', '${ids.userA}')`);
    await db.query(`select remove_transaction_requirement('${transactionId}', 2, 'ARTIFACT', 'title', '${ids.userA}')`);
    await expect(db.query(`select remove_transaction_requirement('${transactionId}', 3, 'ARTIFACT', 'agreement', '${ids.userA}')`)).rejects.toThrow(/at least one/);
    await db.exec("reset role");
    const file = await db.query<{ property_address: string; transaction_type: string; version: number }>(`select property_address, transaction_type, version from transaction_files where id = '${transactionId}'`);
    expect(file.rows[0]).toEqual({ property_address: "New address", transaction_type: "SALE", version: 3 });
    const events = await db.query<{ event_type: string }>(`select event_type from audit_events where aggregate_id = '${transactionId}' and event_type in ('TRANSACTION_DETAILS_UPDATED','TRANSACTION_REQUIREMENT_REMOVED') order by event_type`);
    expect(events.rows).toEqual([{ event_type: "TRANSACTION_DETAILS_UPDATED" }, { event_type: "TRANSACTION_REQUIREMENT_REMOVED" }]);
  });

  it("creates a v2 Transaction File with an owner, primary party, and business stage", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ transaction_id: string }>(`select create_transaction_file_v2(
      '${ids.tenantA}', 'TX-V2', '18 Market Street', '${type.rows[0]!.id}', '${ids.userA}',
      'Jamie Buyer', 'PERSON', 'BUYER', '${ids.userA}') as transaction_id`);
    await db.exec("reset role");
    const file = await db.query<{ business_stage: string; transaction_type: string }>(`select business_stage, transaction_type from transaction_files where id = '${created.rows[0]!.transaction_id}'`);
    expect(file.rows[0]).toEqual({ business_stage: "DRAFT", transaction_type: "PURCHASE" });
    expect((await db.query(`select user_id from transaction_team_assignments where transaction_file_id = '${created.rows[0]!.transaction_id}' and responsibility = 'OWNER'`)).rows).toEqual([{ user_id: ids.userA }]);
    expect((await db.query(`select role, is_primary from transaction_party_assignments where transaction_file_id = '${created.rows[0]!.transaction_id}'`)).rows).toEqual([{ role: "BUYER", is_primary: true }]);
    expect((await db.query(`select id from audit_events where aggregate_id = '${created.rows[0]!.transaction_id}' and event_type = 'TRANSACTION_FILE_V2_CREATED'`)).rows).toHaveLength(1);
    await authenticate(db, ids.userA);
    const context = await db.query<{ transaction_type_name: string; owner_user_id: string; primary_party_name: string; primary_party_role: string }>(`select transaction_type_name, owner_user_id, primary_party_name, primary_party_role from list_transaction_workspace_context('${ids.tenantA}') where transaction_file_id = '${created.rows[0]!.transaction_id}'`);
    expect(context.rows[0]).toEqual({ transaction_type_name: "Purchase", owner_user_id: ids.userA, primary_party_name: "Jamie Buyer", primary_party_role: "BUYER" });
  });

  it("rejects unavailable owners and cross-tenant transaction types", async () => {
    await authenticate(db, ids.userA);
    const ownType = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'SALE'`);
    await expect(db.query(`select create_transaction_file_v2('${ids.tenantA}', '', '18 Market Street', '${ownType.rows[0]!.id}', '${ids.userB}', 'Seller', 'PERSON', 'SELLER', '${ids.userA}')`)).rejects.toThrow(/owner is unavailable/);
    await db.exec("reset role");
    const otherType = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantB}' and code = 'SALE'`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select create_transaction_file_v2('${ids.tenantA}', '', '18 Market Street', '${otherType.rows[0]!.id}', '${ids.userA}', 'Seller', 'PERSON', 'SELLER', '${ids.userA}')`)).rejects.toThrow(/type is unavailable/);
    await expect(db.query(`select create_transaction_file_v2('${ids.tenantA}', '', '18 Market Street', '${ownType.rows[0]!.id}', '${ids.userA}', '', 'PERSON', 'SELLER', '${ids.userA}')`)).rejects.toThrow(/party name/);
  });

  it("publishes immutable validated transaction templates as an administrator", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const configuration = JSON.stringify({
      requirements: { artifacts: [{ key: "purchase-agreement", gate: "BEFORE_REVIEW" }], fields: [{ key: "closing-date", gate: "BEFORE_CLOSING" }] },
      paymentPolicy: { requireApprovedInvoices: true, allowDeferredPayments: false },
      healthWeights: { documents: 30, parties: 25, dates: 10, financials: 15, invoices: 15, issues: 5 },
    }).replaceAll("'", "''");
    const first = await db.query<{ version: number }>(`select version from publish_transaction_template('${type.rows[0]!.id}', '${configuration}'::jsonb, '${ids.userA}')`);
    const second = await db.query<{ version: number }>(`select version from publish_transaction_template('${type.rows[0]!.id}', '${configuration}'::jsonb, '${ids.userA}')`);
    expect(first.rows[0]?.version).toBe(1);
    expect(second.rows[0]?.version).toBe(2);
    await expect(db.query(`select publish_transaction_template('${type.rows[0]!.id}', '{"requirements":{"artifacts":[],"fields":[]},"healthWeights":{"documents":20}}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/template is invalid/);
  });

  it("restricts transaction configuration commands to tenant administrators", async () => {
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select create_transaction_type('${ids.tenantA}', 'REFINANCE', 'Refinance', '${ids.viewerA}')`)).rejects.toThrow(/only tenant administrators/);
    await db.exec("reset role");
    await authenticate(db, ids.userA);
    const created = await db.query<{ id: string }>(`select create_transaction_type('${ids.tenantA}', 'REFINANCE', 'Refinance', '${ids.userA}') as id`);
    await expect(db.query(`select create_transaction_type('${ids.tenantA}', 'REFINANCE', 'Duplicate', '${ids.userA}')`)).rejects.toThrow(/already exists/);
    expect((await db.query<{ active: boolean }>(`select set_transaction_type_active('${created.rows[0]!.id}', false, '${ids.userA}') as active`)).rows[0]?.active).toBe(false);
    await expect(db.query(`select publish_transaction_template('${created.rows[0]!.id}', '{"requirements":{"artifacts":[],"fields":[]}}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/activate/);
  });

  it("materializes template requirements and enforces the Before Review gate", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    await db.query(`select publish_transaction_template('${type.rows[0]!.id}', '{"requirements":{"artifacts":[{"key":"agreement","gate":"BEFORE_REVIEW"}],"fields":[{"key":"closing-date","gate":"BEFORE_CLOSING"}]}}'::jsonb, '${ids.userA}')`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', 'TX-STAGE', '18 Market Street', '${type.rows[0]!.id}', '${ids.userA}', 'Jamie Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    expect((await db.query(`select requirement_key from transaction_requirement_statuses where transaction_file_id = '${transactionId}' order by requirement_key`)).rows).toEqual([{ requirement_key: "agreement" }, { requirement_key: "closing-date" }]);
    expect((await db.query<{ stage: string }>(`select begin_transaction_work('${transactionId}', 1, '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("DOCUMENTS_PENDING");
    await expect(db.query(`select submit_transaction_for_review('${transactionId}', 2, '${ids.userA}')`)).rejects.toThrow(/1 Before Review/);
    await db.query(`select record_transaction_requirement('${transactionId}', 2, 'ARTIFACT', 'agreement', 'PRESENT', 1, '${ids.userA}')`);
    expect((await db.query<{ stage: string }>(`select submit_transaction_for_review('${transactionId}', 3, '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("UNDER_REVIEW");
  });

  it("projects explainable transaction health without combining currencies", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'SALE'`);
    await db.query(`select publish_transaction_template('${type.rows[0]!.id}', '{"requirements":{"artifacts":[{"key":"title","gate":"BEFORE_REVIEW"}],"fields":[{"key":"closing-date","gate":"BEFORE_CLOSING"}]}}'::jsonb, '${ids.userA}')`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', 'TX-HEALTH', '9 Health Road', '${type.rows[0]!.id}', '${ids.userA}', 'Jamie Seller', 'PERSON', 'SELLER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select record_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'title', 'PRESENT', 1, '${ids.userA}')`);
    await db.exec("reset role");
    await db.exec(`
      update transaction_files set key_dates = '{"closingDate":"2030-01-01"}'::jsonb where id = '${transactionId}';
      insert into invoice_candidates (tenant_id, issuer_id, transaction_file_id, origin, lifecycle, linkage_status, schema_fingerprint, currency, total) values
        ('${ids.tenantA}', '${ids.issuerA}', '${transactionId}', 'CAPTURED', 'VERIFIED', 'LINKED', 'schema', 'USD', 100),
        ('${ids.tenantA}', '${ids.issuerA}', '${transactionId}', 'CAPTURED', 'VERIFIED', 'LINKED', 'schema', 'EUR', 50);
    `);
    await authenticate(db, ids.userA);
    const health = await db.query<{ completion_percent: number; missing_documents: number; invoice_conflicts: number; outstanding_by_currency: { USD: number; EUR: number }; calculation_version: string }>(`select completion_percent, missing_documents, invoice_conflicts, outstanding_by_currency, calculation_version from list_transaction_health('${ids.tenantA}') where transaction_file_id = '${transactionId}'`);
    expect(health.rows[0]).toMatchObject({ completion_percent: 50, missing_documents: 0, invoice_conflicts: 0, calculation_version: "requirements-payments-v2" });
    expect(health.rows[0]?.outstanding_by_currency).toEqual({ EUR: 50, USD: 100 });
    await expect(db.query(`select * from list_transaction_health('${ids.tenantB}')`)).rejects.toThrow(/workspace not found/);
  });

  it("records parties, dates, and financials and invalidates an active review", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', 'TX-FACTS', '42 Main Street', '${type.rows[0]!.id}', '${ids.userA}', 'Original Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select begin_transaction_work('${transactionId}', 1, '${ids.userA}')`);
    await db.query(`select submit_transaction_for_review('${transactionId}', 2, '${ids.userA}')`);
    await db.query(`select add_transaction_party('${transactionId}', 3, 'New Buyer LLC', 'ORGANIZATION', 'BUYER', true, '${ids.userA}')`);
    let file = await db.query<{ business_stage: string; version: number }>(`select business_stage, version from transaction_files where id = '${transactionId}'`);
    expect(file.rows[0]).toEqual({ business_stage: "DOCUMENTS_PENDING", version: 4 });
    expect((await db.query<{ count: number }>(`select count(*)::int as count from transaction_party_assignments where transaction_file_id = '${transactionId}' and is_primary`)).rows[0]?.count).toBe(1);
    await db.query(`select set_transaction_important_date('${transactionId}', 4, 'CLOSING', '2030-06-15', null, null, '${ids.userA}')`);
    await db.query(`select set_transaction_financial('${transactionId}', 5, 'DEAL_VALUE', 'Purchase price', 425000.50, 'usd', '${ids.userA}')`);
    file = await db.query<{ business_stage: string; version: number }>(`select business_stage, version from transaction_files where id = '${transactionId}'`);
    expect(file.rows[0]).toEqual({ business_stage: "DOCUMENTS_PENDING", version: 6 });
    expect((await db.query(`select date_value::text from transaction_important_dates where transaction_file_id = '${transactionId}'`)).rows).toEqual([{ date_value: "2030-06-15" }]);
    expect((await db.query(`select financial_kind, amount, currency from transaction_financial_entries where transaction_file_id = '${transactionId}'`)).rows).toEqual([{ financial_kind: "DEAL_VALUE", amount: "425000.50", currency: "USD" }]);
    expect((await db.query<{ event_type: string }>(`select event_type from audit_events where aggregate_id = '${transactionId}' and event_type like 'TRANSACTION_%' order by created_at`)).rows.map((row) => row.event_type)).toEqual(expect.arrayContaining(["TRANSACTION_PARTY_ADDED", "TRANSACTION_IMPORTANT_DATE_SET", "TRANSACTION_FINANCIAL_SET"]));
  });

  it("rejects invalid or unauthorized transaction fact edits", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'SALE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '7 Boundary Road', '${type.rows[0]!.id}', '${ids.userA}', 'Seller', 'PERSON', 'SELLER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await expect(db.query(`select set_transaction_financial('${transactionId}', 1, 'DEAL_VALUE', 'Price', -1, 'USD', '${ids.userA}')`)).rejects.toThrow(/zero or greater/);
    await expect(db.query(`select set_transaction_financial('${transactionId}', 1, 'DEAL_VALUE', 'Price', 10, 'US', '${ids.userA}')`)).rejects.toThrow(/three-letter/);
    await expect(db.query(`select set_transaction_important_date('${transactionId}', 1, 'CLOSING', null, '2030-06-15 10:00+00', null, '${ids.userA}')`)).rejects.toThrow(/time zone/);
    await expect(db.query(`select add_transaction_party('${transactionId}', 1, 'Broker', 'PERSON', 'AGENT', true, '${ids.userA}')`)).rejects.toThrow(/primary party role/);
    await db.exec("reset role");
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select set_transaction_financial('${transactionId}', 1, 'FEE', 'Fee', 10, 'USD', '${ids.viewerA}')`)).rejects.toThrow(/role cannot/);
    await db.exec("reset role");
    await db.exec(`update transaction_files set business_stage = 'CLOSED' where id = '${transactionId}'`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select set_transaction_important_date('${transactionId}', 1, 'CLOSING', '2030-06-15', null, null, '${ids.userA}')`)).rejects.toThrow(/cannot be edited/);
  });

  it("enforces ownership and lifecycle consistency across legacy mutation paths", async () => {
    const reviewer = "00000000-0000-4000-8000-000000000014";
    await db.exec(`insert into tenant_memberships (tenant_id, user_id, role) values ('${ids.tenantA}', '${reviewer}', 'REVIEWER')`);
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '88 Guard Street', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select begin_transaction_work('${transactionId}', 1, '${ids.userA}')`);
    await db.query(`select submit_transaction_for_review('${transactionId}', 2, '${ids.userA}')`);
    await db.query(`select add_transaction_requirement('${transactionId}', 3, 'FIELD', 'financing-reference', '${ids.userA}')`);
    expect((await db.query<{ business_stage: string }>(`select business_stage from transaction_files where id = '${transactionId}'`)).rows[0]?.business_stage).toBe("DOCUMENTS_PENDING");
    await db.exec("reset role");
    await authenticate(db, reviewer);
    await expect(db.query(`select add_transaction_party('${transactionId}', 4, 'Unauthorized Party', 'PERSON', 'BUYER', false, '${reviewer}')`)).rejects.toThrow(/assigned owner/);
    await db.exec("reset role");
    await db.exec(`update transaction_files set business_stage = 'CLOSED' where id = '${transactionId}'`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select update_transaction_file_details('${transactionId}', 4, '', 'Changed address', 'PURCHASE', '', '', '${ids.userA}')`)).rejects.toThrow(/cannot be edited/);
  });

  it("validates typed custom fields and includes required values in the review gate", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'RENTAL'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '12 Typed Lane', '${type.rows[0]!.id}', '${ids.userA}', 'Tenant', 'PERSON', 'TENANT', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    const definition = await db.query<{ id: string }>(`select add_transaction_custom_field('${transactionId}', 1, 'lease_term', 'Lease term (months)', 'NUMBER', true, 'BEFORE_REVIEW', '{"minimum":1,"maximum":120}'::jsonb, '${ids.userA}') as id`);
    await expect(db.query(`select set_transaction_custom_field_value('${transactionId}', 2, '${definition.rows[0]!.id}', '"twelve"'::jsonb, '{"method":"MANUAL"}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/does not match/);
    await expect(db.query(`select set_transaction_custom_field_value('${transactionId}', 2, '${definition.rows[0]!.id}', '121'::jsonb, '{"method":"MANUAL"}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/does not match/);
    await db.query(`select begin_transaction_work('${transactionId}', 2, '${ids.userA}')`);
    await expect(db.query(`select submit_transaction_for_review('${transactionId}', 3, '${ids.userA}')`)).rejects.toThrow(/1 Before Review/);
    expect((await db.query<{ version: number }>(`select set_transaction_custom_field_value('${transactionId}', 3, '${definition.rows[0]!.id}', '24'::jsonb, '{"method":"MANUAL"}'::jsonb, '${ids.userA}') as version`)).rows[0]?.version).toBe(4);
    expect((await db.query<{ stage: string }>(`select submit_transaction_for_review('${transactionId}', 4, '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("UNDER_REVIEW");
    await db.query(`select set_transaction_custom_field_value('${transactionId}', 5, '${definition.rows[0]!.id}', '36'::jsonb, '{"method":"MANUAL"}'::jsonb, '${ids.userA}')`);
    expect((await db.query<{ business_stage: string }>(`select business_stage from transaction_files where id = '${transactionId}'`)).rows[0]?.business_stage).toBe("DOCUMENTS_PENDING");
  });

  it("rejects malformed custom field definitions and duplicate keys", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'LEASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '9 Rules Road', '${type.rows[0]!.id}', '${ids.userA}', 'Landlord', 'PERSON', 'LANDLORD', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await expect(db.query(`select add_transaction_custom_field('${transactionId}', 1, 'Bad Key', 'Bad', 'TEXT', false, 'BEFORE_REVIEW', '{}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/field key/);
    await db.query(`select add_transaction_custom_field('${transactionId}', 1, 'property_code', 'Property code', 'TEXT', false, 'BEFORE_REVIEW', '{"minLength":2}'::jsonb, '${ids.userA}')`);
    await expect(db.query(`select add_transaction_custom_field('${transactionId}', 2, 'property_code', 'Duplicate', 'TEXT', false, 'BEFORE_REVIEW', '{}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/already exists/);
  });

  it("retains immutable document versions and projects the current review state", async () => {
    const evidenceOne = "00000000-0000-4000-8000-000000000091";
    const evidenceTwo = "00000000-0000-4000-8000-000000000092";
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'SALE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '27 Document Way', '${type.rows[0]!.id}', '${ids.userA}', 'Seller', 'PERSON', 'SELLER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'closing-disclosure', '${ids.userA}')`);
    await db.exec("reset role");
    await db.exec(`insert into evidence_artifacts (id, tenant_id, storage_path, media_type, byte_size, sha256, safety_status) values
      ('${evidenceOne}', '${ids.tenantA}', '${ids.tenantA}/docs/closing-v1.pdf', 'application/pdf', 100, '${"8".repeat(64)}', 'SAFE'),
      ('${evidenceTwo}', '${ids.tenantA}', '${ids.tenantA}/docs/closing-v2.pdf', 'application/pdf', 120, '${"9".repeat(64)}', 'SAFE')`);
    await authenticate(db, ids.userA);
    const first = await db.query<{ document_id: string; document_version_id: string; transaction_version: number }>(`select * from register_transaction_document_version('${transactionId}', 2, 'closing-disclosure', 'Closing disclosure', '${evidenceOne}', null, '${ids.userA}')`);
    expect(first.rows[0]?.transaction_version).toBe(3);
    await db.query(`select review_transaction_document('${transactionId}', 3, '${first.rows[0]!.document_version_id}', 'VERIFIED', null, '${ids.userA}')`);
    const second = await db.query<{ document_version_id: string }>(`select document_version_id from register_transaction_document_version('${transactionId}', 4, 'closing-disclosure', 'Closing disclosure', '${evidenceTwo}', '2035-01-01', '${ids.userA}')`);
    const projection = await db.query<{ version: number; effective_status: string; file_name: string }>(`select version, effective_status, file_name from list_transaction_documents('${ids.tenantA}') where transaction_file_id = '${transactionId}'`);
    expect(projection.rows).toEqual([{ version: 2, effective_status: "RECEIVED", file_name: "closing-v2.pdf" }]);
    const history = await db.query<{ version: number; effective_status: string; file_name: string; is_current: boolean }>(`select version, effective_status, file_name, is_current from list_transaction_document_history('${ids.tenantA}') where transaction_file_id = '${transactionId}' order by version desc`);
    expect(history.rows).toEqual([
      { version: 2, effective_status: "RECEIVED", file_name: "closing-v2.pdf", is_current: true },
      { version: 1, effective_status: "VERIFIED", file_name: "closing-v1.pdf", is_current: false },
    ]);
    await db.exec("reset role");
    expect((await db.query(`select version from transaction_document_versions where document_id = '${first.rows[0]!.document_id}' order by version`)).rows).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(db.exec(`delete from transaction_document_versions where id = '${first.rows[0]!.document_version_id}'`)).rejects.toThrow(/append-only/);
    await authenticate(db, ids.userA);
    await expect(db.query(`select review_transaction_document('${transactionId}', 5, '${second.rows[0]!.document_version_id}', 'REJECTED', '', '${ids.userA}')`)).rejects.toThrow(/explain why/);
    await db.query(`select review_transaction_document('${transactionId}', 5, '${second.rows[0]!.document_version_id}', 'REJECTED', 'Signature page is missing', '${ids.userA}')`);
    expect((await db.query(`select status from transaction_requirement_statuses where transaction_file_id = '${transactionId}' and requirement_key = 'closing-disclosure'`)).rows).toEqual([{ status: "MISSING" }]);
    expect((await db.query(`select status from work_items where record_id = '${transactionId}' and blocker_code = 'REQUIREMENT:ARTIFACT:closing-disclosure' order by created_at desc limit 1`)).rows).toEqual([{ status: "WAITING_FOR_EVIDENCE" }]);
  });

  it("keeps verified documents under review and advances only after review gates pass", async () => {
    const evidence = "00000000-0000-4000-8000-000000000094";
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '31 Review Road', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'purchase-agreement', '${ids.userA}')`);
    await db.exec("reset role");
    await db.exec(`insert into evidence_artifacts (id, tenant_id, storage_path, media_type, byte_size, sha256, safety_status) values
      ('${evidence}', '${ids.tenantA}', '${ids.tenantA}/docs/agreement.pdf', 'application/pdf', 100, '${"7".repeat(64)}', 'SAFE')`);
    await authenticate(db, ids.userA);
    const registered = await db.query<{ document_version_id: string }>(`select document_version_id from register_transaction_document_version('${transactionId}', 2, 'purchase-agreement', 'Purchase agreement', '${evidence}', null, '${ids.userA}')`);
    await db.query(`select begin_transaction_work('${transactionId}', 3, '${ids.userA}')`);
    await db.query(`select submit_transaction_for_review('${transactionId}', 4, '${ids.userA}')`);

    await expect(db.query(`select complete_transaction_review('${transactionId}', 5, '${ids.userA}')`)).rejects.toThrow(/verify 1 required document/);
    expect((await db.query<{ version: number }>(`select review_transaction_document('${transactionId}', 5, '${registered.rows[0]!.document_version_id}', 'VERIFIED', null, '${ids.userA}') as version`)).rows[0]?.version).toBe(6);
    expect((await db.query(`select business_stage, version from transaction_files where id = '${transactionId}'`)).rows).toEqual([{ business_stage: "UNDER_REVIEW", version: 6 }]);
    await db.exec("reset role");
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select complete_transaction_review('${transactionId}', 6, '${ids.viewerA}')`)).rejects.toThrow(/role cannot review/);
    await db.exec("reset role");
    await authenticate(db, ids.userA);
    expect((await db.query<{ stage: string }>(`select complete_transaction_review('${transactionId}', 6, '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("READY_FOR_CLOSING");
    expect((await db.query(`select business_stage, version from transaction_files where id = '${transactionId}'`)).rows).toEqual([{ business_stage: "READY_FOR_CLOSING", version: 7 }]);
    await expect(db.query(`select complete_transaction_review('${transactionId}', 7, '${ids.userA}')`)).rejects.toThrow(/not under review/);
  });

  it("reopens document collection when a submitted document is rejected", async () => {
    const evidence = "00000000-0000-4000-8000-000000000095";
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'SALE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '32 Review Road', '${type.rows[0]!.id}', '${ids.userA}', 'Seller', 'PERSON', 'SELLER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'closing-disclosure', '${ids.userA}')`);
    await db.exec("reset role");
    await db.exec(`insert into evidence_artifacts (id, tenant_id, storage_path, media_type, byte_size, sha256, safety_status) values
      ('${evidence}', '${ids.tenantA}', '${ids.tenantA}/docs/disclosure.pdf', 'application/pdf', 100, '${"6".repeat(64)}', 'SAFE')`);
    await authenticate(db, ids.userA);
    const registered = await db.query<{ document_version_id: string }>(`select document_version_id from register_transaction_document_version('${transactionId}', 2, 'closing-disclosure', 'Closing disclosure', '${evidence}', null, '${ids.userA}')`);
    await db.query(`select begin_transaction_work('${transactionId}', 3, '${ids.userA}')`);
    await db.query(`select submit_transaction_for_review('${transactionId}', 4, '${ids.userA}')`);
    await db.query(`select review_transaction_document('${transactionId}', 5, '${registered.rows[0]!.document_version_id}', 'REJECTED', 'Signature page is missing', '${ids.userA}')`);

    expect((await db.query(`select business_stage, version from transaction_files where id = '${transactionId}'`)).rows).toEqual([{ business_stage: "DOCUMENTS_PENDING", version: 6 }]);
    expect((await db.query(`select status from transaction_requirement_statuses where transaction_file_id = '${transactionId}' and requirement_key = 'closing-disclosure'`)).rows).toEqual([{ status: "MISSING" }]);
  });

  it("tracks linked-invoice payments without changing invoice verification", async () => {
    const invoiceId = "00000000-0000-4000-8000-000000000096";
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '40 Payment Lane', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.exec("reset role");
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, transaction_file_id, origin, lifecycle, linkage_status, source_invoice_number, currency, total, schema_fingerprint)
      values ('${invoiceId}', '${ids.tenantA}', '${ids.issuerA}', '${transactionId}', 'CAPTURED', 'VERIFIED', 'LINKED', 'INV-40', 'USD', 100, 'schema');
      insert into invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method)
      values ('${ids.tenantA}', '${invoiceId}', 'due_date', '"2030-05-01"'::jsonb, 'REVIEWER_ENTERED');
    `);
    await authenticate(db, ids.userA);
    expect((await db.query(`select vendor, invoice_number, payment_status, outstanding_amount, due_date::text from list_transaction_invoices('${ids.tenantA}') where invoice_candidate_id = '${invoiceId}'`)).rows).toEqual([{ vendor: "Issuer A", invoice_number: "INV-40", payment_status: "UNPAID", outstanding_amount: "100.0000", due_date: "2030-05-01" }]);
    expect((await db.query<{ version: number }>(`select set_transaction_invoice_payment('${transactionId}', 1, '${invoiceId}', 'PARTIALLY_PAID', 40, null, null, '${ids.userA}') as version`)).rows[0]?.version).toBe(2);
    expect((await db.query(`select payment_status, paid_amount, outstanding_amount from list_transaction_invoices('${ids.tenantA}') where invoice_candidate_id = '${invoiceId}'`)).rows).toEqual([{ payment_status: "PARTIALLY_PAID", paid_amount: "40.0000", outstanding_amount: "60.0000" }]);
    expect((await db.query<{ outstanding: Record<string, number>; calculation_version: string }>(`select outstanding_by_currency as outstanding, calculation_version from list_transaction_health('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows[0]).toEqual({ outstanding: { USD: 60 }, calculation_version: "requirements-payments-v2" });
    await expect(db.query(`select set_transaction_invoice_payment('${transactionId}', 2, '${invoiceId}', 'PAID', 99, null, null, '${ids.userA}')`)).rejects.toThrow(/must equal/);
    await expect(db.query(`select set_transaction_invoice_payment('${transactionId}', 2, '${invoiceId}', 'SCHEDULED', 0, null, null, '${ids.userA}')`)).rejects.toThrow(/date is required/);
    await expect(db.query(`select set_transaction_invoice_payment('${transactionId}', 2, '${invoiceId}', 'DISPUTED', 40, null, null, '${ids.userA}')`)).rejects.toThrow(/reason is required/);
    await db.exec("reset role");
    await authenticate(db, ids.viewerA);
    await expect(db.query(`select set_transaction_invoice_payment('${transactionId}', 2, '${invoiceId}', 'PAID', 100, null, null, '${ids.viewerA}')`)).rejects.toThrow(/only the assigned owner/);
    await db.exec("reset role");
    await authenticate(db, ids.userA);
    await db.query(`select set_transaction_invoice_payment('${transactionId}', 2, '${invoiceId}', 'DISPUTED', 40, null, 'Amount is under review', '${ids.userA}')`);
    expect((await db.query<{ lifecycle: string }>(`select lifecycle::text from invoice_candidates where id = '${invoiceId}'`)).rows[0]?.lifecycle).toBe("VERIFIED");
    expect((await db.query<{ outstanding: Record<string, number> }>(`select outstanding_by_currency as outstanding from list_transaction_health('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows[0]?.outstanding).toEqual({});
    await expect(db.query(`select set_transaction_invoice_payment('${transactionId}', 2, '${invoiceId}', 'UNPAID', 0, null, null, '${ids.userA}')`)).rejects.toThrow(/changed; refresh/);
  });

  it("tracks manual and generated Transaction File issues", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '41 Issue Lane', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'FIELD', 'tax-id', '${ids.userA}')`);
    const issue = await db.query<{ id: string }>(`select create_transaction_issue('${transactionId}', 2, 'Confirm wire instructions', 'PAYMENT', 'HIGH', true, '${ids.userA}', '2030-05-01', '${ids.userA}') as id`);
    expect((await db.query(`select title, category, severity, is_blocking, source from list_transaction_issues('${ids.tenantA}') where transaction_file_id = '${transactionId}' order by source`)).rows).toEqual([
      { title: "Missing information", category: "REQUIREMENT", severity: "MEDIUM", is_blocking: true, source: "GENERATED" },
      { title: "Confirm wire instructions", category: "PAYMENT", severity: "HIGH", is_blocking: true, source: "MANUAL" },
    ]);
    await expect(db.query(`select create_transaction_issue('${transactionId}', 3, 'Bad owner', 'OTHER', 'LOW', false, '${ids.userB}', null, '${ids.userA}')`)).rejects.toThrow(/owner must belong/);
    await db.exec("reset role"); await authenticate(db, ids.viewerA);
    await expect(db.query(`select create_transaction_issue('${transactionId}', 3, 'Viewer issue', 'OTHER', 'LOW', false, null, null, '${ids.viewerA}')`)).rejects.toThrow(/only the assigned owner/);
    await db.exec("reset role"); await authenticate(db, ids.userA);
    expect((await db.query<{ version: number }>(`select resolve_transaction_issue('${issue.rows[0]!.id}', 3, 'Verified with title company', '${ids.userA}') as version`)).rows[0]?.version).toBe(4);
    await expect(db.query(`select resolve_transaction_issue('${issue.rows[0]!.id}', 4, 'Again', '${ids.userA}')`)).rejects.toThrow(/already resolved/);
    await expect(db.query(`select create_transaction_issue('${transactionId}', 3, 'Stale', 'OTHER', 'LOW', false, null, null, '${ids.userA}')`)).rejects.toThrow(/changed; refresh/);
  });

  it("enforces closing, cancellation, and admin-only reopening", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'SALE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '42 Closing Lane', '${type.rows[0]!.id}', '${ids.userA}', 'Seller', 'PERSON', 'SELLER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.exec("reset role");
    await db.exec(`update transaction_files set business_stage = 'READY_FOR_CLOSING' where id = '${transactionId}'`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select close_transaction_file('${transactionId}', 1, '${ids.userA}')`)).rejects.toThrow(/closing date/);
    await db.exec("reset role"); await db.exec(`update transaction_files set key_dates = '{"closingDate":"2030-06-01"}' where id = '${transactionId}'`); await authenticate(db, ids.userA);
    const issue = await db.query<{ id: string }>(`select create_transaction_issue('${transactionId}', 1, 'Resolve title exception', 'DOCUMENT', 'HIGH', true, null, null, '${ids.userA}') as id`);
    await expect(db.query(`select close_transaction_file('${transactionId}', 2, '${ids.userA}')`)).rejects.toThrow(/blocking issues/);
    await db.query(`select resolve_transaction_issue('${issue.rows[0]!.id}', 2, 'Cleared by title company', '${ids.userA}')`);
    expect((await db.query<{ stage: string }>(`select close_transaction_file('${transactionId}', 3, '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("CLOSED");
    await db.exec("reset role"); await authenticate(db, ids.viewerA);
    await expect(db.query(`select reopen_transaction_file('${transactionId}', 4, 'Need another review', '${ids.viewerA}')`)).rejects.toThrow(/only tenant administrators/);
    await db.exec("reset role"); await authenticate(db, ids.userA);
    expect((await db.query<{ stage: string }>(`select reopen_transaction_file('${transactionId}', 4, 'Need another review', '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("UNDER_REVIEW");
    await expect(db.query(`select cancel_transaction_file('${transactionId}', 5, '', '${ids.userA}')`)).rejects.toThrow(/reason is required/);
    expect((await db.query<{ stage: string }>(`select cancel_transaction_file('${transactionId}', 5, 'Deal terminated', '${ids.userA}')::text as stage`)).rows[0]?.stage).toBe("CANCELLED");
    await expect(db.query(`select cancel_transaction_file('${transactionId}', 5, 'Again', '${ids.userA}')`)).rejects.toThrow(/changed; refresh/);
  });

  it("requires audited unlink before moving an invoice between Transaction Files", async () => {
    const invoiceId = "00000000-0000-4000-8000-000000000097";
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const first = (await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '1 First Lane', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`)).rows[0]!.id;
    const second = (await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '2 Second Lane', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`)).rows[0]!.id;
    await db.exec("reset role"); await db.exec(`insert into invoice_candidates (id, tenant_id, issuer_id, origin, lifecycle, linkage_status, source_invoice_number, currency, total, schema_fingerprint) values ('${invoiceId}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'VERIFIED', 'UNLINKED', 'MOVE-1', 'USD', 100, 'schema')`); await authenticate(db, ids.userA);
    await db.query(`select * from link_invoice_to_transaction('${invoiceId}', 1, '${first}', 1, '${ids.userA}')`);
    await db.query(`select set_transaction_invoice_payment('${first}', 2, '${invoiceId}', 'PARTIALLY_PAID', 40, null, null, '${ids.userA}')`);
    await expect(db.query(`select * from link_invoice_to_transaction('${invoiceId}', 2, '${second}', 1, '${ids.userA}')`)).rejects.toThrow(/unlink.*before linking/);
    await expect(db.query(`select * from unlink_invoice_from_transaction('${invoiceId}', 2, 3, '', '${ids.userA}')`)).rejects.toThrow(/reason is required/);
    expect((await db.query(`select * from unlink_invoice_from_transaction('${invoiceId}', 2, 3, 'Wrong property', '${ids.userA}')`)).rows).toEqual([{ invoice_version: 3, transaction_version: 4 }]);
    expect((await db.query(`select transaction_file_id, linkage_status, lifecycle from invoice_candidates where id = '${invoiceId}'`)).rows).toEqual([{ transaction_file_id: null, linkage_status: "UNLINKED", lifecycle: "VERIFIED" }]);
    expect((await db.query(`select count(*)::int as count from transaction_invoice_payments where invoice_candidate_id = '${invoiceId}'`)).rows[0]).toEqual({ count: 0 });
    await db.query(`select * from link_invoice_to_transaction('${invoiceId}', 3, '${second}', 1, '${ids.userA}')`);
    expect((await db.query(`select count(*)::int as count from work_items where record_id = '${invoiceId}' and kind = 'REVIEW_TRANSACTION_CONTEXT'`)).rows[0]).toEqual({ count: 3 });
    expect((await db.query(`select count(*)::int as count from work_items where record_id = '${invoiceId}' and kind = 'REVIEW_TRANSACTION_CONTEXT' and status = 'OPEN'`)).rows[0]).toEqual({ count: 1 });
    expect((await db.query<{ reason: string }>(`select metadata->>'reason' as reason from audit_events where aggregate_id = '${invoiceId}' and event_type = 'INVOICE_UNLINKED_FROM_TRANSACTION'`)).rows[0]?.reason).toBe("Wrong property");
    expect((await db.query(`select * from resolve_invoice_transaction_context('${invoiceId}', 4, 2, 'Property and parties confirmed', '${ids.userA}')`)).rows).toEqual([{ invoice_version: 5, transaction_version: 3 }]);
    expect((await db.query(`select count(*)::int as count from work_items where record_id = '${invoiceId}' and kind = 'REVIEW_TRANSACTION_CONTEXT' and status = 'OPEN'`)).rows[0]).toEqual({ count: 0 });
    await expect(db.query(`select * from resolve_invoice_transaction_context('${invoiceId}', 5, 3, 'Again', '${ids.userA}')`)).rejects.toThrow(/not pending/);
  });

  it("rejects unsafe evidence when registering a transaction document", async () => {
    const unsafeEvidence = "00000000-0000-4000-8000-000000000093";
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '19 Safety Street', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    await db.exec("reset role");
    await db.exec(`insert into evidence_artifacts (id, tenant_id, storage_path, media_type, byte_size, sha256, safety_status) values
      ('${unsafeEvidence}', '${ids.tenantA}', '${ids.tenantA}/docs/pending.pdf', 'application/pdf', 100, '${"a".repeat(64)}', 'PENDING')`);
    await authenticate(db, ids.userA);
    await expect(db.query(`select * from register_transaction_document_version('${created.rows[0]!.id}', 1, null, 'Pending file', '${unsafeEvidence}', null, '${ids.userA}')`)).rejects.toThrow(/pass safety checks/);
  });

  it("routes a scanned deal document to its Transaction File instead of invoice extraction", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '44 Routing Road', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'purchase-agreement', '${ids.userA}')`);
    const receipt = await db.query<{ evidence_artifact_id: string; processing_job_id: string }>(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/documents/purchase.pdf', 'application/pdf', 100, '${"b".repeat(64)}', 'document-route', '${ids.userA}')`);
    await db.query(`select stage_transaction_document_upload('${transactionId}', 2, '${receipt.rows[0]!.evidence_artifact_id}', 'purchase-agreement', 'Purchase agreement', null, '${ids.userA}')`);
    expect((await db.query<{ count: number }>(`select count(*)::int as count from list_manual_intake_pipeline('${ids.tenantA}') where evidence_artifact_id = '${receipt.rows[0]!.evidence_artifact_id}'`)).rows[0]?.count).toBe(0);
    expect((await db.query(`select document_name, intent_status, safety_status, processing_status from list_transaction_document_uploads('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows).toEqual([{ document_name: "Purchase agreement", intent_status: "WAITING_FOR_SCAN", safety_status: "PENDING", processing_status: "QUEUED" }]);
    await db.exec("reset role; set role service_role");
    const claimed = await db.query<{ id: string; lock_token: string }>("select id, lock_token from claim_processing_jobs('scanner', array['SCAN_EVIDENCE'], 5)");
    await db.query(`select complete_evidence_scan('${claimed.rows[0]!.id}', '${claimed.rows[0]!.lock_token}', true, null)`);
    await db.exec("reset role");
    const intent = await db.query<{ status: string }>(`select status from transaction_document_upload_intents where evidence_artifact_id = '${receipt.rows[0]!.evidence_artifact_id}'`);
    expect(intent.rows[0]?.status).toBe("ATTACHED");
    expect((await db.query(`select intent_id from list_transaction_document_uploads('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows).toHaveLength(0);
    expect((await db.query(`select status from transaction_requirement_statuses where transaction_file_id = '${transactionId}' and requirement_key = 'purchase-agreement'`)).rows).toEqual([{ status: "PRESENT" }]);
    expect((await db.query(`select effective_status from list_transaction_documents('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows).toEqual([{ effective_status: "RECEIVED" }]);
    expect((await db.query<{ count: number }>(`select count(*)::int as count from processing_jobs where aggregate_id = '${receipt.rows[0]!.evidence_artifact_id}' and job_type = 'EXTRACT_EVIDENCE'`)).rows[0]?.count).toBe(0);
  });

  it("atomically cancels a queued Transaction File document upload", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '45 Cancel Road', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'ARTIFACT', 'closing-disclosure', '${ids.userA}')`);
    const receipt = await db.query<{ evidence_artifact_id: string; ingestion_event_id: string }>(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/documents/cancel.pdf', 'application/pdf', 100, '${"c".repeat(64)}', 'document-cancel', '${ids.userA}')`);
    await db.query(`select stage_transaction_document_upload('${transactionId}', 2, '${receipt.rows[0]!.evidence_artifact_id}', 'closing-disclosure', 'Closing disclosure', null, '${ids.userA}')`);

    expect((await db.query(`select intent_id from list_transaction_document_uploads('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows).toHaveLength(1);
    expect((await db.query(`select cancel_transaction_document_upload('${transactionId}', '${receipt.rows[0]!.ingestion_event_id}', '${ids.userA}') as status`)).rows).toEqual([{ status: "CANCELLED" }]);
    expect((await db.query(`select intent_id from list_transaction_document_uploads('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows).toHaveLength(0);
    expect((await db.query(`select status from transaction_document_upload_intents where evidence_artifact_id = '${receipt.rows[0]!.evidence_artifact_id}'`)).rows).toEqual([{ status: "CANCELLED" }]);
    const replacement = await db.query<{ evidence_artifact_id: string }>(`select * from register_manual_upload('${ids.tenantA}', '${ids.tenantA}/documents/cancel-replacement.pdf', 'application/pdf', 100, '${"d".repeat(64)}', 'document-cancel-replacement', '${ids.userA}')`);
    await db.query(`select stage_transaction_document_upload('${transactionId}', 4, '${replacement.rows[0]!.evidence_artifact_id}', 'closing-disclosure', 'Closing disclosure', null, '${ids.userA}')`);
    expect((await db.query(`select intent_id from list_transaction_document_uploads('${ids.tenantA}') where transaction_file_id = '${transactionId}'`)).rows).toHaveLength(1);
    expect((await db.query<{ version: number }>(`select version from transaction_files where id = '${transactionId}'`)).rows).toEqual([{ version: 5 }]);
  });

  it("stores required information values and resolves the owner's work item", async () => {
    await authenticate(db, ids.userA);
    const type = await db.query<{ id: string }>(`select id from transaction_types where tenant_id = '${ids.tenantA}' and code = 'PURCHASE'`);
    const created = await db.query<{ id: string }>(`select create_transaction_file_v2('${ids.tenantA}', '', '8 Information Way', '${type.rows[0]!.id}', '${ids.userA}', 'Buyer', 'PERSON', 'BUYER', '${ids.userA}') as id`);
    const transactionId = created.rows[0]!.id;
    await db.query(`select add_transaction_requirement('${transactionId}', 1, 'FIELD', 'property-first-owner', '${ids.userA}')`);
    const open = await db.query<{ assigned_to: string; status: string }>(`select assigned_to, status from work_items where record_id = '${transactionId}' and blocker_code = 'REQUIREMENT:FIELD:property-first-owner'`);
    expect(open.rows).toEqual([{ assigned_to: ids.userA, status: "OPEN" }]);
    const saved = await db.query<{ version: number }>(`select set_transaction_requirement_value('${transactionId}', 2, 'property-first-owner', 'Jordan Lee', '${ids.userA}') as version`);
    expect(saved.rows[0]!.version).toBe(3);
    expect((await db.query(`select status, resolved_value from transaction_requirement_statuses where transaction_file_id = '${transactionId}' and requirement_key = 'property-first-owner'`)).rows).toEqual([{ status: "PRESENT", resolved_value: "Jordan Lee" }]);
    expect((await db.query(`select status from work_items where record_id = '${transactionId}' and blocker_code = 'REQUIREMENT:FIELD:property-first-owner'`)).rows).toEqual([{ status: "RESOLVED" }]);
  });

  it("maps legacy Transaction File states without changing invoice links", async () => {
    await db.exec(`
      insert into transaction_files (id, tenant_id, property_address, lifecycle, business_stage)
        values ('${ids.transactionA}', '${ids.tenantA}', 'Legacy deal', 'ACCUMULATING', 'DOCUMENTS_PENDING');
      insert into invoice_candidates (id, tenant_id, issuer_id, transaction_file_id, origin, linkage_status, schema_fingerprint)
        values ('${ids.invoiceA}', '${ids.tenantA}', '${ids.issuerA}', '${ids.transactionA}', 'CAPTURED', 'LINKED', 'schema');
    `);
    const linked = await db.query<{ transaction_file_id: string; business_stage: string }>(`select invoice.transaction_file_id, file.business_stage from invoice_candidates invoice join transaction_files file on file.id = invoice.transaction_file_id where invoice.id = '${ids.invoiceA}'`);
    expect(linked.rows[0]).toEqual({ transaction_file_id: ids.transactionA, business_stage: "DOCUMENTS_PENDING" });
  });

  it("rejects malformed transaction dates and requirement names", async () => {
    await authenticate(db, ids.userA);
    await expect(db.query(`select create_transaction_file_with_details(
      '${ids.tenantA}', 'TX-BAD-DATE', '1847 Cypress Ave', '', '', '{"closingDate":"tomorrow"}'::jsonb,
      '{"artifacts":["purchase-agreement"],"fields":[]}'::jsonb, '${ids.userA}')`)).rejects.toThrow(/key dates/);
    const created = await db.query<{ transaction_id: string }>(`select create_transaction_file('${ids.tenantA}', 'TX-REQ', '72 Garden Row', '{"artifacts":["title-report"],"fields":[]}'::jsonb, '${ids.userA}') as transaction_id`);
    await expect(db.query(`select add_transaction_requirement('${created.rows[0]!.transaction_id}', 1, 'FIELD', '   ', '${ids.userA}')`)).rejects.toThrow(/name is invalid/);
  });

  it("suspends only linked incomplete invoices during dormancy and restores them on reactivation", async () => {
    const linkedInvoice = "00000000-0000-4000-8000-000000000081";
    const standaloneInvoice = "00000000-0000-4000-8000-000000000082";
    await authenticate(db, ids.userA);
    const created = await db.query<{ transaction_id: string }>(`select create_transaction_file('${ids.tenantA}', 'TX-DORMANT', '72 Garden Row', '{"artifacts":["purchase-agreement"],"fields":[]}'::jsonb, '${ids.userA}') as transaction_id`);
    const transactionId = created.rows[0]!.transaction_id;
    await db.exec("reset role");
    await db.exec(`
      insert into invoice_candidates (id, tenant_id, issuer_id, origin, schema_fingerprint) values
        ('${linkedInvoice}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'schema'),
        ('${standaloneInvoice}', '${ids.tenantA}', '${ids.issuerA}', 'CAPTURED', 'schema');
    `);
    await authenticate(db, ids.userA);
    await db.query(`select * from link_invoice_to_transaction('${linkedInvoice}', 1, '${transactionId}', 1, '${ids.userA}')`);
    await db.exec("reset role");
    await db.exec(`update transaction_files set last_material_activity_at = now() - interval '31 days' where id = '${transactionId}'; set role service_role;`);
    await db.query(`select mark_transaction_dormant('${transactionId}')`);
    await db.exec("reset role");
    let states = await db.query<{ id: string; lifecycle: string }>(`select id, lifecycle from invoice_candidates where id in ('${linkedInvoice}','${standaloneInvoice}') order by id`);
    expect(states.rows).toEqual([{ id: linkedInvoice, lifecycle: "SUSPENDED" }, { id: standaloneInvoice, lifecycle: "INCOMPLETE_DRAFT" }]);
    await authenticate(db, ids.userA);
    await db.query(`select reactivate_transaction_file('${transactionId}', 3, '${ids.userA}')`);
    await db.exec("reset role");
    states = await db.query<{ id: string; lifecycle: string }>(`select id, lifecycle from invoice_candidates where id in ('${linkedInvoice}','${standaloneInvoice}') order by id`);
    expect(states.rows).toEqual([{ id: linkedInvoice, lifecycle: "INCOMPLETE_DRAFT" }, { id: standaloneInvoice, lifecycle: "INCOMPLETE_DRAFT" }]);
  });
});
