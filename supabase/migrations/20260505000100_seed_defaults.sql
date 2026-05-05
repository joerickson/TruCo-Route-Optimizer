-- Seed default branch and 30 crews (27x 2-person, 3x 3-person) on first install.
-- Safe to run multiple times — guarded by NOT EXISTS.

do $$
declare
  v_branch_id uuid;
begin
  if not exists (select 1 from branches) then
    insert into branches (name, address, city, state, postal_code, lat, lng)
    values ('Salt Lake City HQ', '2120 S 700 W', 'Salt Lake City', 'UT', '84119', 40.7240, -111.9080)
    returning id into v_branch_id;

    -- 27 two-person crews
    for i in 1..27 loop
      insert into crews (name, crew_size, home_branch_id)
      values (format('Crew %s', i), 2, v_branch_id);
    end loop;

    -- 3 three-person crews
    for i in 28..30 loop
      insert into crews (name, crew_size, home_branch_id)
      values (format('Crew %s', i), 3, v_branch_id);
    end loop;
  end if;
end $$;
