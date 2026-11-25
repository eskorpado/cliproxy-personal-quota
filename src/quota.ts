import { CpaError, type CpaApi } from "./cpa.ts"
import { allocation, record, tierMatches, utc, type Policy, type PoolPolicy, type WindowPolicy } from "./policy.ts"
import type { LiveSnapshot, QuotaWindow } from "./view.ts"

const MINUTE = 60_000
const DAY = 86_400_000
type Interval = { from: number; to: number; end?: number }
type Meter = Extract<PoolPolicy["meter"], { source: "cpa.cost" }>
type Account = { index: string; category: string; active: boolean }
type Previous = { share: number; index: string; window: QuotaWindow; end: number; asOf: number }
type MeteredSnapshot = { view: LiveSnapshot; fixed: Map<string, Previous>; knownPools: Set<string> }
export type { MeteredSnapshot }

function invalid(): never { throw new CpaError(0) }
function data(value: unknown) { return record(value) ?? invalid() }
function nonnegative(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n) && n >= 0 }
function requestCount(n: unknown): n is number { return nonnegative(n) && Number.isSafeInteger(n) }
function unavailable(w: WindowPolicy, detail: string, status: "missing" | "partial" = "missing"): QuotaWindow {
  return { title: w.title, status, pct: null, detail }
}

export function windowInterval(w: WindowPolicy, now: number): Interval | undefined {
  const length = w.seconds * 1000
  const b = w.boundary
  if (b.type === "rolling") return { from: now - length, to: now }
  if (b.anchor === null) return
  const from = b.anchor + Math.floor((now - b.anchor) / length) * length
  return { from, to: now, end: from + length }
}

function inventory(value: unknown): Account[] {
  const { files } = data(value)
  if (!Array.isArray(files) || files.length > 2000) invalid()
  const accounts = files.map(raw => {
    const f = data(raw)
    if (typeof f.auth_index !== "string" || !f.auth_index || f.auth_index.length > 512 || typeof f.category !== "string" || !f.category ||
      [f.disabled, f.unavailable].some(v => v !== undefined && typeof v !== "boolean")) invalid()
    return { index: f.auth_index, category: f.category, active: !f.disabled && !f.unavailable }
  })
  if (new Set(accounts.map(a => a.index)).size !== accounts.length) invalid()
  return accounts
}

type Totals = Map<string, { requests: number; cost: number }>

async function usage(api: CpaApi, query: Record<string, string>): Promise<Totals> {
  const { models } = data(await api("/usage/models", query))
  if (!Array.isArray(models)) invalid()
  const rows: Totals = new Map()
  for (const raw of models) {
    const row = data(raw)
    if (typeof row.model !== "string" || rows.has(row.model) || !requestCount(row.requests) || row.requests < 1 || !nonnegative(row.cost_usd)) invalid()
    rows.set(row.model, { requests: row.requests, cost: row.cost_usd })
  }
  return rows
}

function merge(totals: Totals, model: string, requests: number, cost: number) {
  const row = totals.get(model)
  totals.set(model, { requests: (row?.requests ?? 0) + requests, cost: (row?.cost ?? 0) + cost })
}

function equal(a: Totals, b: Totals) {
  return a.size === b.size && [...a].every(([model, row]) => {
    const other = b.get(model)
    return other && other.requests === row.requests && Math.abs(other.cost - row.cost) <= 1e-8 * Math.max(1, row.cost)
  })
}

export function eventSpend(event: Record<string, unknown>, model: string, at: number, meter: Meter): number | undefined {
  const cost = record(event.cost)
  if (!meter.models.has(model) || event.accounting_quality !== "complete" || event.price_source !== "custom" ||
    !cost || cost.currency !== "USD" || !nonnegative(cost.total) || cost.tiered ||
    [cost.image_input_tokens, cost.image_cache_read_tokens, cost.image_output_tokens].some(n => n != null && n !== 0)) return
  const multiplier = cost.multiplier ?? 1
  if (multiplier !== 0 && multiplier !== 1) return
  let factor = 1
  if (meter.tiers) {
    const tier = (value: unknown) => {
      if (typeof value !== "string") return
      if (["default", "standard"].includes(value.toLowerCase())) return "standard"
      if (value.toLowerCase() === "priority") return "priority"
    }
    // Response tier is the executed tier; otherwise use final outbound, never the requested tier.
    const executed = tier(event.response_service_tier || event.effective_service_tier)
    if (executed === "standard") factor = meter.tiers.standard
    else if (executed === "priority") {
      const rule = meter.tiers.priority.find(([pattern]) => tierMatches(pattern, model))
      if (!rule) return
      factor = rule[1]
    } else return
  }
  if (meter.time) {
    const date = new Date(at), day = date.getUTCDay() || 7, minute = date.getUTCHours() * 60 + date.getUTCMinutes()
    factor *= meter.time.rules.find(rule => rule.weekdays.includes(day) && rule.from <= minute && minute < rule.until)?.factor ?? meter.time.defaultFactor
  }
  const adjusted = cost.total * factor
  return Number.isFinite(adjusted) ? adjusted : undefined
}

