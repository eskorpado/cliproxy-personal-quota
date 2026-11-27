import assert from "node:assert/strict"
import test from "node:test"
import example from "../quota-policy.example.json" with { type: "json" }
import { CpaClient } from "../src/cpa.ts"
import { liveQuota, type Identity } from "../src/live.ts"
import { allocation, parsePolicy, type PoolPolicy } from "../src/policy.ts"
import { eventSpend, measure, windowInterval, type ReconciliationLog } from "../src/quota.ts"
import { configuredTarget, matchesOrigin } from "../src/target.ts"
import { currentView } from "../src/view.ts"

const at = Date.parse("2026-11-25T12:00:00Z")
const hour = 3_600_000
const origin = "https://cpa.example.org"
const anchors = [[at + 2 * hour], [at + 4 * hour, at + 98 * hour], [null, at + 138 * hour]]
const anchoredExample = { ...example, pools: example.pools.map((pool, i) => ({ ...pool,
  windows: pool.windows.map((window, j) => ({ ...window, boundary: anchors[i][j] === null ? window.boundary : {
    type: "anchored", anchorUtc: new Date(anchors[i][j]!).toISOString(),
  } })),
})) }
const token = "a".repeat(64)
const unrelated = "b".repeat(64)
const model = "gpt-6.2-sol"
const account = { auth_index: "account-a", category: "codex", disabled: false, unavailable: false, quota_supported: true }
const fixtureKey = "synthetic-user-key"
const baseEvent = {
  id: "77", at: "2026-11-25T09:00:00Z", billing_model: model, accounting_quality: "complete", price_source: "custom",
  effective_service_tier: "priority", cost: { currency: "USD", total: 3 },
}
const failedEvent = {
  id: "78", at: "2026-11-25T10:00:00Z", billing_model: "gpt-6-astra", failed: true, stream: true,
  effective_service_tier: "", service_tier: "priority", price_source: "custom",
  error_body: "upstream stream closed before first payload",
  cost: { currency: "USD", total: 0, uncached_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, billed_output_tokens: 0 },
}
type EventFixture = Record<string, unknown> & { billing_model: string; cost: { total: number } }

function codexPolicy(coverage?: { fromUtc?: string; retentionDays?: number }) {
  const pool = example.pools[0], window = pool.windows[0]
  return { ...example, pools: [{
    ...pool, meter: { ...pool.meter, ...(coverage ? { coverage } : {}) },
    windows: [{ ...window, boundary: { type: "fixedReset", resetUtc: new Date(at + hour).toISOString() } }],
  }] }
}

