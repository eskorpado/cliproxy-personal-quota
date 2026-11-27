import { CpaError, type CpaClient } from "./cpa.ts"
import { measure, type MeteredSnapshot, type ReconciliationLog } from "./quota.ts"
import { currentView, type Issue, type LiveSnapshot } from "./view.ts"

export type Identity = { key: string } | { issue: "provider" | "key" }
type CachedKey = {
  key: string; previous?: MeteredSnapshot
  work?: Promise<LiveSnapshot>; controller: AbortController
}

const empty = (issue: Issue): LiveSnapshot => ({ pools: [], asOf: null, issue })

export function liveQuota(resolveIdentity: () => Promise<Identity>, cpa: CpaClient, clock = Date.now, log?: ReconciliationLog) {
  let active: CachedKey | undefined
  let disposed = false

  function clear() {
    active?.controller.abort()
    active = undefined
  }

  async function refresh(state: CachedKey, revalidate: boolean): Promise<LiveSnapshot> {
    const signal = AbortSignal.any([AbortSignal.timeout(40_000), state.controller.signal])
    try {
      const { value: policy, issue } = await cpa.policy(signal, revalidate)
      if (!policy) return empty(issue ?? "catalog-unreachable")
      const next = await measure(cpa.api(state.key, signal), policy, clock(), state.previous, log)
      state.controller.signal.throwIfAborted()
      state.previous = next
      return { ...next.view, ...(issue ? { issue } : {}) }
    } catch (error) {
      if (error instanceof CpaError && [401, 403].includes(error.status)) {
        state.previous = undefined
        return empty("unauthorized")
      }
      // If the profile wasn't confirmed, neither the entitlement nor the allocation
      // was rechecked. Do not return cached personal figures in this case.
      return empty("unreachable")
    }
  }

  return {
    async snapshot(signal: AbortSignal, revalidate = false): Promise<LiveSnapshot> {
      try {
        if (disposed) return empty("unreachable")
        const identity = await resolveIdentity()
        signal.throwIfAborted()
        if (disposed) return empty("unreachable")
        if (!("key" in identity)) { clear(); return empty(identity.issue) }
        if (active?.key !== identity.key) { clear(); active = { key: identity.key, controller: new AbortController() } }
        const state = active
        if (revalidate && state.work) {
          await state.work
          signal.throwIfAborted()
          if (active !== state) return empty("unreachable")
        }
        const result = await (state.work ??= refresh(state, revalidate).finally(() => { state.work = undefined }))
        signal.throwIfAborted()
        // Resolve again before serving an in-flight response after a config/credential change.
        const latest = await resolveIdentity()
        if (active === state && "key" in latest && latest.key === state.key) return currentView(result, clock())
        if (active === state) clear()
        return empty("key" in latest ? "unreachable" : latest.issue)
      } catch {
        if (!signal.aborted) clear()
        return empty("unreachable")
      }
    },
    dispose() { disposed = true; clear() },
  }
}
