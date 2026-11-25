import policy from "../quota-policy.example.json" with { type: "json" }
import type { LiveSnapshot, QuotaWindow } from "./view.ts"

export const scenarios = {
  normal: "Обычный расход",
  larger: "Увеличенный бюджет",
  low: "Мало осталось",
  over: "Перерасход Codex",
  partial: "Часть расхода не оценена",
  missing: "Нет начала недели Z.ai",
  stale: "Устаревшие данные",
  empty: "Нет доступных квот",
} as const

export type Scenario = keyof typeof scenarios

// Один условный ключ, один снимок в середине циклов. Для обычного
// сценария начало недели Z.ai считается известным (в примере политики — null).
const samples: Record<string, Record<string, number>> = {
  "demo-gpt": { week: 6 },
  "demo-kimi": { short: 2, week: 70 },
  "demo-glm": { short: 40, week: 900 },
}
const stamp = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })
export const formatTime = (date: Date) => stamp.format(date)

export type { QuotaWindow } from "./view.ts"

const staleAsOf = Date.now() - 18 * 60_000
export function demoSnapshot(scenario: Scenario, readAt = new Date()) {
  const share = scenario === "larger" ? 60 : 20
  const stale = scenario === "stale"
  // В сценарии сбоя повторное чтение не меняет время последнего наблюдения.
  const asOf = stale ? new Date(staleAsOf) : readAt
  const pools = (scenario === "empty" ? [] : policy.pools).map(pool => {
    const windows = pool.windows.map((w): QuotaWindow => {
      const budget = w.capacity * share / 100
      const used = scenario === "low" ? budget * 0.85
        : scenario === "over" && pool.id === "demo-gpt" && w.id === "week" ? 22
        : samples[pool.id]?.[w.id]
      if (scenario === "missing" && pool.id === "demo-glm" && w.boundary.type === "anchored")
        return { title: w.title, status: "missing", pct: null, detail: "Начало недельного цикла неизвестно." }
      if (used == null)
        return { title: w.title, status: "missing", pct: null, detail: "В демо нет наблюдений для этого окна." }
      const reset = w.boundary.type === "rolling" ? {} : {
        resetAt: asOf.getTime() + (pool.id === "demo-gpt" ? (stale ? 60 : 2)
          : w.id === "short" ? 65 : (pool.id === "demo-glm" ? 6 : 4) * 1440 + 60) * 60_000,
      }
      if (scenario === "partial" && pool.id === "demo-kimi")
        return { title: w.title, status: "partial", pct: null, detail: "В журнале есть вызовы без сопоставимой цены.", ...reset }
      const over = used > budget
      return {
        title: w.title, status: over ? "over" : "ok", pct: Math.max(0, 1 - used / budget) * 100, ...reset,
      }
    })
    return { modelFamilyPrefix: pool.modelFamilyPrefix, windows }
  })
  return { pools, stale, asOf, readAt }
}

export type Snapshot = ReturnType<typeof demoSnapshot>

export function windowLabel(w: QuotaWindow) {
  if (w.status === "over") return "0% · превышена"
  if (w.status === "missing") return "Нет данных"
  if (w.status === "partial") return "Часть расхода не оценена"
  return `≈${Math.round(w.pct!)}% осталось`
}

export function poolForFamily<T extends { modelFamilyPrefix: string }>(pools: T[], family?: string) {
  if (!family) return undefined
  const matches = pools.filter(p => p.modelFamilyPrefix && family.startsWith(p.modelFamilyPrefix))
  // Не угадываем подписку, если привязки в каталоге неоднозначны.
  return matches.length === 1 ? matches[0] : undefined
}

export function indicator(data: Snapshot | LiveSnapshot, family?: string) {
  const pool = poolForFamily(data.pools, family)
  if (!pool) return undefined
  const demo = "stale" in data
  const stale = demo ? data.stale : pool.windows.some(w => w.staleAsOf !== undefined)
  const asOf = demo ? data.asOf : data.asOf !== null ? new Date(data.asOf) : undefined
  const prefix = pool.modelFamilyPrefix.toUpperCase()
  const parts = pool.windows.map(w => {
    const value = w.status === "over" ? "0% · превышена" : w.status === "partial" ? "неполно" : w.pct === null ? "нет данных" : `≈${Math.round(w.pct)}%`
    return `${w.title}: ${value}`
  })
  const tone = stale || (!demo && data.issue) ? "warning" : pool.windows.some(w => w.status === "over") ? "danger" : pool.windows.some(w => w.pct === null || w.pct <= 25) ? "warning" : "success"
  return {
    label: [prefix, ...parts, ...(stale ? ["устарело"] : []), ...(demo ? ["демо"] : [])].join(" · "),
    title: `${prefix} — остаток квоты.${asOf ? ` Снимок: ${formatTime(asOf)}.` : ""}${stale ? " Есть устаревшие окна." : ""}${demo ? " Демоданные" : ""}`,
    tone: tone as "success" | "warning" | "danger",
  }
}
