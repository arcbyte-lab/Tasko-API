-- proofs, copied from arcbyte ideas/tasko/assets/sqlite-schema.sql as is.
-- A proof is a link for now (owner's call, 2026-10-09): `file` holds the URL,
-- and drive_file_id, size and original_name stay null until uploads exist.
CREATE TABLE IF NOT EXISTS "proofs"(
  "id" integer primary key autoincrement not null,
  "task_id" integer not null,
  "user_id" integer not null,
  "file" varchar not null,
  "created_at" datetime,
  "updated_at" datetime,
  "drive_file_id" varchar,
  "size" integer,
  "original_name" varchar,
  foreign key("task_id") references "tasks"("id") on delete cascade,
  foreign key("user_id") references "users"("id")
);
