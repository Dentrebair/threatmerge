create or replace function public.list_manual_intake_receipts(target_tenant uuid)
returns table (
  ingestion_event_id uuid,
  evidence_artifact_id uuid,
  file_name text,
  media_type text,
  byte_size bigint,
  safety_status public.safety_status,
  quarantine_reason text,
  processing_status public.processing_status,
  received_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select event.id, artifact.id, regexp_replace(artifact.storage_path, '^.*/', ''),
      artifact.media_type, artifact.byte_size, artifact.safety_status,
      artifact.quarantine_reason, job.status, event.received_at
    from public.ingestion_events event
    join public.evidence_artifacts artifact
      on artifact.tenant_id = event.tenant_id and artifact.id = event.evidence_artifact_id
    left join public.processing_jobs job
      on job.tenant_id = event.tenant_id and job.idempotency_key = 'manual-upload:' || event.id
    where event.tenant_id = target_tenant
      and event.channel = 'MANUAL_UPLOAD'
      and not exists (
        select 1 from public.evidence_links link
        where link.tenant_id = event.tenant_id
          and link.evidence_artifact_id = event.evidence_artifact_id
          and link.invoice_candidate_id is not null
      )
    order by event.received_at desc;
end $$;

revoke all on function public.list_manual_intake_receipts(uuid) from public, anon;
grant execute on function public.list_manual_intake_receipts(uuid) to authenticated;
