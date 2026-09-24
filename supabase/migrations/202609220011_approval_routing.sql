alter table public.invoice_candidates
  add column approval_policy_version_id uuid references public.approval_policy_versions(id),
  add column approval_decision text check (approval_decision in ('HUMAN_REVIEW','AUTOMATIC_VERIFICATION')),
  add column approval_reason text;

alter table public.verified_invoice_records
  alter column verified_by drop not null,
  add column verification_method text not null default 'HUMAN' check (verification_method in ('HUMAN','AUTOMATIC')),
  add check ((verification_method = 'HUMAN' and verified_by is not null) or (verification_method = 'AUTOMATIC' and verified_by is null));

create table public.automatic_verification_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  origin public.invoice_origin not null,
  document_class text not null,
  provider text not null,
  model_version text not null,
  prompt_version text not null,
  schema_fingerprint text not null,
  evaluation_version text not null,
  evaluation_metrics jsonb not null check (jsonb_typeof(evaluation_metrics) = 'object'),
  approved_at timestamptz not null,
  revoked_at timestamptz,
  unique (tenant_id, origin, document_class, provider, model_version, prompt_version, schema_fingerprint),
  check (revoked_at is null or revoked_at >= approved_at)
);

alter table public.automatic_verification_profiles enable row level security;
create policy tenant_isolation on public.automatic_verification_profiles using (app_private.is_tenant_member(tenant_id));
grant select on public.automatic_verification_profiles to authenticated;

