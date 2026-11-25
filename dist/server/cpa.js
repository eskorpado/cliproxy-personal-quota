import { InvalidPolicy, parsePolicy, POLICY_PATH, record } from "./policy.js";
const API_PATH = "/v0/resource/plugins/cpa-key-billing";
const policyInterval = 5 * 60_000;
export class CpaError extends Error {
    status;
    route;
    expiredFilter;
    constructor(status, route, expiredFilter = false) {
        super("CPA quota request failed");
        this.status = status;
        this.route = route;
        this.expiredFilter = expiredFilter;
    }
}
async function json(response, max) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new CpaError(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0, text = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > max)
                throw new CpaError(0);
            text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    }
    catch {
        void reader.cancel().catch(() => { });
        throw new CpaError(0);
    }
    finally {
        reader.releaseLock();
    }
}
export class CpaClient {
    #policy;
    #checkedAt = -Infinity;
    #policyIssue;
    #fetcher;
    #clock;
    #origin;
    constructor(origin, fetcher = fetch, clock = Date.now) {
        this.#origin = origin;
        this.#fetcher = fetcher;
        this.#clock = clock;
    }
    async read(path, query, headers, signal) {
        const url = new URL(path, this.#origin);
        url.search = new URLSearchParams(query).toString();
        try {
            return await this.#fetcher(url, {
                method: "GET", headers: { Accept: "application/json", ...headers }, redirect: "error", cache: "no-store",
                signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
            });
        }
        catch {
            throw new CpaError(0);
        }
    }
    async policy(signal, revalidate = false) {
        if (revalidate || this.#clock() - this.#checkedAt >= policyInterval) {
            try {
                const response = await this.read(POLICY_PATH, {}, this.#policy?.etag ? { "If-None-Match": this.#policy.etag } : {}, signal);
                if (response.status === 304 && this.#policy) {
                    // Reuse last validated revision, not an unvalidated response body.
                }
                else if (response.ok) {
                    let body;
                    try {
                        body = await json(response, 128 * 1024);
                    }
                    catch {
                        throw new InvalidPolicy();
                    }
                    this.#policy = { value: parsePolicy(body), etag: response.headers.get("etag") };
                }
                else {
                    void response.body?.cancel().catch(() => { });
                    throw new CpaError(response.status);
                }
                this.#policyIssue = undefined;
            }
            catch (error) {
                signal.throwIfAborted();
                this.#policyIssue = error instanceof InvalidPolicy ? "catalog-invalid" : "catalog-unreachable";
            }
            this.#checkedAt = this.#clock();
        }
        return { value: this.#policy?.value, issue: this.#policyIssue };
    }
    api(key, signal) {
        return async (route, query = {}) => {
            const response = await this.read(`${API_PATH}${route}`, query, { Authorization: `Bearer ${key}` }, signal);
            if (response.ok)
                return json(response, route === "/events" ? 3 * 1024 * 1024 : 1024 * 1024);
            if (response.status === 400 && route === "/usage/models" && query.dimension === "credentials") {
                const body = record(await json(response, 16 * 1024).catch(() => undefined));
                throw new CpaError(400, route, body?.error === "expired_filter" || body?.code === "expired_filter" || record(body?.error)?.code === "expired_filter");
            }
            void response.body?.cancel().catch(() => { });
            throw new CpaError(response.status, route);
        };
    }
}
