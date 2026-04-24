-- STU-LS Supabase Online Schema
-- One-time initialization by operator only.

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

-- Institution hierarchy
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

-- Core users (password_hash stores hashed passwords only)
create table if not exists public.users (
  id bigint primary key,
  username text unique not null,
  full_name text,
  password_hash text not null,
  role text not null check (role in ('platform_admin', 'super_admin', 'department_admin', 'lecturer', 'student')),
  college_uid text,
  college_name text,
  college_identification_number text,
  internal_password_hash text,
  internal_password_required boolean not null default true,
  institution_id bigint references public.institutions(id),
  department_id bigint references public.departments(id),
  department text,
  update_available boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new'
);

alter table public.users add column if not exists full_name text;
alter table public.users add column if not exists internal_password_hash text;
alter table public.users add column if not exists internal_password_required boolean not null default true;

-- Dedicated Students Table with Relationships and Optimization
create table if not exists public.students (
  id bigint primary key,
  user_id bigint not null unique references public.users(id) on delete cascade,
  department text not null,
  college_uid text not null,
  college_name text,
  college_identification_number text,
  created_by_admin_id bigint not null references public.users(id) on delete restrict,
  current_semester integer not null default 1,
  enrollment_status text not null check (enrollment_status in ('active', 'inactive', 'graduated', 'suspended')) default 'active',
  academic_year text,
  batch text,
  custom_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new'
);

-- Student-Lecturer Relationship (for quick enrollment lookups)
create table if not exists public.student_lecturer_relationships (
  id bigint primary key,
  student_id bigint not null references public.students(id) on delete cascade,
  lecturer_id bigint not null references public.users(id) on delete cascade,
  relationship_type text not null check (relationship_type in ('enrolled', 'assigned', 'supervised')) default 'enrolled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (student_id, lecturer_id, relationship_type)
);

-- Student-Department Admin Relationship (for quick admin lookups)
create table if not exists public.student_admin_relationships (
  id bigint primary key,
  student_id bigint not null references public.students(id) on delete cascade,
  admin_id bigint not null references public.users(id) on delete cascade,
  relationship_type text not null check (relationship_type in ('created_by', 'managed_by', 'advised_by')) default 'created_by',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  sync_state text not null default 'server_new',
  unique (student_id, admin_id, relationship_type)
);

-- Indexes for optimization
create index if not exists idx_students_user_id on public.students(user_id);
create index if not exists idx_students_department on public.students(department);
create index if not exists idx_students_college_uid on public.students(college_uid);
create index if not exists idx_students_created_by_admin_id on public.students(created_by_admin_id);
create index if not exists idx_students_enrollment_status on public.students(enrollment_status);
create index if not exists idx_students_batch on public.students(batch);
create index if not exists idx_students_college_and_status on public.students(college_uid, enrollment_status);
create index if not exists idx_students_department_status on public.students(department, enrollment_status);
create index if not exists idx_student_lecturer_student_id on public.student_lecturer_relationships(student_id);
create index if not exists idx_student_lecturer_lecturer_id on public.student_lecturer_relationships(lecturer_id);
create index if not exists idx_student_lecturer_type on public.student_lecturer_relationships(relationship_type);
create index if not exists idx_student_admin_student_id on public.student_admin_relationships(student_id);
create index if not exists idx_student_admin_admin_id on public.student_admin_relationships(admin_id);
create index if not exists idx_student_admin_type on public.student_admin_relationships(relationship_type);

-- Sync triggers for students
create trigger if not exists trg_set_students_updated_at
before update on public.students
for each row execute function public.tg_set_updated_at();

create trigger if not exists trg_set_student_lecturer_updated_at
before update on public.student_lecturer_relationships
for each row execute function public.tg_set_updated_at();

create trigger if not exists trg_set_student_admin_updated_at
before update on public.student_admin_relationships
for each row execute function public.tg_set_updated_at();

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

-- Sync service infrastructure
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

create table if not exists public.student_sync_state (
  student_user_id bigint primary key references public.users(id) on delete cascade,
  update_available boolean not null default false,
  last_change_at timestamptz,
  last_pulled_at timestamptz,
  change_counter bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.student_notifications (
  id bigserial primary key,
  student_user_id bigint not null references public.users(id) on delete cascade,
  event_type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists idx_sync_events_client on public.sync_events(client_id);
create index if not exists idx_sync_events_table_record on public.sync_events(table_name, record_id);
create index if not exists idx_sync_pull_queue_status on public.sync_pull_queue(status);
create index if not exists idx_sync_pull_queue_target on public.sync_pull_queue(target_client_id);
create index if not exists idx_users_role_update_available on public.users(role, update_available) where role = 'student';
create index if not exists idx_student_sync_state_update_available on public.student_sync_state(update_available, student_user_id) where update_available = true;
create index if not exists idx_student_notifications_unread on public.student_notifications(student_user_id, is_read, created_at) where is_read = false;
create index if not exists idx_attendance_course_student on public.attendance_records(course_id, student_user_id);
create index if not exists idx_marks_course_student on public.marks(course_id, student_user_id);
create index if not exists idx_course_members_active on public.course_members(course_id, student_user_id, removed_at);

drop trigger if exists trg_set_sync_clients_updated_at on public.sync_clients;
create trigger trg_set_sync_clients_updated_at
before update on public.sync_clients
for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_users_updated_at on public.users;
create trigger trg_set_users_updated_at
before update on public.users
for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_courses_updated_at on public.courses;
create trigger trg_set_courses_updated_at
before update on public.courses
for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_enrollment_requests_updated_at on public.enrollment_requests;
create trigger trg_set_enrollment_requests_updated_at
before update on public.enrollment_requests
for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_departments_updated_at on public.departments;
create trigger trg_set_departments_updated_at
before update on public.departments
for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_institutions_updated_at on public.institutions;
create trigger trg_set_institutions_updated_at
before update on public.institutions
for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_set_student_sync_state_updated_at on public.student_sync_state;
create trigger trg_set_student_sync_state_updated_at
before update on public.student_sync_state
for each row execute function public.tg_set_updated_at();

-- RLS
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
alter table public.student_sync_state enable row level security;
alter table public.student_notifications enable row level security;

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

drop policy if exists service_role_all_student_sync_state on public.student_sync_state;
create policy service_role_all_student_sync_state on public.student_sync_state for all to service_role using (true) with check (true);

drop policy if exists service_role_all_student_notifications on public.student_notifications;
create policy service_role_all_student_notifications on public.student_notifications for all to service_role using (true) with check (true);

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

alter table public.users add column if not exists college_uid text;
alter table public.users add column if not exists college_name text;
alter table public.users add column if not exists college_identification_number text;
