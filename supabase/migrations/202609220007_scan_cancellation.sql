alter type public.processing_status add value if not exists 'CANCEL_REQUESTED';
alter type public.processing_status add value if not exists 'CANCELLED';

create or replace function public.cancel_manual_intake_scan(
  target_tenant uuid,
  target_ingestion_event uuid,
  actor uuid
)
returns public.processing_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare event_row public.ingestion_events%rowtype; job_row public.processing_jobs%rowtype; next_status public.processing_status;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  select * into event_row from public.ingestion_events
    where tenant_id = target_tenant and id = target_ingestion_event and channel = 'MANUAL_UPLOAD';
  if not found then raise exception 'intake receipt not found'; end if;
  select * into job_row from public.processing_jobs
    where tenant_id = target_tenant and idempotency_key = 'manual-upload:' || event_row.id for update;
  if not found then raise exception 'scan job not found'; end if;
  if job_row.status in ('QUEUED','RETRY_SCHEDULED') then next_status := 'CANCELLED';
  elsif job_row.status = 'RUNNING' then next_status := 'CANCEL_REQUESTED';
  elsif job_row.status in ('CANCELLED','CANCEL_REQUESTED') then return job_row.status;
  else raise exception 'scan can no longer be cancelled';
  end if;
  update public.processing_jobs set status = next_status where id = job_row.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'EVIDENCE', event_row.evidence_artifact_id, job_row.attempts + 2, 'SCAN_CANCELLATION_' || next_status::text, actor,
      jsonb_build_object('ingestion_event_id', event_row.id, 'processing_job_id', job_row.id));
  return next_status;
end $$;

revoke all on function public.cancel_manual_intake_scan(uuid, uuid, uuid) from public, anon;
grant execute on function public.cancel_manual_intake_scan(uuid, uuid, uuid) to authenticated;

create or replace function public.list_manual_intake_receipts(target_tenant uuid)
returns table (
  ingestion_event_id uuid, evidence_artifact_id uuid, file_name text, media_type text,
  byte_size bigint, safety_status public.safety_status, quarantine_reason text,
  processing_status public.processing_status, received_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select event.id, artifact.id, regexp_replace(artifact.storage_path, '^.*/', ''),
      artifact.media_type, artifact.byte_size, artifact.safety_status,
      artifact.quarantine_reason, job.status, event.received_at
    from public.ingestion_events event
    join public.evidence_artifacts artifact on artifact.tenant_id = event.tenant_id and artifact.id = event.evidence_artifact_id
    left join public.processing_jobs job on job.tenant_id = event.tenant_id and job.idempotency_key = 'manual-upload:' || event.id
    where event.tenant_id = target_tenant and event.channel = 'MANUAL_UPLOAD'
      and job.status not in ('CANCELLED','CANCEL_REQUESTED')
      and not exists (select 1 from public.evidence_links link where link.tenant_id = event.tenant_id and link.evidence_artifact_id = event.evidence_artifact_id and link.invoice_candidate_id is not null)
    order by event.received_at desc;
end $$;
