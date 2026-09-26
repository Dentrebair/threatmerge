create or replace function app_private.queue_assembly_for_extraction_run()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
  values (new.tenant_id, 'ASSEMBLE_INVOICE', new.evidence_artifact_id,
    'assemble-invoice:' || new.evidence_artifact_id,
    jsonb_build_object('evidence_artifact_id', new.evidence_artifact_id, 'extraction_run_id', new.id))
  on conflict (tenant_id, idempotency_key) do update
    set status = 'QUEUED', attempts = 0, available_at = now(), completed_at = null,
      lock_token = null, locked_at = null, last_error_code = null, payload = excluded.payload;
  return new;
end $$;

drop trigger if exists queue_assembly_for_extraction_run on public.extraction_runs;
create trigger queue_assembly_for_extraction_run
  after insert on public.extraction_runs
  for each row execute function app_private.queue_assembly_for_extraction_run();

create or replace function public.request_invoice_reprocessing(
  target_invoice uuid,
  expected_version integer,
  actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  candidate public.invoice_candidates%rowtype;
  artifact_id uuid;
  extraction_job public.processing_jobs%rowtype;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.origin <> 'CAPTURED' or candidate.lifecycle <> 'INCOMPLETE_DRAFT' then
    raise exception 'only incomplete captured invoices can be processed again';
  end if;

  select link.evidence_artifact_id into artifact_id
  from public.evidence_links link
  join public.evidence_artifacts artifact
    on artifact.tenant_id = link.tenant_id and artifact.id = link.evidence_artifact_id
  where link.tenant_id = candidate.tenant_id and link.invoice_candidate_id = candidate.id
    and link.relationship = 'SOURCE_DOCUMENT' and artifact.safety_status = 'SAFE'
  order by link.created_at desc limit 1;
  if artifact_id is null then raise exception 'the source document is unavailable; upload it again'; end if;

  select * into extraction_job from public.processing_jobs
  where tenant_id = candidate.tenant_id and aggregate_id = artifact_id and job_type = 'EXTRACT_EVIDENCE'
  order by created_at desc limit 1 for update;
  if not found then raise exception 'the source document cannot be processed again; upload it again'; end if;
  if extraction_job.status in ('RUNNING','CANCEL_REQUESTED') then raise exception 'the source document is already being processed'; end if;

  update public.invoice_candidates
    set lifecycle = 'DISMISSED', version = version + 1, updated_at = now()
    where id = candidate.id;
  update public.work_items set status = 'DISMISSED'
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE'
      and record_id = candidate.id and status in ('OPEN','WAITING_FOR_EVIDENCE');
  update public.processing_jobs
    set status = 'QUEUED', available_at = now(), completed_at = null,
      lock_token = null, locked_at = null, last_error_code = null
    where id = extraction_job.id;
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1,
    'INVOICE_REPROCESSING_REQUESTED', actor, jsonb_build_object('evidence_artifact_id', artifact_id));
  return artifact_id;
end $$;

revoke all on function public.request_invoice_reprocessing(uuid, integer, uuid) from public, anon;
grant execute on function public.request_invoice_reprocessing(uuid, integer, uuid) to authenticated;

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
      and not exists (
        select 1 from public.evidence_links link
        join public.invoice_candidates invoice
          on invoice.tenant_id = link.tenant_id and invoice.id = link.invoice_candidate_id
        where link.tenant_id = event.tenant_id and link.evidence_artifact_id = event.evidence_artifact_id
          and invoice.lifecycle <> 'DISMISSED'
      )
    order by event.received_at desc;
end $$;
