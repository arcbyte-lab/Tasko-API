-- A workspace task's repeat rule (arcbyte decision 0009), as JSON: every, unit,
-- weekdays, until, count. Finishing the task moves the rule onto a new task,
-- due one step later. Not in sqlite-schema.sql, whose recurring_tasks is a
-- server-run schedule; that table stays uncopied.
ALTER TABLE tasks ADD COLUMN "repeat" text;
