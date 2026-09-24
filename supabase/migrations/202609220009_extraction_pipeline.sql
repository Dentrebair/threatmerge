create table public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  evidence_artifact_id uuid not null,
  provider text not null,
  model_version text not null,
  prompt_version text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, evidence_artifact_id) references public.evidence_artifacts(tenant_id, id)
);

alter table public.extracted_observations
  add column extraction_run_id uuid,
  add foreign key (tenant_id, extraction_run_id) references public.extraction_runs(tenant_id, id);

alter table public.extraction_runs enable row level security;
create policy tenant_isolation on public.extraction_runs using (app_private.is_tenant_member(tenant_id));
grant select on public.extraction_runs to authenticated;

create or replace function public.complete_evidence_extraction(
  target_job uuid,
  target_lock_token uuid,
  target_provider text,
  target_model_version text,
  target_prompt_version text,
  target_started_at timestamptz,
  target_observations jsonb
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare job public.processing_jobs%rowtype; artifact public.evidence_artifacts%rowtype; run_id uuid; observation jsonb;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found or job.job_type <> 'EXTRACT_EVIDENCE' then raise exception 'extraction job not found'; end if;
  if job.lock_token is distinct from target_lock_token then raise exception 'stale worker lease'; end if;
  if job.status = 'CANCEL_REQUESTED' then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    return null;
  end if;
  if job.status <> 'RUNNING' then raise exception 'extraction job is not running'; end if;
  select * into artifact from public.evidence_artifacts where tenant_id = job.tenant_id and id = job.aggregate_id;
  if not found or artifact.safety_status <> 'SAFE' then raise exception 'only safe evidence may be extracted'; end if;
  if jsonb_typeof(target_observations) <> 'array' or jsonb_array_length(target_observations) > 200 then raise exception 'observations must be an array with at most 200 entries'; end if;
  if length(trim(target_provider)) = 0 or length(trim(target_model_version)) = 0 or length(trim(target_prompt_version)) = 0 then raise exception 'extraction metadata is required'; end if;

  insert into public.extraction_runs (tenant_id, evidence_artifact_id, provider, model_version, prompt_version, started_at)
    values (job.tenant_id, artifact.id, target_provider, target_model_version, target_prompt_version, target_started_at)
    returning id into run_id;
  for observation in select value from jsonb_array_elements(target_observations) loop
    if jsonb_typeof(observation) <> 'object'
      or length(trim(coalesce(observation->>'fieldName',''))) = 0
      or jsonb_typeof(observation->'sourceLocation') <> 'object'
      or (observation->>'confidence')::numeric not between 0 and 1
    then raise exception 'invalid extracted observation'; end if;
    insert into public.extracted_observations (
      tenant_id, evidence_artifact_id, extraction_run_id, field_name, claimed_value,
      source_location, confidence, provider, model_version, schema_version
    ) values (
      job.tenant_id, artifact.id, run_id, observation->>'fieldName', observation->'value',
      observation->'sourceLocation', (observation->>'confidence')::numeric,
      target_provider, target_model_version, target_prompt_version
    );
  end loop;
  update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
  insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
    values (job.tenant_id, 'ASSEMBLE_INVOICE', artifact.id, 'assemble-invoice:' || artifact.id,
      jsonb_build_object('evidence_artifact_id', artifact.id, 'extraction_run_id', run_id))
    on conflict (tenant_id, idempotency_key) do nothing;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (job.tenant_id, 'EVIDENCE', artifact.id, job.attempts + 2, 'EXTRACTION_COMPLETED',
      jsonb_build_object('extraction_run_id', run_id, 'observation_count', jsonb_array_length(target_observations)));
  return run_id;
end $$;

revoke all on function public.complete_evidence_extraction(uuid, uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.complete_evidence_extraction(uuid, uuid, text, text, text, timestamptz, jsonb) to service_role;

create or replace function public.list_manual_intake_pipeline(target_tenant uuid)
returns table (
  ingestion_event_id uuid, evidence_artifact_id uuid, file_name text, media_type text,
  byte_size bigint, safety_status public.safety_status, quarantine_reason text,
  processing_stage text, processing_status public.processing_status, received_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select event.id, artifact.id, regexp_replace(artifact.storage_path, '^.*/', ''), artifact.media_type,
      artifact.byte_size, artifact.safety_status, artifact.quarantine_reason, latest.job_type, latest.status, event.received_at
    from public.ingestion_events event
    join public.evidence_artifacts artifact on artifact.tenant_id = event.tenant_id and artifact.id = event.evidence_artifact_id
    left join lateral (
      select job.job_type, job.status from public.processing_jobs job
      where job.tenant_id = event.tenant_id and job.aggregate_id = event.evidence_artifact_id
      order by job.created_at desc, job.id desc limit 1
    ) latest on true
    where event.tenant_id = target_tenant and event.channel = 'MANUAL_UPLOAD'
      and coalesce(latest.status::text, '') not in ('CANCELLED','CANCEL_REQUESTED')
      and not exists (select 1 from public.evidence_links link where link.tenant_id = event.tenant_id and link.evidence_artifact_id = event.evidence_artifact_id and link.invoice_candidate_id is not null)
    order by event.received_at desc;
end $$;

revoke all on function public.list_manual_intake_pipeline(uuid) from public, anon;
grant execute on function public.list_manual_intake_pipeline(uuid) to authenticated;
