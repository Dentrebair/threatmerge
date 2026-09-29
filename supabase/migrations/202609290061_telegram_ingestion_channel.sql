alter table public.ingestion_events drop constraint ingestion_events_channel_check;
alter table public.ingestion_events add constraint ingestion_events_channel_check
  check (channel in ('MANUAL_UPLOAD','POSTMARK','EML_UPLOAD','MICROSOFT_365','TELEGRAM'));

-- Registers an evidence artifact received via the Telegram inbound webhook. Modeled on
-- register_manual_upload, but callable only by the webhook's service-role connection:
-- there is no authenticated end-user session behind a Telegram message, so it cannot
-- use assert_reviewer. Sprint 10 routes every Telegram message to one fixed test
-- tenant (no per-chat identity resolution yet; see docs/SCALING.md).
create or replace function public.register_telegram_upload(
  target_tenant uuid,
  target_storage_path text,
  target_media_type text,
  target_byte_size bigint,
  target_sha256 text,
  target_transport_identity text,
  target_metadata jsonb default '{}'::jsonb
)
returns table (evidence_artifact_id uuid, ingestion_event_id uuid, processing_job_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare artifact_id uuid; event_id uuid; job_id uuid; existing_event public.ingestion_events%rowtype;
begin
  if target_storage_path not like target_tenant::text || '/%' then raise exception 'storage path must be tenant scoped'; end if;
  if target_media_type not in ('application/pdf','image/jpeg','image/png') then raise exception 'unsupported media type'; end if;
  if target_byte_size <= 0 or target_byte_size > 26214400 then raise exception 'file size must be between 1 byte and 25 MB'; end if;
  if target_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid sha256 checksum'; end if;
  if length(trim(target_transport_identity)) = 0 then raise exception 'transport identity is required'; end if;
  if jsonb_typeof(target_metadata) <> 'object' then raise exception 'metadata must be a JSON object'; end if;

  select * into existing_event from public.ingestion_events
    where tenant_id = target_tenant and channel = 'TELEGRAM' and transport_identity = target_transport_identity;
  if found then
    select id into job_id from public.processing_jobs
      where tenant_id = target_tenant and idempotency_key = 'telegram-upload:' || existing_event.id;
    return query select existing_event.evidence_artifact_id, existing_event.id, job_id;
    return;
  end if;

  insert into public.evidence_artifacts (tenant_id, storage_path, media_type, byte_size, sha256)
    values (target_tenant, target_storage_path, target_media_type, target_byte_size, target_sha256)
    returning id into artifact_id;
  insert into public.ingestion_events (tenant_id, evidence_artifact_id, channel, transport_identity)
    values (target_tenant, artifact_id, 'TELEGRAM', target_transport_identity)
    returning id into event_id;
  insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
    values (target_tenant, 'SCAN_EVIDENCE', artifact_id, 'telegram-upload:' || event_id,
      jsonb_build_object('evidence_artifact_id', artifact_id))
    returning id into job_id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (target_tenant, 'EVIDENCE', artifact_id, 1, 'TELEGRAM_MESSAGE_RECEIVED',
      target_metadata || jsonb_build_object('ingestion_event_id', event_id));
  return query select artifact_id, event_id, job_id;
end $$;

revoke all on function public.register_telegram_upload(uuid, text, text, bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_telegram_upload(uuid, text, text, bigint, text, text, jsonb) to service_role;
