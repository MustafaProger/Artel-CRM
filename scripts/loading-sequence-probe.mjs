// Browser-native requestAnimationFrame observations and timestamped screenshot evidence.
export function instrument(options) {
  const ids = new WeakMap(); let serial = 0, enabled = false, scenario = '', frames = [], transitions = [], last = '';
  const visible = el => { if (el.closest('dialog:not([open])') || el.closest('[hidden]')) return false; for (let parent = el; parent; parent = parent.parentElement) { const style = getComputedStyle(parent); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false; } const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0; };
  const rect = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; };
  const sample = now => {
    if (enabled) {
      const skeletons = [...document.querySelectorAll('.loading-skeleton')].filter(visible).map(el => {
        if (!ids.has(el)) ids.set(el, ++serial);
        const bounds = rect(el), bars = [...el.querySelectorAll('.loading-skeleton__bar')].map(rect);
        const shape = { variant: [...el.classList].find(name => name.startsWith('loading-skeleton--')), toolbar: !!el.querySelector('.loading-skeleton__toolbar'), rows: el.querySelectorAll('.loading-skeleton__row').length, metrics: el.querySelectorAll('.loading-skeleton__metrics>*').length, bounds, bars };
        return { node: ids.get(el), label: el.getAttribute('aria-label'), shape, shapeKey: JSON.stringify(options.motion === 'reduce' ? shape : { variant: shape.variant, toolbar: shape.toolbar, rows: shape.rows, metrics: shape.metrics, width: bounds.width, height: bounds.height, bars: bars.map(bar => ({ width: bar.width, height: bar.height })) }), inViewport: bounds.y < innerHeight && bounds.y + bounds.height > 0 };
      });
      const statuses = [...document.querySelectorAll('.loading-state,.loading-progress,.route-loading-indicator,.page-loading-indicator,.page-loading,[data-loading-indicator]')].filter(visible).map(el => ({ className: el.className, label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80), bounds: rect(el) }));
      const frame = { index: frames.length, time: Math.round(now * 100) / 100, wall: Date.now(), hash: location.hash, skeletons, statuses, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth };
      frames.push(frame);
      const signature = JSON.stringify({ hash: frame.hash, skeletons: skeletons.map(item => ({ node: item.node, label: item.label, shape: item.shape })), statuses });
      if (signature !== last) { transitions.push({ ...frame, signature }); last = signature; }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__loadingSequence = { start(name) { enabled = true; scenario = name; frames = []; transitions = []; last = ''; }, stop() { enabled = false; return { scenario, frames, transitions }; }, peek() { return frames.at(-1) ?? null; }, visibleSkeletonCount() { return [...document.querySelectorAll('.loading-skeleton')].filter(visible).length; } };
  if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => undefined });
  // Save every transient state from first application render on cold navigation.
  const cold = new URL(location.href).searchParams.get('sequenceCold'); if (cold) window.__loadingSequence.start(cold);
}
export async function advanceFrames(page, count = 24) { await page.evaluate(count => new Promise(done => { let left = count; const next = () => { if (--left <= 0) done(); else requestAnimationFrame(next); }; requestAnimationFrame(next); }), count); }
export async function screenshot(page, path, stage, options = {}) { const before = await page.evaluate(() => window.__loadingSequence.peek()); await page.screenshot({ path, fullPage: options.fullPage ?? true }); const after = await page.evaluate(() => window.__loadingSequence.peek()); const regions = await page.evaluate(() => {
    const measure = selector => { const el = document.querySelector(selector); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }; };
    const skeleton = measure('.loading-skeleton__china-table'), skeletonScroll = measure('.loading-skeleton__china-scroll'), content = measure('.china-table'), contentScroll = measure('.china-table-scroll');
    const visibleSkeletonColumns = [...document.querySelectorAll('.loading-skeleton__china-heading > *')].filter(el => { const b = el.getBoundingClientRect(); return skeletonScroll && b.x >= skeletonScroll.x - 1 && b.right <= skeletonScroll.x + skeletonScroll.clientWidth + 1; }).length;
    const visibleContentColumns = [...document.querySelectorAll('.china-table thead th')].filter(el => { const b = el.getBoundingClientRect(); return contentScroll && b.x >= contentScroll.x - 1 && b.right <= contentScroll.x + contentScroll.clientWidth + 1; }).length;
    return { china: { skeleton, skeletonScroll, content, contentScroll, visibleSkeletonColumns, visibleContentColumns } };
  }); return { stage, regions, file: path.split('/').at(-1), frameBefore: before?.index, frameAfter: after?.index, timeBefore: before?.time, timeAfter: after?.time, statuses: after?.statuses, skeletons: after?.skeletons.map(item => ({ node: item.node, label: item.label, shape: item.shape })) }; }

export function feedbackRegressions(frames) {
  let seenSkeleton = false, lastHadSkeleton = false, episodes = 0;
  const backwardFrames = [], simultaneousFrames = [];
  for (const frame of frames) {
    const hasSkeleton = frame.skeletons.length > 0;
    const neutral = frame.statuses.filter(status => /(^|\s)(page-loading|loading-state|route-loading-indicator|page-loading-indicator)(\s|$)/.test(status.className));
    if (hasSkeleton && !lastHadSkeleton) episodes++;
    if (hasSkeleton && neutral.length) simultaneousFrames.push(frame.index);
    if (seenSkeleton && !hasSkeleton && neutral.length) backwardFrames.push(frame.index);
    seenSkeleton ||= hasSkeleton;
    lastHadSkeleton = hasSkeleton;
  }
  return { skeletonEpisodes: episodes, neutralAfterSkeletonFrames: backwardFrames, simultaneousFeedbackFrames: simultaneousFrames };
}