function stub(log?: ReconciliationLog) {
  let now = at, label = "test user quota=20", expectedKey = fixtureKey, files = [account]
  let usageCode = 200, profileCode = 200, inventoryCode = 200, catalogCode = 200
  let events: EventFixture[] = [baseEvent], journal: EventFixture[] | undefined, credentialCount: number | undefined
  let nextCredentialCount: number | undefined
  let catalogue: unknown = codexPolicy()
  const reset = at + hour
  const calls: { path: string; query: URLSearchParams; etag: string | null }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    assert.equal(url.origin, origin)
    assert.equal(init?.redirect, "error")
    assert.equal(init?.method, "GET")
    const path = url.pathname.replace(/^\/v0\/resource\/plugins\/cpa-key-billing/, "")
    calls.push({ path, query: url.searchParams, etag: headers.get("if-none-match") })
    if (path.startsWith("/.well-known")) {
      assert.equal(headers.has("authorization"), false)
      return catalogCode === 304 ? new Response(null, { status: 304 }) : Response.json(catalogue, { status: catalogCode, headers: { ETag: '"catalog"' } })
    }
    assert.equal(headers.get("authorization"), `Bearer ${expectedKey}`)
    assert.equal(url.searchParams.has("key"), false)
    const from = Date.parse(url.searchParams.get("from") ?? ""), to = Date.parse(url.searchParams.get("to") ?? "")
    const inRange = events.filter(event => {
      const timestamp = Date.parse(String(event.at))
      return from <= timestamp && timestamp < to
    })
    switch (path) {
      case "/profile": return Response.json({ tracked: true, identity: { label, preview: "private" } }, { status: profileCode })
      case "/auth-files": return Response.json({ files }, { status: inventoryCode })
      case "/usage/models": {
        assert.equal(url.searchParams.get("auth_index"), account.auth_index)
        const length = 168 * hour
        assert.ok(from >= reset + Math.floor((now - reset) / length) * length && from < to && to <= now)
        if (url.searchParams.get("value") === unrelated) return Response.json({ code: "expired_filter" }, { status: 400 })
        const totals = new Map<string, { model: string; requests: number; cost_usd: number }>()
        for (const event of inRange) {
          const model = event.billing_model
          const row = totals.get(model) ?? { model, requests: 0, cost_usd: 0 }
          row.requests++
          row.cost_usd += event.cost.total
          totals.set(model, row)
        }
        return Response.json({ models: [...totals.values()] }, { status: usageCode })
      }
      case "/events":
        if (url.searchParams.has("credential")) {
          assert.equal(url.searchParams.get("credential"), token)
          assert.equal(url.searchParams.get("snapshot_id"), "81")
          const offset = Number(url.searchParams.get("offset")), size = Number(url.searchParams.get("limit"))
          const entries = journal ?? inRange
          return Response.json({ snapshot_id: "81", total: entries.length, entries: entries.slice(offset, offset + size) })
        }
        const count = nextCredentialCount ?? credentialCount ?? inRange.length
        nextCredentialCount = undefined
        return Response.json({ snapshot_id: "81", filter_options: { credential_options: [{ value: unrelated, count: 3 }, { value: token, count }] } })
      default: throw new Error(`Unexpected test route ${path}`)
    }
  }
  const clock = () => now
  let identity: Identity = { key: fixtureKey }
  const live = liveQuota(async () => identity, new CpaClient(origin, fetcher, clock), clock, log)
  return {
    calls, snapshot: (revalidate = false) => live.snapshot(new AbortController().signal, revalidate),
    label: (s: string) => { label = s }, now: (n: number) => { now = n }, files: (v: typeof files) => { files = v },
    usage: (code: number) => { usageCode = code }, profile: (code: number) => { profileCode = code },
    inventory: (code: number) => { inventoryCode = code },
    catalog: (v: unknown, code = 200) => { catalogue = v; catalogCode = code },
    identity: (v: Identity) => { identity = v; if ("key" in v) expectedKey = v.key },
    count: (n: number) => { credentialCount = n },
    nextCount: (n: number) => { nextCredentialCount = n },
    journal: (v: EventFixture[]) => { journal = v },
    events: (v: EventFixture[]) => { events = v; journal = undefined; credentialCount = undefined },
    empty: () => { events = []; journal = undefined; credentialCount = undefined },
  }
}

test("trusted origin is exact and policy cannot add request targets", () => {
  assert.equal(matchesOrigin(`${origin}/ai/v1`, origin), true)
  for (const bad of ["http://cpa.example.org", "https://other.example.org", "https://cpa.example.org.evil.example", `${origin}:90`, "https://name@cpa.example.org", `blob:${origin}/ai/v1`, `${origin}/v1?token=example`]) assert.equal(matchesOrigin(bad, origin), false)
  assert.deepEqual(configuredTarget({ providerID: "my-cpa", origin: `${origin}/` }), { providerID: "my-cpa", origin })
  for (const bad of [undefined, "/v1", `${origin}/v1`, "http://cpa.example.org", `${origin}?x=y`, `${origin}#fragment`, "https://name@cpa.example.org"]) assert.equal(configuredTarget({ providerID: "my-cpa", origin: bad }), undefined)
  assert.equal(configuredTarget({ origin }), undefined)
  assert.throws(() => parsePolicy({ ...example, schemaVersion: 2 }))
  assert.throws(() => parsePolicy({ ...example, pools: [example.pools[0], example.pools[0]] }))
  assert.equal(parsePolicy(example).pools.find(p => p.modelFamilyPrefix === "kimi")?.category, "kimi-ai")
  assert.equal(parsePolicy({ ...example, pools: [] }).pools.length, 0)
  assert.equal(allocation("key; quota=20, quota.demo-glm=60", "demo-glm"), 60)
  assert.equal(allocation("quota=20 quota.demo-glm=0", "demo-glm"), undefined)
  assert.equal(allocation("quota=20 quota.demo-glm=twenty", "demo-gpt"), 20)
  assert.equal(allocation("quota=20 quota=50", "demo-gpt"), undefined)
  assert.equal(allocation("quota= quota=50", "demo-gpt"), undefined)
  assert.equal(allocation("quota=101", "demo-gpt"), undefined)
})

