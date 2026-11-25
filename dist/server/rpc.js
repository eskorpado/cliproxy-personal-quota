import { Rpc } from "@opencode/plugin/rpc";
export const QuotaRpc = Rpc.define({
    id: "cliproxy-personal-quota",
    events: {},
    methods: {
        snapshot: {
            input: { type: "object", properties: { revalidate: { type: "boolean" } }, additionalProperties: false },
            output: {
                type: "object", additionalProperties: false, required: ["pools", "asOf"],
                properties: {
                    asOf: { type: ["number", "null"] },
                    issue: { enum: ["provider", "key", "unauthorized", "unreachable", "catalog-unreachable", "catalog-invalid"] },
                    pools: { type: "array", items: {
                            type: "object", additionalProperties: false, required: ["modelFamilyPrefix", "windows"],
                            properties: {
                                modelFamilyPrefix: { type: "string" },
                                windows: { type: "array", items: {
                                        type: "object", additionalProperties: false, required: ["title", "status", "pct"],
                                        properties: {
                                            title: { type: "string" }, status: { enum: ["ok", "over", "partial", "missing"] },
                                            pct: { type: ["number", "null"], minimum: 0, maximum: 100 }, detail: { type: "string" },
                                            resetAt: { type: "number" }, validUntil: { type: "number" }, staleAsOf: { type: "number" },
                                        },
                                    } },
                            },
                        } },
                },
            },
        },
    },
});
