-- Dev and test data: the world of the app's FakeTasksApi. Dates are relative
-- to today, so "today" and "overdue" always look right.
-- Every user's password is "password". Make a new hash with:
--   bun -e "import {hashPassword} from './src/auth.ts'; console.log(await hashPassword('password'))"
-- "Today" is the team's local day (UTC+7), stored as UTC.
-- ponytail: fixed UTC+7, make it a parameter if the team spans time zones.
-- Safe to run again: everything is cleared first, children before parents.

DELETE FROM notifications;
DELETE FROM task_deadline_requests;
DELETE FROM comments;
DELETE FROM task_reviews;
DELETE FROM tasks;
DELETE FROM personal_tasks;
DELETE FROM personal_access_tokens;
DELETE FROM project_members;
DELETE FROM projects;
DELETE FROM division_members;
DELETE FROM divisions;
DELETE FROM users;
DELETE FROM sqlite_sequence;

INSERT INTO users (id, name, email, password, must_change_password, created_at, updated_at) VALUES
  (1, 'Mira',  'mira@arcbyte.dev',  'pbkdf2_sha256$100000$aYcZ4HbhItQTTOEf14sASQ==$6YMHsCe+OdE3SEMDxafk9UPvpgBl6B4hkcKWIFgoEXA=', 0, datetime('now'), datetime('now')),
  (2, 'Ana',   'ana@arcbyte.dev',   'pbkdf2_sha256$100000$KCQdhm0ZsSQoHqAG//uPUA==$hNKbBxQiBSRXKz77ctlX3qVShVgSE5Ca1E3Mm9exRtc=', 0, datetime('now'), datetime('now')),
  (3, 'Budi',  'budi@arcbyte.dev',  'pbkdf2_sha256$100000$mhU6JxK2EjRDqETcY+kM9w==$mYBmxEEOrP1uZb5yVdBpBT4dzg4ZwPGDe9o9cC29gRQ=', 0, datetime('now'), datetime('now')),
  (4, 'Citra', 'citra@arcbyte.dev', 'pbkdf2_sha256$100000$vIP4jqZB6GalnNe6BrFqbA==$kW1CXQOrHbBfyvOkSOgRL2YJl3J6OP3hnCZX8B2k0j8=', 0, datetime('now'), datetime('now')),
  (5, 'Dimas', 'dimas@arcbyte.dev', 'pbkdf2_sha256$100000$EVr51+a6UNfN3SMGxCAoZA==$72hbj+t8R8PsCJFHgNDDPHWF7ceyWazcnflZ2SYOIFU=', 0, datetime('now'), datetime('now')),
  (6, 'Eka',   'eka@arcbyte.dev',   'pbkdf2_sha256$100000$/9180t5I4TctKeEATMEYYA==$a27GGRPaVJl6JNU1nszZPtF5h5lSsc0FKLP1Vmr9nYk=', 0, datetime('now'), datetime('now')),
  (7, 'Fajar', 'fajar@arcbyte.dev', 'pbkdf2_sha256$100000$gL4elREcV+XumVYoNy9fiA==$DmR8O9FOz0ZfOdLcIpRQvk4BShb7UxsybIdDg/gPvpg=', 0, datetime('now'), datetime('now'));

INSERT INTO divisions (id, prefix, name, slug, created_at, updated_at) VALUES
  (1, 'TECH', 'tech', 'tech', datetime('now'), datetime('now'));

INSERT INTO division_members (user_id, division_id, role_type, created_at, updated_at) VALUES
  (1, 1, 'member', datetime('now'), datetime('now')),
  (2, 1, 'admin',  datetime('now'), datetime('now')),
  (3, 1, 'member', datetime('now'), datetime('now')),
  (4, 1, 'member', datetime('now'), datetime('now')),
  (5, 1, 'member', datetime('now'), datetime('now')),
  (6, 1, 'member', datetime('now'), datetime('now')),
  (7, 1, 'member', datetime('now'), datetime('now'));

-- tasko-app: Ana's project, Mira is a plain member. tasko-web: Mira is the author.
INSERT INTO projects (id, name, creator_id, division_id, status, created_at, updated_at) VALUES
  (1, 'tasko-app', 2, 1, 'in_progress', datetime('now'), datetime('now')),
  (2, 'tasko-web', 1, 1, 'in_progress', datetime('now'), datetime('now'));

