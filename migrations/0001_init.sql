-- Copied from arcbyte ideas/tasko/assets/sqlite-schema.sql: only the tables the
-- API reads (Laravel's own tables are left out). Two changes:
--   * tasks.status has a check constraint (arcbyte decision 0005).
--   * tasks.recurring_task_id keeps its column but loses its foreign key,
--     because recurring_tasks is not copied.
CREATE TABLE IF NOT EXISTS "users"(
  "id" integer primary key autoincrement not null,
  "name" varchar not null,
  "email" varchar not null,
  "email_verified_at" datetime,
  "password" varchar not null,
  "remember_token" varchar,
  "must_change_password" tinyint(1) not null default '1',
  "is_active" tinyint(1) not null default '1',
  "created_at" datetime,
  "updated_at" datetime,
  "two_factor_secret" text,
  "two_factor_recovery_codes" text,
  "two_factor_confirmed_at" datetime,
  "nik" varchar,
  "role" varchar not null default 'user',
  "avatar" varchar
);
CREATE UNIQUE INDEX "users_email_unique" on "users"("email");
CREATE TABLE IF NOT EXISTS "divisions"(
  "id" integer primary key autoincrement not null,
  "prefix" varchar not null,
  "name" varchar not null,
  "slug" varchar not null,
  "description" text,
  "created_at" datetime,
  "updated_at" datetime,
  "deleted_at" datetime
);
CREATE UNIQUE INDEX "divisions_prefix_unique" on "divisions"("prefix");
CREATE UNIQUE INDEX "divisions_name_unique" on "divisions"("name");
CREATE UNIQUE INDEX "divisions_slug_unique" on "divisions"("slug");
CREATE TABLE IF NOT EXISTS "division_members"(
  "id" integer primary key autoincrement not null,
  "user_id" integer not null,
  "division_id" integer not null,
  "role_type" varchar check("role_type" in('admin', 'supervisor', 'member', 'viewer')) not null default 'member',
  "role_label" varchar,
  "created_at" datetime,
  "updated_at" datetime,
  foreign key("user_id") references "users"("id") on delete cascade,
  foreign key("division_id") references "divisions"("id") on delete cascade
);
CREATE UNIQUE INDEX "division_members_user_id_division_id_unique" on "division_members"(
  "user_id",
  "division_id"
);
CREATE TABLE IF NOT EXISTS "project_members"(
  "id" integer primary key autoincrement not null,
  "project_id" integer not null,
  "user_id" integer not null,
  "role" varchar check("role" in('owner', 'person-in-charge', 'member', 'viewer')) not null default 'member',
  "invited_by" integer,
  "created_at" datetime,
  "updated_at" datetime,
  foreign key("project_id") references "projects"("id") on delete cascade,
  foreign key("user_id") references "users"("id") on delete cascade,
  foreign key("invited_by") references "users"("id") on delete set null
);
CREATE UNIQUE INDEX "project_members_project_id_user_id_unique" on "project_members"(
  "project_id",
  "user_id"
);
CREATE TABLE IF NOT EXISTS "personal_access_tokens"(
  "id" integer primary key autoincrement not null,
  "tokenable_type" varchar not null,
  "tokenable_id" integer not null,
  "name" text not null,
  "token" varchar not null,
  "abilities" text,
  "last_used_at" datetime,
  "expires_at" datetime,
  "created_at" datetime,
  "updated_at" datetime
);
CREATE INDEX "personal_access_tokens_tokenable_type_tokenable_id_index" on "personal_access_tokens"(
  "tokenable_type",
  "tokenable_id"
);
CREATE UNIQUE INDEX "personal_access_tokens_token_unique" on "personal_access_tokens"(
  "token"
);
CREATE INDEX "personal_access_tokens_expires_at_index" on "personal_access_tokens"(
  "expires_at"
);
CREATE TABLE IF NOT EXISTS "projects"(
  "id" integer primary key autoincrement not null,
  "name" varchar not null,
  "description" text,
  "start_date" date,
  "due_date" date,
  "creator_id" integer not null,
  "division_id" integer not null,
  -- ADR 0005: final 5-value lifecycle. 'archived' is now a real terminal status (the
  -- visible form of soft-delete, reachable from any of the other four), not dead legacy.
  -- Default is 'planning', matching every doc's claim that a new Project hasn't started.
  "status" varchar check("status" in('planning', 'in_progress', 'completed', 'cancelled', 'archived')) not null default 'planning',
  "created_at" datetime,
  "updated_at" datetime,
  -- ADR 0005: kept only as the timestamp of the most recent transition into 'archived'
  -- (paralleling tasks.completed_date/cancelled_date) — not a parallel soft-delete
  -- mechanism. A row is archived because status says so, not because this is set.
  "deleted_at" datetime,
  foreign key("division_id") references divisions("id") on delete cascade on update no action,
  foreign key("creator_id") references users("id") on delete cascade on update no action
);
CREATE TABLE IF NOT EXISTS "tasks"(
  "id" integer primary key autoincrement not null,
  "code" varchar not null,
  "division_id" integer not null,
  "project_id" integer,
  "creator_id" integer not null,
  "name" varchar not null,
  "description" text,
  "priority_level" integer not null default('2'),
  "status" varchar check("status" in('waiting', 'in_progress', 'review', 'done')) not null default('waiting'),
  "due_date" datetime,
  "start_date" datetime,
  "completed_date" datetime,
  "review_date" datetime,
  "cancelled_date" datetime,
  "created_at" datetime,
  "updated_at" datetime,
  "required_proof_type" varchar,
  "parent_id" integer,
  "recurring_task_id" integer,
  "due_soon_notified_at" datetime,
  "reminder_notified_at" datetime,
  "overdue_notified_at" datetime,
  "assignee_id" integer,
  foreign key("creator_id") references users("id") on delete no action on update no action,
  foreign key("project_id") references projects("id") on delete set null on update no action,
  foreign key("division_id") references divisions("id") on delete cascade on update no action,
  foreign key("parent_id") references tasks("id") on delete cascade on update no action,
  foreign key("assignee_id") references users("id") on delete set null on update no action
);
CREATE UNIQUE INDEX "tasks_code_unique" on "tasks"("code");
CREATE INDEX "tasks_assignee_id_status_index" on "tasks"("assignee_id", "status");
CREATE TABLE IF NOT EXISTS "task_reviews"(
  "id" integer primary key autoincrement not null,
  "task_id" integer not null,
  "reviewer_id" integer not null,
  "decision" varchar not null,
  "reason" text,
  "created_at" datetime,
  "updated_at" datetime,
  foreign key("task_id") references "tasks"("id") on delete cascade,
  foreign key("reviewer_id") references "users"("id")
);
CREATE TABLE IF NOT EXISTS "comments"(
  "id" integer primary key autoincrement not null,
  "task_id" integer not null,
  "user_id" integer not null,
  "comment" text,
  "created_at" datetime,
  "updated_at" datetime,
  "mentioned_names" text,
  "deleted_at" datetime,
  foreign key("user_id") references users("id") on delete no action on update no action,
  foreign key("task_id") references tasks("id") on delete cascade on update no action
);
CREATE TABLE IF NOT EXISTS "personal_tasks"(
  "id" integer primary key autoincrement not null,
  "user_id" integer not null,
  "parent_id" integer,
  "title" varchar not null,
  "note" text,
  "status" varchar check("status" in('todo', 'in_progress', 'done')) not null default 'todo',
  "priority_level" integer not null default '2',
  "due_date" datetime,
  "completed_at" datetime,
  "position" integer not null default '0',
  "created_at" datetime,
  "updated_at" datetime,
  foreign key("user_id") references "users"("id") on delete cascade,
  foreign key("parent_id") references "personal_tasks"("id") on delete cascade
);
CREATE INDEX "personal_tasks_user_id_parent_id_index" on "personal_tasks"(
  "user_id",
  "parent_id"
);
CREATE INDEX "personal_tasks_user_id_status_index" on "personal_tasks"(
  "user_id",
  "status"
);
CREATE TABLE IF NOT EXISTS "notifications"(
  "id" varchar not null,
  "type" varchar not null,
  "notifiable_type" varchar not null,
  "notifiable_id" integer not null,
  "data" text not null,
  "read_at" datetime,
  "created_at" datetime,
  "updated_at" datetime,
  primary key("id")
);
CREATE INDEX "notifications_notifiable_type_notifiable_id_index" on "notifications"(
  "notifiable_type",
  "notifiable_id"
);
CREATE TABLE IF NOT EXISTS "task_deadline_requests"(
  "id" integer primary key autoincrement not null,
  "task_id" integer not null,
  "requester_id" integer not null,
  "decided_by" integer,
  "current_due_date" datetime,
  "requested_due_date" datetime not null,
  "reason" text,
  "status" varchar not null default 'pending',
  "decision_reason" text,
  "decided_at" datetime,
  "created_at" datetime,
  "updated_at" datetime,
  foreign key("task_id") references "tasks"("id") on delete cascade,
  foreign key("requester_id") references "users"("id"),
  foreign key("decided_by") references "users"("id")
);
CREATE INDEX "task_deadline_requests_task_id_status_index" on "task_deadline_requests"(
  "task_id",
  "status"
);
CREATE INDEX "tasks_project_id_parent_id_status_index" on "tasks"(
  "project_id",
  "parent_id",
  "status"
);
CREATE INDEX "tasks_division_id_parent_id_status_index" on "tasks"(
  "division_id",
  "parent_id",
  "status"
);
CREATE INDEX "tasks_due_soon_notified_at_due_date_index" on "tasks"(
  "due_soon_notified_at",
  "due_date"
);
CREATE INDEX "tasks_due_date_index" on "tasks"("due_date");
CREATE INDEX "notifications_notifiable_type_notifiable_id_read_at_index" on "notifications"(
  "notifiable_type",
  "notifiable_id",
  "read_at"
);
CREATE UNIQUE INDEX "users_nik_unique" on "users"("nik");
