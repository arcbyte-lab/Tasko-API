import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, login } from './helpers'

// Ana is tech's admin, so she sets repeats up and sees the view; Mira is a plain member and ticks them (0012).
let mira: string, ana: string
beforeEach(async () => {
  mira = await login()
  ana = await login('ana@arcbyte.dev')
})

const send = (method: string, path: string, body: unknown, token = ana) => api(token, path, { method, body: JSON.stringify(body) })
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>
const WEEKLY = { every: 1, unit: 'week' }

/** A weekly task for Mira, due at [due]; returns its id. */
const repeatingTask = async (name: string, due: string) =>
  (await json(send('POST', '/tabs/division/1/tasks', { name, priority: 2, assigneeId: 1, dueDate: due, repeat: WEEKLY }))).id as number
const tick = (id: number) => send('PATCH', `/tasks/${id}/status`, { status: 'done' }, mira)
const live = async (name: string) => (await json(api(ana, '/divisions/1/repeating'))).find((s: any) => s.task.name === name)

describe('the repeating view (0012)', () => {
  it('is for division leads only', async () => {
    const id = await repeatingTask('Backup check', '2030-01-07T02:00:00Z')
    expect((await api(mira, '/divisions/1/repeating')).status).toBe(403)
    expect((await api(mira, `/series/${id}`)).status).toBe(403)
    expect((await api(ana, '/series/999999')).status).toBe(404)
  })

  it('lists each live series with how its last occurrences went, newest first', async () => {
    const first = await repeatingTask('Backup check', '2030-01-07T02:00:00Z')
    await tick(first) // done now, years early: on time
    const second = (await live('Backup check')).task.id
    await tick(second)
    await env.DB.prepare("update tasks set completed_date = '2031-01-01 00:00:00' where id = ?").bind(second).run() // late
    const series = await live('Backup check')
    expect(series.task).toMatchObject({ dueDate: '2030-01-21T02:00:00Z', seriesId: first, status: 'waiting' })
    expect(series.recent.map((r: any) => [r.dueDate, r.onTime])).toEqual([
      ['2030-01-14T02:00:00Z', false],
      ['2030-01-07T02:00:00Z', true],
    ])
  })

  it('drops a series once it stops repeating', async () => {
    const id = await repeatingTask('Backup check', '2030-01-07T02:00:00Z')
    expect(await live('Backup check')).toBeDefined()
    await send('PATCH', `/tasks/${id}`, { repeat: null })
    expect(await live('Backup check')).toBeUndefined()
  })

  it('history: every occurrence newest first; a proof task counts from when it was sent for review', async () => {
    const id = await repeatingTask('Weekly report', '2026-01-01T00:00:00Z')
    await env.DB.prepare("update tasks set required_proof_type = 'image' where id = ?").bind(id).run()
    await send('PATCH', `/tasks/${id}/status`, { status: 'review', proofUrl: 'https://example.com/report' }, mira)
    await env.DB.prepare("update tasks set review_date = '2025-12-31 00:00:00' where id = ?").bind(id).run()
    await send('POST', `/tasks/${id}/reviews`, { approve: true }) // approved today, long after the due date
    const history = await json(api(ana, `/series/${id}`))
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ task: { status: 'waiting', dueDate: '2026-01-08T00:00:00Z' }, onTime: null, finishedAt: null, proofUrl: null })
    expect(history[1]).toMatchObject({ task: { id }, onTime: true, finishedAt: '2025-12-31T00:00:00Z', proofUrl: 'https://example.com/report' })
  })
})

describe('deleting a repeating task (0012)', () => {
  it('deletes the open task while it is waiting; finished ones stay', async () => {
    const first = await repeatingTask('Backup check', '2030-01-07T02:00:00Z')
    await tick(first)
    expect((await api(mira, `/series/${first}`, { method: 'DELETE' })).status, 'not a lead').toBe(403)
    expect((await api(ana, `/series/${first}`, { method: 'DELETE' })).status).toBe(204)
    expect(await live('Backup check')).toBeUndefined()
    const history = await json(api(ana, `/series/${first}`))
    expect(history.map((o: any) => o.task.id)).toEqual([first])
    expect((await api(ana, `/series/${first}`, { method: 'DELETE' })).status, 'nothing left to delete').toBe(404)
  })

  it('refuses once the open task is started or in review', async () => {
    for (const status of ['in_progress', 'review']) {
      const id = await repeatingTask(`Report ${status}`, '2030-01-07T02:00:00Z')
      await env.DB.prepare('update tasks set status = ? where id = ?').bind(status, id).run()
      expect((await api(ana, `/series/${id}`, { method: 'DELETE' })).status, status).toBe(409)
      expect(await live(`Report ${status}`), status).toBeDefined()
    }
  })
})