INSERT INTO project_members (project_id, user_id, role, created_at, updated_at) VALUES
  (1, 1, 'member',           datetime('now'), datetime('now')),
  (1, 2, 'person-in-charge', datetime('now'), datetime('now')),
  (1, 3, 'member',           datetime('now'), datetime('now')),
  (1, 4, 'member',           datetime('now'), datetime('now')),
  (1, 5, 'member',           datetime('now'), datetime('now')),
  (1, 6, 'member',           datetime('now'), datetime('now')),
  (1, 7, 'member',           datetime('now'), datetime('now')),
  (2, 1, 'owner',            datetime('now'), datetime('now')),
  (2, 2, 'person-in-charge', datetime('now'), datetime('now')),
  (2, 3, 'member',           datetime('now'), datetime('now')),
  (2, 4, 'member',           datetime('now'), datetime('now')),
  (2, 5, 'member',           datetime('now'), datetime('now')),
  (2, 6, 'member',           datetime('now'), datetime('now')),
  (2, 7, 'member',           datetime('now'), datetime('now'));

-- Mira's private tab.
INSERT INTO personal_tasks (id, user_id, parent_id, title, status, priority_level, due_date, completed_at, created_at, updated_at) VALUES
  (1, 1, NULL, 'Buy domain',                 'todo',        2, datetime('now', '+7 hours', 'start of day', '-7 hours', '+3 days'),  NULL, datetime('now'), datetime('now')),
  (2, 1, NULL, 'Renew passport',             'todo',        3, datetime('now', '+7 hours', 'start of day', '-7 hours', '+2 days'),  NULL, datetime('now'), datetime('now')),
  (3, 1, NULL, 'Book dentist',               'in_progress', 2, datetime('now', '+7 hours', 'start of day', '-7 hours'),             NULL, datetime('now'), datetime('now')),
  (4, 1, NULL, 'Pay internet bill',          'todo',        4, datetime('now', '+7 hours', 'start of day', '-7 hours', '-2 days'),  NULL, datetime('now'), datetime('now')),
  (5, 1, NULL, 'Read Flutter release notes', 'todo',        1, NULL,                                        NULL, datetime('now'), datetime('now')),
  (6, 1, NULL, 'Buy groceries',              'done',        2, datetime('now', '+7 hours', 'start of day', '-7 hours', '-1 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '-1 days'), datetime('now'), datetime('now')),
  (7, 1, 1,    'Compare registrars',         'done',        2, NULL,                                        datetime('now', '+7 hours', 'start of day', '-7 hours'), datetime('now'), datetime('now')),
  (8, 1, 1,    'Set up DNS',                 'todo',        2, NULL,                                        NULL, datetime('now'), datetime('now'));

-- Team tasks. Ana created the top-level ones, Mira the sub-tasks. Assignee is Mira unless noted.
INSERT INTO tasks (id, code, division_id, project_id, creator_id, assignee_id, parent_id, name, description, priority_level, status, due_date, completed_date, required_proof_type, created_at, updated_at) VALUES
  -- tasko-app
  (1,  'TA-0011', 1, 1, 2, 1, NULL, 'Set up CI',          NULL, 3, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '+1 days'), NULL, NULL, datetime('now'), datetime('now')),
  (2,  'TA-0012', 1, 1, 2, 1, NULL, 'Port theme tokens',  NULL, 2, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+3 days'), NULL, NULL, datetime('now'), datetime('now')),
  (3,  'TA-0013', 1, 1, 2, 1, NULL, 'Draft API contract', NULL, 2, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+3 days'), NULL, NULL, datetime('now'), datetime('now')),
  (4,  'TA-0014', 1, 1, 2, 1, NULL, 'Pick an icon set',   NULL, 1, 'done',        datetime('now', '+7 hours', 'start of day', '-7 hours', '-3 days'), datetime('now', '+7 hours', 'start of day', '-7 hours', '-3 days'), NULL, datetime('now'), datetime('now')),
  -- tasko-web
  (5,  'TW-0041', 1, 2, 2, 1, NULL, 'Fix login redirect',
       'After login, users land on /home instead of the page they came from. Keep the return URL and redirect back.',
                                                                    4, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '-4 days', '+17 hours'), NULL, 'image', datetime('now'), datetime('now')),
  (6,  'TW-0042', 1, 2, 2, 1, NULL, 'Write onboarding copy',      NULL, 2, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours'),             NULL, NULL,    datetime('now'), datetime('now')),
  (7,  'TW-0043', 1, 2, 2, 3, NULL, 'Review PR #42',              NULL, 3, 'review',      datetime('now', '+7 hours', 'start of day', '-7 hours'),             NULL, 'image', datetime('now'), datetime('now')),
  (8,  'TW-0044', 1, 2, 2, 1, NULL, 'Deploy staging',             NULL, 3, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+1 days'),  NULL, NULL,    datetime('now'), datetime('now')),
  (9,  'TW-0045', 1, 2, 2, 1, NULL, 'Upload release screenshots', NULL, 2, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+2 days'),  NULL, 'image', datetime('now'), datetime('now')),
  (10, 'TW-0046', 1, 2, 2, 1, NULL, 'Design empty state',         NULL, 1, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+7 days'),  NULL, NULL,    datetime('now'), datetime('now')),
  (11, 'TW-0047', 1, 2, 2, 1, NULL, 'Fix navbar on mobile',       NULL, 3, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '+7 days'),  NULL, NULL,    datetime('now'), datetime('now')),
  (12, 'TW-0048', 1, 2, 2, 1, NULL, 'QA checkout flow',           NULL, 2, 'review',      datetime('now', '+7 hours', 'start of day', '-7 hours', '+7 days'),  NULL, 'file',  datetime('now'), datetime('now')),
  (13, 'TW-0049', 1, 2, 2, 1, NULL, 'Write release notes',        NULL, 2, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+7 days'),  NULL, NULL,    datetime('now'), datetime('now')),
  (14, 'TW-0050', 1, 2, 2, 1, NULL, 'Add 404 page',               NULL, 1, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+7 days'),  NULL, NULL,    datetime('now'), datetime('now')),
  (15, 'TW-0051', 1, 2, 2, 1, NULL, 'Update favicon',             NULL, 1, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '+13 days'), NULL, NULL,    datetime('now'), datetime('now')),
  (16, 'TW-0052', 1, 2, 2, 1, NULL, 'Clean up old branches',      NULL, 1, 'waiting',     NULL,                                        NULL, NULL,    datetime('now'), datetime('now')),
  (17, 'TW-0053', 1, 2, 2, 1, NULL, 'Set up analytics',           NULL, 2, 'done',        datetime('now', '+7 hours', 'start of day', '-7 hours', '-2 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '-2 days'), NULL, datetime('now'), datetime('now')),
  (18, 'TW-0054', 1, 2, 2, 1, NULL, 'Fix footer links',           NULL, 1, 'done',        datetime('now', '+7 hours', 'start of day', '-7 hours', '-5 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '-5 days'), NULL, datetime('now'), datetime('now')),
  (19, 'TW-0055', 1, 2, 2, 1, NULL, 'Compress hero images',       NULL, 1, 'done',        datetime('now', '+7 hours', 'start of day', '-7 hours', '-6 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '-6 days'), NULL, datetime('now'), datetime('now')),
  (20, 'TW-0056', 1, 2, 1, 1, 5,    'Reproduce on Safari',        NULL, 2, 'done',        NULL, datetime('now', '+7 hours', 'start of day', '-7 hours'), NULL, datetime('now'), datetime('now')),
  (21, 'TW-0057', 1, 2, 1, 1, 5,    'Store return URL',           NULL, 2, 'waiting',     NULL, NULL, NULL, datetime('now'), datetime('now')),
  (22, 'TW-0058', 1, 2, 1, 1, 5,    'Add redirect test',          NULL, 2, 'waiting',     NULL, NULL, NULL, datetime('now'), datetime('now')),
  -- Not in the fake: one division-only task, so the tech tab has something to show (decision 0002).
  (23, 'TECH-0001', 1, NULL, 2, 1, NULL, 'Renew SSL certificate', NULL, 3, 'waiting', datetime('now', '+7 hours', 'start of day', '-7 hours', '+5 days'), NULL, NULL, datetime('now'), datetime('now'));

INSERT INTO comments (task_id, user_id, comment, created_at, updated_at) VALUES
  (5, 2, 'Only happens on Safari for me. Chrome is fine.', datetime('now', '-2 hours'),    datetime('now', '-2 hours')),
  (5, 3, 'Can this ship before Friday''s release?',        datetime('now', '-45 minutes'), datetime('now', '-45 minutes'));
