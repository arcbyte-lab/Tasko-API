/**
 * Prints the SQL that creates real users, with passwords hashed as login checks them.
 *
 *   bun scripts/users-sql.ts users.json > users.sql
 *   bunx wrangler d1 execute DB --remote --file users.sql
 *
 * users.json: [{ "name": "Mira", "email": "mira@example.com", "password"?: "..." }]
 * A user without a password gets a random one, printed to stderr to hand out.
 * Everyone starts with must_change_password = 1. Keep users.json and users.sql
 * out of git (both are ignored) and delete them once applied.
 */
import { hashPassword } from '../src/auth'

type NewUser = { name: string; email: string; password?: string }

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
const randomPassword = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, '').slice(0, 16)

/** One insert per user, and the passwords that were generated, by email. */
export async function usersSql(users: NewUser[]) {
  const generated: Record<string, string> = {}
  const statements: string[] = []
  for (const u of users) {
    if (typeof u.name !== 'string' || !u.name.trim() || typeof u.email !== 'string' || !u.email.includes('@')) {
      throw new Error(`Each user needs a name and an email: ${JSON.stringify(u)}`)
    }
    const password = u.password || (generated[u.email.trim()] = randomPassword())
    statements.push(
      `insert into users (name, email, password, must_change_password, created_at, updated_at) values (${quote(u.name.trim())}, ${quote(u.email.trim())}, ${quote(await hashPassword(password))}, 1, datetime('now'), datetime('now'));`,
    )
  }
  return { statements, generated }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: bun scripts/users-sql.ts users.json > users.sql')
  const { statements, generated } = await usersSql(JSON.parse(await Bun.file(path).text()))
  console.log(statements.join('\n'))
  for (const [email, password] of Object.entries(generated)) console.error(`${email}\t${password}`)
}
