create or replace function public.record_invoice_field_value(
  target_invoice uuid,
  expected_version integer,
  target_field text,
  target_value jsonb,
  actor uuid
)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  candidate public.invoice_candidates%rowtype;
  next_version integer;
  entered_text text;
  normalized_issuer text;
  resolved_issuer_id uuid;
  ready_for_routing boolean;
begin
  if length(trim(target_field)) = 0 or target_value is null or target_value = 'null'::jsonb then
    raise exception 'field name and non-null value are required';
  end if;
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.lifecycle in ('VERIFIED','VOIDED','DISMISSED') then raise exception 'terminal invoice cannot be edited'; end if;

  entered_text := case when jsonb_typeof(target_value) = 'string' then trim(target_value #>> '{}') else null end;
  if target_field in ('issuer','invoiceNumber','currency','invoiceDate','billTo') and length(coalesce(entered_text, '')) = 0 then
    raise exception '% must be a non-empty text value', target_field;
  end if;
  if target_field = 'currency' and upper(entered_text) !~ '^[A-Z]{3}$' then raise exception 'currency must be a three-letter code'; end if;
  if target_field in ('total','subtotal','tax') and
    (jsonb_typeof(target_value) not in ('number','string') or (target_value #>> '{}') !~ '^\d+(\.\d{1,4})?$') then
    raise exception '% must be a non-negative decimal amount', target_field;
  end if;

  if target_field = 'issuer' then
    normalized_issuer := lower(regexp_replace(entered_text, '\s+', ' ', 'g'));
    insert into public.issuers (tenant_id, legal_name, normalized_name)
      values (candidate.tenant_id, entered_text, normalized_issuer)
      on conflict (tenant_id, normalized_name) do update set legal_name = excluded.legal_name
      returning id into resolved_issuer_id;
    update public.invoice_candidates set issuer_id = resolved_issuer_id where id = candidate.id;
  elsif target_field = 'invoiceNumber' then
    update public.invoice_candidates set source_invoice_number = entered_text where id = candidate.id;
  elsif target_field = 'currency' then
    update public.invoice_candidates set currency = upper(entered_text) where id = candidate.id;
    target_value := to_jsonb(upper(entered_text));
  elsif target_field = 'total' then
    update public.invoice_candidates set total = (target_value #>> '{}')::numeric where id = candidate.id;
  end if;

  next_version := candidate.version + 1;
  insert into public.invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, version)
    values (candidate.tenant_id, candidate.id, target_field, target_value, 'REVIEWER_ENTERED', 1)
    on conflict (tenant_id, invoice_candidate_id, field_name) do update
      set resolved_value = excluded.resolved_value, resolution_method = 'REVIEWER_ENTERED', confidence = null,
          version = public.invoice_field_values.version + 1;

  update public.work_items set status = 'RESOLVED', resolved_at = now()
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
      and status in ('OPEN','WAITING_FOR_EVIDENCE')
      and blocker_code in ('MISSING:' || target_field, 'INVALID:' || target_field, 'CONFLICT:' || target_field);

  select not exists (
    select 1 from public.work_items
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
      and status in ('OPEN','WAITING_FOR_EVIDENCE')
  ) into ready_for_routing;

  update public.invoice_candidates set version = next_version, updated_at = now(),
    lifecycle = case when ready_for_routing then 'READY_FOR_VERIFICATION'::public.invoice_lifecycle else lifecycle end
    where id = candidate.id;
  if ready_for_routing then
    insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
      values (candidate.tenant_id, 'ROUTE_INVOICE_APPROVAL', candidate.id, 'route-invoice-approval:' || candidate.id,
        jsonb_build_object('invoice_candidate_id', candidate.id))
      on conflict (tenant_id, idempotency_key) do update
        set status = 'QUEUED', attempts = 0, available_at = now(), completed_at = null,
            lock_token = null, locked_at = null, last_error_code = null;
  end if;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, next_version, 'FIELD_VALUE_RECORDED', actor,
      jsonb_build_object('field_name', target_field, 'became_ready', ready_for_routing));
  return next_version;
end $$;

revoke all on function public.record_invoice_field_value(uuid, integer, text, jsonb, uuid) from public, anon;
grant execute on function public.record_invoice_field_value(uuid, integer, text, jsonb, uuid) to authenticated;
