create table public.verified_invoice_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  invoice_candidate_id uuid not null,
  origin public.invoice_origin not null,
  issuer_id uuid not null,
  source_invoice_number text,
  official_invoice_number text,
  currency char(3) not null,
  total numeric(19,4) not null check (total >= 0),
  field_values jsonb not null check (jsonb_typeof(field_values) = 'object'),
  schema_fingerprint text not null,
  candidate_version integer not null check (candidate_version > 0),
  verified_by uuid not null,
  verified_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, invoice_candidate_id),
  foreign key (tenant_id, invoice_candidate_id) references public.invoice_candidates(tenant_id, id),
  foreign key (tenant_id, issuer_id) references public.issuers(tenant_id, id),
  check ((origin = 'CAPTURED') = (official_invoice_number is null)),
  check (origin = 'GENERATED' or source_invoice_number is not null)
);

alter table public.verified_invoice_records enable row level security;
create policy tenant_isolation on public.verified_invoice_records
  using (app_private.is_tenant_member(tenant_id));
create trigger verified_invoice_records_immutable
  before update or delete on public.verified_invoice_records
  for each row execute function app_private.reject_audit_mutation();
grant select on public.verified_invoice_records to authenticated;

create or replace function app_private.assert_reviewer(target_tenant uuid, actor uuid)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if not app_private.has_tenant_role(target_tenant, array['TENANT_ADMIN','REVIEWER']::public.workspace_role[]) then
    raise exception 'role cannot review invoices';
  end if;
end $$;

create or replace function public.record_invoice_field_value(
  target_invoice uuid,
  expected_version integer,
  target_field text,
  target_value jsonb,
  actor uuid
)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; next_version integer;
begin
  if length(trim(target_field)) = 0 or target_value is null or target_value = 'null'::jsonb then
    raise exception 'field name and non-null value are required';
  end if;
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.lifecycle in ('VERIFIED','VOIDED','DISMISSED') then raise exception 'terminal invoice cannot be edited'; end if;
  next_version := candidate.version + 1;
  insert into public.invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, version)
    values (candidate.tenant_id, candidate.id, target_field, target_value, 'REVIEWER_ENTERED', 1)
    on conflict (tenant_id, invoice_candidate_id, field_name) do update
      set resolved_value = excluded.resolved_value, resolution_method = 'REVIEWER_ENTERED', confidence = null,
          version = public.invoice_field_values.version + 1;
  update public.invoice_candidates set version = next_version, updated_at = now() where id = candidate.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, next_version, 'FIELD_VALUE_RECORDED', actor, jsonb_build_object('field_name', target_field));
  return next_version;
end $$;

create or replace function public.verify_captured_invoice(target_invoice uuid, expected_version integer, actor uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; record_id uuid; values_snapshot jsonb;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.origin <> 'CAPTURED' or candidate.lifecycle <> 'PENDING_REVIEW' then raise exception 'invoice is not eligible for captured verification'; end if;
  if candidate.source_invoice_number is null or length(trim(candidate.source_invoice_number)) = 0 or candidate.total is null then
    raise exception 'captured invoice is incomplete';
  end if;
  select coalesce(jsonb_object_agg(field_name, resolved_value), '{}'::jsonb) into values_snapshot
    from public.invoice_field_values where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id;
  update public.invoice_candidates set lifecycle = 'VERIFIED', version = version + 1, updated_at = now() where id = candidate.id;
  insert into public.verified_invoice_records (tenant_id, invoice_candidate_id, origin, issuer_id, source_invoice_number, currency, total, field_values, schema_fingerprint, candidate_version, verified_by)
    values (candidate.tenant_id, candidate.id, candidate.origin, candidate.issuer_id, candidate.source_invoice_number, candidate.currency, candidate.total, values_snapshot, candidate.schema_fingerprint, candidate.version + 1, actor)
    returning id into record_id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_VERIFIED', actor);
  return record_id;
end $$;

create or replace function public.finalize_generated_invoice(target_invoice uuid, expected_version integer, actor uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; sequence_row public.official_number_sequences%rowtype; allocated text; values_snapshot jsonb;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.origin <> 'GENERATED' or candidate.lifecycle <> 'PENDING_REVIEW' or candidate.total is null then raise exception 'invoice is not eligible for generated finalization'; end if;
  select * into sequence_row from public.official_number_sequences where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id for update;
  if not found then raise exception 'official number sequence is not configured'; end if;
  allocated := sequence_row.prefix || lpad(sequence_row.next_value::text, 6, '0');
  select coalesce(jsonb_object_agg(field_name, resolved_value), '{}'::jsonb) into values_snapshot
    from public.invoice_field_values where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id;
  update public.official_number_sequences set next_value = next_value + 1 where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id;
  update public.invoice_candidates set lifecycle = 'VERIFIED', official_invoice_number = allocated, compilation_status = 'PENDING', version = version + 1, updated_at = now() where id = target_invoice;
  insert into public.verified_invoice_records (tenant_id, invoice_candidate_id, origin, issuer_id, official_invoice_number, currency, total, field_values, schema_fingerprint, candidate_version, verified_by)
    values (candidate.tenant_id, candidate.id, candidate.origin, candidate.issuer_id, allocated, candidate.currency, candidate.total, values_snapshot, candidate.schema_fingerprint, candidate.version + 1, actor);
  insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key) values (candidate.tenant_id, 'COMPILE_GENERATED_INVOICE_PDF', target_invoice, 'generated-invoice:' || target_invoice || ':pdf:v1');
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata) values (candidate.tenant_id, 'INVOICE', target_invoice, candidate.version + 1, 'INVOICE_VERIFIED', actor, jsonb_build_object('official_invoice_number', allocated));
  return allocated;
end $$;

revoke all on function public.record_invoice_field_value(uuid, integer, text, jsonb, uuid) from public, anon;
revoke all on function public.verify_captured_invoice(uuid, integer, uuid) from public, anon;
revoke all on function public.finalize_generated_invoice(uuid, integer, uuid) from public, anon;
grant execute on function public.record_invoice_field_value(uuid, integer, text, jsonb, uuid) to authenticated;
grant execute on function public.verify_captured_invoice(uuid, integer, uuid) to authenticated;
grant execute on function public.finalize_generated_invoice(uuid, integer, uuid) to authenticated;
