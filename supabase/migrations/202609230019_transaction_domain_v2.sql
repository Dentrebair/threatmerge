create type public.transaction_stage as enum (
  'DRAFT','DOCUMENTS_PENDING','UNDER_REVIEW','READY_FOR_CLOSING','CLOSED','CANCELLED'
);
create type public.transaction_party_role as enum (
  'BUYER','SELLER','TENANT','LANDLORD','AGENT','LENDER','ATTORNEY','TITLE_ESCROW'
);

create table public.transaction_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text not null check (length(trim(name)) between 2 and 80),
  active boolean not null default true,
  system_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id), unique (tenant_id, code)
);

create or replace function app_private.initialize_transaction_types()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.transaction_types (tenant_id, code, name, system_default) values
    (new.id, 'PURCHASE', 'Purchase', true),
    (new.id, 'SALE', 'Sale', true),
    (new.id, 'LEASE', 'Lease', true),
    (new.id, 'RENTAL', 'Rental', true)
  on conflict (tenant_id, code) do nothing;
  return new;
end $$;

create trigger initialize_transaction_types_after_tenant
after insert on public.tenants for each row execute function app_private.initialize_transaction_types();

create table public.transaction_template_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_type_id uuid not null,
  version integer not null check (version > 0),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id), unique (tenant_id, transaction_type_id, version),
  foreign key (tenant_id, transaction_type_id) references public.transaction_types(tenant_id, id),
  foreign key (tenant_id, published_by) references public.tenant_memberships(tenant_id, user_id)
);

create table public.transaction_parties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 200),
  normalized_name text not null check (length(trim(normalized_name)) > 0),
  party_kind text not null check (party_kind in ('PERSON','ORGANIZATION')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.transaction_party_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  party_id uuid not null,
  role public.transaction_party_role not null,
  is_primary boolean not null default false,
  override_reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id), unique (tenant_id, transaction_file_id, party_id, role),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, party_id) references public.transaction_parties(tenant_id, id),
  check (not is_primary or override_reason is null or length(trim(override_reason)) > 0)
);
create unique index transaction_party_one_primary_idx
  on public.transaction_party_assignments (tenant_id, transaction_file_id) where is_primary;

create table public.transaction_team_assignments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  user_id uuid not null,
  responsibility text not null check (responsibility in ('OWNER','AGENT','COORDINATOR')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, transaction_file_id, user_id, responsibility),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, user_id) references public.tenant_memberships(tenant_id, user_id)
);
create unique index transaction_team_one_owner_idx
  on public.transaction_team_assignments (tenant_id, transaction_file_id) where responsibility = 'OWNER';

alter table public.transaction_files
  add column business_stage public.transaction_stage,
  add column transaction_type_id uuid,
  add column template_version_id uuid,
  add column stage_migrated_at timestamptz,
  add foreign key (tenant_id, transaction_type_id) references public.transaction_types(tenant_id, id),
  add foreign key (tenant_id, template_version_id) references public.transaction_template_versions(tenant_id, id);

insert into public.transaction_types (tenant_id, code, name, system_default)
select tenant.id, defaults.code, defaults.name, true
from public.tenants tenant cross join (values
  ('PURCHASE','Purchase'),('SALE','Sale'),('LEASE','Lease'),('RENTAL','Rental')
) defaults(code, name)
on conflict (tenant_id, code) do nothing;

update public.transaction_files file set business_stage = case file.lifecycle
  when 'AMBIGUOUS' then 'UNDER_REVIEW'::public.transaction_stage
  when 'CONVERGED' then 'READY_FOR_CLOSING'::public.transaction_stage
  when 'APPROVED' then 'READY_FOR_CLOSING'::public.transaction_stage
  when 'ARCHIVED' then case when file.approved_at is null then 'CANCELLED'::public.transaction_stage else 'CLOSED'::public.transaction_stage end
  else case when exists (
    select 1 from public.transaction_requirement_statuses requirement
    where requirement.tenant_id = file.tenant_id and requirement.transaction_file_id = file.id
  ) then 'DOCUMENTS_PENDING'::public.transaction_stage else 'DRAFT'::public.transaction_stage end