test("rolling, anchored and unknown boundaries remain independent", () => {
  const [codex, , zai] = parsePolicy(example).pools
  assert.equal(windowInterval(zai.windows[1], at), undefined)
  assert.deepEqual(windowInterval(zai.windows[0], at), { from: at - 5 * hour, to: at })
  const anchorWindow = { ...zai.windows[1], boundary: { type: "anchored" as const, anchor: at - 9 * 24 * hour } }
  assert.deepEqual(windowInterval(anchorWindow, at), { from: at - 2 * 24 * hour, to: at, end: at + 5 * 24 * hour })
  assert.equal(windowInterval(codex.windows[0], at), undefined)
  const legacy = { ...example, pools: [{ ...example.pools[0], windows: [{ ...example.pools[0].windows[0], boundary: { type: "reportedReset", row: { window_seconds: 604800 } } }] }] }
  assert.equal(windowInterval(parsePolicy(legacy).pools[0].windows[0], at), undefined)
})

test("an anchored weekly reset repeats independently of the rolling window", () => {
  const zai = parsePolicy(anchoredExample).pools.find(p => p.id === "demo-glm")!
  const [short, week] = zai.windows
  const reset = anchors[2][1]!
  const prior = reset - 168 * hour, next = reset + 168 * hour
  assert.deepEqual(windowInterval(week, at), { from: prior, to: at, end: reset })
  assert.deepEqual(windowInterval(week, reset), { from: reset, to: reset, end: next })
  assert.deepEqual(windowInterval(short, reset), { from: reset - 5 * hour, to: reset })
})

test("Codex and both Kimi windows roll over independently from their catalog anchors", async () => {
  const p = parsePolicy(anchoredExample)
  const [codex, kimi] = p.pools
  const [[gpt], [short, week]] = anchors as number[][]
  assert.equal(windowInterval(codex.windows[0], at)?.end, gpt)
  assert.deepEqual(windowInterval(codex.windows[0], gpt), { from: gpt, to: gpt, end: gpt + 168 * hour })
  assert.equal(windowInterval(kimi.windows[0], short - 5 * hour - 1)?.end, short - 5 * hour)
  assert.equal(windowInterval(kimi.windows[0], at + 3 * hour)?.end, short)
  assert.deepEqual(windowInterval(kimi.windows[0], short), { from: short, to: short, end: short + 5 * hour })
  assert.equal(windowInterval(kimi.windows[1], at)?.end, week)
  assert.deepEqual(windowInterval(kimi.windows[1], week), { from: week, to: week, end: week + 168 * hour })
  const now = short + 71 * hour, iso = (t: number) => new Date(t).toISOString()
  const shortStart = short + 70 * hour, nextShort = short + 75 * hour
  const observedReset = now + 2 * hour
  const calls: string[] = []
  const next = await measure(async (route, query) => {
    calls.push(route)
    switch (route) {
      case "/profile": return { tracked: true, identity: { label: "quota=20" } }
      case "/auth-files": return { files: [{ ...account, category: "kimi-ai", quota: { fetched_at: iso(now), quota: [{ window_seconds: 18000, reset_at: iso(observedReset) }] } }] }
      case "/usage/models":
        assert.equal(query?.auth_index, account.auth_index)
        assert.ok([iso(shortStart), iso(week - 168 * hour)].includes(query!.from))
        return { models: [] }
      default: assert.fail(`Unexpected route ${route}`)
    }
  }, p, now)
  assert.deepEqual(calls, ["/profile", "/auth-files", "/usage/models", "/usage/models"])
  assert.deepEqual(next.view.pools[0].windows.map(w => [w.pct, w.validUntil, w.resetAt]), [[100, nextShort, nextShort], [100, week, week]])
})

