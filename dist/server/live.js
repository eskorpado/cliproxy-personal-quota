import { CpaError } from "./cpa.js";
import { measure } from "./quota.js";
import { currentView } from "./view.js";
const empty = (issue) => ({ pools: [], asOf: null, issue });
export function liveQuota(resolveIdentity, cpa, clock = Date.now) {
    let active;
    let disposed = false;
    function clear() {
        active?.controller.abort();
        active = undefined;
    }
    async function refresh(state, revalidate) {
        const signal = AbortSignal.any([AbortSignal.timeout(40_000), state.controller.signal]);
        try {
            const { value: policy, issue } = await cpa.policy(signal, revalidate);
            if (!policy)
                return empty(issue ?? "catalog-unreachable");
            // Don't reuse percentages across pricing/cycle policy changes.
            if (state.policy !== policy && state.previous) {
                state.previous = { view: { pools: [], asOf: null }, fixed: new Map(), knownPools: new Set(), spendCache: state.previous.spendCache };
            }
            state.policy = policy;
            const next = await measure(cpa.api(state.key, signal), policy, clock(), state.previous);
            signal.throwIfAborted();
            state.previous = next;
            return { ...next.view, ...(issue ? { issue } : {}) };
        }
        catch (error) {
            if (error instanceof CpaError && [401, 403].includes(error.status)) {
                state.previous = undefined;
                return empty("unauthorized");
            }
            // If the profile wasn't confirmed, neither the entitlement nor the allocation
            // was rechecked. Do not return cached personal figures in this case.
            return empty("unreachable");
        }
    }
    return {
        async snapshot(signal, revalidate = false) {
            try {
                if (disposed)
                    return empty("unreachable");
                const identity = await resolveIdentity();
                signal.throwIfAborted();
                if (disposed)
                    return empty("unreachable");
                if (!("key" in identity)) {
                    clear();
                    return empty(identity.issue);
                }
                if (active?.key !== identity.key) {
                    clear();
                    active = { key: identity.key, controller: new AbortController() };
                }
                const state = active;
                if (revalidate && state.work) {
                    await state.work;
                    signal.throwIfAborted();
                    if (active !== state)
                        return empty("unreachable");
                }
                const result = await (state.work ??= refresh(state, revalidate).finally(() => { state.work = undefined; }));
                signal.throwIfAborted();
                // Resolve again before serving an in-flight response after a config/credential change.
                const latest = await resolveIdentity();
                if (active === state && "key" in latest && latest.key === state.key)
                    return currentView(result, clock());
                if (active === state)
                    clear();
                return empty("key" in latest ? "unreachable" : latest.issue);
            }
            catch {
                if (!signal.aborted)
                    clear();
                return empty("unreachable");
            }
        },
        dispose() { disposed = true; clear(); },
    };
}
