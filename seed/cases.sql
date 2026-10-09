-- Edge cases on top of seed.sql, for trying the app against every rule. Run
-- it after seed.sql (`bun run db:seed` does both); seed.sql clears these rows
-- too. The tests use seed.sql alone, so nothing here moves their counts.
-- Every user's password is "password" (Mira's hash, reused). Dates as in seed.sql.
--
-- Mira (mira@arcbyte.dev) sees, besides seed.sql's tabs:
--   ops        division, she is its supervisor: reviews its division-only tasks
--   ops-site   project, she is person-in-charge: reviews, even her own task
--   ops-wiki   project, plain member; its author Kiki left, so only Joko reviews
--   contracts  project in legal, a division she is not in (membership is per table, 0002)
-- and never sees: legal (not a member), old (deleted division) and its
-- old-site project, archived-app (archived project).
--
-- Other logins:
--   gita@arcbyte.dev   must change password; assignee of ops tasks
--   hadi@arcbyte.dev   inactive: login refused, not assignable, still shown as an assignee
--   indah@arcbyte.dev  no memberships: only the private tab
--   joko@arcbyte.dev   ops admin, ops-site owner, ops-wiki person-in-charge
--   kiki@arcbyte.dev   created ops-wiki, then left it

INSERT INTO users (id, name, email, password, must_change_password, is_active, created_at, updated_at) VALUES
  (8,  'Gita',  'gita@arcbyte.dev',  'pbkdf2_sha256$100000$aYcZ4HbhItQTTOEf14sASQ==$6YMHsCe+OdE3SEMDxafk9UPvpgBl6B4hkcKWIFgoEXA=', 1, 1, datetime('now'), datetime('now')),
  (9,  'Hadi',  'hadi@arcbyte.dev',  'pbkdf2_sha256$100000$aYcZ4HbhItQTTOEf14sASQ==$6YMHsCe+OdE3SEMDxafk9UPvpgBl6B4hkcKWIFgoEXA=', 0, 0, datetime('now'), datetime('now')),
  (10, 'Indah', 'indah@arcbyte.dev', 'pbkdf2_sha256$100000$aYcZ4HbhItQTTOEf14sASQ==$6YMHsCe+OdE3SEMDxafk9UPvpgBl6B4hkcKWIFgoEXA=', 0, 1, datetime('now'), datetime('now')),
  (11, 'Joko',  'joko@arcbyte.dev',  'pbkdf2_sha256$100000$aYcZ4HbhItQTTOEf14sASQ==$6YMHsCe+OdE3SEMDxafk9UPvpgBl6B4hkcKWIFgoEXA=', 0, 1, datetime('now'), datetime('now')),
  (12, 'Kiki',  'kiki@arcbyte.dev',  'pbkdf2_sha256$100000$aYcZ4HbhItQTTOEf14sASQ==$6YMHsCe+OdE3SEMDxafk9UPvpgBl6B4hkcKWIFgoEXA=', 0, 1, datetime('now'), datetime('now'));

INSERT INTO divisions (id, prefix, name, slug, deleted_at, created_at, updated_at) VALUES
  (2, 'OPS', 'ops',   'ops',   NULL,            datetime('now'), datetime('now')),
  (3, 'LGL', 'legal', 'legal', NULL,            datetime('now'), datetime('now')),
  (4, 'OLD', 'old',   'old',   datetime('now'), datetime('now'), datetime('now'));

INSERT INTO division_members (user_id, division_id, role_type, created_at, updated_at) VALUES
  (1,  2, 'supervisor', datetime('now'), datetime('now')),
  (11, 2, 'admin',      datetime('now'), datetime('now')),
  (8,  2, 'member',     datetime('now'), datetime('now')),
  (9,  2, 'member',     datetime('now'), datetime('now')),
  (3,  2, 'viewer',     datetime('now'), datetime('now')),
  (2,  3, 'admin',      datetime('now'), datetime('now')),
  (1,  4, 'member',     datetime('now'), datetime('now'));

