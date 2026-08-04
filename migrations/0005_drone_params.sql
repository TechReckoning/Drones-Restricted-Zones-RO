-- 0005_drone_params.sql
-- Volume Planner: aerodynamic parameters on the drone library, so selecting a
-- saved drone can auto-fill the operational-volume calculation.
--
-- Non-breaking: existing rows get NULLs. Row-level security from 0003 already
-- covers public.drones, so no policy changes are needed.
--
-- Apply once in Supabase → SQL Editor (or your migration runner). Re-runnable.

alter table public.drones add column if not exists aircraft_type text;    -- 'multirotor' | 'fixedwing'
alter table public.drones add column if not exists v0_ms        numeric;  -- max operational speed (m/s)
alter table public.drones add column if not exists cd_m         numeric;  -- characteristic dimension (m)
alter table public.drones add column if not exists v_wind_ms    numeric;  -- max wind speed (m/s)
alter table public.drones add column if not exists glide_ratio  numeric;  -- fixed-wing glide ratio
