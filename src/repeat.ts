import { HTTPException } from 'hono/http-exception'

/**
 * A workspace task's repeat rule, stored as JSON in `tasks.repeat`. Santian's
 * model: the rule rides on the task, and finishing it creates the next one,
 * due one step later. `count` is how many occurrences are left, this one
 * included; `until` is the last local day one may fall on.
 */
export type Repeat = {
  every: number
  unit: 'day' | 'week' | 'month' | 'year'
  weekdays: number[]
  until: string | null
  count: number | null
}

const UNITS = ['day', 'week', 'month', 'year']
const bad = (message: string) => new HTTPException(400, { message })

/** The body's `repeat`, checked, as the JSON to store; null turns it off. */
export function readRepeat(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('repeat must be an object or null')
  const { every, unit, weekdays = [], until = null, count = null } = v as Record<string, unknown>
  if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 999) throw bad('repeat.every must be 1 to 999')
  if (typeof unit !== 'string' || !UNITS.includes(unit)) throw bad('repeat.unit must be one of ' + UNITS.join(', '))
  if (!Array.isArray(weekdays) || !weekdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    throw bad('repeat.weekdays must be ISO weekdays, 1 (Monday) to 7')
  }
  if (until !== null && (typeof until !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(until))) throw bad('repeat.until must be YYYY-MM-DD or null')
  if (count !== null && (!Number.isInteger(count) || (count as number) < 1)) throw bad('repeat.count must be at least 1, or null')
  if (until !== null && count !== null) throw bad('repeat ends on a date or after a count, not both')
  const days = unit === 'week' ? [...new Set(weekdays as number[])].sort() : []
  return JSON.stringify({ every, unit, weekdays: days, until, count } satisfies Repeat)
}

// ponytail: the team's day is fixed UTC+7, as in seed.sql; take the zone from the task's creator if the team spans zones.
const OFFSET = 7 * 3600_000

/**
 * The next due date after [due] (D1's UTC `YYYY-MM-DD HH:MM:SS`), or null when
 * the rule has run out. Worked out on the team's wall clock, so the time of
 * day and the weekday stay put. Month ends clamp: Jan 31 + 1 month is Feb 28.
 */
export function nextDue(due: string, r: Repeat): string | null {
  if (r.count !== null && r.count <= 1) return null
  const d = new Date(Date.parse(due.replace(' ', 'T') + 'Z') + OFFSET)
  const addDays = (n: number) => d.setUTCDate(d.getUTCDate() + n)
  if (r.unit === 'day') addDays(r.every)
  else if (r.unit === 'week' && r.weekdays.length) {
    const today = d.getUTCDay() || 7
    const later = r.weekdays.find((w) => w > today)
    // A later weekday in this week comes first; past the last, jump [every] weeks from this Monday.
    if (later) addDays(later - today)
    else addDays(7 * r.every - (today - 1) + (r.weekdays[0] - 1))
  } else if (r.unit === 'week') addDays(7 * r.every)
  else {
    const months = r.unit === 'month' ? r.every : 12 * r.every
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + months)
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, last))
  }
  if (r.until !== null && d.toISOString().slice(0, 10) > r.until) return null
  return new Date(d.getTime() - OFFSET).toISOString().slice(0, 19).replace('T', ' ')
}