test("only scheduled windows have a reset date, independent of usage availability", async () => {
  const p = parsePolicy(anchoredExample)
  const read = (now: number) => measure(async route => {
    switch (route) {
      case "/profile": return { tracked: true, identity: { label: "quota=20" } }
      case "/auth-files": return { files: [account, { ...account, auth_index: "kimi", category: "kimi-ai" }, { ...account, auth_index: "zai", category: "zai" }] }
      case "/usage/models": return { models: [] }
      default: assert.fail(`Unexpected route ${route}`)
    }
  }, p, now)
  const kimiReset = anchors[1][0]!, zaiReset = anchors[2][1]!
  const { view } = await read(kimiReset - 6 * hour)
  const [, kimi, zai] = view.pools
  assert.equal(kimi.windows[0].status, "ok")
  assert.equal(kimi.windows[0].resetAt, kimiReset - 5 * hour)
  assert.equal(zai.windows[0].pct, 100)
  assert.equal(zai.windows[0].validUntil, kimiReset - 6 * hour + 360_000)
  assert.equal(zai.windows[0].resetAt, undefined)
  assert.equal(zai.windows[1].resetAt, zaiReset)
  assert.equal(currentView(view, kimiReset).pools[1].windows[0].resetAt, undefined)
  const atBoundary = (await read(kimiReset)).view.pools[1].windows[0]
  assert.equal(atBoundary.resetAt, kimiReset + 5 * hour)
  assert.equal(atBoundary.pct, 100)
  assert.equal((await read(zaiReset)).view.pools[2].windows[1].resetAt, zaiReset + 168 * hour)
})

test("published legacy resetUtc is reused after multiple cycles without carrying over the old balance", async () => {
  const s = stub()
  const first = (await s.snapshot()).pools[0].windows[0]
  const anchor = at + hour, length = 168 * hour, start = anchor + 3 * length
  assert.equal(first.pct, 70)
  assert.equal(first.resetAt, anchor)
  s.empty()
  s.now(start + hour)
  const fresh = (await s.snapshot()).pools[0].windows[0]
  assert.equal(fresh.pct, 100)
  assert.equal(fresh.resetAt, start + length)
  s.usage(502)
  s.now(start + length + hour)
  const missing = (await s.snapshot()).pools[0].windows[0]
  assert.equal(missing.pct, null)
  assert.doesNotMatch(JSON.stringify(missing), /staleAsOf/)
  assert.equal(missing.resetAt, start + 2 * length)
})

test("per-event adjustments use actual tier and time, not guesses or already adjusted prices", () => {
  const [codex, , zai] = parsePolicy(example).pools.map(p => p.meter) as Extract<PoolPolicy["meter"], { source: "cpa.cost" }>[]
  assert.equal(eventSpend(baseEvent, model, at, codex), 6)
  assert.equal(eventSpend(baseEvent, "gpt-6.1-sol", at, codex), 7.5)
  assert.equal(eventSpend({ ...baseEvent, response_service_tier: "default" }, model, at, codex), 3)
  assert.equal(eventSpend({ ...baseEvent, service_tier: "priority", effective_service_tier: undefined }, model, at, codex), undefined)
  assert.equal(eventSpend({ ...baseEvent, cost: { ...baseEvent.cost, multiplier: 2.5 } }, model, at, codex), undefined)
  assert.equal(eventSpend({ ...baseEvent, cost: { ...baseEvent.cost, image_output_tokens: 1 } }, model, at, codex), undefined)
  assert.equal(eventSpend({ ...baseEvent, price_source: "reference" }, model, at, codex), undefined)
  assert.equal(eventSpend(baseEvent, "glm-5.4", Date.parse("2026-11-25T06:00:00Z"), zai), 3)
  assert.equal(eventSpend(baseEvent, "glm-5.4", Date.parse("2026-11-25T10:00:00Z"), zai), 1.5)
})

test("only comparable billing is accepted regardless of request outcome or telemetry", () => {
  const codex = parsePolicy(example).pools[0].meter
  assert.equal(codex.source, "cpa.cost")
  const spend = (event: EventFixture) => eventSpend(event, event.billing_model, at, codex)
  assert.equal(spend({ ...baseEvent, failed: true, ttft_ms: 907 }), 6)
  assert.equal(spend({ ...baseEvent, cost: { ...baseEvent.cost, total: 0, multiplier: 0, tiered: false } }), 0)
  for (const event of [
    failedEvent, { ...failedEvent, ttft_ms: 907 }, { ...failedEvent, failed: false },
    { ...baseEvent, accounting_quality: "inconsistent" }, { ...baseEvent, price_source: "none" },
    { ...baseEvent, billing_model: "gpt-image-2.6" }, { ...baseEvent, response_service_tier: "unknown" },
    { ...baseEvent, response_service_tier: false }, { ...baseEvent, cost: { ...baseEvent.cost, currency: "EUR" } },
    { ...baseEvent, cost: { ...baseEvent.cost, tiered: true } }, { ...baseEvent, cost: { ...baseEvent.cost, long_context: true } },
    { ...baseEvent, cost: { ...baseEvent.cost, image_output: 0.01 } },
  ]) assert.equal(spend(event), undefined, JSON.stringify(event))
})

