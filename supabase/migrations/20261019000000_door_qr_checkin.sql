-- Rotating door-QR check-in (additive; existing static member-QR flow untouched).
--
-- Adds per-branch door secrets + geofence config to gym_branches, GPS audit
-- columns to visits, and a small replay-protection table for used door codes.

-- ---------------------------------------------------------------------------
-- gym_branches: door secret, check-in mode, geofence
-- ---------------------------------------------------------------------------
ALTER TABLE public.gym_branches
  ADD COLUMN IF NOT EXISTS door_secret text,
  ADD COLUMN IF NOT EXISTS checkin_mode text NOT NULL DEFAULT 'lenient',
  ADD COLUMN IF NOT EXISTS geo_lat double precision,
  ADD COLUMN IF NOT EXISTS geo_lng double precision,
  ADD COLUMN IF NOT EXISTS geo_radius_m integer NOT NULL DEFAULT 100;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gym_branches_checkin_mode_check'
  ) THEN
    ALTER TABLE public.gym_branches
      ADD CONSTRAINT gym_branches_checkin_mode_check
      CHECK (checkin_mode IN ('lenient', 'strict'));
  END IF;
END
$$;

-- One random 32-byte secret per existing branch. Server-side only: never
-- select this column with a user-scoped client or expose it via any API.
UPDATE public.gym_branches
SET door_secret = encode(gen_random_bytes(32), 'hex')
WHERE door_secret IS NULL;

ALTER TABLE public.gym_branches ALTER COLUMN door_secret SET NOT NULL;

-- ---------------------------------------------------------------------------
-- visits: GPS audit columns for door-QR check-ins
-- ---------------------------------------------------------------------------
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS check_in_lat double precision,
  ADD COLUMN IF NOT EXISTS check_in_lng double precision,
  ADD COLUMN IF NOT EXISTS check_in_accuracy_m double precision;

-- ---------------------------------------------------------------------------
-- door_code_uses: replay protection for rotating door codes.
-- A code is valid for ~60s (current + previous 30s window); rows older than
-- that are pruned on every check-in, so the table stays tiny.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.door_code_uses (
  code_hash text PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES public.gym_branches(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS door_code_uses_used_at_idx
  ON public.door_code_uses (used_at);