end, stage_migrated_at = now();

insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
select tenant_id, 'TRANSACTION_FILE', id, version, 'TRANSACTION_STAGE_MIGRATED',
  jsonb_build_object('legacy_lifecycle', lifecycle, 'business_stage', business_stage)
from public.transaction_files;

alter table public.transaction_files alter column business_stage set default 'DRAFT';
alter table public.transaction_files alter column business_stage set not null;

alter table public.transaction_types enable row level security;
alter table public.transaction_template_versions enable row level security;
alter table public.transaction_parties enable row level security;
alter table public.transaction_party_assignments enable row level security;
alter table public.transaction_team_assignments enable row level security;
create policy tenant_isolation on public.transaction_types using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_template_versions using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_parties using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_party_assignments using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_team_assignments using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_types, public.transaction_template_versions, public.transaction_parties,
  public.transaction_party_assignments, public.transaction_team_assignments to authenticated;

create or replace function public.create_transaction_file_v2(
  target_tenant uuid, target_external_reference text, target_property_address text,
  target_transaction_type uuid, target_owner uuid, target_primary_party_name text,
  target_primary_party_kind text, target_primary_party_role text, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction_id uuid; party_id uuid; template public.transaction_template_versions%rowtype; type_row public.transaction_types%rowtype;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  if length(trim(coalesce(target_property_address, ''))) = 0 then raise exception 'property address is required'; end if;
  select * into type_row from public.transaction_types where tenant_id = target_tenant and id = target_transaction_type and active;
  if not found then raise exception 'transaction type is unavailable'; end if;
  if not exists (select 1 from public.tenant_memberships where tenant_id = target_tenant and user_id = target_owner and active and role <> 'INTEGRATION') then
    raise exception 'assigned owner is unavailable';
  end if;
  if length(trim(coalesce(target_primary_party_name, ''))) = 0 then raise exception 'primary party name is required'; end if;
  if target_primary_party_kind not in ('PERSON','ORGANIZATION') then raise exception 'primary party type is invalid'; end if;
  if target_primary_party_role not in ('BUYER','SELLER','TENANT','LANDLORD') then raise exception 'primary party role is invalid'; end if;

  select * into template from public.transaction_template_versions
    where tenant_id = target_tenant and transaction_type_id = type_row.id and published_at is not null
    order by version desc limit 1;
  insert into public.transaction_files (tenant_id, external_reference, property_address, transaction_type,
    transaction_type_id, template_version_id, lifecycle, business_stage, requirement_snapshot)
  values (target_tenant, nullif(trim(target_external_reference), ''), trim(target_property_address), type_row.code,
    type_row.id, template.id, 'ACCUMULATING', 'DRAFT', coalesce(template.configuration->'requirements', '{"artifacts":[],"fields":[]}'::jsonb))
  returning id into transaction_id;
  insert into public.transaction_team_assignments (tenant_id, transaction_file_id, user_id, responsibility)
    values (target_tenant, transaction_id, target_owner, 'OWNER');
  insert into public.transaction_parties (tenant_id, display_name, normalized_name, party_kind)
    values (target_tenant, trim(target_primary_party_name), lower(regexp_replace(trim(target_primary_party_name), '\s+', ' ', 'g')), target_primary_party_kind)
    returning id into party_id;
  insert into public.transaction_party_assignments (tenant_id, transaction_file_id, party_id, role, is_primary)
    values (target_tenant, transaction_id, party_id, target_primary_party_role::public.transaction_party_role, true);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'TRANSACTION_FILE', transaction_id, 1, 'TRANSACTION_FILE_V2_CREATED', actor,
      jsonb_build_object('transaction_type_id', type_row.id, 'owner_user_id', target_owner, 'primary_party_id', party_id,
        'primary_party_role', target_primary_party_role, 'template_version_id', template.id));
  return transaction_id;
end $$;

revoke all on function public.create_transaction_file_v2(uuid, text, text, uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.create_transaction_file_v2(uuid, text, text, uuid, uuid, text, text, text, uuid) to authenticated;