create or replace function app_private.approval_condition_matches(target_invoice uuid, condition jsonb)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; child jsonb; operator text; result boolean; field_value jsonb;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice;
  if not found or jsonb_typeof(condition) <> 'object' then return true; end if;
  if condition ? 'conditions' then
    if jsonb_typeof(condition->'conditions') <> 'array' or jsonb_array_length(condition->'conditions') = 0 then return true; end if;
    operator := upper(coalesce(condition->>'operator', ''));
    if operator not in ('AND','OR') then return true; end if;
    result := operator = 'AND';
    for child in select value from jsonb_array_elements(condition->'conditions') loop
      if operator = 'AND' then result := result and app_private.approval_condition_matches(target_invoice, child);
      else result := result or app_private.approval_condition_matches(target_invoice, child); end if;
    end loop;
    return result;
  end if;
  case condition->>'type'
    when 'TOTAL_ABOVE' then return candidate.total > (condition->>'value')::numeric;
    when 'NEW_ISSUER' then return exists (select 1 from public.issuers where id = candidate.issuer_id and created_at >= candidate.created_at - interval '1 second');
    when 'ISSUER' then return candidate.issuer_id = (condition->>'value')::uuid;
    when 'ORIGIN' then return candidate.origin::text = upper(condition->>'value');
    when 'LOW_CONFIDENCE' then return exists (
      select 1 from public.invoice_field_values where tenant_id = candidate.tenant_id
        and invoice_candidate_id = candidate.id and confidence < (condition->>'value')::numeric
    );
    when 'FIELD_EQUALS' then
      select resolved_value into field_value from public.invoice_field_values
        where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id and field_name = condition->>'field';
      return field_value = condition->'value';
    when 'VARIANCE_ABOVE' then
      select resolved_value into field_value from public.invoice_field_values
        where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id and field_name = condition->>'field';
      return abs(coalesce((field_value #>> '{}')::numeric, 0)) > (condition->>'value')::numeric;
    else return true;
  end case;
exception when invalid_text_representation or numeric_value_out_of_range then
  return true;
end $$;

create or replace function public.route_invoice_approval(target_job uuid, target_lock_token uuid)
returns public.invoice_lifecycle
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  job public.processing_jobs%rowtype;
  candidate public.invoice_candidates%rowtype;
  policy public.approval_policy_versions%rowtype;
  requires_review boolean := true;
  reason text := 'MANDATORY_POLICY';
  probable_duplicate boolean;
  eligible boolean := false;
  values_snapshot jsonb;
  allocated text;
  sequence_row public.official_number_sequences%rowtype;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found or job.job_type <> 'ROUTE_INVOICE_APPROVAL' then raise exception 'approval routing job not found'; end if;
  if job.lock_token is distinct from target_lock_token then raise exception 'stale worker lease'; end if;
  if job.status = 'CANCEL_REQUESTED' then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    return null;
  end if;
  if job.status <> 'RUNNING' then raise exception 'approval routing job is not running'; end if;
  select * into candidate from public.invoice_candidates where tenant_id = job.tenant_id and id = job.aggregate_id for update;
  if not found or candidate.lifecycle <> 'READY_FOR_VERIFICATION' then raise exception 'invoice is not ready for approval routing'; end if;

  select * into policy from public.approval_policy_versions policy_version
    where policy_version.tenant_id = candidate.tenant_id and policy_version.published_at is not null
    order by policy_version.version desc limit 1;
  if not found then raise exception 'published approval policy is required'; end if;

  select exists (
    select 1 from public.invoice_candidates existing
    where existing.tenant_id = candidate.tenant_id and existing.id <> candidate.id
      and existing.issuer_id = candidate.issuer_id and existing.source_invoice_number is not distinct from candidate.source_invoice_number
      and candidate.source_invoice_number is not null and existing.lifecycle <> 'DISMISSED'
  ) into probable_duplicate;
  if probable_duplicate then
    requires_review := true; reason := 'PROBABLE_DUPLICATE';
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
      values (candidate.tenant_id, 'INVOICE', candidate.id, 'RESOLVE_PROBABLE_DUPLICATE', 'PROBABLE_DUPLICATE');
  elsif policy.mode = 'MANDATORY' then
    requires_review := true; reason := 'MANDATORY_POLICY';
  elsif policy.mode = 'CONDITIONAL' and app_private.approval_condition_matches(candidate.id, policy.rules->'reviewWhen') then
    requires_review := true; reason := 'CONDITIONAL_MATCH';
  else
    requires_review := false; reason := case when policy.mode = 'AUTOMATIC' then 'AUTOMATIC_POLICY' else 'NO_CONDITIONAL_MATCH' end;
  end if;

  if not requires_review then
    select exists (
      select 1 from public.evidence_links link
      join public.extraction_runs run on run.tenant_id = link.tenant_id and run.evidence_artifact_id = link.evidence_artifact_id
      join public.automatic_verification_profiles profile on profile.tenant_id = candidate.tenant_id
        and profile.origin = candidate.origin and profile.document_class = 'INVOICE'
        and profile.provider = run.provider and profile.model_version = run.model_version
        and profile.prompt_version = run.prompt_version and profile.schema_fingerprint = candidate.schema_fingerprint
        and profile.revoked_at is null
      where link.tenant_id = candidate.tenant_id and link.invoice_candidate_id = candidate.id
    ) into eligible;
    if not eligible then requires_review := true; reason := 'AUTOMATION_PROFILE_NOT_APPROVED'; end if;
  end if;

  if requires_review then
    update public.invoice_candidates set lifecycle = 'PENDING_REVIEW', approval_policy_version_id = policy.id,
      approval_decision = 'HUMAN_REVIEW', approval_reason = reason, version = version + 1, updated_at = now()
      where id = candidate.id;
    update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
      values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_ROUTED_TO_REVIEW',
        jsonb_build_object('approval_policy_version_id', policy.id, 'reason', reason));
    return 'PENDING_REVIEW';
  end if;

  if candidate.total is null or (candidate.origin = 'CAPTURED' and nullif(trim(candidate.source_invoice_number), '') is null) then
    raise exception 'invoice is incomplete for automatic verification';
  end if;
  select coalesce(jsonb_object_agg(field_name, resolved_value), '{}'::jsonb) into values_snapshot
    from public.invoice_field_values where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id;
  if candidate.origin = 'GENERATED' then
    select * into sequence_row from public.official_number_sequences where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id for update;
    if not found then raise exception 'official number sequence is not configured'; end if;
    allocated := sequence_row.prefix || lpad(sequence_row.next_value::text, 6, '0');
    update public.official_number_sequences set next_value = next_value + 1 where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id;
  end if;
  update public.invoice_candidates set lifecycle = 'VERIFIED', official_invoice_number = allocated,
    compilation_status = case when origin = 'GENERATED' then 'PENDING' else compilation_status end,
    approval_policy_version_id = policy.id, approval_decision = 'AUTOMATIC_VERIFICATION', approval_reason = reason,
    version = version + 1, updated_at = now() where id = candidate.id;
  insert into public.verified_invoice_records (tenant_id, invoice_candidate_id, origin, issuer_id, source_invoice_number,
    official_invoice_number, currency, total, field_values, schema_fingerprint, candidate_version, verified_by, verification_method)
    values (candidate.tenant_id, candidate.id, candidate.origin, candidate.issuer_id, candidate.source_invoice_number,
      allocated, candidate.currency, candidate.total, values_snapshot, candidate.schema_fingerprint, candidate.version + 1, null, 'AUTOMATIC');
  if candidate.origin = 'GENERATED' then
    insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key)
      values (candidate.tenant_id, 'COMPILE_GENERATED_INVOICE_PDF', candidate.id, 'generated-invoice:' || candidate.id || ':pdf:v1');
  end if;
  update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_AUTOMATICALLY_VERIFIED',
      jsonb_build_object('approval_policy_version_id', policy.id, 'reason', reason));
  return 'VERIFIED';
end $$;

revoke all on function public.route_invoice_approval(uuid, uuid) from public, anon, authenticated;
grant execute on function public.route_invoice_approval(uuid, uuid) to service_role;
