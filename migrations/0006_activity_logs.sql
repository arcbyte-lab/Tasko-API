-- One row per team action, written in the same batch as the change (arcbyte
-- decision 0014). Names are copied in, so a row still reads after its user or
-- subject is deleted. `project_id` has no foreign key on purpose: a project's
-- log outlives it. `target_user_id` is the person the action lands on.
CREATE TABLE "activity_logs" (
  "id" integer primary key autoincrement not null,
  "actor_id" integer references "users"("id") on delete set null,
  "actor_name" varchar,
  "action" varchar not null,
  "subject_type" varchar,
  "subject_id" integer,
  "subject_label" varchar,
  "division_id" integer references "divisions"("id") on delete set null,
  "project_id" integer,
  "target_user_id" integer references "users"("id") on delete set null,
  "changes" text,
  "description" varchar,
  "created_at" datetime
);
CREATE INDEX "activity_logs_division_id_created_at_index" ON "activity_logs"("division_id", "created_at");
CREATE INDEX "activity_logs_project_id_created_at_index" ON "activity_logs"("project_id", "created_at");
CREATE INDEX "activity_logs_actor_id_created_at_index" ON "activity_logs"("actor_id", "created_at");
CREATE INDEX "activity_logs_target_user_id_created_at_index" ON "activity_logs"("target_user_id", "created_at");
CREATE INDEX "activity_logs_subject_type_subject_id_index" ON "activity_logs"("subject_type", "subject_id");
