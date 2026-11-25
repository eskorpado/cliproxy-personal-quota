import { For, Show } from "solid-js"
import { formatTime, scenarios, windowLabel, type Scenario, type Snapshot } from "./demo"
import { resetTime, type Issue, type LiveSnapshot } from "./view"

const notices: Record<Issue, string> = {
  provider: "Проверьте providerID и origin в настройках плагина: они должны соответствовать вашему HTTPS-провайдеру CPA.",
  key: "У провайдера нет активного API-ключа.",
  unauthorized: "CPA не подтвердил доступ по активному ключу.",
  unreachable: "Не удалось получить данные квот.",
  "catalog-unreachable": "Не удалось обновить каталог квот.",
  "catalog-invalid": "Каталог квот повреждён или его версия не поддерживается.",
}

export function QuotaPanel(props: {
  data: Snapshot | LiveSnapshot; now: number; scenario?: Scenario; pending: boolean; supported: boolean
  change(value: Scenario): void; refresh(): void
}) {
  const issue = () => "issue" in props.data ? props.data.issue : undefined
  const staleDemo = () => "stale" in props.data && props.data.stale
  const asOf = () => props.data.asOf === null ? null : formatTime(new Date(props.data.asOf))
  return <section class="cpq-panel" aria-label="Мои квоты">
    <header>
      <div class="cpq-heading"><h2>Мои квоты</h2><Show when={props.scenario}><span class="cpq-tag">Демо</span></Show></div>
    </header>
    <Show when={props.supported && issue()}>{value =>
      <p class="cpq-notice" role="status">{notices[value()]}{value().startsWith("catalog-") && props.data.asOf !== null ? " Используется последняя валидная редакция." : ""}</p>
    }</Show>
    <Show when={staleDemo()}>
      <p class="cpq-notice" role="status">Устарело · {asOf()}. Показан последний доступный снимок.</p>
    </Show>
    <div class="cpq-cards">
      <For each={props.data.pools} fallback={<p class="cpq-empty">{!props.supported ? "Квоты доступны только во встроенном сервере OpenCode." : props.pending ? "Читаем квоты…" : "Нет доступных квот."}</p>}>
        {pool => <section class="cpq-card" aria-label={pool.modelFamilyPrefix.toUpperCase()}>
          <h3>{pool.modelFamilyPrefix.toUpperCase()}</h3>
          <For each={pool.windows}>{w =>
            <div class="cpq-window" data-tone={staleDemo() || w.staleAsOf !== undefined || w.status === "missing" ? "muted" : w.status === "over" ? "danger" : w.status === "partial" || (w.pct ?? 100) <= 25 ? "warn" : "good"}>
              <div class="cpq-line"><span>{w.title}</span><strong>{windowLabel(w)}</strong></div>
              <Show when={w.pct !== null}>
                <div class="cpq-track" aria-hidden="true"><i style={{ width: `${w.pct}%` }} /></div>
              </Show>
              <Show when={resetTime(w.resetAt, props.now)}>{reset =>
                <p class="cpq-reset">Ожидаемый сброс <time datetime={reset().iso}>{reset().date}</time>
                  <span data-urgent={reset().urgent}> · {reset().relative}</span></p>
              }</Show>
              <Show when={w.detail}><p class="cpq-detail">{w.detail}</p></Show>
              <Show when={w.staleAsOf}>{at => <p class="cpq-detail">Устарело · {formatTime(new Date(at()))}</p>}</Show>
            </div>
          }</For>
        </section>}
      </For>
    </div>
    <footer>
      <div class="cpq-sync"><span role="status">{asOf() ? `Снимок · ${asOf()}` : ""}</span>
        <button type="button" disabled={!props.supported || props.pending} onClick={props.refresh}>Обновить</button></div>
      <Show when={props.scenario}><label class="cpq-demo">Демосценарий
        <select value={props.scenario} onChange={e => props.change(e.currentTarget.value as Scenario)}>
          <For each={Object.entries(scenarios)}>{([id, name]) => <option value={id}>{name}</option>}</For>
        </select>
      </label></Show>
    </footer>
  </section>
}
