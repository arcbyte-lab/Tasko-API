-- Occurrences of a repeating task share a series (arcbyte decision 0012): the
-- first task's id, copied to every next one, so a lead can see how each went.
ALTER TABLE tasks ADD COLUMN "series_id" integer;
UPDATE tasks SET series_id = id WHERE repeat IS NOT NULL;
