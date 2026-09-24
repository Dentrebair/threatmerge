create table public.transaction_document_upload_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  evidence_artifact_id uuid not null,
  requirement_key text,
  document_name text not null check (length(trim(document_name)) between 1 and 160),
  expires_on date,
  status text not null default 'WAITING_FOR_SCAN'
    check (status in ('WAITING_FOR_SCAN','ATTACHED','FAILED','CANCELLED')),
  failure_reason text,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, evidence_artifact_id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, evidence_artifact_id) references public.evidence_artifacts(tenant_id, id),
  foreign key (tenant_id, requested_by) references public.tenant_memberships(tenant_id, user_id),
  check ((status = 'FAILED') = (failure_reason is not null)),
  check ((status in ('ATTACHED','FAILED','CANCELLED')) = (completed_at is not null))
);

alter table public.transaction_document_upload_intents enable row level security;
create policy tenant_isolation on public.transaction_document_upload_intents
  for select using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_document_upload_intents to authenticated;
create trigger guard_transaction_document_intent_write
before insert or update or delete on public.transaction_document_upload_intents
for each row execute function app_private.guard_transaction_child_write();

create or replace function public.stage_transaction_document_upload(
  target_transaction uuid, expected_version integer, target_evidence uuid,
  target_requirement_key text, target_name text, target_expires_on date, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; artifact public.evidence_artifacts%rowtype;
  requirement public.transaction_requirement_statuses%rowtype; intent_id uuid;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into artifact from public.evidence_artifacts where tenant_id = file.tenant_id and id = target_evidence;
  if not found then raise exception 'uploaded file not found'; end if;
  if artifact.safety_status = 'QUARANTINED' then raise exception 'replace the file because it did not pass safety checks'; end if;
  if length(trim(coalesce(target_name, ''))) not between 1 and 160 then raise exception 'document name is required'; end if;
  if target_expires_on is not null and target_expires_on < current_date then raise exception 'document expiry must be today or later'; end if;
  if nullif(trim(coalesce(target_requirement_key, '')), '') is not null then
    select * into requirement from public.transaction_requirement_statuses
      where tenant_id = file.tenant_id and transaction_file_id = file.id
        and requirement_kind = 'ARTIFACT' and requirement_key = trim(target_requirement_key);
    if not found then raise exception 'document requirement not found'; end if;
  end if;
  insert into public.transaction_document_upload_intents
    (tenant_id, transaction_file_id, evidence_artifact_id, requirement_key, document_name, expires_on, requested_by)
  values (file.tenant_id, file.id, artifact.id, nullif(trim(target_requirement_key), ''),
    trim(target_name), target_expires_on, actor) returning id into intent_id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version, 'TRANSACTION_DOCUMENT_UPLOAD_STAGED', actor,
      jsonb_build_object('intent_id', intent_id, 'evidence_artifact_id', artifact.id,
        'requirement_key', nullif(trim(target_requirement_key), '')));
  if artifact.safety_status = 'SAFE' then
    perform app_private.finalize_transaction_document_intent(artifact.id);
  end if;
  return intent_id;
exception when unique_violation then raise exception 'this upload is already assigned to a Transaction File document';
end $$;

