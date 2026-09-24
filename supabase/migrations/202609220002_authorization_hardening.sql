create or replace function app_private.has_tenant_role(
  target_tenant uuid,
  allowed_roles public.workspace_role[]
)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.tenant_memberships
    where tenant_id = target_tenant
      and user_id = auth.uid()
      and active
      and role = any(allowed_roles)
  );
$$;

-- Browser clients read through RLS and mutate aggregates only through reviewed RPCs.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.tenants, public.tenant_memberships, public.issuers,
  public.invoice_schema_versions, public.approval_policy_versions,
  public.evidence_artifacts, public.ingestion_events, public.transaction_files,
  public.invoice_candidates, public.extracted_observations,
  public.invoice_field_values, public.evidence_links, public.work_items,
  public.audit_events to authenticated;

create or replace function public.finalize_generated_invoice(target_invoice uuid, expected_version integer, actor uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; sequence_row public.official_number_sequences%rowtype; allocated text;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  if not app_private.has_tenant_role(candidate.tenant_id, array['TENANT_ADMIN','REVIEWER']::public.workspace_role[]) then raise exception 'role cannot verify invoices'; end if;
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.origin <> 'GENERATED' or candidate.lifecycle <> 'PENDING_REVIEW' then raise exception 'invoice is not eligible for generated finalization'; end if;
  select * into sequence_row from public.official_number_sequences where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id for update;
  if not found then raise exception 'official number sequence is not configured'; end if;
  allocated := sequence_row.prefix || lpad(sequence_row.next_value::text, 6, '0');
  update public.official_number_sequences set next_value = next_value + 1 where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id;
  update public.invoice_candidates set lifecycle = 'VERIFIED', official_invoice_number = allocated, compilation_status = 'PENDING', version = version + 1, updated_at = now() where id = target_invoice;
  insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key) values (candidate.tenant_id, 'COMPILE_GENERATED_INVOICE_PDF', target_invoice, 'generated-invoice:' || target_invoice || ':pdf:v1');
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata) values (candidate.tenant_id, 'INVOICE', target_invoice, candidate.version + 1, 'INVOICE_VERIFIED', actor, jsonb_build_object('official_invoice_number', allocated));
  return allocated;
end $$;

revoke all on function public.finalize_generated_invoice(uuid, integer, uuid) from public, anon;
grant execute on function public.finalize_generated_invoice(uuid, integer, uuid) to authenticated;

-- Generated numbers survive VOIDED corrections; only unverified Generated Invoices lack one.
do $$ declare constraint_name text; begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.invoice_candidates'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%lifecycle%VERIFIED%official_invoice_number%';
  if constraint_name is not null then
    execute format('alter table public.invoice_candidates drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.invoice_candidates
  add constraint generated_official_number_lifecycle check (
    origin = 'CAPTURED'
    or (lifecycle in ('VERIFIED','VOIDED') and official_invoice_number is not null)
    or (lifecycle not in ('VERIFIED','VOIDED') and official_invoice_number is null)
  );

create index if not exists invoice_candidates_queue_idx
  on public.invoice_candidates (tenant_id, lifecycle, updated_at desc);
create index if not exists transaction_files_queue_idx
  on public.transaction_files (tenant_id, lifecycle, updated_at desc);
create index if not exists work_items_queue_idx
  on public.work_items (tenant_id, status, assigned_to, created_at);
create index if not exists processing_jobs_claim_idx
  on public.processing_jobs (status, available_at, created_at);
create index if not exists evidence_links_invoice_idx
  on public.evidence_links (tenant_id, invoice_candidate_id) where invoice_candidate_id is not null;

-- Supabase-only Storage policies; skipped by compatible test runtimes without Storage.
do $$ begin
  if to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public) values ('evidence', 'evidence', false)
      on conflict (id) do update set public = false;
    execute $policy$
      create policy evidence_read on storage.objects for select to authenticated
      using (bucket_id = 'evidence' and app_private.is_tenant_member(((storage.foldername(name))[1])::uuid))
    $policy$;
    execute $policy$
      create policy evidence_upload on storage.objects for insert to authenticated
      with check (bucket_id = 'evidence' and app_private.has_tenant_role(((storage.foldername(name))[1])::uuid, array['TENANT_ADMIN','REVIEWER','INTEGRATION']::public.workspace_role[]))
    $policy$;
  end if;
end $$;
