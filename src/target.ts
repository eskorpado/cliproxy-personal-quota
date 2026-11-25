function httpsURL(value: unknown) {
  if (typeof value !== "string") return
  try {
    const url = new URL(value)
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url
  } catch { /* Invalid configuration disables live reads. */ }
}

export function configuredTarget(options: Readonly<Record<string, unknown>>) {
  const { providerID, origin } = options
  const url = httpsURL(origin)
  if (typeof providerID === "string" && providerID.trim() && url && url.pathname === "/") {
    return { providerID, origin: url.origin }
  }
}

export function matchesOrigin(baseURL: unknown, origin: string) {
  return httpsURL(baseURL)?.origin === origin
}
