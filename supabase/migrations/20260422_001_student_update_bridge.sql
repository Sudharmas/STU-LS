-- Add student update availability tracking and notification queue for bridge sync.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS update_available boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_role_update_available
  ON public.users (role, update_available)
  WHERE role = 'student';

CREATE TABLE IF NOT EXISTS public.student_sync_state (
  student_user_id bigint PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  update_available boolean NOT NULL DEFAULT false,
  last_change_at timestamptz,
  last_pulled_at timestamptz,
  change_counter bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.student_notifications (
  id bigserial PRIMARY KEY,
  student_user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_student_sync_state_update_available
  ON public.student_sync_state (update_available, student_user_id)
  WHERE update_available = true;

CREATE INDEX IF NOT EXISTS idx_student_notifications_unread
  ON public.student_notifications (student_user_id, is_read, created_at)
  WHERE is_read = false;

DROP TRIGGER IF EXISTS trg_set_student_sync_state_updated_at ON public.student_sync_state;
CREATE TRIGGER trg_set_student_sync_state_updated_at
BEFORE UPDATE ON public.student_sync_state
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.student_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_student_sync_state ON public.student_sync_state;
CREATE POLICY service_role_all_student_sync_state ON public.student_sync_state
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all_student_notifications ON public.student_notifications;
CREATE POLICY service_role_all_student_notifications ON public.student_notifications
FOR ALL TO service_role USING (true) WITH CHECK (true);
