import { InvalidPolicy, parsePolicy, POLICY_PATH, record, type Policy } from "./policy.ts"

const API_PATH = "/v0/resource/plugins/cpa-key-billing"
const policyInterval = 5 * 60_000
type Route = "/profile" | "/auth-files" | "/usage/models" | "/events"

export class CpaError extends Error {
  readonly status: number
  readonly route?: Route
  readonly expiredFilter: boolean

  constructor(status: number, route?: Route, expiredFilter = false) {
    super("CPA quota request failed")
    this.status = status
    this.route = route
    this.expiredFilter = expiredFilter
  }
}

async function json(response: Response, max: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new CpaError(0)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let size = 0, text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw new CpaError(0)
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch {
    void reader.cancel().catch(() => {})
    throw new CpaError(0)
  } finally {
    reader.releaseLock()
  }
}

export class CpaClient {
  #policy?: { value: Policy; etag: string | null }
  #checkedAt = -Infinity
  #policyIssue?: "catalog-unreachable" | "catalog-invalid"
  readonly #fetcher: typeof fetch
  readonly #clock: () => number
  readonly #origin: string

  constructor(origin: string, fetcher: typeof fetch = fetch, clock = Date.now) {
    this.#origin = origin
    this.#fetcher = fetcher
    this.#clock = clock
  }

  private async read(path: typeof POLICY_PATH | `${typeof API_PATH}${Route}`, query: Record<string, string>, headers: HeadersInit, signal: AbortSignal) {
    const url = new URL(path, this.#origin)
    url.search = new URLSearchParams(query).toString()
    try {
      return await this.#fetcher(url, {
        method: "GET", headers: { Accept: "application/json", ...headers }, redirect: "error", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      })
    } catch { throw new CpaError(0) }
  }

  async policy(signal: AbortSignal, revalidate = false) {
    if (revalidate || this.#clock() - this.#checkedAt >= policyInterval) {
      try {
        const response = await this.read(POLICY_PATH, {}, this.#policy?.etag ? { "If-None-Match": this.#policy.etag } : {}, signal)
        if (response.status === 304 && this.#policy) {
          // Reuse last validated revision, not an unvalidated response body.
        } else if (response.ok) {
          let body: unknown
          try { body = await json(response, 128 * 1024) } catch { throw new InvalidPolicy() }
          this.#policy = { value: parsePolicy(body), etag: response.headers.get("etag") }
        } else {
          void response.body?.cancel().catch(() => {})
          throw new CpaError(response.status)
        }
        this.#policyIssue = undefined
      } catch (error) {
        signal.throwIfAborted()
        this.#policyIssue = error instanceof InvalidPolicy ? "catalog-invalid" : "catalog-unreachable"
      }
      this.#checkedAt = this.#clock()
    }
    return { value: this.#policy?.value, issue: this.#policyIssue }
  }

  api(key: string, signal: AbortSignal) {
    return async (route: Route, query: Record<string, string> = {}) => {
      const response = await this.read(`${API_PATH}${route}`, query, { Authorization: `Bearer ${key}` }, signal)
      if (response.ok) return json(response, route === "/events" ? 3 * 1024 * 1024 : 1024 * 1024)
      if (response.status === 400 && route === "/usage/models" && query.dimension === "credentials") {
        const body = record(await json(response, 16 * 1024).catch(() => undefined))
        throw new CpaError(400, route, body?.error === "expired_filter" || body?.code === "expired_filter" || record(body?.error)?.code === "expired_filter")
      }
      void response.body?.cancel().catch(() => {})
      throw new CpaError(response.status, route)
    }
  }
}

export type CpaApi = ReturnType<CpaClient["api"]>
