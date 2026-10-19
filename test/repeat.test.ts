import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextDue, type Repeat } from '../src/repeat'
import { api, login } from './helpers'

// Wall-clock times are the team's UTC+7, stored as UTC: 09:00 local is 02:00Z.
const rule = (r: Partial<Repeat>): Repeat => ({ every: 1, unit: 'day', weekdays: [], until: null, count: null, ...r })

describe('nextDue', () => {
  it('steps days, weeks, months and years, keeping the local time', () => {
    expect(nextDue('2026-10-14 02:00:00', rule({ every: 3 }))).toBe('2026-10-17 02:00:00')
    expect(nextDue('2026-10-14 02:00:00', rule({ unit: 'week', every: 2 }))).toBe('2026-10-28 02:00:00')
    expect(nextDue('2026-10-14 02:00:00', rule({ unit: 'month' }))).toBe('2026-11-14 02:00:00')
    expect(nextDue('2026-10-14 02:00:00', rule({ unit: 'year' }))).toBe('2027-10-14 02:00:00')
  })

  it('clamps month ends: Jan 31 → Feb 28, Feb 29 → Feb 28 next year', () => {
    expect(nextDue('2027-01-31 02:00:00', rule({ unit: 'month' }))).toBe('2027-02-28 02:00:00')
    expect(nextDue('2028-02-29 02:00:00', rule({ unit: 'year' }))).toBe('2029-02-28 02:00:00')
  })

  it('weekdays: the next one this week, then [every] weeks on from this Monday', () => {
    const monThu = rule({ unit: 'week', weekdays: [1, 4] })
    expect(nextDue('2026-10-12 02:00:00', monThu), 'Mon → Thu').toBe('2026-10-15 02:00:00')
    expect(nextDue('2026-10-15 02:00:00', monThu), 'Thu → next Mon').toBe('2026-10-19 02:00:00')
    expect(nextDue('2026-10-15 02:00:00', { ...monThu, every: 2 }), 'Thu → Mon in two weeks').toBe('2026-10-26 02:00:00')
  })

  it('works on the local day: 06:00 Monday local is still Sunday in UTC', () => {
    expect(nextDue('2026-10-11 23:00:00', rule({ unit: 'week', weekdays: [1, 3] }))).toBe('2026-10-13 23:00:00')
  })

  it('stops after the count or past the until day', () => {
    expect(nextDue('2026-10-14 02:00:00', rule({ count: 1 }))).toBeNull()
    expect(nextDue('2026-10-14 02:00:00', rule({ count: 2 }))).toBe('2026-10-15 02:00:00')
    expect(nextDue('2026-10-14 02:00:00', rule({ until: '2026-10-15' }))).toBe('2026-10-15 02:00:00')
    expect(nextDue('2026-10-15 02:00:00', rule({ until: '2026-10-15' }))).toBeNull()
  })
})

// Mira is a plain member of tech and the assignee of task 23; Ana is tech's admin, so she sets up repeats (0012).
let mira: string, ana: string
beforeEach(async () => {
  mira = await login()
  ana = await login('ana@arcbyte.dev')
})

const send = (method: string, path: string, body: unknown, token = ana) => api(token, path, { method, body: JSON.stringify(body) })
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>
const WEEKLY = { every: 1, unit: 'week', weekdays: [4, 1, 1] }
const workspaceTasks = async () => json(api(mira, '/tabs/division/1/tasks'))

