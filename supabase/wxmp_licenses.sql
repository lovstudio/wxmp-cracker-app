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
  account_level_factor integer not null default 50 check (account_level_factor >= 0),
  own_capability_factor integer not null default 50 check (own_capability_factor >= 0),
  default_account_level integer not null default 1 check (default_account_level >= 0),
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

alter table public.wxmp_licenses enable row level security;
alter table public.wxmp_quota_settings enable row level security;
alter table public.wxmp_user_capabilities enable row level security;

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

revoke all on function public.get_wxmp_license(text) from public;
grant execute on function public.get_wxmp_license(text) to anon, authenticated;
revoke all on function public.get_wxmp_quota_entitlement(uuid) from public;
grant execute on function public.get_wxmp_quota_entitlement(uuid) to authenticated;

grant select, insert, update on public.wxmp_licenses to authenticated;
grant select, insert, update on public.wxmp_quota_settings to authenticated;
grant select, insert, update on public.wxmp_user_capabilities to authenticated;
