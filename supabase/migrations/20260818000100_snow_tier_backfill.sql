-- Backfill properties.tier from the notes field for snow scenarios. The IFS Snow
-- import landed the tier level in notes as "Tier 1" / "Tier 2" / "Tier 3"; extract the
-- digit into the dedicated tier column (values match snow_tier_rates: '1','2','3').
-- Non-destructive: notes is left as-is. Only fills rows whose tier is still null and
-- whose notes actually look like "Tier N".
update properties
set tier = regexp_replace(notes, '\D', '', 'g')
where scenario_id in (select id from scenarios where kind = 'snow')
  and tier is null
  and notes ~* 'tier\s*\d';
