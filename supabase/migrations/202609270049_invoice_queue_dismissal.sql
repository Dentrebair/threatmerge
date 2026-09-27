create or replace function public.dismiss_invoice_candidate(
  target_invoice uuid,
  expected_version integer,
  actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.transaction_file_id is not null then raise exception 'linked invoice must be unlinked before dismissal'; end if;
  if candidate.lifecycle = 'DISMISSED' then return candidate.version; end if;

  update public.invoice_candidates
    set lifecycle = 'DISMISSED', version = version + 1, updated_at = now()
    where id = candidate.id;
  update public.work_items
    set status = 'DISMISSED', resolved_at = now()
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
      and status in ('OPEN','WAITING_FOR_EVIDENCE');
  update public.processing_jobs
    set status = case when status = 'RUNNING' then 'CANCEL_REQUESTED'::public.processing_status else 'CANCELLED'::public.processing_status end,
      completed_at = case when status = 'RUNNING' then completed_at else now() end
    where tenant_id = candidate.tenant_id and aggregate_id = candidate.id
      and status in ('QUEUED','RETRY_SCHEDULED','RUNNING');
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_DISMISSED', actor,
      jsonb_build_object('previous_lifecycle', candidate.lifecycle));
  return candidate.version + 1;
end $$;

revoke all on function public.dismiss_invoice_candidate(uuid, integer, uuid) from public, anon;
grant execute on function public.dismiss_invoice_candidate(uuid, integer, uuid) to authenticated;

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
  if job_row.status in ('QUEUED','RETRY_SCHEDULED','FAILED') then next_status := 'CANCELLED';
  elsif job_row.status = 'RUNNING' then next_status := 'CANCEL_REQUESTED';
  elsif job_row.status in ('CANCELLED','CANCEL_REQUESTED') then return job_row.status;
  else raise exception 'scan can no longer be cancelled';
  end if;
  update public.processing_jobs set status = next_status, completed_at = case when next_status = 'CANCELLED' then now() else completed_at end where id = job_row.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'EVIDENCE', event_row.evidence_artifact_id, job_row.attempts + 2, 'SCAN_CANCELLATION_' || next_status::text, actor,
      jsonb_build_object('ingestion_event_id', event_row.id, 'processing_job_id', job_row.id));
  return next_status;
end $$;

revoke all on function public.cancel_manual_intake_scan(uuid, uuid, uuid) from public, anon;
grant execute on function public.cancel_manual_intake_scan(uuid, uuid, uuid) to authenticated;
