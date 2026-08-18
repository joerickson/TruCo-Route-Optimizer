-- Operational capacity cap for snow crews: how many properties one truck/crew covers
-- per storm ("4 properties per truck"). A crew closes at whichever binds first — this
-- cap or the design window. 0 disables the cap (window-only sizing).
alter table scenarios add column if not exists snow_max_stops_per_crew numeric not null default 4;
