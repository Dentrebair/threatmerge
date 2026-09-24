create table public.transaction_important_dates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  date_kind text not null check (date_kind in ('AGREEMENT','INSPECTION','FINANCING','DOCUMENT_DEADLINE','CLOSING','HANDOVER')),
  date_value date,
  timestamp_value timestamptz,
  timezone text,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, transaction_file_id, date_kind),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, updated_by) references public.tenant_memberships(tenant_id, user_id),
  check ((date_value is not null) <> (timestamp_value is not null)),
  check (timestamp_value is null or length(trim(coalesce(timezone, ''))) > 0),
  check (date_value is null or timezone is null)
);

create table public.transaction_financial_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  financial_kind text not null check (financial_kind in ('DEAL_VALUE','DEPOSIT','COMMISSION','TAX','FEE')),
  label text not null check (length(trim(label)) between 1 and 120),
  amount numeric(18,2) not null check (amount >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, transaction_file_id, financial_kind, label),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, updated_by) references public.tenant_memberships(tenant_id, user_id)
);

alter table public.transaction_important_dates enable row level security;
alter table public.transaction_financial_entries enable row level security;
create policy tenant_isolation on public.transaction_important_dates
  for select using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_financial_entries
  for select using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_important_dates, public.transaction_financial_entries to authenticated;

create or replace function app_private.invalidate_transaction_review(target_transaction uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.transaction_files
  set business_stage = case when business_stage in ('UNDER_REVIEW','READY_FOR_CLOSING')
      then 'DOCUMENTS_PENDING'::public.transaction_stage else business_stage end,
    version = version + 1, updated_at = now()
  where id = target_transaction;
$$;

create or replace function public.add_transaction_party(
  target_transaction uuid, expected_version integer, target_name text,
  target_kind text, target_role text, target_primary boolean, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; party_id uuid;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if length(trim(coalesce(target_name, ''))) not between 1 and 200 then raise exception 'party name is required'; end if;
  if target_kind not in ('PERSON','ORGANIZATION') then raise exception 'party type is invalid'; end if;
  if target_role not in ('BUYER','SELLER','TENANT','LANDLORD','AGENT','LENDER','ATTORNEY','TITLE_ESCROW') then raise exception 'party role is invalid'; end if;
  if target_primary and target_role not in ('BUYER','SELLER','TENANT','LANDLORD') then raise exception 'primary party role is invalid'; end if;
  if target_primary then
    update public.transaction_party_assignments set is_primary = false
      where tenant_id = file.tenant_id and transaction_file_id = file.id and is_primary;
  end if;
  insert into public.transaction_parties (tenant_id, display_name, normalized_name, party_kind)
    values (file.tenant_id, trim(target_name), lower(regexp_replace(trim(target_name), '\s+', ' ', 'g')), target_kind)
    returning id into party_id;
  insert into public.transaction_party_assignments (tenant_id, transaction_file_id, party_id, role, is_primary)
    values (file.tenant_id, file.id, party_id, target_role::public.transaction_party_role, target_primary);
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_PARTY_ADDED', actor,
      jsonb_build_object('party_id', party_id, 'role', target_role, 'is_primary', target_primary));
  return party_id;
end $$;

create or replace function public.set_transaction_important_date(
  target_transaction uuid, expected_version integer, target_kind text,
  target_date date, target_timestamp timestamptz, target_timezone text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if target_kind not in ('AGREEMENT','INSPECTION','FINANCING','DOCUMENT_DEADLINE','CLOSING','HANDOVER') then raise exception 'important date type is invalid'; end if;
  if (target_date is null) = (target_timestamp is null) then raise exception 'provide either a date or a date and time'; end if;
  if target_timestamp is not null and length(trim(coalesce(target_timezone, ''))) = 0 then raise exception 'time zone is required for a date and time'; end if;
  insert into public.transaction_important_dates
    (tenant_id, transaction_file_id, date_kind, date_value, timestamp_value, timezone, updated_by)
  values (file.tenant_id, file.id, target_kind, target_date, target_timestamp,
    case when target_timestamp is null then null else trim(target_timezone) end, actor)
  on conflict (tenant_id, transaction_file_id, date_kind) do update
    set date_value = excluded.date_value, timestamp_value = excluded.timestamp_value,
      timezone = excluded.timezone, updated_by = excluded.updated_by, updated_at = now();
  if target_kind = 'CLOSING' and target_date is not null then
    update public.transaction_files set key_dates = jsonb_set(key_dates, '{closingDate}'::text[], to_jsonb(target_date::text), true)
      where id = file.id;
  end if;
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_IMPORTANT_DATE_SET', actor,
      jsonb_build_object('date_kind', target_kind, 'date_value', target_date, 'timestamp_value', target_timestamp, 'timezone', target_timezone));
  return file.version + 1;
end $$;

create or replace function public.set_transaction_financial(
  target_transaction uuid, expected_version integer, target_kind text,
  target_label text, target_amount numeric, target_currency text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; normalized_currency text;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if target_kind not in ('DEAL_VALUE','DEPOSIT','COMMISSION','TAX','FEE') then raise exception 'financial type is invalid'; end if;
  if length(trim(coalesce(target_label, ''))) not between 1 and 120 then raise exception 'financial label is required'; end if;
  if target_amount is null or target_amount < 0 then raise exception 'amount must be zero or greater'; end if;
  normalized_currency := upper(trim(coalesce(target_currency, '')));
  if normalized_currency !~ '^[A-Z]{3}$' then raise exception 'currency must be a three-letter code'; end if;
  insert into public.transaction_financial_entries
    (tenant_id, transaction_file_id, financial_kind, label, amount, currency, updated_by)
  values (file.tenant_id, file.id, target_kind, trim(target_label), target_amount, normalized_currency, actor)
  on conflict (tenant_id, transaction_file_id, financial_kind, label) do update
    set amount = excluded.amount, currency = excluded.currency,
      updated_by = excluded.updated_by, updated_at = now();
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_FINANCIAL_SET', actor,
      jsonb_build_object('financial_kind', target_kind, 'label', trim(target_label), 'amount', target_amount, 'currency', normalized_currency));
  return file.version + 1;
end $$;

revoke all on function public.add_transaction_party(uuid, integer, text, text, text, boolean, uuid) from public, anon;
revoke all on function public.set_transaction_important_date(uuid, integer, text, date, timestamptz, text, uuid) from public, anon;
revoke all on function public.set_transaction_financial(uuid, integer, text, text, numeric, text, uuid) from public, anon;
grant execute on function public.add_transaction_party(uuid, integer, text, text, text, boolean, uuid) to authenticated;
grant execute on function public.set_transaction_important_date(uuid, integer, text, date, timestamptz, text, uuid) to authenticated;
grant execute on function public.set_transaction_financial(uuid, integer, text, text, numeric, text, uuid) to authenticated;
