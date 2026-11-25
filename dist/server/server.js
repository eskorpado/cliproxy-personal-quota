import { Plugin } from "@opencode/plugin";
import { CpaClient } from "./cpa.js";
import { liveQuota } from "./live.js";
import { QuotaRpc } from "./rpc.js";
import { configuredTarget, matchesOrigin } from "./target.js";
export default Plugin.define({
    id: "cliproxy-personal-quota",
    async setup(ctx) {
        if (ctx.options.mode === "demo")
            return;
        const target = configuredTarget(ctx.options);
        const live = target && liveQuota(async () => {
            const provider = await ctx.provider.get({ providerID: target.providerID }).then(result => result.data, () => undefined);
            if (!provider || provider.activation === "disabled" || provider.package !== "@opencode/ai/providers/openai-compatible" ||
                !matchesOrigin(provider.settings?.baseURL, target.origin) || Object.keys(provider.headers ?? {}).some(k => k.toLowerCase() === "authorization"))
                return { issue: "provider" };
            let key = provider.settings?.apiKey;
            if (key === undefined && provider.integrationID) {
                const connection = await ctx.integration.connection.active(provider.integrationID);
                const credential = connection && await ctx.integration.connection.resolve(connection);
                if (credential?.type === "key")
                    key = credential.key;
            }
            return typeof key === "string" && key.length <= 1024 && /^[\x21-\x7e]+$/.test(key) ? { key } : { issue: "key" };
        }, new CpaClient(target.origin));
        const registration = await ctx.rpc.register(QuotaRpc, {
            snapshot: async (input, { signal }) => live?.snapshot(signal, input.revalidate === true) ?? { pools: [], asOf: null, issue: "provider" },
        });
        return () => { live?.dispose(); return registration.dispose(); };
    },
});