describe('a repeating workspace task', () => {
  it('saves the rule, cleaned up, and returns it on the task', async () => {
    const task = await json(send('PATCH', '/tasks/23', { repeat: WEEKLY }))
    expect(task.repeat).toEqual({ every: 1, unit: 'week', weekdays: [1, 4], until: null, count: null })
    expect((await json(send('PATCH', '/tasks/23', { repeat: null }))).repeat).toBeNull()
  })

  it('is refused outside a workspace, on a sub-task, or without a due date', async () => {
    expect((await send('PATCH', '/tasks/1', { repeat: WEEKLY })).status, 'project task').toBe(422)
    expect((await send('PATCH', '/tasks/20', { repeat: WEEKLY })).status, 'sub-task').toBe(422)
    expect((await send('PATCH', '/personal-tasks/1', { repeat: WEEKLY }, mira)).status, 'personal').toBe(422)
    expect((await send('POST', '/tabs/division/1/tasks', { name: 'x', priority: 2, repeat: WEEKLY })).status, 'no due').toBe(422)
    await send('PATCH', '/tasks/23', { repeat: WEEKLY })
    expect((await send('PATCH', '/tasks/23', { dueDate: null })).status, 'clearing the due').toBe(422)
    expect((await send('PATCH', '/tasks/23', { repeat: { every: 0, unit: 'day' } })).status).toBe(400)
    expect((await send('PATCH', '/tasks/23', { repeat: { every: 1, unit: 'day', until: '2027-01-01', count: 3 } })).status).toBe(400)
  })

  it('done creates the next one, a day later, carrying the rule; unticking and ticking again adds no second', async () => {
    const created = await json(
      send('POST', '/tabs/division/1/tasks', {
        name: 'Water plants', priority: 3, assigneeId: 1, dueDate: '2026-10-14T02:00:00Z', repeat: { every: 1, unit: 'day', count: 3 },
      }),
    )
    const done = await json(send('PATCH', `/tasks/${created.id}/status`, { status: 'done' }, mira))
    expect(done.repeat).toBeNull()
    const next = (await workspaceTasks()).find((t: any) => t.name === 'Water plants' && t.id !== created.id)
    expect(next).toMatchObject({ status: 'waiting', priority: 3, assigneeId: 1, dueDate: '2026-10-15T02:00:00Z', code: 'TECH-0003' })
    expect(next.repeat).toMatchObject({ unit: 'day', count: 2 })

    await send('PATCH', `/tasks/${created.id}/status`, { status: 'waiting' }, mira)
    await send('PATCH', `/tasks/${created.id}/status`, { status: 'done' }, mira)
    expect((await workspaceTasks()).filter((t: any) => t.name === 'Water plants')).toHaveLength(2)
  })

  it('the last occurrence creates nothing', async () => {
    await send('PATCH', '/tasks/23', { repeat: { every: 1, unit: 'day', count: 1 } })
    await send('PATCH', '/tasks/23/status', { status: 'done' }, mira)
    expect((await workspaceTasks()).filter((t: any) => t.name === 'Renew SSL certificate')).toHaveLength(1)
  })

  it('with a proof, the next one comes when the review is approved, and keeps the proof rule', async () => {
    await env.DB.prepare("update tasks set required_proof_type = 'image' where id = 23").run()
    await send('PATCH', '/tasks/23', { repeat: { every: 1, unit: 'month' } })
    await send('PATCH', '/tasks/23/status', { status: 'review', proofUrl: 'https://example.com/p' }, mira)
    expect((await workspaceTasks()).filter((t: any) => t.name === 'Renew SSL certificate')).toHaveLength(1)
    expect((await send('POST', '/tasks/23/reviews', { approve: true }, ana)).status).toBe(200)
    const both = (await workspaceTasks()).filter((t: any) => t.name === 'Renew SSL certificate')
    expect(both).toHaveLength(2)
    expect(both[1]).toMatchObject({ requiredProofType: 'image', status: 'waiting', repeat: { unit: 'month' } })
  })
})

describe('repeat is set up by division leads, and occurrences share a series (0012)', () => {
  it('a member who is not a lead gets 403 creating or changing a repeat, but can still edit the task', async () => {
    const due = '2026-10-14T02:00:00Z'
    expect((await send('POST', '/tabs/division/1/tasks', { name: 'x', priority: 2, dueDate: due, repeat: WEEKLY }, mira)).status).toBe(403)
    expect((await send('PATCH', '/tasks/23', { repeat: WEEKLY }, mira)).status, 'assignee').toBe(403)
    await send('PATCH', '/tasks/23', { repeat: WEEKLY })
    expect((await send('PATCH', '/tasks/23', { repeat: null }, mira)).status, 'stopping it').toBe(403)
    // The app sends the rule with every edit: unchanged, it needs no lead.
    const same = await send('PATCH', '/tasks/23', { name: 'Renew SSL', repeat: WEEKLY }, mira)
    expect(same.status).toBe(200)
  })

  it('a new repeating task starts its own series, and the next one keeps it', async () => {
    const created = await json(
      send('POST', '/tabs/division/1/tasks', { name: 'Backup check', priority: 2, assigneeId: 1, dueDate: '2026-10-14T02:00:00Z', repeat: WEEKLY }),
    )
    expect(created.seriesId).toBe(created.id)
    await send('PATCH', `/tasks/${created.id}/status`, { status: 'done' }, mira)
    const next = (await workspaceTasks()).find((t: any) => t.name === 'Backup check' && t.id !== created.id)
    expect(next.seriesId).toBe(created.id)
    expect((await workspaceTasks()).find((t: any) => t.name === 'Renew SSL certificate').seriesId, 'no repeat, no series').toBeNull()
  })

  it('turning a rule off and on again keeps the series', async () => {
    expect((await json(send('PATCH', '/tasks/23', { repeat: WEEKLY }))).seriesId).toBe(23)
    expect((await json(send('PATCH', '/tasks/23', { repeat: null }))).seriesId).toBe(23)
    expect((await json(send('PATCH', '/tasks/23', { repeat: WEEKLY }))).seriesId).toBe(23)
  })
})
