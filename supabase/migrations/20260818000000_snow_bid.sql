-- Snow bid support — as-needed (storm-triggered) work sized by a per-event design
-- window, distinct from the recurring weekly/biweekly/monthly maintenance model.

-- Scenario kind switches the whole UI/model between summer maintenance and snow.
alter table scenarios add column if not exists kind text not null default 'maintenance';
alter table scenarios add constraint scenarios_kind_check
  check (kind in ('maintenance', 'snow')) not valid;
alter table scenarios validate constraint scenarios_kind_check;

-- Snow bid parameters (per scenario). Design window = hours available to complete one
-- full clearing pass before business open. Sidewalk time = flat hours for any property
-- flagged as having sidewalks.
alter table scenarios add column if not exists snow_window_hours numeric not null default 4;
alter table scenarios add column if not exists snow_sidewalk_hours numeric not null default 0.5;

-- Flip existing snow scenarios (matched by name) to kind='snow' so they pick up the
-- seeded tier rates below. Safe/idempotent; adjust or remove if names differ.
update scenarios set kind = 'snow' where kind = 'maintenance' and name ilike '%snow%';

-- Per-property snow attributes. Tier drives plow time (via snow_tier_rates); has_sidewalk
-- opts a property into the sidewalk fleet (default off — most properties have no sidewalks).
alter table properties add column if not exists tier text;
alter table properties add column if not exists has_sidewalk boolean not null default false;

-- Editable plow hours per tier, per scenario.
create table if not exists snow_tier_rates (
  scenario_id uuid not null references scenarios(id) on delete cascade,
  tier text not null,
  plow_hours numeric not null default 1,
  primary key (scenario_id, tier)
);

-- Seed the three tiers for every existing snow-kind scenario (idempotent).
-- Plow hours: Tier 1 = 1.5h, Tier 2 = 1.0h, Tier 3 = 1.0h.
insert into snow_tier_rates (scenario_id, tier, plow_hours)
select s.id, v.tier, v.plow_hours
from scenarios s
cross join (values ('1', 1.5), ('2', 1.0), ('3', 1.0)) as v(tier, plow_hours)
where s.kind = 'snow'
on conflict (scenario_id, tier) do nothing;
