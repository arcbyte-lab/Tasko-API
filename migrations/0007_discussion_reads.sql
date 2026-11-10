-- A discussion is a task's comment thread (arcbyte H13), so it needs no table
-- of its own. This one marks how far each user has read each thread; a
-- comment by someone else after `last_read_at` is unread.
CREATE TABLE "discussion_reads" (
  "user_id" integer not null references "users"("id") on delete cascade,
  "task_id" integer not null references "tasks"("id") on delete cascade,
  "last_read_at" datetime not null,
  primary key ("user_id", "task_id")
);
