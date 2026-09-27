alter table public.ingestion_events
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid;

create or replace function public.dismiss_manual_intake_receipt(
  target_tenant uuid,
  target_ingestion_event uuid,
  actor uuid
)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare event_row public.ingestion_events%rowtype;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  select * into event_row from public.ingestion_events
    where tenant_id = target_tenant and id = target_ingestion_event and channel = 'MANUAL_UPLOAD'
    for update;
  if not found then raise exception 'intake receipt not found'; end if;
  if exists (
    select 1 from public.evidence_links link
    join public.invoice_candidates invoice on invoice.tenant_id = link.tenant_id and invoice.id = link.invoice_candidate_id
    where link.tenant_id = target_tenant and link.evidence_artifact_id = event_row.evidence_artifact_id
      and invoice.lifecycle <> 'DISMISSED'
  ) then raise exception 'upload has an active invoice; dismiss the invoice instead'; end if;

  update public.processing_jobs
    set status = case when status = 'RUNNING' then 'CANCEL_REQUESTED'::public.processing_status else 'CANCELLED'::public.processing_status end,
      completed_at = case when status = 'RUNNING' then completed_at else now() end
    where tenant_id = target_tenant and aggregate_id = event_row.evidence_artifact_id
      and status in ('QUEUED','RETRY_SCHEDULED','RUNNING');
  update public.ingestion_events set dismissed_at = now(), dismissed_by = actor where id = event_row.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'EVIDENCE', event_row.evidence_artifact_id,
      coalesce((select max(aggregate_version) + 1 from public.audit_events where tenant_id = target_tenant and aggregate_type = 'EVIDENCE' and aggregate_id = event_row.evidence_artifact_id), 1),
      'MANUAL_INTAKE_RECEIPT_DISMISSED', actor, jsonb_build_object('ingestion_event_id', event_row.id));
end $$;

revoke all on function public.dismiss_manual_intake_receipt(uuid, uuid, uuid) from public, anon;
grant execute on function public.dismiss_manual_intake_receipt(uuid, uuid, uuid) to authenticated;

drop function public.list_manual_intake_pipeline(uuid);
create function public.list_manual_intake_pipeline(target_tenant uuid)
returns table (
  ingestion_event_id uuid, evidence_artifact_id uuid, file_name text, media_type text,
  byte_size bigint, safety_status public.safety_status, quarantine_reason text,
  processing_stage text, processing_status public.processing_status, failure_reason text,
  received_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select event.id, artifact.id, regexp_replace(artifact.storage_path, '^.*/', ''), artifact.media_type,
      artifact.byte_size, artifact.safety_status, artifact.quarantine_reason,
      latest.job_type, latest.status, latest.last_error_code, event.received_at
    from public.ingestion_events event
    join public.evidence_artifacts artifact on artifact.tenant_id = event.tenant_id and artifact.id = event.evidence_artifact_id
    left join lateral (
      select job.job_type, job.status, job.last_error_code from public.processing_jobs job
      where job.tenant_id = event.tenant_id and job.aggregate_id = event.evidence_artifact_id
      order by job.created_at desc, job.id desc limit 1
    ) latest on true
    where event.tenant_id = target_tenant and event.channel = 'MANUAL_UPLOAD' and event.dismissed_at is null
      and coalesce(latest.status::text, '') not in ('CANCELLED','CANCEL_REQUESTED')
      and not exists (select 1 from public.transaction_document_upload_intents intent where intent.tenant_id = event.tenant_id and intent.evidence_artifact_id = event.evidence_artifact_id)
      and not exists (
        select 1 from public.evidence_links link join public.invoice_candidates invoice on invoice.tenant_id = link.tenant_id and invoice.id = link.invoice_candidate_id
        where link.tenant_id = event.tenant_id and link.evidence_artifact_id = event.evidence_artifact_id and invoice.lifecycle <> 'DISMISSED'
      )
    order by event.received_at desc;
end $$;

revoke all on function public.list_manual_intake_pipeline(uuid) from public, anon;
grant execute on function public.list_manual_intake_pipeline(uuid) to authenticated;