INSERT INTO projects (id, name, creator_id, division_id, status, created_at, updated_at) VALUES
  (3, 'ops-site',     11, 2, 'in_progress', datetime('now'), datetime('now')),
  (4, 'ops-wiki',     12, 2, 'planning',    datetime('now'), datetime('now')),
  (5, 'contracts',    2,  3, 'in_progress', datetime('now'), datetime('now')),
  (6, 'old-site',     1,  4, 'in_progress', datetime('now'), datetime('now')),
  (7, 'archived-app', 2,  1, 'archived',    datetime('now'), datetime('now'));

INSERT INTO project_members (project_id, user_id, role, created_at, updated_at) VALUES
  (3, 1,  'person-in-charge', datetime('now'), datetime('now')),
  (3, 11, 'owner',            datetime('now'), datetime('now')),
  (3, 8,  'member',           datetime('now'), datetime('now')),
  (3, 9,  'member',           datetime('now'), datetime('now')),
  (3, 3,  'viewer',           datetime('now'), datetime('now')),
  (4, 1,  'member',           datetime('now'), datetime('now')),
  (4, 11, 'person-in-charge', datetime('now'), datetime('now')),
  (4, 8,  'member',           datetime('now'), datetime('now')),
  (5, 1,  'member',           datetime('now'), datetime('now')),
  (5, 2,  'person-in-charge', datetime('now'), datetime('now')),
  (6, 1,  'owner',            datetime('now'), datetime('now')),
  (7, 1,  'member',           datetime('now'), datetime('now')),
  (7, 2,  'owner',            datetime('now'), datetime('now'));