test("a GPT stream failure with TTFT leaves a partial estimate, not a free request", async () => {
  const s = stub()
  s.events([baseEvent, { ...failedEvent, ttft_ms: 907 }])
  const window = (await s.snapshot()).pools[0].windows[0]
  assert.equal(window.status, "partial")
  assert.equal(window.pct, 70)
  assert.equal(window.detail, "Не учтено запросов: 1.")
  assert.equal(window.resetAt, at + hour)
  assert.equal(currentView({ pools: [{ modelFamilyPrefix: "gpt", windows: [window] }], asOf: at }, at + hour).pools[0].windows[0].pct, null)
})

test("unknown models and incompatible positive costs are skipped without losing comparable spend", async () => {
  const s = stub()
  const image = { ...baseEvent, id: "79", billing_model: "gpt-image-2.6", cost: { ...baseEvent.cost, total: 9 } }
  const unknownTier = { ...baseEvent, id: "80", response_service_tier: "unknown" }
  const window = async () => (await s.snapshot()).pools[0].windows[0]
  s.events([baseEvent, image, unknownTier, failedEvent])
  assert.deepEqual(await window(), {
    title: "7 дней", status: "partial", pct: 70, detail: "Не учтено запросов: 3.", resetAt: at + hour, validUntil: at + hour,
  })
  s.events([image, unknownTier])
  const allSkipped = await window()
  assert.equal(allSkipped.status, "partial")
  assert.equal(allSkipped.pct, null)
  assert.match(allSkipped.detail!, /Не учтено запросов: 2/)
  s.events([{ ...baseEvent, cost: { ...baseEvent.cost, total: 11 } }, image])
  const over = await window()
  assert.equal(over.status, "over")
  assert.equal(over.pct, 0)
  assert.equal(over.detail, "Не учтено запросов: 1.")
})

test("even skipped events must reconcile by count, cost, identity and window", async () => {
  const s = stub()
  const image = { ...baseEvent, id: "79", billing_model: "gpt-image-2.6", cost: { ...baseEvent.cost, total: 9 } }
  s.events([baseEvent, image])
  const assertUnreconciled = async () => {
    const w = (await s.snapshot()).pools[0].windows[0]
    assert.equal(w.status, "partial")
    assert.equal(w.pct, null)
    assert.match(w.detail!, /Не удалось сверить журнал/)
  }
  s.count(1)
  await assertUnreconciled()
  s.count(2)
  for (const invalid of [
    { ...image, cost: { ...image.cost, total: 8 } }, { ...image, id: baseEvent.id },
    { ...image, at: new Date(at).toISOString() }, { ...image, billing_model: "another-model" },
  ]) {
    s.journal([baseEvent, invalid])
    await assertUnreconciled()
  }
})

test("a weekly journal above 10,000 events is fully reconciled across page batches", async () => {
  const s = stub()
  const events = Array.from({ length: 10_708 }, (_, i) => ({
    ...baseEvent, id: String(i + 1), cost: { ...baseEvent.cost, total: i === 10_707 ? 3 : 0 },
  }))
  s.events(events)
  const window = async () => (await s.snapshot()).pools[0].windows[0]
  assert.equal((await window()).pct, 70)
  assert.equal(s.calls.filter(c => c.query.has("credential")).length, 43)

  // After the cache expires, matching totals cannot hide an ID repeated in a later batch.
  s.journal([...events.slice(0, -1), { ...events.at(-1)!, id: events[0].id }])
  s.now(at + 30 * 60_000)
  s.identity({ key: "second-synthetic-key" })
  const duplicate = await window()
  assert.equal(duplicate.pct, null)
  assert.match(duplicate.detail!, /Не удалось сверить журнал/)
})

