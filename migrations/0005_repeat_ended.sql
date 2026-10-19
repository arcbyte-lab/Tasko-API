-- An ended repeat keeps its last rule here, on its latest task, until a lead
-- deletes it (arcbyte decision 0013); `repeat` keeps meaning "live". Moves
-- the rule off finished tasks whose repeat ran out, which kept it until now.
ALTER TABLE tasks ADD COLUMN "repeat_ended" text;
UPDATE tasks SET repeat_ended = repeat, repeat = NULL WHERE repeat IS NOT NULL AND status = 'done';
