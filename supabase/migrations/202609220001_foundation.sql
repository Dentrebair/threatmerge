create schema if not exists app_private;

create type public.workspace_role as enum ('TENANT_ADMIN','REVIEWER','VIEWER','INTEGRATION');
create type public.invoice_origin as enum ('CAPTURED','GENERATED');
create type public.invoice_lifecycle as enum ('INCOMPLETE_DRAFT','SUSPENDED','READY_FOR_VERIFICATION','PENDING_REVIEW','VERIFIED','DISMISSED','VOIDED');
create type public.linkage_status as enum ('UNLINKED','AMBIGUOUS','LINKED');
create type public.transaction_lifecycle as enum ('INGESTED','ACCUMULATING','AMBIGUOUS','CONVERGED','APPROVED','DORMANT','ARCHIVED');
create type public.processing_status as enum ('QUEUED','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED');
create type public.compilation_status as enum ('NOT_REQUIRED','PENDING','READY','FAILED');
create type public.safety_status as enum ('PENDING','SAFE','QUARANTINED');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  role public.workspace_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create or replace function app_private.is_tenant_member(target_tenant uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.tenant_memberships
    where tenant_id = target_tenant and user_id = auth.uid() and active
  );
$$;

create table public.issuers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  legal_name text not null check (length(trim(legal_name)) > 0),
  normalized_name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, normalized_name)
);

create table public.invoice_schema_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version integer not null check (version > 0),
  scope text not null check (scope in ('BROKERAGE_DEFAULT','INVOICE_PARTY','OFFICE','TRANSACTION_TYPE')),
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  published_at timestamptz,
  unique (tenant_id, scope, version)
);

create table public.approval_policy_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version integer not null check (version > 0),
  mode text not null check (mode in ('MANDATORY','CONDITIONAL','AUTOMATIC')),
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  published_at timestamptz,
  unique (tenant_id, version)
);

create table public.evidence_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  storage_path text not null check (storage_path like tenant_id::text || '/%'),
  media_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  safety_status public.safety_status not null default 'PENDING',
  quarantine_reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check ((safety_status = 'QUARANTINED') = (quarantine_reason is not null))
);

create table public.ingestion_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  evidence_artifact_id uuid not null,
  channel text not null check (channel in ('MANUAL_UPLOAD','POSTMARK','EML_UPLOAD','MICROSOFT_365')),
  transport_identity text not null,
  received_at timestamptz not null default now(),
  unique (tenant_id, channel, transport_identity),
  foreign key (tenant_id, evidence_artifact_id) references public.evidence_artifacts(tenant_id, id)
);

create table public.transaction_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  external_reference text,
  property_address text not null,
  lifecycle public.transaction_lifecycle not null default 'INGESTED',
  version integer not null default 1 check (version > 0),
  last_material_activity_at timestamptz not null default now(),
  last_material_resolver_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, external_reference)
);

create table public.invoice_candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  issuer_id uuid not null,
  transaction_file_id uuid,
  origin public.invoice_origin not null,
  lifecycle public.invoice_lifecycle not null default 'INCOMPLETE_DRAFT',
  linkage_status public.linkage_status not null default 'UNLINKED',
  source_invoice_number text,
  official_invoice_number text,
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  total numeric(19,4) check (total >= 0),
  schema_fingerprint text not null,
  version integer not null default 1 check (version > 0),
  compilation_status public.compilation_status not null default 'NOT_REQUIRED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, official_invoice_number),
  foreign key (tenant_id, issuer_id) references public.issuers(tenant_id, id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  check ((linkage_status = 'LINKED') = (transaction_file_id is not null)),
  check ((origin = 'CAPTURED' and official_invoice_number is null) or origin = 'GENERATED'),
  check ((lifecycle = 'VERIFIED' and origin = 'GENERATED') = (official_invoice_number is not null) or origin = 'CAPTURED')
);

create table public.extracted_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  evidence_artifact_id uuid not null,
  field_name text not null,
  claimed_value jsonb not null,
  source_location jsonb not null check (jsonb_typeof(source_location) = 'object'),
  confidence numeric(5,4) check (confidence between 0 and 1),
  provider text not null,
  model_version text not null,
  schema_version text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, evidence_artifact_id) references public.evidence_artifacts(tenant_id, id)
);

