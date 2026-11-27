import { CpaError } from "./cpa.js";
import { allocation, record, tierMatches, utc } from "./policy.js";
const MINUTE = 60_000;
const DAY = 86_400_000;
function invalid() { throw new CpaError(0); }
function data(value) { return record(value) ?? invalid(); }
function nonnegative(n) { return typeof n === "number" && Number.isFinite(n) && n >= 0; }
function requestCount(n) { return nonnegative(n) && Number.isSafeInteger(n); }
function unavailable(w, detail, status = "missing") {
    return { title: w.title, status, pct: null, detail };
}
export function windowInterval(w, now) {
    const length = w.seconds * 1000;
    const b = w.boundary;
    if (b.type === "rolling")
        return { from: now - length, to: now };
    if (b.anchor === null)
        return;
    const from = b.anchor + Math.floor((now - b.anchor) / length) * length;
    return { from, to: now, end: from + length };
}
function inventory(value) {
    const { files } = data(value);
    if (!Array.isArray(files) || files.length > 2000)
        invalid();
    const accounts = files.map(raw => {
        const f = data(raw);
        if (typeof f.auth_index !== "string" || !f.auth_index || f.auth_index.length > 512 || typeof f.category !== "string" || !f.category ||
            [f.disabled, f.unavailable].some(v => v !== undefined && typeof v !== "boolean"))
            invalid();
        return { index: f.auth_index, category: f.category, active: !f.disabled && !f.unavailable };
    });
    if (new Set(accounts.map(a => a.index)).size !== accounts.length)
        invalid();
    return accounts;
}
async function usage(api, query) {
    const { models } = data(await api("/usage/models", query));
    if (!Array.isArray(models))
        invalid();
    const rows = new Map();
    for (const raw of models) {
        const row = data(raw);
        if (typeof row.model !== "string" || rows.has(row.model) || !requestCount(row.requests) || row.requests < 1 || !nonnegative(row.cost_usd))
            invalid();
        rows.set(row.model, { requests: row.requests, cost: row.cost_usd });
    }
    return rows;
}
function merge(totals, model, requests, cost) {
    const row = totals.get(model);
    totals.set(model, { requests: (row?.requests ?? 0) + requests, cost: (row?.cost ?? 0) + cost });
}
function equal(a, b) {
    return a.size === b.size && [...a].every(([model, row]) => {
        const other = b.get(model);
        return other && other.requests === row.requests && Math.abs(other.cost - row.cost) <= 1e-8 * Math.max(1, row.cost);
    });
}
export function eventSpend(event, model, at, meter) {
    const cost = record(event.cost);
    // Require positive evidence of comparable billing, not a guess based on
    // the request outcome, latency or an unverified zero reported by CPA.
    if (!meter.models.has(model) || event.accounting_quality !== "complete" || event.price_source !== "custom" ||
        !cost || cost.currency !== "USD" || !nonnegative(cost.total) || !Number.isFinite(at))
        return;
    if ([cost.tiered, cost.long_context].some(flag => flag !== undefined && flag !== false) ||
        (cost.multiplier !== undefined && cost.multiplier !== 0 && cost.multiplier !== 1) ||
        [cost.image_input_tokens, cost.image_cache_read_tokens, cost.image_output_tokens,
            cost.image_input, cost.image_cache_read, cost.image_output].some(n => n != null && n !== 0))
        return;
    let factor = 1;
    if (meter.tiers) {
        const tier = (value) => {
            if (typeof value !== "string")
                return;
            if (["default", "standard"].includes(value.toLowerCase()))
                return "standard";
            if (value.toLowerCase() === "priority")
                return "priority";
        };
        // Response tier is the executed tier; otherwise use final outbound, never the requested tier.
        const reported = event.response_service_tier;
        const executed = tier(reported == null || reported === "" ? event.effective_service_tier : reported);
        if (executed === "standard")
            factor = meter.tiers.standard;
        else if (executed === "priority") {
            const rule = meter.tiers.priority.find(([pattern]) => tierMatches(pattern, model));
            if (!rule)
                return;
            factor = rule[1];
        }
        else
            return;
    }
    if (meter.time) {
        const date = new Date(at), day = date.getUTCDay() || 7, minute = date.getUTCHours() * 60 + date.getUTCMinutes();
        factor *= meter.time.rules.find(rule => rule.weekdays.includes(day) && rule.from <= minute && minute < rule.until)?.factor ?? meter.time.defaultFactor;
    }
    const adjusted = cost.total * factor;
    return Number.isFinite(adjusted) ? adjusted : undefined;
}
const PAGE_SIZE = 250;
const PAGES_IN_FLIGHT = 4;
const SPEND_CACHE_TTL = 30 * MINUTE;
function rangeQuery({ from, to }) {
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
function addTotals(target, source) {
    for (const [model, row] of source)
        merge(target, model, row.requests, row.cost);
}
const dayStart = (at) => Math.floor(at / DAY) * DAY;
function appendSlice(slices, slice) {
    const last = slices.at(-1);
    if (last?.to !== slice.from || dayStart(last.from) !== dayStart(slice.from)) {
        slices.push(slice);
        return;
    }
    const totals = new Map(last.totals);
    addTotals(totals, slice.totals);
    slices[slices.length - 1] = { from: last.from, to: slice.to, totals, used: last.used + slice.used,
        skipped: last.skipped + slice.skipped, verifiedAt: Math.min(last.verifiedAt, slice.verifiedAt) };
}
async function readSlices(api, index, interval, meter, expected, ids, now) {
    if (!expected.size)
        return [];
    const expectedCount = [...expected.values()].reduce((n, row) => n + row.requests, 0);
    if (!requestCount(expectedCount))
        return "invalid-request-count";
    const range = rangeQuery(interval), query = { ...range, auth_index: index };
    const head = data(await api("/events", { ...range, limit: "1" }));
    const snapshot = head.snapshot_id;
    const options = record(head.filter_options)?.credential_options;
    if (typeof snapshot !== "string" || !/^\d{1,19}$/.test(snapshot) || !Array.isArray(options) || options.length > 64)
        return "invalid-journal-snapshot";
    const initialCount = ids.size, matched = new Map(), credentials = new Set(), days = new Map();
    for (const raw of options) {
        const option = record(raw), token = option?.value;
        if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || credentials.has(token))
            return "invalid-credential-filter";
        credentials.add(token);
        // Tokens represent credential names, not auth indices. Use the intersection with
        // this account, and reject a name collision instead of merging histories.
        let intersection;
        try {
            intersection = await usage(api, { ...query, dimension: "credentials", value: token });
        }
        catch (error) {
            if (error instanceof CpaError && error.expiredFilter)
                continue;
            throw error;
        }
        const count = [...intersection.values()].reduce((n, row) => n + row.requests, 0);
        if (!count)
            continue;
        if (count !== option?.count || count > expectedCount - (ids.size - initialCount))
            return "credential-count-mismatch";
        const seen = new Map();
        // All pages use the same snapshot. Bound concurrent reads instead of
        // rejecting an entire window because its journal has many events.
        for (let start = 0; start < count; start += PAGE_SIZE * PAGES_IN_FLIGHT) {
            const offsets = Array.from({ length: Math.min(PAGES_IN_FLIGHT, Math.ceil((count - start) / PAGE_SIZE)) }, (_, i) => start + i * PAGE_SIZE);
            const pages = await Promise.all(offsets.map(async (offset) => data(await api("/events", {
                ...range, credential: token, snapshot_id: snapshot, limit: String(PAGE_SIZE), offset: String(offset),
            }))));
            for (const [i, page] of pages.entries()) {
                if (page.snapshot_id !== snapshot || page.total !== count || !Array.isArray(page.entries) || page.entries.length !== Math.min(PAGE_SIZE, count - offsets[i]))
                    return "journal-page-mismatch";
                for (const raw of page.entries) {
                    const event = record(raw), id = event?.id;
                    if (!event || typeof id !== "string" || !/^\d{1,19}$/.test(id) || ids.has(id))
                        return "invalid-or-duplicate-event-id";
                    ids.add(id);
                    const at = utc(event.at), model = event.billing_model || event.upstream_model, cost = record(event.cost);
                    if (!(at >= interval.from && at < interval.to) || typeof model !== "string" || !cost || !nonnegative(cost.total))
                        return "invalid-journal-event";
                    // Even events without comparable prices must reconcile against the account.
                    merge(seen, model, 1, cost.total);
                    const day = dayStart(at);
                    let slice = days.get(day);
                    if (!slice) {
                        slice = { from: Math.max(day, interval.from), to: Math.min(day + DAY, interval.to), totals: new Map(), used: 0, skipped: 0, verifiedAt: now };
                        days.set(day, slice);
                    }
                    merge(slice.totals, model, 1, cost.total);
                    const adjusted = eventSpend(event, model, at, meter);
                    if (adjusted === undefined)
                        slice.skipped++;
                    else
                        slice.used += adjusted;
                }
            }
        }
        if (!equal(intersection, seen))
            return "credential-totals-mismatch";
        addTotals(matched, seen);
    }
    if (!equal(expected, matched))
        return "journal-totals-mismatch";
    return [...days.values()].sort((a, b) => a.from - b.from);
}
async function spend(api, index, interval, meter, previous) {
    const pricing = JSON.stringify([[...meter.models].sort(), meter.tiers, meter.time]);
    const cache = { index, pricing, end: interval.end, slices: [] };
    // At the exact cycle boundary [from, to) is empty; CPA needs a nonempty range.
    if (interval.from === interval.to)
        return { used: 0, skipped: 0, cache };
    const expected = await usage(api, { ...rangeQuery(interval), auth_index: index });
    // The default assumes seven days of history. Operators can declare a shorter
    // retention or an explicit guarantee for longer windows in their catalog.
    const coverage = meter.coverage;
    if ((coverage?.from !== undefined && interval.from < coverage.from) ||
        interval.from < interval.to - (coverage?.retentionDays ?? 7) * DAY)
        return "coverage";
    if (!expected.size)
        return { used: 0, skipped: 0, cache };
    const ranges = [];
    let from = interval.from;
    if (previous?.index === index && previous.pricing === pricing && previous.end === interval.end) {
        for (const slice of previous.slices) {
            // CPA's aggregates cannot detect every correction to event metadata.
            if (slice.from < from || slice.to > interval.to || interval.to - slice.verifiedAt >= SPEND_CACHE_TTL)
                continue;
            if (slice.from > from)
                ranges.push({ interval: { from, to: slice.from } });
            ranges.push({ interval: slice, cached: slice });
            from = slice.to;
        }
    }
    if (from < interval.to)
        ranges.push({ interval: { from, to: interval.to } });
    // Recheck even closed days: a request can finish late and be logged at its start time.
    const totals = new Map(), ids = new Set();
    for (let start = 0; start < ranges.length; start += PAGES_IN_FLIGHT) {
        const batch = ranges.slice(start, start + PAGES_IN_FLIGHT);
        const checks = ranges.length === 1 ? [expected] : await Promise.all(batch.map(({ interval }) => usage(api, { ...rangeQuery(interval), auth_index: index })));
        for (const [i, { interval: range, cached }] of batch.entries()) {
            const current = checks[i];
            addTotals(totals, current);
            const slices = cached && equal(cached.totals, current) ? [cached] : await readSlices(api, index, range, meter, current, ids, interval.to);
            if (typeof slices === "string")
                return slices;
            for (const slice of slices)
                appendSlice(cache.slices, slice);
        }
    }
    if (!equal(expected, totals))
        return "interval-totals-mismatch";
    const reconciled = new Map();
    let used = 0, skipped = 0;
    for (const slice of cache.slices) {
        addTotals(reconciled, slice.totals);
        used += slice.used;
        skipped += slice.skipped;
    }
    const count = [...expected.values()].reduce((sum, row) => sum + row.requests, 0);
    if (!equal(expected, reconciled) || !Number.isFinite(used) || !requestCount(count))
        return "reconciled-totals-mismatch";
    return { used: skipped === count ? null : used, skipped, cache };
}
function windowRules(pool, window) {
    const { meter } = pool;
    return JSON.stringify([pool.modelFamilyPrefix, pool.category, pool.authIndex, window, meter,
        meter.source === "cpa.cost" && [...meter.models].sort()]);
}
function reusable(previous, index, share, rules, now, end) {
    return !!previous && previous.index === index && previous.share === share && previous.rules === rules && previous.end > now && end === previous.end;
}
export async function measure(api, policy, now, previous, log) {
    const profile = data(await api("/profile"));
    if (profile.tracked === false)
        throw new CpaError(401);
    if (profile.tracked !== true)
        invalid();
    const label = data(profile.identity).label;
    if (label !== undefined && typeof label !== "string")
        invalid();
    const assigned = policy.pools.flatMap(pool => {
        const share = allocation(label ?? "", pool.id);
        return share ? [{ pool, share }] : [];
    });
    const fixed = new Map(), pools = [], knownPools = new Set(), spendCache = new Map();
    if (!assigned.length)
        return { view: { pools, asOf: now }, fixed, knownPools, spendCache };
    // A failed inventory must not be treated as successful account removal. Profile must
    // have been rechecked first, so do not reuse numbers after a share change.
    let accounts;
    try {
        accounts = inventory(await api("/auth-files"));
    }
    catch (error) {
        if (error instanceof CpaError && [401, 403].includes(error.status))
            throw error;
        for (const { pool, share } of assigned) {
            if (!previous?.knownPools.has(pool.id))
                continue;
            knownPools.add(pool.id);
            const windows = pool.windows.map(w => {
                const key = `${pool.id}/${w.id}`, old = previous?.fixed.get(key);
                if (old && reusable(old, old.index, share, windowRules(pool, w), now, windowInterval(w, now)?.end)) {
                    fixed.set(key, old);
                    return old.window;
                }
                return unavailable(w, "Не удалось проверить доступные аккаунты в CPA.");
            });
            pools.push({ modelFamilyPrefix: pool.modelFamilyPrefix, windows });
        }
        return { view: { pools, asOf: previous?.view.asOf ?? null, issue: "unreachable" }, fixed, knownPools, spendCache };
    }
    let asOf = now;
    for (const { pool, share } of assigned) {
        const accountsForPool = accounts.filter(a => a.active && a.category === pool.category && (!pool.authIndex || pool.authIndex === a.index));
        if (accountsForPool.length === 0)
            continue;
        if (accountsForPool.length > 1) {
            knownPools.add(pool.id);
            pools.push({ modelFamilyPrefix: pool.modelFamilyPrefix, windows: pool.windows.map(w => unavailable(w, "Несколько активных аккаунтов. Нужна явная привязка в каталоге.")) });
            continue;
        }
        const [account] = accountsForPool;
        const windows = [];
        let revoked = false, poolAsOf = now;
        for (const w of pool.windows) {
            const key = `${pool.id}/${w.id}`, old = previous?.fixed.get(key);
            const interval = windowInterval(w, now);
            const resetAt = interval?.end;
            const withReset = (window) => resetAt === undefined ? window : { ...window, resetAt };
            const rules = windowRules(pool, w);
            const fallback = () => {
                if (!reusable(old, account.index, share, rules, now, resetAt))
                    return;
                fixed.set(key, old);
                poolAsOf = Math.min(poolAsOf, old.asOf);
                return old.window;
            };
            if (pool.meter.source === "serverSummary") {
                windows.push(withReset(unavailable(w, "Для этого источника ещё нет серверного адаптера.")));
                continue;
            }
            if (!interval) {
                windows.push(unavailable(w, "Граница цикла не задана в каталоге."));
                continue;
            }
            try {
                const cached = previous?.spendCache.get(key);
                let estimate = await spend(api, account.index, interval, pool.meter, cached);
                if (typeof estimate === "string" && estimate !== "coverage") {
                    log?.({ check: estimate, action: "retry", windowSeconds: w.seconds });
                    estimate = await spend(api, account.index, interval, pool.meter, cached);
                }
                if (typeof estimate === "string") {
                    if (estimate === "coverage") {
                        windows.push(withReset(unavailable(w, "Не подтверждено, что журнал CPA покрывает всё окно.", "partial")));
                    }
                    else {
                        const last = fallback();
                        if (last && cached)
                            spendCache.set(key, cached);
                        log?.({ check: estimate, action: last ? "keep-last" : "unavailable", windowSeconds: w.seconds });
                        windows.push(last ?? withReset(unavailable(w, "Не удалось сверить журнал начислений с данными аккаунта.", "partial")));
                    }
                    continue;
                }
                const { used, skipped, cache } = estimate;
                spendCache.set(key, cache);
                const skippedNote = `Не учтено запросов: ${skipped}.`;
                if (used === null) {
                    windows.push(withReset(unavailable(w, `${skippedNote} Нет подтверждённых начислений.`, "partial")));
                    continue;
                }
                const budget = w.capacity * share / 100;
                if (!(budget > 0)) {
                    windows.push(withReset(unavailable(w, "Не удалось определить личный бюджет.")));
                    continue;
                }
                const status = used > budget ? "over" : skipped ? "partial" : "ok";
                const window = withReset({
                    title: w.title, status, pct: Math.max(0, 1 - used / budget) * 100,
                    ...(skipped ? { detail: skippedNote } : {}),
                    validUntil: interval.end ?? now + 6 * MINUTE,
                });
                windows.push(window);
                if (interval.end !== undefined)
                    fixed.set(key, { share, index: account.index, rules, window, end: interval.end, asOf: now });
            }
            catch (error) {
                if (error instanceof CpaError && error.status === 401)
                    throw error;
                if (error instanceof CpaError && (error.status === 403 || (error.status === 404 && error.route === "/usage/models"))) {
                    revoked = true;
                    break;
                }
                const last = fallback();
                if (last) {
                    const cached = previous?.spendCache.get(key);
                    if (cached)
                        spendCache.set(key, cached);
                }
                windows.push(last ?? withReset(unavailable(w, "Не удалось прочитать расход в CPA.")));
            }
        }
        if (revoked) {
            for (const w of pool.windows) {
                fixed.delete(`${pool.id}/${w.id}`);
                spendCache.delete(`${pool.id}/${w.id}`);
            }
            continue;
        }
        asOf = Math.min(asOf, poolAsOf);
        knownPools.add(pool.id);
        pools.push({ modelFamilyPrefix: pool.modelFamilyPrefix, windows });
    }
    return { view: { pools, asOf }, fixed, knownPools, spendCache };
}