INSERT INTO tasks (id, code, division_id, project_id, creator_id, assignee_id, parent_id, name, description, priority_level, status, due_date, completed_date, review_date, required_proof_type, created_at, updated_at) VALUES
  -- ops, division-only: Mira reviews as supervisor
  (24, 'OPS-0001', 2, NULL, 11, 8,    NULL, 'Restock printer paper',    'Someone else''s task: Mira can edit it (reviewer) but not tick it.',
                                                                              1, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+10 hours'), NULL, NULL, NULL, datetime('now'), datetime('now')),
  (25, 'OPS-0002', 2, NULL, 11, 8,    NULL, 'Check fire extinguishers', NULL, 3, 'review',      datetime('now', '+7 hours', 'start of day', '-7 hours'),              NULL, datetime('now', '-2 hours'), 'image', datetime('now'), datetime('now')),
  (26, 'OPS-0003', 2, NULL, 11, NULL, NULL, 'Order office chairs',      'Unassigned: anyone in ops can tick it.',
                                                                              2, 'waiting',     NULL,                                                                 NULL, NULL, NULL, datetime('now'), datetime('now')),
  (27, 'OPS-0004', 2, NULL, 11, 1,    NULL, 'File expense reports',     'Mira''s, overdue; she is a reviewer here, so no extension request.',
                                                                              3, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '-3 days'),   NULL, NULL, NULL, datetime('now'), datetime('now')),
  -- ops-site: Mira is person-in-charge
  (28, 'OPS-0005', 2, 3, 11, 1,    NULL, 'Survey the new site',         'Needs a proof; Mira then reviews her own task (0004).',
                                                                              3, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+2 days'),   NULL, NULL, 'file', datetime('now'), datetime('now')),
  (29, 'OPS-0006', 2, 3, 11, 9,    NULL, 'Install wifi',                'Rejected once, sent again: two proofs, the latest shows. Assignee Hadi is inactive.',
                                                                              4, 'review',      datetime('now', '+7 hours', 'start of day', '-7 hours', '-1 days'),   NULL, datetime('now', '-1 hours'), 'image', datetime('now'), datetime('now')),
  (30, 'OPS-0007', 2, 3, 11, 8,    NULL, 'Move furniture',              NULL, 2, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '+4 days'),   NULL, NULL, NULL, datetime('now'), datetime('now')),
  (31, 'OPS-0008', 2, 3, 11, 8,    NULL, 'Label cables',                NULL, 1, 'done',        datetime('now', '+7 hours', 'start of day', '-7 hours', '-1 days'),   datetime('now', '-20 hours'), datetime('now', '-26 hours'), 'image', datetime('now'), datetime('now')),
  (32, 'OPS-0009', 2, 3, 1,  8,    30,   'Measure rooms',               NULL, 2, 'waiting',     NULL,                                                                 NULL, NULL, NULL, datetime('now'), datetime('now')),
  (33, 'OPS-0010', 2, 3, 1,  8,    30,   'Book a van',                  NULL, 2, 'done',        NULL,                                                                 datetime('now', '-3 hours'), NULL, NULL, datetime('now'), datetime('now')),
  (34, 'OPS-0011', 2, 3, 11, 1,    NULL, 'Quarterly audit',             'Due next month, for the calendar.',
                                                                              2, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+35 days'),  NULL, NULL, NULL, datetime('now'), datetime('now')),
  -- ops-wiki: Mira is a member; author Kiki left, so Joko alone reviews
  (35, 'OPS-0012', 2, 4, 12, 8,    NULL, 'Write onboarding wiki',       'In review, but Mira is not a reviewer here.',
                                                                              2, 'review',      datetime('now', '+7 hours', 'start of day', '-7 hours', '+1 days'),   NULL, datetime('now', '-30 minutes'), 'file', datetime('now'), datetime('now')),
  (36, 'OPS-0013', 2, 4, 12, 1,    NULL, 'Document VPN setup',          'An extension request is pending: a second one is refused.',
                                                                              3, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+1 days'),   NULL, NULL, NULL, datetime('now'), datetime('now')),
  (37, 'OPS-0014', 2, 4, 11, 1,    NULL, 'Update wiki theme',           'Overdue; one extension approved and one rejected before, none pending.',
                                                                              2, 'in_progress', datetime('now', '+7 hours', 'start of day', '-7 hours', '-1 days'),   NULL, NULL, NULL, datetime('now'), datetime('now')),
  -- contracts: a project in a division Mira is not in
  (38, 'LGL-0001', 3, 5, 2,  1,    NULL, 'Review NDA template',         NULL, 4, 'waiting',     datetime('now', '+7 hours', 'start of day', '-7 hours', '+1 days', '+9 hours'), NULL, NULL, NULL, datetime('now'), datetime('now')),
  (39, 'LGL-0002', 3, 5, 2,  1,    NULL, 'Sign vendor contract',        NULL, 3, 'done',        datetime('now', '+7 hours', 'start of day', '-7 hours', '-4 days'),   datetime('now', '-4 days'), NULL, NULL, datetime('now'), datetime('now')),
  -- Hidden from Mira: 403 by id
  (40, 'LGL-0003', 3, NULL, 2, 2,  NULL, 'Renew trademark',             'legal division only; Mira is not a member.', 2, 'waiting', NULL, NULL, NULL, NULL, datetime('now'), datetime('now')),
  (41, 'OLD-0001', 4, 6,    1, 1,  NULL, 'Retire the old site',         'Its division is deleted.',                   2, 'waiting', NULL, NULL, NULL, NULL, datetime('now'), datetime('now')),
  (42, 'TECH-0002', 1, 7,   2, 1,  NULL, 'Delete old builds',           'Its project is archived.',                   1, 'waiting', NULL, NULL, NULL, NULL, datetime('now'), datetime('now'));

INSERT INTO comments (task_id, user_id, comment, deleted_at, created_at, updated_at) VALUES
  (30, 8, 'The big desk does not fit the lift.',      NULL,                          datetime('now', '-1 days'),    datetime('now', '-1 days')),
  (30, 9, 'Comment from Hadi, now inactive.',         NULL,                          datetime('now', '-20 hours'),  datetime('now', '-20 hours')),
  (30, 1, 'Deleted, so it never shows.',              datetime('now', '-10 hours'),  datetime('now', '-12 hours'),  datetime('now', '-12 hours')),
  (30, 1, 'We take it apart first.',                  NULL,                          datetime('now', '-5 minutes'), datetime('now', '-5 minutes'));

INSERT INTO proofs (task_id, user_id, file, created_at, updated_at) VALUES
  (25, 8, 'https://photos.example.com/extinguishers.jpg',   datetime('now', '-2 hours'),  datetime('now', '-2 hours')),
  (29, 9, 'https://photos.example.com/wifi-first-try.jpg',  datetime('now', '-1 days'),   datetime('now', '-1 days')),
  (29, 9, 'https://photos.example.com/wifi-second-try.jpg', datetime('now', '-1 hours'),  datetime('now', '-1 hours')),
  (31, 8, 'https://photos.example.com/cables.jpg',          datetime('now', '-26 hours'), datetime('now', '-26 hours')),
  (35, 8, 'https://docs.example.com/onboarding-wiki',       datetime('now', '-30 minutes'), datetime('now', '-30 minutes'));

INSERT INTO task_reviews (task_id, reviewer_id, decision, reason, created_at, updated_at) VALUES
  (29, 1, 'rejected', 'The router is not in the photo.', datetime('now', '-20 hours'), datetime('now', '-20 hours')),
  (31, 1, 'approved', NULL,                              datetime('now', '-20 hours'), datetime('now', '-20 hours'));

INSERT INTO task_deadline_requests (task_id, requester_id, decided_by, current_due_date, requested_due_date, reason, status, decision_reason, decided_at, created_at, updated_at) VALUES
  (36, 1, NULL, datetime('now', '+7 hours', 'start of day', '-7 hours', '+1 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '+5 days'), 'Waiting on the VPN vendor.', 'pending',  NULL, NULL, datetime('now', '-3 hours'), datetime('now', '-3 hours')),
  (37, 1, 11,   datetime('now', '+7 hours', 'start of day', '-7 hours', '-5 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '-3 days'), 'Design review moved.',       'approved', NULL, datetime('now', '-5 days'), datetime('now', '-6 days'), datetime('now', '-5 days')),
  (37, 1, 11,   datetime('now', '+7 hours', 'start of day', '-7 hours', '-3 days'),  datetime('now', '+7 hours', 'start of day', '-7 hours', '+2 days'), 'Still waiting on design.',   'rejected', 'Ship what we have.', datetime('now', '-3 days'), datetime('now', '-4 days'), datetime('now', '-3 days'));

-- Mira's bell: each type, read and unread, and one whose actor no longer exists ("Someone").
INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, read_at, created_at, updated_at) VALUES
  ('case-0001', 'task_assigned',         'user', 1, '{"taskId":28,"taskName":"Survey the new site","actorId":11}',                   NULL,                       datetime('now', '-10 minutes'), datetime('now', '-10 minutes')),
  ('case-0002', 'task_review_requested', 'user', 1, '{"taskId":25,"taskName":"Check fire extinguishers","actorId":8}',               NULL,                       datetime('now', '-2 hours'),    datetime('now', '-2 hours')),
  ('case-0003', 'task_review_requested', 'user', 1, '{"taskId":29,"taskName":"Install wifi","actorId":9}',                           NULL,                       datetime('now', '-1 hours'),    datetime('now', '-1 hours')),
  ('case-0004', 'task_reviewed',         'user', 1, '{"taskId":39,"taskName":"Sign vendor contract","actorId":2,"approved":true}',   datetime('now', '-3 days'), datetime('now', '-4 days'),     datetime('now', '-4 days')),
  ('case-0005', 'task_assigned',         'user', 1, '{"taskId":38,"taskName":"Review NDA template","actorId":999}',                  datetime('now', '-1 days'), datetime('now', '-2 days'),     datetime('now', '-2 days')),
  ('case-0006', 'task_reviewed',         'user', 8, '{"taskId":29,"taskName":"Install wifi","actorId":1,"approved":false}',         NULL,                       datetime('now', '-20 hours'),   datetime('now', '-20 hours'));

-- Indah has no team at all: only her private tab.
INSERT INTO personal_tasks (id, user_id, parent_id, title, note, status, priority_level, due_date, completed_at, created_at, updated_at) VALUES
  (9,  10, NULL, 'Ask HR which team I join', 'No division or project yet.', 'todo', 3, datetime('now', '+7 hours', 'start of day', '-7 hours'), NULL, datetime('now'), datetime('now')),
  (10, 10, NULL, 'Set up laptop',            NULL,                          'done', 2, NULL, datetime('now', '-1 days'), datetime('now'), datetime('now')),
  -- Mira: a personal task with a note and a time of day.
  (11, 1,  NULL, 'Call the bank',            'Ask about the card limit.',   'in_progress', 4, datetime('now', '+7 hours', 'start of day', '-7 hours', '+16 hours'), NULL, datetime('now'), datetime('now'));
