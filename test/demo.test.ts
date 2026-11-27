import assert from "node:assert/strict"
import test from "node:test"
import { demoSnapshot, indicator, poolForFamily, windowLabel } from "../src/demo.ts"
import { resetTime } from "../src/view.ts"

test("Личный остаток зависит от доли; превышение не даёт отрицательного остатка", () => {
  const codex = (s: "normal" | "larger" | "over") => demoSnapshot(s).pools[0].windows[0]
  assert.equal(windowLabel(codex("normal")), "≈70% осталось")
  assert.equal(windowLabel(codex("larger")), "≈90% осталось")
  assert.equal(windowLabel(codex("over")), "0% · превышена")
  assert.equal(codex("normal").detail, undefined)
  assert.equal(codex("over").detail, undefined)
})

test("Индикатор отличает верхнюю границу остатка от полного результата и отсутствия данных", () => {
  const normal = demoSnapshot("normal")
  assert.equal(normal.pools.flatMap(p => p.windows).length, 5)
  assert.equal(indicator(normal, "gpt-image")?.label, "GPT · 7 дней: ≈70% · демо")
  assert.equal(indicator(demoSnapshot("empty"), "gpt-sol"), undefined)
  const missing = demoSnapshot("missing")
  const [short, week] = missing.pools[2].windows
  assert.ok(missing.pools.slice(0, 2).every(pool => pool.windows.every(w => w.pct !== null && w.resetAt !== undefined)))
  assert.equal(windowLabel(short), "≈80% осталось")
  assert.equal(week.pct, null)
  assert.equal(windowLabel(week), "Нет данных")
  const partial = demoSnapshot("partial")
  const partialWindow = partial.pools[1].windows[0]
  assert.equal(windowLabel(partialWindow), "Осталось не более 80%")
  assert.equal(windowLabel({ ...partialWindow, pct: null }), "Часть расхода не оценена")
  assert.equal(windowLabel({ ...partialWindow, pct: 80.01 }), "Осталось не более 81%")
  assert.match(indicator(partial, "kimi-k3")!.label, /KIMI · 5 часов: ≤80%/)
  assert.equal(indicator(partial, "kimi-k3")?.tone, "warning")
  assert.equal(indicator(demoSnapshot("over"), "gpt-astra")?.tone, "danger")
  assert.equal(indicator(demoSnapshot("over"), "glm")?.tone, "success")
  assert.equal(indicator(demoSnapshot("low"), "gpt-astra")?.tone, "warning")
})

test("Повторное чтение устаревших данных не выдаёт снимок за свежий", () => {
  const first = demoSnapshot("stale")
  const next = demoSnapshot("stale", new Date(first.readAt.getTime() + 60000))
  assert.equal(first.asOf.getTime(), next.asOf.getTime())
  assert.ok(first.asOf < first.readAt)
  assert.equal(first.pools[0].windows[0].resetAt, next.pools[0].windows[0].resetAt)
  assert.deepEqual(indicator(next, "glm-flash"), indicator(first, "glm-flash"))
  assert.doesNotMatch(JSON.stringify(indicator(next, "glm-flash")), /устарел/i)
})

test("В демо показан отсчёт до известной границы, а не срок годности снимка", () => {
  const now = new Date("2026-11-25T12:00:00Z")
  const [codex, kimi, zai] = demoSnapshot("normal", now).pools
  assert.equal(resetTime(codex.windows[0].resetAt, +now)?.relative, "через 2 минуты")
  assert.equal(resetTime(codex.windows[0].resetAt, +now)?.urgent, true)
  assert.equal(resetTime(codex.windows[0].resetAt, +now + 61_000)?.relative, "меньше минуты")
  assert.equal(resetTime(codex.windows[0].resetAt, +now + 120_000), undefined)
  assert.equal(resetTime(kimi.windows[0].resetAt, +now)?.relative, "через 1 час")
  assert.equal(resetTime(kimi.windows[1].resetAt, +now)?.relative, "через 4 дня")
  assert.equal(resetTime(kimi.windows[1].resetAt, +now)?.urgent, false)
  assert.equal(zai.windows[0].resetAt, undefined)
  assert.equal(demoSnapshot("missing", now).pools[2].windows[1].resetAt, undefined)
})

test("Смена family выбирает только свои окна; новый префикс не требует новой подписи", () => {
  const snapshot = demoSnapshot("normal")
  for (const [family, label] of [
    ["gpt-astra", "GPT · 7 дней: ≈70% · демо"], ["gpt-sol", "GPT · 7 дней: ≈70% · демо"],
    ["kimi-k3", "KIMI · 5 часов: ≈80% · 7 дней: ≈30% · демо"],
    ["glm-flash", "GLM · 5 часов: ≈80% · 7 дней: ≈55% · демо"],
  ]) assert.equal(indicator(snapshot, family)?.label, label)
  assert.equal(indicator(snapshot, "unknown-gpt"), undefined)
  assert.equal(indicator(snapshot, undefined), undefined)
  assert.equal(poolForFamily([{ modelFamilyPrefix: "a" }, { modelFamilyPrefix: "ab" }], "abc"), undefined)
  const future = { ...snapshot, pools: [{ ...snapshot.pools[0], modelFamilyPrefix: "nova" }] }
  assert.match(indicator(future, "nova-v2")!.label, /^NOVA · /)
})
