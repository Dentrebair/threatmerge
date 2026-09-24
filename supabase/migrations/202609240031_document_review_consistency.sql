create or replace function public.review_transaction_document(
  target_transaction uuid, expected_version integer, target_document_version uuid,
  target_decision text, target_reason text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; version public.transaction_document_versions%rowtype;
  document public.transaction_documents%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into version from public.transaction_document_versions
    where tenant_id = file.tenant_id and transaction_file_id = file.id and id = target_document_version;
  if not found then raise exception 'document version not found'; end if;
  select * into document from public.transaction_documents
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and id = version.document_id and current_version_id = version.id;
  if not found then raise exception 'only the current document version can be reviewed'; end if;
  if target_decision not in ('VERIFIED','REJECTED') then raise exception 'document decision is invalid'; end if;
  if target_decision = 'REJECTED' and length(trim(coalesce(target_reason, ''))) = 0 then
    raise exception 'explain why the document was rejected';
  end if;

  insert into public.transaction_document_decisions
    (tenant_id, transaction_file_id, document_version_id, decision, reason, decided_by)
  values (file.tenant_id, file.id, version.id, target_decision,
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
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
      'TRANSACTION_DOCUMENT_' || target_decision, actor,
      jsonb_build_object('document_id', document.id, 'document_version_id', version.id,
        'reason', nullif(trim(coalesce(target_reason, '')), '')));
  return file.version + 1;
end $$;

revoke all on function public.review_transaction_document(uuid, integer, uuid, text, text, uuid) from public, anon;
grant execute on function public.review_transaction_document(uuid, integer, uuid, text, text, uuid) to authenticated;
