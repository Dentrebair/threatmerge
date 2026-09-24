create or replace function public.review_transaction_document(
  target_transaction uuid, expected_version integer, target_document_version uuid,
  target_decision text, target_reason text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; stored_version public.transaction_document_versions%rowtype;
  document public.transaction_documents%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into stored_version from public.transaction_document_versions
    where tenant_id = file.tenant_id and transaction_file_id = file.id and id = target_document_version;
  if not found then raise exception 'document version not found'; end if;
  select * into document from public.transaction_documents
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and id = stored_version.document_id and current_version_id = stored_version.id;
  if not found then raise exception 'only the current document version can be reviewed'; end if;
  if target_decision not in ('VERIFIED','REJECTED') then raise exception 'document decision is invalid'; end if;
  if target_decision = 'REJECTED' and length(trim(coalesce(target_reason, ''))) = 0 then
    raise exception 'explain why the document was rejected';
  end if;

  insert into public.transaction_document_decisions
    (tenant_id, transaction_file_id, document_version_id, decision, reason, decided_by)
  values (file.tenant_id, file.id, stored_version.id, target_decision,
    case when target_decision = 'REJECTED' then trim(target_reason) else null end, actor);
  if document.requirement_key is not null then
    update public.transaction_requirement_statuses
      set status = case when target_decision = 'VERIFIED' then 'PRESENT' else 'MISSING' end,
        confidence = case when target_decision = 'VERIFIED' then 1 else null end,
        resolved_by = case when target_decision = 'VERIFIED' then actor else null end,
        updated_at = now()
      where tenant_id = file.tenant_id and transaction_file_id = file.id
        and requirement_kind = 'ARTIFACT' and requirement_key = document.requirement_key;
  end if;
  if target_decision = 'REJECTED' then
    perform app_private.invalidate_transaction_review(file.id);
  else
    update public.transaction_files set business_stage = file.business_stage,
      version = public.transaction_files.version + 1, updated_at = now() where id = file.id;
  end if;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
      'TRANSACTION_DOCUMENT_' || target_decision, actor,
      jsonb_build_object('document_id', document.id, 'document_version_id', stored_version.id,
        'reason', nullif(trim(coalesce(target_reason, '')), '')));
  return file.version + 1;
end $$;

create or replace function public.complete_transaction_review(
  target_transaction uuid, expected_version integer, actor uuid
)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; blockers integer;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage <> 'UNDER_REVIEW' then raise exception 'Transaction File is not under review'; end if;

  select count(*) into blockers from public.transaction_requirement_statuses requirement
    where requirement.tenant_id = file.tenant_id and requirement.transaction_file_id = file.id
      and requirement.stage_gate in ('BEFORE_REVIEW','BEFORE_APPROVAL')
      and requirement.status <> 'PRESENT';
  if blockers > 0 then raise exception 'resolve % required item(s) before completing review', blockers; end if;

  select count(*) into blockers from public.transaction_custom_field_definitions definition
    where definition.tenant_id = file.tenant_id and definition.transaction_file_id = file.id
      and definition.required and definition.stage_gate in ('BEFORE_REVIEW','BEFORE_APPROVAL')
      and not exists (
        select 1 from public.transaction_custom_field_values stored
        where stored.tenant_id = definition.tenant_id and stored.definition_id = definition.id
      );
  if blockers > 0 then raise exception 'complete % required information field(s) before completing review', blockers; end if;

  select count(*) into blockers
  from public.transaction_requirement_statuses requirement
  where requirement.tenant_id = file.tenant_id and requirement.transaction_file_id = file.id
    and requirement.requirement_kind = 'ARTIFACT'
    and requirement.stage_gate in ('BEFORE_REVIEW','BEFORE_APPROVAL')
    and not exists (
      select 1 from public.transaction_documents document
      join public.transaction_document_versions stored
        on stored.tenant_id = document.tenant_id and stored.id = document.current_version_id
      where document.tenant_id = requirement.tenant_id
        and document.transaction_file_id = requirement.transaction_file_id
        and document.requirement_key = requirement.requirement_key
        and (stored.expires_on is null or stored.expires_on >= current_date)
        and (
          select decision.decision from public.transaction_document_decisions decision
          where decision.tenant_id = stored.tenant_id and decision.document_version_id = stored.id
          order by decision.decided_at desc, decision.id desc limit 1
        ) = 'VERIFIED'
    );
  if blockers > 0 then raise exception 'verify % required document(s) before completing review', blockers; end if;

  select count(*) into blockers from public.work_items work
    where work.tenant_id = file.tenant_id and work.record_type = 'TRANSACTION_FILE'
      and work.record_id = file.id and work.status in ('OPEN','WAITING_FOR_EVIDENCE')
      and work.kind in ('RESOLVE_CONFLICT','CONFIRM_INFORMATION');
  if blockers > 0 then raise exception 'resolve % conflict or confirmation task(s) before completing review', blockers; end if;

  update public.transaction_files set business_stage = 'READY_FOR_CLOSING', version = version + 1,
    updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
      'TRANSACTION_REVIEW_COMPLETED', actor);
  return 'READY_FOR_CLOSING';
end $$;

revoke all on function public.review_transaction_document(uuid, integer, uuid, text, text, uuid) from public, anon;
revoke all on function public.complete_transaction_review(uuid, integer, uuid) from public, anon;
grant execute on function public.review_transaction_document(uuid, integer, uuid, text, text, uuid) to authenticated;
grant execute on function public.complete_transaction_review(uuid, integer, uuid) to authenticated;
