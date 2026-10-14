/**
 * Prints the SQL that creates real users, with passwords hashed as login checks them.
 *
 *   bun scripts/users-sql.ts users.json > users.sql
 *   bunx wrangler d1 execute DB --remote --file users.sql
 *
 * users.json: [{ "name": "Mira", "email": "mira@example.com", "password"?: "..." }]
 * or, to also create divisions and who is in them (arcbyte decision 0010):
 *   { "divisions": [{ "prefix": "TECH", "name": "Tech" }],
 *     "users": [{ "name": "Mira", "email": "...", "divisions": { "TECH": "admin" } }] }
 * Divisions and memberships are `insert or ignore`, so listing one that exists is harmless.
 * A user without a password gets a random one, printed to stderr to hand out.
 * Everyone starts with must_change_password = 1. Keep users.json and users.sql
 * out of git (both are ignored) and delete them once applied.
 */
import { hashPassword } from '../src/auth'

const ROLES = ['admin', 'supervisor', 'member', 'viewer']

type NewUser = { name: string; email: string; password?: string; divisions?: Record<string, string> }
type NewDivision = { prefix: string; name: string }
type Input = NewUser[] | { divisions?: NewDivision[]; users: NewUser[] }

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
const randomPassword = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, '').slice(0, 16)

/** Inserts for the divisions, the users and their memberships, and the passwords that were generated, by email. */
export async function usersSql(input: Input) {
  const { divisions = [], users } = Array.isArray(input) ? { users: input } : input
  const generated: Record<string, string> = {}
  const statements: string[] = []
  for (const d of divisions) {
    if (typeof d.prefix !== 'string' || !d.prefix.trim() || typeof d.name !== 'string' || !d.name.trim()) {
      throw new Error(`Each division needs a prefix and a name: ${JSON.stringify(d)}`)
    }
    const name = d.name.trim()
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    statements.push(
      `insert or ignore into divisions (prefix, name, slug, created_at, updated_at) values (${quote(d.prefix.trim())}, ${quote(name)}, ${quote(slug)}, datetime('now'), datetime('now'));`,
    )
  }
  const prefixes = new Set(divisions.map((d) => d.prefix.trim()))
  const memberships: string[] = []
  for (const u of users) {
    if (typeof u.name !== 'string' || !u.name.trim() || typeof u.email !== 'string' || !u.email.includes('@')) {
      throw new Error(`Each user needs a name and an email: ${JSON.stringify(u)}`)
    }
    const password = u.password || (generated[u.email.trim()] = randomPassword())
    statements.push(
      `insert into users (name, email, password, must_change_password, created_at, updated_at) values (${quote(u.name.trim())}, ${quote(u.email.trim())}, ${quote(await hashPassword(password))}, 1, datetime('now'), datetime('now'));`,
    )
    for (const [prefix, role] of Object.entries(u.divisions ?? {})) {
      if (!prefixes.has(prefix)) throw new Error(`${u.email}: no division with prefix ${prefix}`)
      if (!ROLES.includes(role)) throw new Error(`${u.email}: role must be one of ${ROLES.join(', ')}, not ${role}`)
      memberships.push(
        `insert or ignore into division_members (user_id, division_id, role_type, created_at, updated_at) select u.id, d.id, ${quote(role)}, datetime('now'), datetime('now') from users u, divisions d where u.email = ${quote(u.email.trim())} and d.prefix = ${quote(prefix)};`,
      )
    }
  }
  return { statements: [...statements, ...memberships], generated }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: bun scripts/users-sql.ts users.json > users.sql')
  const { statements, generated } = await usersSql(JSON.parse(await Bun.file(path).text()))
  console.log(statements.join('\n'))
  for (const [email, password] of Object.entries(generated)) console.error(`${email}\t${password}`)
}