create table public.invoice_field_values (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_candidate_id uuid not null,
  field_name text not null,
  resolved_value jsonb not null,
  resolution_method text not null check (resolution_method in ('EXTRACTED','CALCULATED','REVIEWER_ENTERED')),
  confidence numeric(5,4) check (confidence between 0 and 1),
  version integer not null default 1 check (version > 0),
  unique (tenant_id, id),
  unique (tenant_id, invoice_candidate_id, field_name),
  foreign key (tenant_id, invoice_candidate_id) references public.invoice_candidates(tenant_id, id)
);

create table public.evidence_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  evidence_artifact_id uuid not null,
  invoice_candidate_id uuid,
  transaction_file_id uuid,
  field_value_id uuid,
  relationship text not null,
  confidence numeric(5,4) check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  check (num_nonnulls(invoice_candidate_id, transaction_file_id, field_value_id) = 1),
  foreign key (tenant_id, evidence_artifact_id) references public.evidence_artifacts(tenant_id, id),
  foreign key (tenant_id, invoice_candidate_id) references public.invoice_candidates(tenant_id, id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, field_value_id) references public.invoice_field_values(tenant_id, id)
);

create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  record_type text not null check (record_type in ('INVOICE','TRANSACTION_FILE','EVIDENCE')),
  record_id uuid not null,
  kind text not null,
  status text not null default 'OPEN' check (status in ('OPEN','WAITING_FOR_EVIDENCE','RESOLVED','DISMISSED')),
  assigned_to uuid,
  blocker_code text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_type text not null,
  aggregate_id uuid not null,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.processing_status not null default 'QUEUED',
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 0),
  event_type text not null,
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type)
);

create table public.official_number_sequences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  issuer_id uuid not null,
  prefix text not null,
  next_value bigint not null default 1 check (next_value > 0),
  primary key (tenant_id, issuer_id),
  foreign key (tenant_id, issuer_id) references public.issuers(tenant_id, id)
);

create or replace function app_private.reject_audit_mutation()
returns trigger language plpgsql as $$ begin raise exception 'audit_events are append-only'; end; $$;
create trigger audit_events_immutable before update or delete on public.audit_events
for each row execute function app_private.reject_audit_mutation();

create or replace function public.finalize_generated_invoice(target_invoice uuid, expected_version integer, actor uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; sequence_row public.official_number_sequences%rowtype; allocated text;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.origin <> 'GENERATED' or candidate.lifecycle <> 'PENDING_REVIEW' then raise exception 'invoice is not eligible for generated finalization'; end if;
  select * into sequence_row from public.official_number_sequences where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id for update;
  if not found then raise exception 'official number sequence is not configured'; end if;
  allocated := sequence_row.prefix || lpad(sequence_row.next_value::text, 6, '0');
  update public.official_number_sequences set next_value = next_value + 1 where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id;
  update public.invoice_candidates set lifecycle = 'VERIFIED', official_invoice_number = allocated, compilation_status = 'PENDING', version = version + 1, updated_at = now() where id = target_invoice;
  insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key) values (candidate.tenant_id, 'COMPILE_GENERATED_INVOICE_PDF', target_invoice, 'generated-invoice:' || target_invoice || ':pdf:v1');
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata) values (candidate.tenant_id, 'INVOICE', target_invoice, candidate.version + 1, 'INVOICE_VERIFIED', actor, jsonb_build_object('official_invoice_number', allocated));
  return allocated;
end $$;

revoke all on function public.finalize_generated_invoice(uuid, integer, uuid) from public;
grant execute on function public.finalize_generated_invoice(uuid, integer, uuid) to authenticated;

do $$ declare table_name text; begin
  foreach table_name in array array['tenants','tenant_memberships','issuers','invoice_schema_versions','approval_policy_versions','evidence_artifacts','ingestion_events','transaction_files','invoice_candidates','extracted_observations','invoice_field_values','evidence_links','work_items','processing_jobs','audit_events','official_number_sequences'] loop
    execute format('alter table public.%I enable row level security', table_name);
    if table_name = 'tenants' then
      execute 'create policy tenant_isolation on public.tenants using (app_private.is_tenant_member(id))';
    else
      execute format('create policy tenant_isolation on public.%I using (app_private.is_tenant_member(tenant_id)) with check (app_private.is_tenant_member(tenant_id))', table_name);
    end if;
  end loop;
end $$;
