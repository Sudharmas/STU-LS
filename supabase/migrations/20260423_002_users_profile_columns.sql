-- Align users table with current desktop/backend payload fields.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS full_name text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS college_uid text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS college_name text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS college_identification_number text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS internal_password_hash text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS internal_password_required boolean NOT NULL DEFAULT true;
