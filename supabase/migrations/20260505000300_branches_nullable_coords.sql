-- Allow branches without coordinates so we can persist address edits
-- when geocoding fails. The UI flags un-geocoded branches and excludes
-- them from the map and optimizer. Existing rows are unaffected.

alter table branches alter column lat drop not null;
alter table branches alter column lng drop not null;