const PAGE_SIZE = 250
const MAX_EVENTS = 10_000

async function spend(api: CpaApi, index: string, interval: Interval, meter: Meter): Promise<number | "coverage" | undefined> {
  // At the exact cycle boundary [from, to) is empty; CPA needs a nonempty range.
  if (interval.from === interval.to) return 0
  const range = { from: new Date(interval.from).toISOString(), to: new Date(interval.to).toISOString() }
  const query = { ...range, auth_index: index }
  const expected = await usage(api, query)
  // The default assumes seven days of history. Operators can declare a shorter
  // retention or an explicit guarantee for longer windows in their catalog.
  const coverage = meter.coverage
  if ((coverage?.from !== undefined && interval.from < coverage.from) ||
    interval.from < interval.to - (coverage?.retentionDays ?? 7) * DAY) return "coverage"
  if (!expected.size) return 0
  if ([...expected].some(([model]) => !meter.models.has(model)) || [...expected.values()].reduce((n, row) => n + row.requests, 0) > MAX_EVENTS) return

  const head = data(await api("/events", { ...range, limit: "1" }))
  const snapshot = head.snapshot_id
  const options = record(head.filter_options)?.credential_options
  if (typeof snapshot !== "string" || !/^\d{1,19}$/.test(snapshot) || !Array.isArray(options) || options.length > 64) return
  const ids = new Set<string>(), matched: Totals = new Map(), credentials = new Set<string>()
  let total = 0
  for (const raw of options) {
    const option = record(raw), token = option?.value
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || credentials.has(token)) return
    credentials.add(token)
    // Tokens represent credential names, not auth indices. Use the intersection with
    // this account, and reject a name collision instead of merging histories.
    let intersection: Totals
    try { intersection = await usage(api, { ...query, dimension: "credentials", value: token }) }
    catch (error) {
      if (error instanceof CpaError && error.expiredFilter) continue
      throw error
    }
    const count = [...intersection.values()].reduce((n, row) => n + row.requests, 0)
    if (!count) continue
    if (count !== option?.count || ids.size + count > MAX_EVENTS) return
    const seen: Totals = new Map()
    for (let offset = 0; offset < count; offset += PAGE_SIZE) {
      const page = data(await api("/events", { ...range, credential: token, snapshot_id: snapshot, limit: String(PAGE_SIZE), offset: String(offset) }))
      if (page.snapshot_id !== snapshot || page.total !== count || !Array.isArray(page.entries) || page.entries.length !== Math.min(PAGE_SIZE, count - offset)) return
      for (const raw of page.entries) {
        const event = record(raw), id = event?.id
        if (!event || typeof id !== "string" || !/^\d{1,19}$/.test(id) || ids.has(id)) return
        ids.add(id)
        const at = utc(event.at), model = event.billing_model || event.upstream_model, cost = record(event.cost)
        if (!(at >= interval.from && at < interval.to) || typeof model !== "string" || !cost || !nonnegative(cost.total)) return
        const adjusted = eventSpend(event, model, at, meter)
        if (adjusted === undefined) return
        merge(seen, model, 1, cost.total)
        total += adjusted
      }
    }
    if (!equal(intersection, seen)) return
    for (const [model, row] of seen) merge(matched, model, row.requests, row.cost)
  }
  return equal(expected, matched) && Number.isFinite(total) ? total : undefined
}

function staleWindow(previous: Previous | undefined, index: string, share: number, now: number, end?: number) {
  if (previous && previous.index === index && previous.share === share && previous.end > now && (end === undefined || end === previous.end))
    return { ...previous.window, staleAsOf: previous.asOf }
}

