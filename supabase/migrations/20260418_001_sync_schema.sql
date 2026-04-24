-- Migration: full domain + sync schema
-- Keep in sync with supabase/schema.sql.

create extension if not exists pgcrypto;

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.institutions (
  id bigserial primary key,
  code text unique not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.departments (
  id bigserial primary key,
  institution_id bigint references public.institutions(id) on delete cascade,
  code text not null,
  name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, code)
);

create table if not exists public.users (
  id bigint primary key,
  username text unique not null,
  password_hash text not null,
  role text not null check (role in ('platform_admin', 'super_admin', 'department_admin', 'lecturer', 'student')),
  institution_id bigint references public.institutions(id),
  department_id bigint references public.departments(id),
  department text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new'
);

create table if not exists public.courses (
  id bigint primary key,
  code text not null,
  title text not null,
  lecturer_user_id bigint not null references public.users(id),
  department text,
  semester integer not null,
  status text not null check (status in ('active', 'ending', 'ended')) default 'active',
  end_announced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (code, lecturer_user_id)
);

create table if not exists public.enrollment_requests (
  id bigint primary key,
  course_id bigint not null references public.courses(id) on delete cascade,
  student_user_id bigint not null references public.users(id) on delete cascade,
  status text not null check (status in ('pending', 'approved', 'rejected')) default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (course_id, student_user_id)
);

create table if not exists public.course_members (
  id bigint primary key,
  course_id bigint not null references public.courses(id) on delete cascade,
  student_user_id bigint not null references public.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  removal_deadline_at timestamptz,
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (course_id, student_user_id)
);

create table if not exists public.attendance_records (
  id bigint primary key,
  course_id bigint not null references public.courses(id) on delete cascade,
  student_user_id bigint not null references public.users(id) on delete cascade,
  attendance_date date not null,
  status text not null check (status in ('P', 'A')),
  marked_by bigint not null references public.users(id),
  created_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (course_id, student_user_id, attendance_date)
);

create table if not exists public.marks (
  id bigint primary key,
  course_id bigint not null references public.courses(id) on delete cascade,
  student_user_id bigint not null references public.users(id) on delete cascade,
  internal_marks integer check (internal_marks between 0 and 50),
  external_marks integer check (external_marks between 0 and 50),
  lecturer_decision text check (lecturer_decision in ('pass', 'fail', 'override_pass')),
  updated_by bigint not null references public.users(id),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (course_id, student_user_id)
);

create table if not exists public.student_semesters (
  student_user_id bigint primary key references public.users(id) on delete cascade,
  current_semester integer not null default 1,
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new'
);

create table if not exists public.course_progress_log (
  id bigint primary key,
  course_id bigint not null references public.courses(id) on delete cascade,
  lecturer_user_id bigint not null references public.users(id),
  progress_text text not null,
  progress_date date not null default current_date,
  created_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new'
);

create table if not exists public.audit_log (
  id bigserial primary key,
  actor_username text not null,
  action text not null,
  metadata_json jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sync_clients (
  client_id text primary key,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_events (
  id bigserial primary key,
  client_id text not null references public.sync_clients(client_id) on delete cascade,
  outbox_id bigint not null,
  table_name text not null,
  record_id bigint not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  payload jsonb not null default '{}'::jsonb,
  retries integer not null default 0,
  received_at timestamptz not null default now(),
  unique (client_id, outbox_id)
);

create table if not exists public.sync_pull_queue (
  id bigserial primary key,
  target_client_id text,
  table_name text not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  record jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'pulled')),
  created_at timestamptz not null default now(),
  pulled_at timestamptz
);

create index if not exists idx_sync_events_client on public.sync_events(client_id);
create index if not exists idx_sync_events_table_record on public.sync_events(table_name, record_id);
create index if not exists idx_sync_pull_queue_status on public.sync_pull_queue(status);
create index if not exists idx_sync_pull_queue_target on public.sync_pull_queue(target_client_id);

drop trigger if exists trg_set_sync_clients_updated_at on public.sync_clients;
create trigger trg_set_sync_clients_updated_at before update on public.sync_clients for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_users_updated_at on public.users;
create trigger trg_set_users_updated_at before update on public.users for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_courses_updated_at on public.courses;
create trigger trg_set_courses_updated_at before update on public.courses for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_enrollment_requests_updated_at on public.enrollment_requests;
create trigger trg_set_enrollment_requests_updated_at before update on public.enrollment_requests for each row execute function public.tg_set_updated_at();

alter table public.institutions enable row level security;
alter table public.departments enable row level security;
alter table public.users enable row level security;
alter table public.courses enable row level security;
alter table public.enrollment_requests enable row level security;
alter table public.course_members enable row level security;
alter table public.attendance_records enable row level security;
alter table public.marks enable row level security;
alter table public.student_semesters enable row level security;
alter table public.course_progress_log enable row level security;
alter table public.audit_log enable row level security;
alter table public.sync_clients enable row level security;
alter table public.sync_events enable row level security;
alter table public.sync_pull_queue enable row level security;

drop policy if exists service_role_all_institutions on public.institutions;
create policy service_role_all_institutions on public.institutions for all to service_role using (true) with check (true);

drop policy if exists service_role_all_departments on public.departments;
create policy service_role_all_departments on public.departments for all to service_role using (true) with check (true);

drop policy if exists service_role_all_users on public.users;
create policy service_role_all_users on public.users for all to service_role using (true) with check (true);

drop policy if exists service_role_all_courses on public.courses;
create policy service_role_all_courses on public.courses for all to service_role using (true) with check (true);

drop policy if exists service_role_all_enrollment_requests on public.enrollment_requests;
create policy service_role_all_enrollment_requests on public.enrollment_requests for all to service_role using (true) with check (true);

drop policy if exists service_role_all_course_members on public.course_members;
create policy service_role_all_course_members on public.course_members for all to service_role using (true) with check (true);

drop policy if exists service_role_all_attendance_records on public.attendance_records;
create policy service_role_all_attendance_records on public.attendance_records for all to service_role using (true) with check (true);

drop policy if exists service_role_all_marks on public.marks;
create policy service_role_all_marks on public.marks for all to service_role using (true) with check (true);

drop policy if exists service_role_all_student_semesters on public.student_semesters;
create policy service_role_all_student_semesters on public.student_semesters for all to service_role using (true) with check (true);

drop policy if exists service_role_all_course_progress_log on public.course_progress_log;
create policy service_role_all_course_progress_log on public.course_progress_log for all to service_role using (true) with check (true);

drop policy if exists service_role_all_audit_log on public.audit_log;
create policy service_role_all_audit_log on public.audit_log for all to service_role using (true) with check (true);

drop policy if exists service_role_all_sync_clients on public.sync_clients;
create policy service_role_all_sync_clients on public.sync_clients for all to service_role using (true) with check (true);

drop policy if exists service_role_all_sync_events on public.sync_events;
create policy service_role_all_sync_events on public.sync_events for all to service_role using (true) with check (true);

drop policy if exists service_role_all_sync_pull_queue on public.sync_pull_queue;
create policy service_role_all_sync_pull_queue on public.sync_pull_queue for all to service_role using (true) with check (true);
