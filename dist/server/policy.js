export const POLICY_PATH = "/.well-known/cpa-quota-policy.json";
export function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
export function utc(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
        return NaN;
    return Date.parse(value);
}
export class InvalidPolicy extends Error {
    constructor() { super("Invalid or unsupported quota policy"); }
}
function check(value) { if (!value)
    throw new InvalidPolicy(); }
function obj(value) { const result = record(value); check(result); return result; }
function str(value, pattern) {
    check(typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1F\x7F]/.test(value) && (!pattern || pattern.test(value)));
    return value;
}
function num(value, max, integer = false) {
    check(typeof value === "number" && value >= 0.000001 && value <= max && (!integer || Number.isInteger(value)));
    return value;
}
function list(value, max, min = 1) {
    check(Array.isArray(value) && value.length >= min && value.length <= max);
    return value;
}
function unique(values, key) {
    check(new Set(values.map(key)).size === values.length);
    return values;
}
const identifier = /^[a-z0-9][a-z0-9_-]*$/;
const modelID = /^[A-Za-z0-9][A-Za-z0-9./:_-]*$/;
function windowPolicy(raw) {
    const w = obj(raw);
    const b = obj(w.boundary);
    const common = { id: str(w.id, identifier), title: str(w.title), seconds: num(w.seconds, 366 * 86400, true), capacity: num(w.capacity, 1e12) };
    if (b.type === "rolling")
        return { ...common, boundary: { type: "rolling" } };
    // Earlier deployed catalogs still parse, but no longer enable CPA reset reads.
    if (b.type === "reportedReset")
        return { ...common, boundary: { type: "anchored", anchor: null } };
    // Treat resetUtc in deployed catalogs as another known boundary of the cycle.
    check(b.type === "anchored" || b.type === "fixedReset");
    const date = b.type === "anchored" ? b.anchorUtc : b.resetUtc;
    const anchor = date === null ? null : utc(date);
    check(anchor === null || Number.isFinite(anchor));
    return { ...common, boundary: { type: "anchored", anchor } };
}
function minute(value) {
    const time = str(value, /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
function meter(raw) {
    const m = obj(raw);
    if (m.source === "serverSummary")
        return { source: "serverSummary" };
    check(m.source === "cpa.cost");
    const result = {
        source: m.source, unit: str(m.unit, identifier), models: new Set(unique(list(m.models, 1000).map(id => str(id, modelID)), id => id)),
    };
    if (m.coverage !== undefined) {
        const c = obj(m.coverage);
        const from = c.fromUtc === undefined ? undefined : utc(c.fromUtc);
        check(from === undefined || Number.isFinite(from));
        result.coverage = { from, retentionDays: c.retentionDays === undefined ? undefined : num(c.retentionDays, 36600, true) };
    }
    if (m.tierAdjustments !== undefined) {
        const t = obj(m.tierAdjustments), tiers = obj(t.tiers), priority = Object.entries(obj(tiers.priority));
        check(t.requiresBaseCost === true && t.unknown === "incomplete" && priority.length > 0 && priority.length <= 100);
        result.tiers = { standard: num(tiers.standard, 100), priority: priority.map(([pattern, factor]) => [str(pattern, /^[A-Za-z0-9][A-Za-z0-9./:_-]*\*?$/), num(factor, 100)]) };
        check([...result.models].every(model => result.tiers.priority.filter(([pattern]) => tierMatches(pattern, model)).length <= 1));
    }
    if (m.timeAdjustment !== undefined) {
        const t = obj(m.timeAdjustment);
        check(t.timezone === "UTC");
        const rules = list(t.rules, 40).map(value => {
            const r = obj(value), from = minute(r.from), until = minute(r.until);
            check(from < until);
            return { weekdays: unique(list(r.weekdays, 7).map(day => num(day, 7, true)), day => day), from, until, factor: num(r.factor, 100) };
        });
        check(rules.every((a, i) => rules.slice(i + 1).every(b => a.until <= b.from || b.until <= a.from || !a.weekdays.some(d => b.weekdays.includes(d)))));
        result.time = { defaultFactor: num(t.defaultFactor, 100), rules };
    }
    return result;
}
export function tierMatches(pattern, model) {
    return pattern.endsWith("*") ? model.startsWith(pattern.slice(0, -1)) : model === pattern;
}
export function parsePolicy(value) {
    const p = obj(value), allocation = obj(p.allocation);
    check(p.schemaVersion === 1 && allocation.source === "cpa.profile.identity.label" && allocation.tag === "quota" && allocation.missing === "hide");
    const pools = list(p.pools, 32, 0).map((raw) => {
        const pool = obj(raw), account = obj(pool.account);
        check(account.authIndex === undefined ? account.match === "exactlyOne" : account.match === undefined);
        return {
            id: str(pool.id, identifier), modelFamilyPrefix: str(pool.modelFamilyPrefix, identifier),
            category: str(account.category, identifier), authIndex: account.authIndex === undefined ? undefined : str(account.authIndex),
            windows: unique(list(pool.windows, 12).map(windowPolicy), w => w.id), meter: meter(pool.meter),
        };
    });
    return { revision: str(p.revision), pools: unique(pools, pool => pool.id) };
}
export function allocation(label, pool) {
    const tags = new Map();
    // Tags can be delimited by whitespace, commas or semicolons in a human label.
    for (const match of label.matchAll(/(?:^|[\s,;])(quota(?:\.[a-z0-9_-]+)?)[\t ]*=(?=[\t ]*([^\s,;]*))/g)) {
        const [, tag, value] = match;
        tags.set(tag, [...(tags.get(tag) ?? []), value]);
    }
    const values = tags.get(`quota.${pool}`) ?? tags.get("quota");
    if (values?.length !== 1 || !/^\d+(?:\.\d+)?$/.test(values[0]))
        return;
    const share = Number(values[0]);
    return share <= 100 && share > 0 ? share : undefined;
}