export async function measure(api: CpaApi, policy: Policy, now: number, previous?: MeteredSnapshot): Promise<MeteredSnapshot> {
  const profile = data(await api("/profile"))
  if (profile.tracked === false) throw new CpaError(401)
  if (profile.tracked !== true) invalid()
  const label = data(profile.identity).label
  if (label !== undefined && typeof label !== "string") invalid()
  const assigned = policy.pools.flatMap(pool => {
    const share = allocation(label ?? "", pool.id)
    return share ? [{ pool, share }] : []
  })
  const fixed = new Map<string, Previous>(), pools: LiveSnapshot["pools"] = [], knownPools = new Set<string>()
  if (!assigned.length) return { view: { pools, asOf: now }, fixed, knownPools }
  // A failed inventory must not be treated as successful account removal. Profile must
  // have been rechecked first, so do not reuse numbers after a share change.
  let accounts: Account[]
  try { accounts = inventory(await api("/auth-files")) } catch (error) {
    if (error instanceof CpaError && [401, 403].includes(error.status)) throw error
    for (const { pool, share } of assigned) {
      if (!previous?.knownPools.has(pool.id)) continue
      knownPools.add(pool.id)
      const windows = pool.windows.map(w => {
        const key = `${pool.id}/${w.id}`, old = previous?.fixed.get(key)
        const stale = old && staleWindow(old, old.index, share, now)
        if (stale && old) fixed.set(key, old)
        return stale ?? unavailable(w, "Не удалось проверить доступные аккаунты в CPA.")
      })
      pools.push({ modelFamilyPrefix: pool.modelFamilyPrefix, windows })
    }
    return { view: { pools, asOf: previous?.view.asOf ?? null, issue: "unreachable" }, fixed, knownPools }
  }

  for (const { pool, share } of assigned) {
    const accountsForPool = accounts.filter(a => a.active && a.category === pool.category && (!pool.authIndex || pool.authIndex === a.index))
    if (accountsForPool.length === 0) continue
    if (accountsForPool.length > 1) {
      knownPools.add(pool.id)
      pools.push({ modelFamilyPrefix: pool.modelFamilyPrefix, windows: pool.windows.map(w => unavailable(w, "Несколько активных аккаунтов. Нужна явная привязка в каталоге.")) })
      continue
    }
    const [account] = accountsForPool
    const windows: QuotaWindow[] = []
    let revoked = false
    for (const w of pool.windows) {
      const key = `${pool.id}/${w.id}`, old = previous?.fixed.get(key)
      const interval = windowInterval(w, now)
      const resetAt = interval?.end
      const withReset = (window: QuotaWindow) => resetAt === undefined ? window : { ...window, resetAt }
      const fallback = (detail: string, end?: number) => {
        const stale = staleWindow(old, account.index, share, now, end)
        if (stale && old) fixed.set(key, old)
        return stale ?? withReset(unavailable(w, detail))
      }
      if (pool.meter.source === "serverSummary") { windows.push(withReset(unavailable(w, "Для этого источника ещё нет серверного адаптера."))); continue }
      if (!interval) {
        windows.push(unavailable(w, "Граница цикла не задана в каталоге."))
        continue
      }
      try {
        const used = await spend(api, account.index, interval, pool.meter)
        if (typeof used !== "number") {
          windows.push(withReset(unavailable(w, used === "coverage" ? "Не подтверждено, что журнал CPA покрывает всё окно." :
            "Не удалось подтвердить сопоставимость начислений или их привязку к аккаунту.", "partial")))
          continue
        }
        const budget = w.capacity * share / 100
        if (!(budget > 0)) { windows.push(withReset(unavailable(w, "Не удалось определить личный бюджет."))); continue }
        const window = withReset({
          title: w.title, status: used > budget ? "over" : "ok", pct: Math.max(0, 1 - used / budget) * 100,
          validUntil: interval.end ?? now + 6 * MINUTE,
        })
        windows.push(window)
        if (interval.end !== undefined) fixed.set(key, { share, index: account.index, window, end: interval.end, asOf: now })
      } catch (error) {
        if (error instanceof CpaError && error.status === 401) throw error
        if (error instanceof CpaError && [403, 404].includes(error.status) && error.route === "/usage/models") { revoked = true; break }
        windows.push(fallback("Не удалось прочитать расход в CPA.", interval.end))
      }
    }
    if (revoked) { for (const w of pool.windows) fixed.delete(`${pool.id}/${w.id}`); continue }
    knownPools.add(pool.id)
    pools.push({ modelFamilyPrefix: pool.modelFamilyPrefix, windows })
  }
  return { view: { pools, asOf: now }, fixed, knownPools }
}
