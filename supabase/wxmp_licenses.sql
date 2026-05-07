do $$
begin
  create type public.license_kind as enum ('trial', 'official');
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create type public.license_status as enum ('active', 'revoked');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.wxmp_licenses (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  kind public.license_kind not null,
  quota_level integer not null default 1 check (quota_level >= 0),
  expires_at timestamptz not null,
  customer text,
  status public.license_status not null default 'active',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wxmp_licenses
  add column if not exists quota_level integer not null default 1;

do $$
begin
  alter table public.wxmp_licenses
    add constraint wxmp_licenses_quota_level_check check (quota_level >= 0);
exception
  when duplicate_object then null;
end;
$$;

create unique index if not exists wxmp_licenses_account_id_key
  on public.wxmp_licenses (account_id);

create table if not exists public.wxmp_quota_settings (
  id text primary key default 'default' check (id = 'default'),
  account_level_factor integer not null default 5 check (account_level_factor >= 0),
  own_capability_factor integer not null default 50 check (own_capability_factor >= 0),
  default_account_level integer not null default 0 check (default_account_level >= 0),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wxmp_user_capabilities (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  mp_username text,
  mp_nickname text,
  mp_alias text,
  service_type text,
  capability_units integer not null default 1 check (capability_units >= 0),
  provides_to_others boolean not null default false,
  commercial_terms_accepted_at timestamptz,
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wxmp_quota_settings
  alter column account_level_factor set default 5,
  alter column default_account_level set default 0;

update public.wxmp_quota_settings
set
  account_level_factor = 5,
  default_account_level = 0,
  updated_at = now()
where id = 'default'
  and account_level_factor = 50
  and default_account_level = 1;

create table if not exists public.wxmp_provider_nodes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  capability_user_id uuid references public.wxmp_user_capabilities(user_id) on delete set null,
  mp_username text,
  mp_nickname text,
  mp_alias text,
  service_type text,
  self_use_enabled boolean not null default false,
  commercial_enabled boolean not null default false,
  commercial_terms_accepted_at timestamptz,
  self_capability_units integer not null default 0 check (self_capability_units >= 0),
  commercial_capability_units integer not null default 0 check (commercial_capability_units >= 0),
  current_hour_capacity integer not null default 0 check (current_hour_capacity >= 0),
  current_hour_used integer not null default 0 check (current_hour_used >= 0),
  current_hour_started_at timestamptz not null default date_trunc('hour', now()),
  health_score integer not null default 100 check (health_score >= 0 and health_score <= 100),
  status text not null default 'online' check (status in ('online', 'degraded', 'offline', 'cooldown', 'paused', 'revoked')),
  last_seen_at timestamptz,
  cooldown_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wxmp_provider_nodes_owner_user_id_key
  on public.wxmp_provider_nodes (owner_user_id);

create index if not exists wxmp_provider_nodes_commercial_ready_idx
  on public.wxmp_provider_nodes (commercial_enabled, status, cooldown_until, health_score desc);

create table if not exists public.wxmp_gateway_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  request_kind text not null check (request_kind in ('self', 'commercial')),
  endpoint text,
  target_fakeid text,
  idempotency_key text,
  payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  assigned_provider_node_id uuid references public.wxmp_provider_nodes(id) on delete set null,
  assigned_owner_user_id uuid references auth.users(id) on delete set null,
  quota_cost integer not null default 1 check (quota_cost > 0),
  priority integer not null default 100,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  trace_id text,
  error_code text,
  error_message text,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wxmp_gateway_requests_idempotency_key_idx
  on public.wxmp_gateway_requests (requester_user_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists wxmp_gateway_requests_queue_idx
  on public.wxmp_gateway_requests (status, priority, enqueued_at);

create table if not exists public.wxmp_provider_leases (
  id uuid primary key default gen_random_uuid(),
  provider_node_id uuid not null references public.wxmp_provider_nodes(id) on delete cascade,
  gateway_request_id uuid references public.wxmp_gateway_requests(id) on delete set null,
  lease_kind text not null check (lease_kind in ('self', 'commercial')),
  quota_units integer not null default 1 check (quota_units > 0),
  status text not null default 'active' check (status in ('active', 'consumed', 'released', 'expired')),
  leased_by uuid references auth.users(id) on delete set null default auth.uid(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wxmp_provider_leases_active_idx
  on public.wxmp_provider_leases (provider_node_id, status, expires_at);

create table if not exists public.wxmp_provider_health_events (
  id uuid primary key default gen_random_uuid(),
  provider_node_id uuid references public.wxmp_provider_nodes(id) on delete set null,
  owner_user_id uuid references auth.users(id) on delete cascade,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  event_type text not null,
  message text,
  observed_value jsonb not null default '{}'::jsonb,
  trace_id text,
  created_at timestamptz not null default now()
);

create index if not exists wxmp_provider_health_events_provider_idx
  on public.wxmp_provider_health_events (provider_node_id, created_at desc);

create table if not exists public.wxmp_gateway_alerts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  provider_node_id uuid references public.wxmp_provider_nodes(id) on delete set null,
  alert_key text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  message text not null,
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wxmp_gateway_alerts_open_key_idx
  on public.wxmp_gateway_alerts (owner_user_id, alert_key)
  where status <> 'resolved';

alter table public.wxmp_provider_nodes
  add column if not exists current_hour_started_at timestamptz not null default date_trunc('hour', now());

alter table public.wxmp_gateway_requests
  add column if not exists result_payload jsonb not null default '{}'::jsonb;

insert into public.wxmp_quota_settings (id)
values ('default')
on conflict (id) do nothing;

create or replace function public.set_wxmp_license_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_wxmp_license_updated_at on public.wxmp_licenses;
create trigger set_wxmp_license_updated_at
before update on public.wxmp_licenses
for each row
execute function public.set_wxmp_license_updated_at();

drop trigger if exists set_wxmp_quota_settings_updated_at on public.wxmp_quota_settings;
create trigger set_wxmp_quota_settings_updated_at
before update on public.wxmp_quota_settings
for each row
execute function public.set_wxmp_license_updated_at();

drop trigger if exists set_wxmp_user_capabilities_updated_at on public.wxmp_user_capabilities;
create trigger set_wxmp_user_capabilities_updated_at
before update on public.wxmp_user_capabilities
for each row
execute function public.set_wxmp_license_updated_at();

drop trigger if exists set_wxmp_provider_nodes_updated_at on public.wxmp_provider_nodes;
create trigger set_wxmp_provider_nodes_updated_at
before update on public.wxmp_provider_nodes
for each row
execute function public.set_wxmp_license_updated_at();

drop trigger if exists set_wxmp_gateway_requests_updated_at on public.wxmp_gateway_requests;
create trigger set_wxmp_gateway_requests_updated_at
before update on public.wxmp_gateway_requests
for each row
execute function public.set_wxmp_license_updated_at();

drop trigger if exists set_wxmp_provider_leases_updated_at on public.wxmp_provider_leases;
create trigger set_wxmp_provider_leases_updated_at
before update on public.wxmp_provider_leases
for each row
execute function public.set_wxmp_license_updated_at();

drop trigger if exists set_wxmp_gateway_alerts_updated_at on public.wxmp_gateway_alerts;
create trigger set_wxmp_gateway_alerts_updated_at
before update on public.wxmp_gateway_alerts
for each row
execute function public.set_wxmp_license_updated_at();

create or replace function public.sync_wxmp_provider_node_from_capability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  capability_factor integer;
  active_capability boolean;
  self_units integer;
  commercial_units integer;
begin
  select coalesce(own_capability_factor, 50)
    into capability_factor
  from public.wxmp_quota_settings
  where id = 'default';

  capability_factor := coalesce(capability_factor, 50);
  active_capability := new.status = 'active';
  self_units := case when active_capability then new.capability_units else 0 end;
  commercial_units := case
    when active_capability and new.provides_to_others then greatest(new.capability_units, 1)
    else 0
  end;

  insert into public.wxmp_provider_nodes (
    owner_user_id,
    capability_user_id,
    mp_username,
    mp_nickname,
    mp_alias,
    service_type,
    self_use_enabled,
    commercial_enabled,
    commercial_terms_accepted_at,
    self_capability_units,
    commercial_capability_units,
    current_hour_capacity,
    status,
    last_seen_at
  )
  values (
    new.user_id,
    new.user_id,
    new.mp_username,
    new.mp_nickname,
    new.mp_alias,
    new.service_type,
    self_units > 0,
    commercial_units > 0,
    new.commercial_terms_accepted_at,
    self_units,
    commercial_units,
    greatest(self_units, commercial_units) * capability_factor,
    case when active_capability and greatest(self_units, commercial_units) > 0 then 'online' else 'paused' end,
    now()
  )
  on conflict (owner_user_id) do update set
    capability_user_id = excluded.capability_user_id,
    mp_username = excluded.mp_username,
    mp_nickname = excluded.mp_nickname,
    mp_alias = excluded.mp_alias,
    service_type = excluded.service_type,
    self_use_enabled = excluded.self_use_enabled,
    commercial_enabled = excluded.commercial_enabled,
    commercial_terms_accepted_at = excluded.commercial_terms_accepted_at,
    self_capability_units = excluded.self_capability_units,
    commercial_capability_units = excluded.commercial_capability_units,
    current_hour_capacity = excluded.current_hour_capacity,
    status = excluded.status,
    last_seen_at = excluded.last_seen_at,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists sync_wxmp_provider_node_from_capability on public.wxmp_user_capabilities;
create trigger sync_wxmp_provider_node_from_capability
after insert or update on public.wxmp_user_capabilities
for each row
execute function public.sync_wxmp_provider_node_from_capability();

create or replace function public.refresh_wxmp_provider_node_capacity_from_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.wxmp_provider_nodes
  set
    current_hour_capacity = greatest(self_capability_units, commercial_capability_units) * new.own_capability_factor,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists refresh_wxmp_provider_node_capacity_from_settings on public.wxmp_quota_settings;
create trigger refresh_wxmp_provider_node_capacity_from_settings
after update of own_capability_factor on public.wxmp_quota_settings
for each row
execute function public.refresh_wxmp_provider_node_capacity_from_settings();

insert into public.wxmp_provider_nodes (
  owner_user_id,
  capability_user_id,
  mp_username,
  mp_nickname,
  mp_alias,
  service_type,
  self_use_enabled,
  commercial_enabled,
  commercial_terms_accepted_at,
  self_capability_units,
  commercial_capability_units,
  current_hour_capacity,
  status,
  last_seen_at
)
select
  capability.user_id,
  capability.user_id,
  capability.mp_username,
  capability.mp_nickname,
  capability.mp_alias,
  capability.service_type,
  capability.status = 'active' and capability.capability_units > 0,
  capability.status = 'active' and capability.provides_to_others,
  capability.commercial_terms_accepted_at,
  case when capability.status = 'active' then capability.capability_units else 0 end,
  case
    when capability.status = 'active' and capability.provides_to_others then greatest(capability.capability_units, 1)
    else 0
  end,
  greatest(
    case when capability.status = 'active' then capability.capability_units else 0 end,
    case
      when capability.status = 'active' and capability.provides_to_others then greatest(capability.capability_units, 1)
      else 0
    end
  ) * coalesce(settings.own_capability_factor, 50),
  case
    when capability.status = 'active'
      and greatest(
        capability.capability_units,
        case when capability.provides_to_others then 1 else 0 end
      ) > 0
    then 'online'
    else 'paused'
  end,
  now()
from public.wxmp_user_capabilities capability
cross join (
  select coalesce(
    (select own_capability_factor from public.wxmp_quota_settings where id = 'default'),
    50
  )::integer as own_capability_factor
) settings
on conflict (owner_user_id) do update set
  capability_user_id = excluded.capability_user_id,
  mp_username = excluded.mp_username,
  mp_nickname = excluded.mp_nickname,
  mp_alias = excluded.mp_alias,
  service_type = excluded.service_type,
  self_use_enabled = excluded.self_use_enabled,
  commercial_enabled = excluded.commercial_enabled,
  commercial_terms_accepted_at = excluded.commercial_terms_accepted_at,
  self_capability_units = excluded.self_capability_units,
  commercial_capability_units = excluded.commercial_capability_units,
  current_hour_capacity = excluded.current_hour_capacity,
  status = excluded.status,
  last_seen_at = excluded.last_seen_at,
  updated_at = now();

alter table public.wxmp_licenses enable row level security;
alter table public.wxmp_quota_settings enable row level security;
alter table public.wxmp_user_capabilities enable row level security;
alter table public.wxmp_provider_nodes enable row level security;
alter table public.wxmp_gateway_requests enable row level security;
alter table public.wxmp_provider_leases enable row level security;
alter table public.wxmp_provider_health_events enable row level security;
alter table public.wxmp_gateway_alerts enable row level security;

drop policy if exists "wxmp license admins select" on public.wxmp_licenses;
create policy "wxmp license admins select"
on public.wxmp_licenses
for select
to authenticated
using (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp license admins insert" on public.wxmp_licenses;
create policy "wxmp license admins insert"
on public.wxmp_licenses
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp license admins update" on public.wxmp_licenses;
create policy "wxmp license admins update"
on public.wxmp_licenses
for update
to authenticated
using (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp quota settings admins select" on public.wxmp_quota_settings;
create policy "wxmp quota settings admins select"
on public.wxmp_quota_settings
for select
to authenticated
using (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp quota settings admins insert" on public.wxmp_quota_settings;
create policy "wxmp quota settings admins insert"
on public.wxmp_quota_settings
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp quota settings admins update" on public.wxmp_quota_settings;
create policy "wxmp quota settings admins update"
on public.wxmp_quota_settings
for update
to authenticated
using (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp user capabilities own select" on public.wxmp_user_capabilities;
create policy "wxmp user capabilities own select"
on public.wxmp_user_capabilities
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp user capabilities own insert" on public.wxmp_user_capabilities;
create policy "wxmp user capabilities own insert"
on public.wxmp_user_capabilities
for insert
to authenticated
with check (
  user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp user capabilities own update" on public.wxmp_user_capabilities;
create policy "wxmp user capabilities own update"
on public.wxmp_user_capabilities
for update
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider nodes own select" on public.wxmp_provider_nodes;
create policy "wxmp provider nodes own select"
on public.wxmp_provider_nodes
for select
to authenticated
using (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider nodes own insert" on public.wxmp_provider_nodes;
create policy "wxmp provider nodes own insert"
on public.wxmp_provider_nodes
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider nodes own update" on public.wxmp_provider_nodes;
create policy "wxmp provider nodes own update"
on public.wxmp_provider_nodes
for update
to authenticated
using (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp gateway requests scoped select" on public.wxmp_gateway_requests;
create policy "wxmp gateway requests scoped select"
on public.wxmp_gateway_requests
for select
to authenticated
using (
  requester_user_id = auth.uid()
  or assigned_owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp gateway requests own insert" on public.wxmp_gateway_requests;
create policy "wxmp gateway requests own insert"
on public.wxmp_gateway_requests
for insert
to authenticated
with check (
  requester_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp gateway requests scoped update" on public.wxmp_gateway_requests;
create policy "wxmp gateway requests scoped update"
on public.wxmp_gateway_requests
for update
to authenticated
using (
  requester_user_id = auth.uid()
  or assigned_owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  requester_user_id = auth.uid()
  or assigned_owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider leases scoped select" on public.wxmp_provider_leases;
create policy "wxmp provider leases scoped select"
on public.wxmp_provider_leases
for select
to authenticated
using (
  exists (
    select 1
    from public.wxmp_provider_nodes node
    where node.id = wxmp_provider_leases.provider_node_id
      and node.owner_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.wxmp_gateway_requests request
    where request.id = wxmp_provider_leases.gateway_request_id
      and request.requester_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider leases admins insert" on public.wxmp_provider_leases;
create policy "wxmp provider leases admins insert"
on public.wxmp_provider_leases
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider leases admins update" on public.wxmp_provider_leases;
create policy "wxmp provider leases admins update"
on public.wxmp_provider_leases
for update
to authenticated
using (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider health events scoped select" on public.wxmp_provider_health_events;
create policy "wxmp provider health events scoped select"
on public.wxmp_provider_health_events
for select
to authenticated
using (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp provider health events scoped insert" on public.wxmp_provider_health_events;
create policy "wxmp provider health events scoped insert"
on public.wxmp_provider_health_events
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp gateway alerts scoped select" on public.wxmp_gateway_alerts;
create policy "wxmp gateway alerts scoped select"
on public.wxmp_gateway_alerts
for select
to authenticated
using (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp gateway alerts scoped insert" on public.wxmp_gateway_alerts;
create policy "wxmp gateway alerts scoped insert"
on public.wxmp_gateway_alerts
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

drop policy if exists "wxmp gateway alerts scoped update" on public.wxmp_gateway_alerts;
create policy "wxmp gateway alerts scoped update"
on public.wxmp_gateway_alerts
for update
to authenticated
using (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
)
with check (
  owner_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles
    where user_roles.user_id = auth.uid()
      and user_roles.role = 'admin'
  )
);

create or replace function public.get_wxmp_license(_account_id text)
returns table (
  id uuid,
  account_id text,
  kind public.license_kind,
  quota_level integer,
  expires_at timestamptz,
  expires_at_epoch bigint,
  customer text,
  status public.license_status,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    wxmp_licenses.id,
    wxmp_licenses.account_id,
    wxmp_licenses.kind,
    wxmp_licenses.quota_level,
    wxmp_licenses.expires_at,
    extract(epoch from wxmp_licenses.expires_at)::bigint as expires_at_epoch,
    wxmp_licenses.customer,
    wxmp_licenses.status,
    wxmp_licenses.updated_at
  from public.wxmp_licenses
  where wxmp_licenses.account_id = btrim(_account_id)
    and wxmp_licenses.status = 'active'
    and wxmp_licenses.expires_at > now()
  order by
    case wxmp_licenses.kind when 'official' then 1 else 0 end desc,
    wxmp_licenses.expires_at desc
  limit 1;
$$;

create or replace function public.get_wxmp_quota_entitlement(_account_id uuid)
returns table (
  account_id text,
  account_level integer,
  account_level_factor integer,
  own_capability_units integer,
  own_capability_factor integer,
  provides_to_others boolean,
  commercial_terms_accepted_at timestamptz,
  hourly_quota integer
)
language sql
security definer
set search_path = public
as $$
  with authorized as (
    select _account_id as user_id
    where _account_id = auth.uid()
      or exists (
        select 1
        from public.user_roles
        where user_roles.user_id = auth.uid()
          and user_roles.role = 'admin'
      )
  ),
  settings as (
    select
      coalesce(
        (select account_level_factor from public.wxmp_quota_settings where id = 'default'),
        50
      )::integer as account_level_factor,
      coalesce(
        (select own_capability_factor from public.wxmp_quota_settings where id = 'default'),
        50
      )::integer as own_capability_factor,
      coalesce(
        (select default_account_level from public.wxmp_quota_settings where id = 'default'),
        1
      )::integer as default_account_level
  ),
  active_license as (
    select wxmp_licenses.quota_level
    from public.wxmp_licenses
    join authorized on wxmp_licenses.account_id = authorized.user_id::text
    where wxmp_licenses.status = 'active'
      and wxmp_licenses.expires_at > now()
    order by
      wxmp_licenses.quota_level desc,
      case wxmp_licenses.kind when 'official' then 1 else 0 end desc,
      wxmp_licenses.expires_at desc
    limit 1
  )
  select
    authorized.user_id::text as account_id,
    coalesce(active_license.quota_level, settings.default_account_level)::integer as account_level,
    settings.account_level_factor,
    case
      when capability.user_id is null then 0
      else capability.capability_units
    end::integer as own_capability_units,
    settings.own_capability_factor,
    coalesce(capability.provides_to_others, false) as provides_to_others,
    capability.commercial_terms_accepted_at,
    (
      coalesce(active_license.quota_level, settings.default_account_level)
      * settings.account_level_factor
      + coalesce(capability.capability_units, 0)
      * settings.own_capability_factor
    )::integer as hourly_quota
  from authorized
  cross join settings
  left join active_license on true
  left join public.wxmp_user_capabilities capability
    on capability.user_id = authorized.user_id
   and capability.status = 'active';
$$;

create or replace function public.enqueue_wxmp_gateway_request(
  _request_kind text,
  _endpoint text,
  _target_fakeid text default null,
  _payload jsonb default '{}'::jsonb,
  _quota_cost integer default 1,
  _priority integer default 100,
  _idempotency_key text default null
)
returns table (
  request_id uuid,
  request_status text,
  request_kind text,
  endpoint text,
  target_fakeid text,
  enqueued_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_request public.wxmp_gateway_requests%rowtype;
  normalized_kind text := btrim(coalesce(_request_kind, ''));
  normalized_endpoint text := nullif(btrim(coalesce(_endpoint, '')), '');
  normalized_idempotency_key text := nullif(btrim(coalesce(_idempotency_key, '')), '');
begin
  if auth.uid() is null then
    raise exception '请先登录 Lovstudio 账号。' using errcode = '28000';
  end if;

  if normalized_kind not in ('self', 'commercial') then
    raise exception '网关请求类型必须是 self 或 commercial。';
  end if;

  if normalized_endpoint is null then
    raise exception '缺少网关执行端点。';
  end if;

  if coalesce(_quota_cost, 1) < 1 then
    raise exception '网关请求额度成本必须大于 0。';
  end if;

  if normalized_idempotency_key is null then
    insert into public.wxmp_gateway_requests (
      requester_user_id,
      request_kind,
      endpoint,
      target_fakeid,
      payload,
      quota_cost,
      priority
    )
    values (
      auth.uid(),
      normalized_kind,
      normalized_endpoint,
      nullif(btrim(coalesce(_target_fakeid, '')), ''),
      coalesce(_payload, '{}'::jsonb),
      coalesce(_quota_cost, 1),
      coalesce(_priority, 100)
    )
    returning * into inserted_request;
  else
    insert into public.wxmp_gateway_requests (
      requester_user_id,
      request_kind,
      endpoint,
      target_fakeid,
      idempotency_key,
      payload,
      quota_cost,
      priority
    )
    values (
      auth.uid(),
      normalized_kind,
      normalized_endpoint,
      nullif(btrim(coalesce(_target_fakeid, '')), ''),
      normalized_idempotency_key,
      coalesce(_payload, '{}'::jsonb),
      coalesce(_quota_cost, 1),
      coalesce(_priority, 100)
    )
    on conflict (requester_user_id, idempotency_key)
      where idempotency_key is not null
    do update set
      request_kind = excluded.request_kind,
      endpoint = excluded.endpoint,
      target_fakeid = excluded.target_fakeid,
      payload = excluded.payload,
      quota_cost = excluded.quota_cost,
      priority = excluded.priority,
      updated_at = now()
    returning * into inserted_request;
  end if;

  request_id := inserted_request.id;
  request_status := inserted_request.status;
  request_kind := inserted_request.request_kind;
  endpoint := inserted_request.endpoint;
  target_fakeid := inserted_request.target_fakeid;
  enqueued_at := inserted_request.enqueued_at;
  return next;
end;
$$;

create or replace function public.heartbeat_wxmp_provider_node()
returns table (
  provider_node_id uuid,
  provider_status text,
  provider_health_score integer,
  remaining_capacity integer,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  node_record public.wxmp_provider_nodes%rowtype;
  hour_start timestamptz := date_trunc('hour', now());
begin
  if auth.uid() is null then
    raise exception '请先登录 Lovstudio 账号。' using errcode = '28000';
  end if;

  update public.wxmp_provider_nodes node
  set
    current_hour_used = case
      when node.current_hour_started_at < hour_start then 0
      else node.current_hour_used
    end,
    current_hour_started_at = case
      when node.current_hour_started_at < hour_start then hour_start
      else node.current_hour_started_at
    end,
    status = case
      when node.status = 'revoked' then 'revoked'
      when node.cooldown_until is not null and node.cooldown_until > now() then 'cooldown'
      when greatest(node.self_capability_units, node.commercial_capability_units) <= 0 then 'paused'
      when node.health_score < 80 then 'degraded'
      else 'online'
    end,
    last_seen_at = now(),
    updated_at = now()
  where node.owner_user_id = auth.uid()
  returning * into node_record;

  if not found then
    return;
  end if;

  provider_node_id := node_record.id;
  provider_status := node_record.status;
  provider_health_score := node_record.health_score;
  remaining_capacity := greatest(node_record.current_hour_capacity - node_record.current_hour_used, 0);
  last_seen_at := node_record.last_seen_at;
  return next;
end;
$$;

create or replace function public.claim_wxmp_gateway_request(
  _provider_node_id uuid default null,
  _lease_seconds integer default 300
)
returns table (
  request_id uuid,
  lease_id uuid,
  request_kind text,
  endpoint text,
  target_fakeid text,
  payload jsonb,
  quota_cost integer,
  requester_user_id uuid,
  assigned_provider_node_id uuid,
  trace_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  node_record public.wxmp_provider_nodes%rowtype;
  request_record public.wxmp_gateway_requests%rowtype;
  new_lease_id uuid;
  remaining integer;
  hour_start timestamptz := date_trunc('hour', now());
begin
  if auth.uid() is null then
    raise exception '请先登录 Lovstudio 账号。' using errcode = '28000';
  end if;

  update public.wxmp_provider_nodes node
  set
    current_hour_used = case
      when node.current_hour_started_at < hour_start then 0
      else node.current_hour_used
    end,
    current_hour_started_at = case
      when node.current_hour_started_at < hour_start then hour_start
      else node.current_hour_started_at
    end,
    status = case
      when node.status = 'revoked' then 'revoked'
      when node.cooldown_until is not null and node.cooldown_until > now() then 'cooldown'
      when greatest(node.self_capability_units, node.commercial_capability_units) <= 0 then 'paused'
      when node.health_score < 80 then 'degraded'
      else 'online'
    end,
    last_seen_at = now(),
    updated_at = now()
  where node.owner_user_id = auth.uid()
    and (_provider_node_id is null or node.id = _provider_node_id)
  returning * into node_record;

  if not found then
    return;
  end if;

  if node_record.status not in ('online', 'degraded') then
    return;
  end if;

  remaining := greatest(node_record.current_hour_capacity - node_record.current_hour_used, 0);
  if remaining <= 0 then
    return;
  end if;

  select request.*
    into request_record
  from public.wxmp_gateway_requests request
  where request.status = 'queued'
    and request.quota_cost <= remaining
    and (
      (
        request.request_kind = 'self'
        and request.requester_user_id = node_record.owner_user_id
        and node_record.self_use_enabled = true
      )
      or (
        request.request_kind = 'commercial'
        and node_record.commercial_enabled = true
      )
    )
  order by
    case when request.request_kind = 'self' then 0 else 1 end,
    request.priority asc,
    request.enqueued_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.wxmp_provider_nodes node
  set
    current_hour_used = node.current_hour_used + request_record.quota_cost,
    last_seen_at = now(),
    updated_at = now()
  where node.id = node_record.id;

  insert into public.wxmp_provider_leases (
    provider_node_id,
    gateway_request_id,
    lease_kind,
    quota_units,
    leased_by,
    expires_at
  )
  values (
    node_record.id,
    request_record.id,
    request_record.request_kind,
    request_record.quota_cost,
    auth.uid(),
    now() + make_interval(secs => greatest(coalesce(_lease_seconds, 300), 30))
  )
  returning id into new_lease_id;

  update public.wxmp_gateway_requests request
  set
    status = 'running',
    assigned_provider_node_id = node_record.id,
    assigned_owner_user_id = node_record.owner_user_id,
    started_at = now(),
    attempt_count = request.attempt_count + 1,
    trace_id = coalesce(request.trace_id, gen_random_uuid()::text),
    updated_at = now()
  where request.id = request_record.id
  returning * into request_record;

  request_id := request_record.id;
  lease_id := new_lease_id;
  request_kind := request_record.request_kind;
  endpoint := request_record.endpoint;
  target_fakeid := request_record.target_fakeid;
  payload := request_record.payload;
  quota_cost := request_record.quota_cost;
  requester_user_id := request_record.requester_user_id;
  assigned_provider_node_id := request_record.assigned_provider_node_id;
  trace_id := request_record.trace_id;
  return next;
end;
$$;

create or replace function public.complete_wxmp_gateway_request(
  _request_id uuid,
  _lease_id uuid,
  _status text,
  _result_payload jsonb default '{}'::jsonb,
  _error_code text default null,
  _error_message text default null,
  _latency_ms integer default null
)
returns table (
  request_id uuid,
  request_status text,
  provider_node_id uuid,
  provider_status text,
  provider_health_score integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  request_record public.wxmp_gateway_requests%rowtype;
  lease_record public.wxmp_provider_leases%rowtype;
  node_record public.wxmp_provider_nodes%rowtype;
  final_status text := btrim(coalesce(_status, ''));
  final_error_code text := nullif(btrim(coalesce(_error_code, '')), '');
  final_error_message text := nullif(btrim(coalesce(_error_message, '')), '');
  severe_failure boolean;
begin
  if auth.uid() is null then
    raise exception '请先登录 Lovstudio 账号。' using errcode = '28000';
  end if;

  if final_status not in ('succeeded', 'failed', 'cancelled', 'expired') then
    raise exception '网关完成状态必须是 succeeded、failed、cancelled 或 expired。';
  end if;

  select *
    into lease_record
  from public.wxmp_provider_leases lease
  where lease.id = _lease_id
    and lease.gateway_request_id = _request_id
    and lease.leased_by = auth.uid()
    and lease.status = 'active'
  for update;

  if not found then
    raise exception '网关租约不存在或已结束。';
  end if;

  select *
    into request_record
  from public.wxmp_gateway_requests request
  where request.id = _request_id
    and request.assigned_owner_user_id = auth.uid()
    and request.assigned_provider_node_id = lease_record.provider_node_id
    and request.status = 'running'
  for update;

  if not found then
    raise exception '网关请求不存在或不可由当前节点完成。';
  end if;

  update public.wxmp_gateway_requests request
  set
    status = final_status,
    result_payload = coalesce(_result_payload, '{}'::jsonb),
    error_code = final_error_code,
    error_message = final_error_message,
    latency_ms = case
      when _latency_ms is null then null
      else greatest(_latency_ms, 0)
    end,
    finished_at = now(),
    updated_at = now()
  where request.id = request_record.id
  returning * into request_record;

  update public.wxmp_provider_leases lease
  set
    status = case
      when final_status in ('succeeded', 'failed') then 'consumed'
      else 'released'
    end,
    consumed_at = case
      when final_status in ('succeeded', 'failed') then now()
      else lease.consumed_at
    end,
    updated_at = now()
  where lease.id = lease_record.id;

  severe_failure := final_status = 'failed'
    and (
      final_error_code in ('rate_limited', 'auth_error')
      or coalesce(final_error_message, '') ilike '%触发风控%'
      or coalesce(final_error_message, '') ilike '%认证失败%'
      or coalesce(final_error_message, '') ilike '%尚未登录%'
    );

  update public.wxmp_provider_nodes node
  set
    health_score = case
      when final_status = 'succeeded' then least(node.health_score + 2, 100)
      when final_status = 'failed' then greatest(node.health_score - case when severe_failure then 30 else 12 end, 0)
      else node.health_score
    end,
    status = case
      when node.status = 'revoked' then 'revoked'
      when final_status = 'succeeded' and node.cooldown_until is not null and node.cooldown_until > now() then 'cooldown'
      when final_status = 'succeeded' and node.health_score >= 78 then 'online'
      when final_status = 'failed' and severe_failure then 'cooldown'
      when final_status = 'failed' then 'degraded'
      else node.status
    end,
    cooldown_until = case
      when final_status = 'failed' and severe_failure then now() + interval '15 minutes'
      when final_status = 'succeeded' and (node.cooldown_until is null or node.cooldown_until <= now()) then null
      else node.cooldown_until
    end,
    last_seen_at = now(),
    updated_at = now()
  where node.id = lease_record.provider_node_id
  returning * into node_record;

  insert into public.wxmp_provider_health_events (
    provider_node_id,
    owner_user_id,
    severity,
    event_type,
    message,
    observed_value,
    trace_id
  )
  values (
    lease_record.provider_node_id,
    auth.uid(),
    case
      when final_status = 'succeeded' then 'info'
      when severe_failure then 'critical'
      else 'warning'
    end,
    case
      when final_status = 'succeeded' then 'gateway_succeeded'
      when final_status = 'failed' then 'gateway_failed'
      else 'gateway_released'
    end,
    final_error_message,
    jsonb_build_object(
      'request_id', request_record.id,
      'request_kind', request_record.request_kind,
      'endpoint', request_record.endpoint,
      'latency_ms', _latency_ms,
      'error_code', final_error_code
    ),
    request_record.trace_id
  );

  if severe_failure then
    insert into public.wxmp_gateway_alerts (
      owner_user_id,
      provider_node_id,
      alert_key,
      severity,
      status,
      message
    )
    values (
      auth.uid(),
      lease_record.provider_node_id,
      'provider:' || lease_record.provider_node_id::text || ':' || coalesce(final_error_code, 'failed'),
      'critical',
      'open',
      coalesce(final_error_message, '公众号节点执行失败，已进入冷却。')
    )
    on conflict (owner_user_id, alert_key)
      where status <> 'resolved'
    do update set
      severity = excluded.severity,
      status = 'open',
      message = excluded.message,
      opened_at = now(),
      acknowledged_at = null,
      updated_at = now();
  end if;

  request_id := request_record.id;
  request_status := request_record.status;
  provider_node_id := node_record.id;
  provider_status := node_record.status;
  provider_health_score := node_record.health_score;
  return next;
end;
$$;

create or replace function public.start_wxmp_provider_execution(
  _endpoint text,
  _target_fakeid text default null,
  _payload jsonb default '{}'::jsonb,
  _quota_cost integer default 1,
  _priority integer default 100
)
returns table (
  request_id uuid,
  lease_id uuid,
  provider_node_id uuid,
  request_status text,
  trace_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  node_record public.wxmp_provider_nodes%rowtype;
  request_record public.wxmp_gateway_requests%rowtype;
  new_lease_id uuid;
  normalized_endpoint text := nullif(btrim(coalesce(_endpoint, '')), '');
  cost integer := greatest(coalesce(_quota_cost, 1), 1);
  hour_start timestamptz := date_trunc('hour', now());
begin
  if auth.uid() is null then
    raise exception '请先登录 Lovstudio 账号。' using errcode = '28000';
  end if;

  if normalized_endpoint is null then
    raise exception '缺少 provider 执行端点。';
  end if;

  update public.wxmp_provider_nodes node
  set
    current_hour_started_at = case
      when node.current_hour_started_at < hour_start then hour_start
      else node.current_hour_started_at
    end,
    current_hour_used = case
      when node.current_hour_started_at < hour_start then 0
      else node.current_hour_used
    end,
    status = case
      when node.status = 'revoked' then 'revoked'
      when node.cooldown_until is not null and node.cooldown_until > now() then 'cooldown'
      when greatest(node.self_capability_units, node.commercial_capability_units) <= 0 then 'paused'
      when node.health_score < 80 then 'degraded'
      else 'online'
    end,
    last_seen_at = now(),
    updated_at = now()
  where node.owner_user_id = auth.uid()
  returning * into node_record;

  if not found then
    return;
  end if;

  if node_record.status not in ('online', 'degraded')
    or node_record.self_use_enabled is not true
    or node_record.current_hour_capacity - node_record.current_hour_used < cost then
    return;
  end if;

  insert into public.wxmp_gateway_requests (
    requester_user_id,
    request_kind,
    endpoint,
    target_fakeid,
    payload,
    status,
    assigned_provider_node_id,
    assigned_owner_user_id,
    quota_cost,
    priority,
    attempt_count,
    trace_id,
    started_at
  )
  values (
    auth.uid(),
    'self',
    normalized_endpoint,
    nullif(btrim(coalesce(_target_fakeid, '')), ''),
    coalesce(_payload, '{}'::jsonb),
    'running',
    node_record.id,
    auth.uid(),
    cost,
    coalesce(_priority, 100),
    1,
    gen_random_uuid()::text,
    now()
  )
  returning * into request_record;

  update public.wxmp_provider_nodes node
  set
    current_hour_used = node.current_hour_used + cost,
    last_seen_at = now(),
    updated_at = now()
  where node.id = node_record.id
  returning * into node_record;

  insert into public.wxmp_provider_leases (
    provider_node_id,
    gateway_request_id,
    lease_kind,
    quota_units,
    leased_by,
    expires_at
  )
  values (
    node_record.id,
    request_record.id,
    'self',
    cost,
    auth.uid(),
    now() + interval '5 minutes'
  )
  returning id into new_lease_id;

  request_id := request_record.id;
  lease_id := new_lease_id;
  provider_node_id := node_record.id;
  request_status := request_record.status;
  trace_id := request_record.trace_id;
  return next;
end;
$$;

create or replace function public.report_wxmp_provider_execution(
  _endpoint text,
  _status text,
  _quota_cost integer default 1,
  _error_code text default null,
  _error_message text default null,
  _latency_ms integer default null,
  _observed_value jsonb default '{}'::jsonb
)
returns table (
  provider_node_id uuid,
  provider_status text,
  provider_health_score integer,
  current_hour_used integer,
  remaining_capacity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  node_record public.wxmp_provider_nodes%rowtype;
  final_status text := btrim(coalesce(_status, ''));
  normalized_endpoint text := nullif(btrim(coalesce(_endpoint, '')), '');
  cost integer := greatest(coalesce(_quota_cost, 1), 1);
  final_error_code text := nullif(btrim(coalesce(_error_code, '')), '');
  final_error_message text := nullif(btrim(coalesce(_error_message, '')), '');
  severe_failure boolean;
  hour_start timestamptz := date_trunc('hour', now());
begin
  if auth.uid() is null then
    raise exception '请先登录 Lovstudio 账号。' using errcode = '28000';
  end if;

  if normalized_endpoint is null then
    raise exception '缺少 provider 执行端点。';
  end if;

  if final_status not in ('succeeded', 'failed') then
    raise exception 'provider 执行状态必须是 succeeded 或 failed。';
  end if;

  severe_failure := final_status = 'failed'
    and (
      final_error_code in ('rate_limited', 'auth_error')
      or coalesce(final_error_message, '') ilike '%触发风控%'
      or coalesce(final_error_message, '') ilike '%认证失败%'
      or coalesce(final_error_message, '') ilike '%尚未登录%'
    );

  update public.wxmp_provider_nodes node
  set
    current_hour_started_at = case
      when node.current_hour_started_at < hour_start then hour_start
      else node.current_hour_started_at
    end,
    current_hour_used = case
      when node.current_hour_started_at < hour_start then cost
      else node.current_hour_used + cost
    end,
    health_score = case
      when final_status = 'succeeded' then least(node.health_score + 1, 100)
      else greatest(node.health_score - case when severe_failure then 30 else 8 end, 0)
    end,
    status = case
      when node.status = 'revoked' then 'revoked'
      when final_status = 'failed' and severe_failure then 'cooldown'
      when final_status = 'failed' then 'degraded'
      when node.health_score < 80 then 'degraded'
      when greatest(node.self_capability_units, node.commercial_capability_units) <= 0 then 'paused'
      else 'online'
    end,
    cooldown_until = case
      when final_status = 'failed' and severe_failure then now() + interval '15 minutes'
      when final_status = 'succeeded' and (node.cooldown_until is null or node.cooldown_until <= now()) then null
      else node.cooldown_until
    end,
    last_seen_at = now(),
    updated_at = now()
  where node.owner_user_id = auth.uid()
  returning * into node_record;

  if not found then
    return;
  end if;

  insert into public.wxmp_provider_health_events (
    provider_node_id,
    owner_user_id,
    severity,
    event_type,
    message,
    observed_value,
    trace_id
  )
  values (
    node_record.id,
    auth.uid(),
    case
      when final_status = 'succeeded' then 'info'
      when severe_failure then 'critical'
      else 'warning'
    end,
    case
      when final_status = 'succeeded' then 'local_execution_succeeded'
      else 'local_execution_failed'
    end,
    final_error_message,
    coalesce(_observed_value, '{}'::jsonb) || jsonb_build_object(
      'endpoint', normalized_endpoint,
      'quota_cost', cost,
      'latency_ms', _latency_ms,
      'error_code', final_error_code
    ),
    gen_random_uuid()::text
  );

  if severe_failure then
    insert into public.wxmp_gateway_alerts (
      owner_user_id,
      provider_node_id,
      alert_key,
      severity,
      status,
      message
    )
    values (
      auth.uid(),
      node_record.id,
      'provider:' || node_record.id::text || ':' || coalesce(final_error_code, 'local_failed'),
      'critical',
      'open',
      coalesce(final_error_message, '本机公众号执行失败，已进入冷却。')
    )
    on conflict (owner_user_id, alert_key)
      where status <> 'resolved'
    do update set
      severity = excluded.severity,
      status = 'open',
      message = excluded.message,
      opened_at = now(),
      acknowledged_at = null,
      updated_at = now();
  end if;

  provider_node_id := node_record.id;
  provider_status := node_record.status;
  provider_health_score := node_record.health_score;
  current_hour_used := node_record.current_hour_used;
  remaining_capacity := greatest(node_record.current_hour_capacity - node_record.current_hour_used, 0);
  return next;
end;
$$;

drop function if exists public.get_wxmp_gateway_overview(uuid);

create or replace function public.get_wxmp_gateway_overview(_account_id uuid)
returns table (
  account_id text,
  provider_node_id uuid,
  provider_status text,
  provider_health_score integer,
  self_use_enabled boolean,
  commercial_enabled boolean,
  self_capability_units integer,
  self_hourly_quota integer,
  self_remaining_capacity integer,
  commercial_capability_units integer,
  commercial_pool_nodes integer,
  commercial_pool_hourly_capacity integer,
  executable_pool_hourly_capacity integer,
  theoretical_hourly_quota integer,
  effective_hourly_quota integer,
  queued_requests integer,
  running_requests integer,
  open_alerts integer,
  last_health_event_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with authorized as (
    select _account_id as user_id
    where _account_id = auth.uid()
      or exists (
        select 1
        from public.user_roles
        where user_roles.user_id = auth.uid()
          and user_roles.role = 'admin'
      )
  ),
  settings as (
    select
      coalesce(
        (select account_level_factor from public.wxmp_quota_settings where id = 'default'),
        5
      )::integer as account_level_factor,
      coalesce(
        (select own_capability_factor from public.wxmp_quota_settings where id = 'default'),
        50
      )::integer as own_capability_factor,
      coalesce(
        (select default_account_level from public.wxmp_quota_settings where id = 'default'),
        0
      )::integer as default_account_level
  ),
  active_license as (
    select wxmp_licenses.quota_level
    from public.wxmp_licenses
    join authorized on wxmp_licenses.account_id = authorized.user_id::text
    where wxmp_licenses.status = 'active'
      and wxmp_licenses.expires_at > now()
    order by
      wxmp_licenses.quota_level desc,
      case wxmp_licenses.kind when 'official' then 1 else 0 end desc,
      wxmp_licenses.expires_at desc
    limit 1
  ),
  own_node as (
    select node.*
    from public.wxmp_provider_nodes node
    join authorized on node.owner_user_id = authorized.user_id
    limit 1
  ),
  own_capacity as (
    select
      case
        when own_node.id is null then 0
        when own_node.self_use_enabled is not true then 0
        when own_node.status not in ('online', 'degraded') then 0
        when own_node.cooldown_until is not null and own_node.cooldown_until > now() then 0
        when own_node.last_seen_at is null or own_node.last_seen_at < now() - interval '2 minutes' then 0
        when own_node.current_hour_started_at < date_trunc('hour', now()) then own_node.current_hour_capacity
        else greatest(own_node.current_hour_capacity - own_node.current_hour_used, 0)
      end::integer as remaining_capacity
    from own_node
  ),
  commercial_pool as (
    select
      count(*)::integer as node_count,
      coalesce(sum(
        case
          when node.current_hour_started_at < date_trunc('hour', now()) then node.current_hour_capacity
          else node.current_hour_capacity - node.current_hour_used
        end
      ), 0)::integer as hourly_capacity
    from public.wxmp_provider_nodes node
    cross join authorized
    where node.commercial_enabled = true
      and node.status in ('online', 'degraded')
      and (node.cooldown_until is null or node.cooldown_until <= now())
      and node.last_seen_at >= now() - interval '2 minutes'
      and node.owner_user_id <> authorized.user_id
      and (
        node.current_hour_started_at < date_trunc('hour', now())
        or node.current_hour_capacity > node.current_hour_used
      )
  ),
  request_stats as (
    select
      count(*) filter (where request.status in ('queued', 'leased'))::integer as queued_requests,
      count(*) filter (where request.status = 'running')::integer as running_requests
    from public.wxmp_gateway_requests request
    join authorized on request.requester_user_id = authorized.user_id
  ),
  alert_stats as (
    select count(*)::integer as open_alerts
    from public.wxmp_gateway_alerts alert
    join authorized on alert.owner_user_id = authorized.user_id
    where alert.status <> 'resolved'
  ),
  health_stats as (
    select max(event.created_at) as last_health_event_at
    from public.wxmp_provider_health_events event
    join authorized on event.owner_user_id = authorized.user_id
  ),
  quota_stats as (
    select
      (
        coalesce(active_license.quota_level, settings.default_account_level)
        * settings.account_level_factor
        + coalesce(own_node.self_capability_units, 0)
        * settings.own_capability_factor
      )::integer as theoretical_hourly_quota,
      (
        coalesce(own_capacity.remaining_capacity, 0)
        + greatest(commercial_pool.hourly_capacity, 0)
      )::integer as executable_pool_hourly_capacity
    from settings
    left join active_license on true
    left join own_node on true
    left join own_capacity on true
    cross join commercial_pool
  )
  select
    authorized.user_id::text as account_id,
    own_node.id as provider_node_id,
    case
      when own_node.id is null then 'offline'
      when own_node.status in ('online', 'degraded') and (
        own_node.last_seen_at is null
        or own_node.last_seen_at < now() - interval '2 minutes'
      ) then 'offline'
      else own_node.status
    end::text as provider_status,
    coalesce(own_node.health_score, 0)::integer as provider_health_score,
    coalesce(own_node.self_use_enabled, false) as self_use_enabled,
    coalesce(own_node.commercial_enabled, false) as commercial_enabled,
    coalesce(own_node.self_capability_units, 0)::integer as self_capability_units,
    (
      coalesce(own_node.self_capability_units, 0)
      * settings.own_capability_factor
    )::integer as self_hourly_quota,
    coalesce(own_capacity.remaining_capacity, 0)::integer as self_remaining_capacity,
    coalesce(own_node.commercial_capability_units, 0)::integer as commercial_capability_units,
    commercial_pool.node_count,
    greatest(commercial_pool.hourly_capacity, 0)::integer as commercial_pool_hourly_capacity,
    quota_stats.executable_pool_hourly_capacity,
    quota_stats.theoretical_hourly_quota,
    least(
      quota_stats.theoretical_hourly_quota,
      quota_stats.executable_pool_hourly_capacity
    )::integer as effective_hourly_quota,
    coalesce(request_stats.queued_requests, 0)::integer as queued_requests,
    coalesce(request_stats.running_requests, 0)::integer as running_requests,
    coalesce(alert_stats.open_alerts, 0)::integer as open_alerts,
    health_stats.last_health_event_at
  from authorized
  cross join settings
  left join own_node on true
  left join own_capacity on true
  cross join commercial_pool
  cross join quota_stats
  cross join request_stats
  cross join alert_stats
  cross join health_stats;
$$;

revoke all on function public.get_wxmp_license(text) from public;
grant execute on function public.get_wxmp_license(text) to anon, authenticated;
revoke all on function public.get_wxmp_quota_entitlement(uuid) from public;
grant execute on function public.get_wxmp_quota_entitlement(uuid) to authenticated;
revoke all on function public.enqueue_wxmp_gateway_request(text, text, text, jsonb, integer, integer, text) from public;
grant execute on function public.enqueue_wxmp_gateway_request(text, text, text, jsonb, integer, integer, text) to authenticated;
revoke all on function public.heartbeat_wxmp_provider_node() from public;
grant execute on function public.heartbeat_wxmp_provider_node() to authenticated;
revoke all on function public.claim_wxmp_gateway_request(uuid, integer) from public;
grant execute on function public.claim_wxmp_gateway_request(uuid, integer) to authenticated;
revoke all on function public.complete_wxmp_gateway_request(uuid, uuid, text, jsonb, text, text, integer) from public;
grant execute on function public.complete_wxmp_gateway_request(uuid, uuid, text, jsonb, text, text, integer) to authenticated;
revoke all on function public.start_wxmp_provider_execution(text, text, jsonb, integer, integer) from public;
grant execute on function public.start_wxmp_provider_execution(text, text, jsonb, integer, integer) to authenticated;
revoke all on function public.report_wxmp_provider_execution(text, text, integer, text, text, integer, jsonb) from public;
grant execute on function public.report_wxmp_provider_execution(text, text, integer, text, text, integer, jsonb) to authenticated;
revoke all on function public.get_wxmp_gateway_overview(uuid) from public;
grant execute on function public.get_wxmp_gateway_overview(uuid) to authenticated;

grant select, insert, update on public.wxmp_licenses to authenticated;
grant select, insert, update on public.wxmp_quota_settings to authenticated;
grant select, insert, update on public.wxmp_user_capabilities to authenticated;
grant select, insert, update on public.wxmp_provider_nodes to authenticated;
grant select, insert, update on public.wxmp_gateway_requests to authenticated;
grant select, insert, update on public.wxmp_provider_leases to authenticated;
grant select, insert on public.wxmp_provider_health_events to authenticated;
grant select, insert, update on public.wxmp_gateway_alerts to authenticated;