create or replace function app_private.finalize_transaction_document_intent(target_evidence uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare intent public.transaction_document_upload_intents%rowtype; artifact public.evidence_artifacts%rowtype;
  file public.transaction_files%rowtype; document public.transaction_documents%rowtype;
  requirement public.transaction_requirement_statuses%rowtype; next_document_version integer; version_id uuid;
begin
  select * into intent from public.transaction_document_upload_intents
    where evidence_artifact_id = target_evidence and status = 'WAITING_FOR_SCAN' for update;
  if not found then return; end if;
  select * into artifact from public.evidence_artifacts
    where tenant_id = intent.tenant_id and id = intent.evidence_artifact_id;
  if artifact.safety_status = 'QUARANTINED' then
    update public.transaction_document_upload_intents set status = 'FAILED',
      failure_reason = coalesce(artifact.quarantine_reason, 'FILE_DID_NOT_PASS_SAFETY_CHECKS'), completed_at = now()
      where id = intent.id;
    return;
  end if;
  if artifact.safety_status <> 'SAFE' then return; end if;
  select * into file from public.transaction_files where tenant_id = intent.tenant_id and id = intent.transaction_file_id for update;
  if file.business_stage in ('CLOSED','CANCELLED') then
    update public.transaction_document_upload_intents set status = 'FAILED',
      failure_reason = 'TRANSACTION_FILE_NOT_EDITABLE', completed_at = now() where id = intent.id;
    return;
  end if;
  if intent.requirement_key is not null then
    select * into requirement from public.transaction_requirement_statuses
      where tenant_id = file.tenant_id and transaction_file_id = file.id
        and requirement_kind = 'ARTIFACT' and requirement_key = intent.requirement_key;
  end if;
  select * into document from public.transaction_documents
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and requirement_key is not distinct from intent.requirement_key for update;
  if not found then
    insert into public.transaction_documents
      (tenant_id, transaction_file_id, requirement_key, name, required, stage_gate, created_by)
    values (file.tenant_id, file.id, intent.requirement_key, intent.document_name,
      requirement.id is not null, coalesce(requirement.stage_gate, 'BEFORE_REVIEW'), intent.requested_by)
    returning * into document;
  end if;
  select coalesce(max(stored.version), 0) + 1 into next_document_version
    from public.transaction_document_versions stored
    where stored.tenant_id = file.tenant_id and stored.document_id = document.id;
  insert into public.transaction_document_versions
    (tenant_id, transaction_file_id, document_id, evidence_artifact_id, version, expires_on, uploaded_by)
  values (file.tenant_id, file.id, document.id, artifact.id, next_document_version,
    intent.expires_on, intent.requested_by) returning id into version_id;
  update public.transaction_documents set current_version_id = version_id,
    name = intent.document_name where id = document.id;
  insert into public.evidence_links (tenant_id, evidence_artifact_id, transaction_file_id, relationship, confidence)
    values (file.tenant_id, artifact.id, file.id, 'TRANSACTION_DOCUMENT_VERSION', 1);
  if requirement.id is not null then
    update public.transaction_requirement_statuses set status = 'PRESENT', confidence = 1,
      resolved_by = intent.requested_by, updated_at = now() where id = requirement.id;
  end if;
  perform app_private.invalidate_transaction_review(file.id);
  update public.transaction_document_upload_intents set status = 'ATTACHED', completed_at = now() where id = intent.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
      'TRANSACTION_DOCUMENT_UPLOAD_ATTACHED', intent.requested_by,
      jsonb_build_object('intent_id', intent.id, 'document_id', document.id,
        'document_version_id', version_id, 'evidence_artifact_id', artifact.id));
end $$;

create or replace function public.complete_evidence_scan(
  target_job uuid, target_lock_token uuid, is_safe boolean, failure_reason text default null
)
returns public.processing_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare job public.processing_jobs%rowtype; is_transaction_document boolean;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found or job.job_type <> 'SCAN_EVIDENCE' then raise exception 'scan job not found'; end if;
  if job.lock_token is distinct from target_lock_token then raise exception 'stale worker lease'; end if;
  if job.status = 'CANCEL_REQUESTED' then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    update public.transaction_document_upload_intents set status = 'CANCELLED', completed_at = now()
      where tenant_id = job.tenant_id and evidence_artifact_id = job.aggregate_id and status = 'WAITING_FOR_SCAN';
    return 'CANCELLED';
  end if;
  if job.status <> 'RUNNING' then raise exception 'scan job is not running'; end if;
  if not is_safe and length(trim(coalesce(failure_reason, ''))) = 0 then raise exception 'unsafe scan requires a reason'; end if;
  select exists (select 1 from public.transaction_document_upload_intents
    where tenant_id = job.tenant_id and evidence_artifact_id = job.aggregate_id and status = 'WAITING_FOR_SCAN')
    into is_transaction_document;
  if is_safe then
    update public.evidence_artifacts set safety_status = 'SAFE', quarantine_reason = null
      where tenant_id = job.tenant_id and id = job.aggregate_id;
    if is_transaction_document then
      perform app_private.finalize_transaction_document_intent(job.aggregate_id);
    else
      insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
        values (job.tenant_id, 'EXTRACT_EVIDENCE', job.aggregate_id, 'extract-evidence:' || job.aggregate_id,
          jsonb_build_object('evidence_artifact_id', job.aggregate_id)) on conflict (tenant_id, idempotency_key) do nothing;
    end if;
  else
    update public.evidence_artifacts set safety_status = 'QUARANTINED', quarantine_reason = failure_reason
      where tenant_id = job.tenant_id and id = job.aggregate_id;
    if is_transaction_document then
      perform app_private.finalize_transaction_document_intent(job.aggregate_id);
    else
      insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
        values (job.tenant_id, 'EVIDENCE', job.aggregate_id, 'REPLACE_UNSAFE_FILE', 'SAFETY_SCAN_FAILED');
    end if;
  end if;
  update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (job.tenant_id, 'EVIDENCE', job.aggregate_id, job.attempts + 1,
      case when is_safe then 'SAFETY_SCAN_PASSED' else 'EVIDENCE_QUARANTINED' end,
      jsonb_build_object('processing_job_id', job.id, 'reason', failure_reason,
        'routed_to', case when is_transaction_document then 'TRANSACTION_DOCUMENT' else 'INVOICE_EXTRACTION' end));
  return 'SUCCEEDED';
end $$;

revoke all on function public.stage_transaction_document_upload(uuid, integer, uuid, text, text, date, uuid) from public, anon;
grant execute on function public.stage_transaction_document_upload(uuid, integer, uuid, text, text, date, uuid) to authenticated;