test("warm estimates only read new or changed event ranges, including late arrivals", async () => {
  const s = stub(), iso = (time: number) => new Date(time).toISOString()
  const older = { ...baseEvent, id: "74", at: "2026-11-24T09:00:00Z", cost: { ...baseEvent.cost, total: 1 } }
  const late = { ...failedEvent, id: "75", at: "2026-11-24T10:00:00Z" }
  const fresh = { ...baseEvent, id: "79", at: iso(at), cost: { ...baseEvent.cost, total: 1 } }
  const pages = () => s.calls.splice(0).filter(call => call.query.has("credential")).map(call => [call.query.get("from"), call.query.get("to")])
  const window = async (revalidate = false) => (await s.snapshot(revalidate)).pools[0].windows[0]
  s.events([older, baseEvent])
  assert.equal((await window()).pct, 60)
  assert.equal(pages().length, 1)

  // Unchanged pricing under a newly published catalog must not invalidate verified spend.
  s.catalog({ ...codexPolicy(), revision: "next" })
  s.now(at + 60_000)
  assert.equal((await window(true)).pct, 60)
  assert.deepEqual(pages(), [])

  s.events([older, baseEvent, fresh])
  assert.equal((await window()).pct, 50)
  assert.deepEqual(pages(), [[iso(at), iso(at + 60_000)]])

  s.events([older, late, baseEvent, fresh])
  const partial = await window()
  assert.equal(partial.pct, 50)
  assert.equal(partial.detail, "Не учтено запросов: 1.")
  assert.deepEqual(pages(), [["2026-11-24T00:00:00.000Z", "2026-11-25T00:00:00.000Z"]])

  s.identity({ key: "other-synthetic-key" })
  assert.equal((await window()).pct, 50)
  assert.equal(pages().length, 1)

  const changed = structuredClone(codexPolicy())
  changed.pools[0].meter.tierAdjustments!.tiers.priority["gpt-6.2-*"] = 1
  s.catalog(changed)
  assert.equal((await window(true)).pct, 75)
  assert.equal(pages().length, 1)
})

test("snapshots apply allocation changes without resetting spend and disclose only display fields", async () => {
  const s = stub()
  const first = await s.snapshot()
  assert.equal(first.pools[0]?.windows[0]?.pct, 70)
  s.label("quota=20 quota.demo-gpt=60")
  assert.equal((await s.snapshot()).pools[0]?.windows[0]?.pct, 90)
  assert.doesNotMatch(JSON.stringify(first), /account-a|synthetic-user-key|test user|auth_index|cost|share|budget/)
  s.label("quota=0")
  assert.deepEqual((await s.snapshot()).pools, [])
})

test("event pages are pinned; account collisions and coverage gaps don't invent a percentage", async () => {
  const s = stub()
  s.events(Array.from({ length: 255 }, (_, i) => ({ ...(i === 249 || i === 250 ? failedEvent : baseEvent), id: String(i + 1) })))
  const paged = (await s.snapshot()).pools[0].windows[0]
  assert.equal(paged.status, "over")
  assert.equal(paged.detail, "Не учтено запросов: 2.")
  assert.deepEqual(s.calls.filter(c => c.query.has("credential")).map(c => c.query.get("offset")), ["0", "250"])
  s.count(256)
  s.now(at + 30 * 60_000)
  s.identity({ key: "second-synthetic-key" })
  const mismatch = (await s.snapshot()).pools[0].windows[0]
  assert.equal(mismatch.status, "partial")
  assert.equal(mismatch.pct, null)
  s.empty()
  assert.equal((await s.snapshot()).pools[0].windows[0].pct, 100)
  s.catalog(codexPolicy({ fromUtc: "2026-11-25T00:00:00Z" }))
  const window = (await s.snapshot(true)).pools[0].windows[0]
  assert.equal(window.status, "partial")
  assert.equal(window.resetAt, at + hour)
  assert.match(window.detail!, /журнал CPA покрывает всё окно/)
})

