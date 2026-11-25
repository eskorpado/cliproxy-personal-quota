import { Command, ComposerPill, MenuItem, Panel, Plugin, Style, type ComposerPillProps, type ComposerPillTone, type IconName, type PanelTab } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { demoSnapshot, indicator, type Scenario } from "./demo"
import { QuotaPanel } from "./panel"
import { configuredTarget } from "./target"
import { QuotaRpc } from "./rpc"
import { currentView, type LiveSnapshot } from "./view"
import css from "./quota.css?inline"

const title = "Мои квоты"
const tab: PanelTab = { id: "budgets", title, closable: "compact", fallback: true }
const quotaIcons: Record<ComposerPillTone, IconName> = {
  success: "circle-check",
  warning: "circle-exclamation",
  danger: "circle-x",
}

function selectedFamily({ screen, session }: ComposerPillProps, demo: boolean, providerID?: string) {
  const model = screen.composer.model()
  if (!model || !session.location || (!demo && (!session.server.builtin || model.providerID !== providerID))) return undefined
  // Синхронизированный каталог самого Desktop. Только чтение, без sync/fetch.
  const catalog = session.server.data.location.model.list(session.location)
  return catalog?.find(m => m.providerID === model.providerID && m.id === model.modelID)?.family
}

export default Plugin.define({
  setup(ctx) {
    const demo = ctx.options.mode === "demo"
    const target = configuredTarget(ctx.options)
    const [scenario, setScenario] = createSignal<Scenario>("normal")
    const [readAt, setReadAt] = createSignal(new Date())
    const [clock, setClock] = createSignal(Date.now())
    const [live, setLive] = createSignal<{ directory: string; data: LiveSnapshot }>()
    const [pending, setPending] = createSignal(false)
    const directory = createMemo(() => {
      const session = ctx.sessions.current()
      return session?.server.builtin ? session.location?.directory : undefined
    })
    const data = createMemo(() => {
      if (demo) return demoSnapshot(scenario(), readAt())
      const value = live()
      if (value && value.directory === directory()) return currentView(value.data, clock())
      return { pools: [], asOf: null } satisfies LiveSnapshot
    })
    let request: AbortController | undefined
    const clear = () => { request?.abort(); request = undefined; setLive(undefined); setPending(false) }
    const refresh = (replace = false) => {
      if (demo) { setReadAt(new Date()); return }
      const path = directory()
      if (!path) return
      if (request && !replace) return
      request?.abort()
      const controller = new AbortController()
      request = controller
      setPending(true)
      void (async () => {
        try {
          const snapshot = await ctx.client.rpc(QuotaRpc).snapshot(replace ? { revalidate: true } : {}, { location: { directory: path }, signal: controller.signal }) as LiveSnapshot
          if (!controller.signal.aborted) { setClock(Date.now()); setLive({ directory: path, data: snapshot }) }
        } catch {
          // The local server might have reloaded with another key; never retain here.
          if (!controller.signal.aborted) setLive({ directory: path, data: { pools: [], asOf: null, issue: "unreachable" } })
        } finally {
          if (request === controller) { request = undefined; setPending(false) }
        }
      })()
    }
    if (!demo) {
      createEffect(() => {
        const path = directory()
        clear()
        if (path) untrack(refresh)
      })
      createEffect(() => {
        if (!directory()) return
        const client = ctx.client, controller = new AbortController()
        onCleanup(() => controller.abort())
        void (async () => {
          for await (const event of client.event.subscribe({
            types: ["config.updated", "provider.updated", "integration.updated", "credential.updated", "credential.switched"],
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) break
            if (event.type !== "server.connected" && event.location && event.location.directory !== directory() && event.type === "config.updated") continue
            clear(); refresh()
          }
        })().catch(() => { if (!controller.signal.aborted) clear() })
      })
      const focus = () => { setClock(Date.now()); refresh() }
      window.addEventListener("focus", focus)
      window.addEventListener("pageshow", focus)
      const policyTimer = setInterval(() => refresh(), 5 * 60_000)
      createEffect(() => {
        const next = data().pools.flatMap(p => p.windows.map(w => w.validUntil ?? w.resetAt)).filter(t => t !== undefined)
        if (!next.length) return
        const timer = setTimeout(() => { setClock(Date.now()); refresh() }, Math.min(2_147_483_647, Math.max(0, Math.min(...next) - Date.now())))
        onCleanup(() => clearTimeout(timer))
      })
      onCleanup(() => { window.removeEventListener("focus", focus); window.removeEventListener("pageshow", focus); clearInterval(policyTimer); request?.abort() })
    }
    const key = `${ctx.id}:${tab.id}`
    const open = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(key, session, { tab: "select" })
    }

    ctx.add(Style, css)
    ctx.add(Panel, {
      id: tab.id, region: "side", width: 370,
      mobile: { title, kind: "menu", order: 50, icon: "status" },
      list: input => input.open.includes(tab.id) ? [tab] : [],
      render: props => {
        const [panelClock, setPanelClock] = createSignal(Date.now())
        createEffect(() => {
          if (ctx.layout.state(key, props.session) !== "visible") return
          setPanelClock(Date.now())
          refresh()
          const clockTimer = setInterval(() => setPanelClock(Date.now()), 5_000)
          const refreshTimer = demo ? undefined : setInterval(() => refresh(), 60_000)
          onCleanup(() => { clearInterval(clockTimer); clearInterval(refreshTimer) })
        })
        const panelData = () => demo || (props.session.server.builtin && props.session.location?.directory === directory())
          ? data() : { pools: [], asOf: null } satisfies LiveSnapshot
        return <QuotaPanel data={panelData()} now={panelClock()} pending={pending()} supported={demo || props.session.server.builtin} scenario={demo ? scenario() : undefined} change={value => { setScenario(value); refresh() }} refresh={() => refresh(true)} />
      },
    })
    ctx.add(Command, (): Command => ({
      id: "open", title, keywords: "квоты бюджет quota", slash: { name: "quotas" },
      enabled: !!ctx.sessions.current(), run: open,
    }))
    ctx.add(MenuItem, (): MenuItem => ({
      id: "open", menu: "session.panel", title, icon: "status", run: open,
    }))
    ctx.add(ComposerPill, {
      id: "family-quota",
      show: input => {
        if (!demo && input.session.location?.directory !== directory()) return undefined
        const badge = indicator(data(), selectedFamily(input, demo, target?.providerID))
        if (!badge) return undefined
        return { ...badge, icon: quotaIcons[badge.tone], run: () => ctx.layout.open(key, input.session) }
      },
    })
  },
})
