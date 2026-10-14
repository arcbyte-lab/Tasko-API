import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { api, login } from './helpers'

// Project 2 (tasko-web): Mira (1) is the only owner, Ana (2) person-in-charge, Budi (3) and 4–7 members.
let mira: string, ana: string, budi: string
beforeEach(async () => {
  ;[mira, ana, budi] = await Promise.all([login(), login('ana@arcbyte.dev'), login('budi@arcbyte.dev')])
})

const add = (token: string, body: unknown) => api(token, '/projects/2/members', { method: 'POST', body: JSON.stringify(body) })
const setRole = (token: string, userId: number, role: string) =>
  api(token, `/projects/2/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) })
const remove = (token: string, userId: number) => api(token, `/projects/2/members/${userId}`, { method: 'DELETE' })

async function newUser(active = 1) {
  const row = await env.DB.prepare("insert into users (name, email, password, is_active) values ('Lina', 'lina@example.com', 'x', ?) returning id")
    .bind(active)
    .first<{ id: number }>()
  return row!.id
}

it('a manager adds someone directly, who is told about it (0010)', async () => {
  const lina = await newUser()
  const res = await add(ana, { userId: lina })
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({ user: { id: lina, name: 'Lina' }, role: 'member' })
  expect(await env.DB.prepare('select role, invited_by from project_members where project_id = 2 and user_id = ?').bind(lina).first()).toEqual({
    role: 'member',
    invited_by: 2,
  })
  const n = await env.DB.prepare("select type, data from notifications where notifiable_type = 'user' and notifiable_id = ?").bind(lina).first<any>()
  expect(n.type).toBe('project_member_added')
  expect(JSON.parse(n.data)).toEqual({ projectId: 2, projectName: 'tasko-web', actorId: 2 })
})

it('refuses an add from a plain member, an owner role from a non-owner, and bad targets', async () => {
  const lina = await newUser()
  expect((await add(budi, { userId: lina })).status).toBe(403)
  expect((await add(ana, { userId: lina, role: 'owner' })).status).toBe(403)
  expect((await add(mira, { userId: 3 })).status).toBe(409)
  expect((await add(mira, { userId: 999 })).status).toBe(404)
  expect((await add(mira, { userId: lina, role: 'boss' })).status).toBe(400)
  expect((await add(mira, { userId: 'x' })).status).toBe(400)
  await env.DB.prepare('update users set is_active = 0 where id = ?').bind(lina).run()
  expect((await add(mira, { userId: lina })).status).toBe(422)
})

it('an owner can add another owner', async () => {
  const lina = await newUser()
  expect((await (await add(mira, { userId: lina, role: 'owner' })).json()) as any).toMatchObject({ role: 'owner' })
})

it('changes roles; only an owner touches the owner role; the last owner stays', async () => {
  const res = await setRole(ana, 3, 'viewer')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ user: { id: 3, name: 'Budi' }, role: 'viewer' })
  expect((await setRole(budi, 4, 'viewer')).status).toBe(403)
  expect((await setRole(ana, 1, 'member')).status).toBe(403)
  expect((await setRole(ana, 3, 'owner')).status).toBe(403)
  expect((await setRole(mira, 999, 'member')).status).toBe(404)
  expect((await setRole(mira, 1, 'member')).status).toBe(422)

  expect((await setRole(mira, 2, 'owner')).status).toBe(200)
  expect((await setRole(mira, 1, 'member')).status).toBe(200)
  expect((await setRole(ana, 2, 'member')).status).toBe(422)
})

it('removes members; a plain member or a non-owner cannot remove an owner', async () => {
  expect((await remove(budi, 2)).status).toBe(403)
  expect((await remove(ana, 1)).status).toBe(403)
  expect((await remove(mira, 999)).status).toBe(404)
  expect((await remove(ana, 3)).status).toBe(204)
  expect((await api(budi, '/tabs/project/2/tasks')).status).toBe(403)
})

it('anyone can leave, except the last owner', async () => {
  expect((await remove(budi, 3)).status).toBe(204)
  expect((await remove(mira, 1)).status).toBe(422)
})

it('a member who leaves loses their open tasks in the project; review and done keep them (0010)', async () => {
  await setRole(mira, 2, 'owner')
  expect((await remove(mira, 1)).status).toBe(204)
  const assignee = (id: number) => env.DB.prepare('select assignee_id from tasks where id = ?').bind(id).first('assignee_id')
  expect(await assignee(6)).toBeNull() // waiting
  expect(await assignee(11)).toBeNull() // in_progress
  expect(await assignee(12)).toBe(1) // review
  expect(await assignee(17)).toBe(1) // done
  expect(await assignee(1)).toBe(1) // another project
})

it('a refused removal unassigns nothing', async () => {
  expect((await remove(mira, 1)).status).toBe(422)
  expect(await env.DB.prepare('select assignee_id from tasks where id = 6').first('assignee_id')).toBe(1)
})