test("ETag revalidation keeps only a validated policy and notes a damaged revision", async () => {
  const s = stub()
  await s.snapshot()
  assert.equal(s.calls.filter(c => c.path.startsWith("/.well-known")).length, 1)
  s.catalog(null, 304)
  s.now(at + 300_000)
  assert.equal((await s.snapshot()).pools[0].windows[0].pct, 70)
  assert.equal(s.calls.filter(c => c.path.startsWith("/.well-known")).at(-1)?.etag, '"catalog"')
  s.catalog({ ...example, schemaVersion: 2 })
  s.now(at + 600_000)
  const fallback = await s.snapshot()
  assert.equal(fallback.issue, "catalog-invalid")
  assert.equal(fallback.pools[0].windows[0].pct, 70)
})

test("manual refresh picks up a published catalog immediately within its five-minute TTL", async () => {
  const s = stub()
  s.catalog(example) // template has no dates
  s.empty()
  const unknown = (await s.snapshot()).pools[0].windows[0]
  assert.equal(unknown.status, "missing")
  assert.equal(unknown.resetAt, undefined)
  s.catalog(codexPolicy())
  assert.equal((await s.snapshot()).pools[0].windows[0].status, "missing")
  assert.equal((await s.snapshot(true)).pools[0].windows[0].pct, 100)
  assert.deepEqual(s.calls.filter(c => c.path.startsWith("/.well-known")).map(c => c.etag), [null, '"catalog"'])
})

test("transient failures keep the last fixed-window figure without marking it; loss of access clears it", async () => {
  const s = stub()
  const first = await s.snapshot()
  s.now(at + 60_000)
  s.usage(502)
  const fallback = await s.snapshot()
  assert.deepEqual(fallback, first)
  s.inventory(502)
  assert.equal((await s.snapshot()).pools[0].windows[0].pct, 70)
  const expired = currentView(first, at + hour).pools[0].windows[0]
  assert.equal(expired.pct, null)
  assert.equal(expired.resetAt, undefined)
  s.identity({ key: "second-synthetic-key" })
  assert.deepEqual((await s.snapshot()).pools, [])
  s.inventory(200); s.usage(200)
  assert.equal((await s.snapshot()).pools[0].windows[0].pct, 70)
  s.profile(401)
  assert.deepEqual(await s.snapshot(), { pools: [], asOf: null, issue: "unauthorized" })
  s.profile(200); s.usage(502)
  assert.equal((await s.snapshot()).pools[0].windows[0].pct, null)
  s.files([])
  assert.deepEqual((await s.snapshot()).pools, [])
})

test("a journal mismatch retries once, then keeps the same window without a UI marker", async () => {
  const logs: Parameters<ReconciliationLog>[0][] = []
  const s = stub(event => logs.push(event))
  s.nextCount(2)
  const first = await s.snapshot()
  assert.equal(first.pools[0].windows[0].pct, 70)
  assert.deepEqual(logs.splice(0), [{ check: "credential-count-mismatch", action: "retry", windowSeconds: 604800 }])

  const later = { ...baseEvent, id: "79", at: new Date(at + 1).toISOString() }
  s.events([baseEvent, later])
  s.now(at + 60_000)
  s.count(2)
  s.catalog({ ...codexPolicy(), revision: "next" })
  assert.deepEqual(await s.snapshot(true), first)
  assert.deepEqual(logs.map(event => event.action), ["retry", "keep-last"])

  const changed = structuredClone(codexPolicy())
  changed.pools[0].windows[0].capacity = 200
  s.catalog(changed)
  const noFallback = (await s.snapshot(true)).pools[0].windows[0]
  assert.equal(noFallback.pct, null)
  assert.match(noFallback.detail!, /Не удалось сверить журнал/)
  assert.equal(logs.at(-1)?.action, "unavailable")

  s.events([baseEvent, later])
  assert.equal((await s.snapshot()).pools[0].windows[0].pct, 70)
})

test("account ambiguity, confirmed removal and a failed inventory are distinct", async () => {
  const s = stub()
  s.files([account, { ...account, auth_index: "account-b" }])
  const ambiguous = (await s.snapshot()).pools[0].windows[0]
  assert.match(ambiguous.detail!, /Несколько активных аккаунтов/)
  assert.equal(ambiguous.resetAt, undefined)
  assert.equal(s.calls.some(c => c.path === "/usage/models"), false)
  s.inventory(502)
  assert.match((await s.snapshot()).pools[0].windows[0].detail!, /Не удалось проверить/)
  s.inventory(200)
  s.files([{ ...account, disabled: true }])
  assert.deepEqual((await s.snapshot()).pools, [])
})
