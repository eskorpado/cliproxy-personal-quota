export function currentView(data, now) {
    return {
        ...data,
        pools: data.pools.map(pool => ({ ...pool, windows: pool.windows.map(w => {
                if (w.validUntil !== undefined && w.validUntil <= now)
                    return { title: w.title, status: "missing", pct: null, detail: "Нужен новый снимок этого окна." };
                if (w.resetAt !== undefined && w.resetAt <= now) {
                    const { resetAt, ...window } = w;
                    return window;
                }
                return w;
            }) })),
    };
}
const resetDate = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const relativeTime = new Intl.RelativeTimeFormat("ru-RU");
const minute = 60_000;
export function resetTime(resetAt, now) {
    if (resetAt === undefined || resetAt <= now)
        return undefined;
    const minutes = (resetAt - now) / minute;
    const relative = minutes >= 1440 ? relativeTime.format(Math.floor(minutes / 1440), "day")
        : minutes >= 60 ? relativeTime.format(Math.floor(minutes / 60), "hour")
            : minutes >= 1 ? relativeTime.format(Math.ceil(minutes), "minute") : "меньше минуты";
    return { date: resetDate.format(resetAt), iso: new Date(resetAt).toISOString(), relative, urgent: minutes <= 5 };
}
