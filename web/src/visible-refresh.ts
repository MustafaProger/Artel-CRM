/** Background reads only. Manual actions and authorization keep their own fresh requests. */
export function watchVisibleRefresh(refresh: () => void, intervalMs?: number): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    pending = undefined
    if (document.visibilityState === 'visible') refresh()
  }
  // Returning to a tab commonly emits both visibilitychange and focus. Schedule
  // one read for that burst instead of aborting and restarting the same request.
  const schedule = () => {
    if (document.visibilityState !== 'visible') {
      clearTimeout(pending); pending = undefined
      return
    }
    clearTimeout(pending)
    pending = setTimeout(run, 50)
  }
  const timer = intervalMs === undefined ? undefined : setInterval(schedule, intervalMs)
  window.addEventListener('focus', schedule)
  document.addEventListener('visibilitychange', schedule)
  return () => {
    clearTimeout(pending); clearInterval(timer)
    window.removeEventListener('focus', schedule)
    document.removeEventListener('visibilitychange', schedule)
  }
}
