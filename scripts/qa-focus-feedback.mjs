import assert from 'node:assert/strict';

// Sample the browser's real CSS transitions, in both directions and on reversal.
export async function verifyFocusFeedback(page, locator, name) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await locator.evaluate(element => {
    const surface = element.closest('.company-combobox, .shipment-search, .overview-search, .bank-search, .team-search, .table-search, .driver-search, .filter-search, .auth-input-wrap') || element;
    const style = () => getComputedStyle(surface);
    const flush = () => style().outlineColor;
    const finish = () => { flush(); surface.getAnimations().forEach(animation => animation.finish()); flush(); };
    const alpha = () => { const color = flush(); return color.startsWith('rgba') ? Number(color.split(',').at(-1).replace(')', '')) : 1; };
    const sample = () => {
      flush();
      const animation = surface.getAnimations().find(animation => animation.transitionProperty === 'outline-color');
      if (!animation) return { animated: false, alpha: alpha() };
      animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      return { animated: true, duration: animation.effect.getTiming().duration, alpha: alpha() };
    };
    element.blur(); finish();
    const rect = surface.getBoundingClientRect(), rest = alpha();
    element.focus(); const enter = sample(); finish();
    const focused = alpha(), width = style().outlineWidth;
    element.blur(); const leave = sample();
    element.focus(); const reverse = sample(); finish();
    const finalRect = surface.getBoundingClientRect();
    element.blur(); finish();
    return { rest, enter, focused, width, leave, reverse, end: alpha(), unchangedSize: rect.width === finalRect.width && rect.height === finalRect.height };
  });
  assert.equal(result.width, '1px', `${name}: ring thickness`);
  assert.equal(result.rest, 0, `${name}: transparent at rest`);
  assert.equal(result.focused, 1, `${name}: full focus colour`);
  assert.equal(result.end, 0, `${name}: transparent after blur`);
  assert.ok(result.unchangedSize, `${name}: focus must not change geometry`);
  for (const direction of ['enter', 'leave']) {
    assert.ok(result[direction].animated && result[direction].duration === 160 && result[direction].alpha > 0 && result[direction].alpha < 1, `${name}: ${direction} ${JSON.stringify(result)}`);
  }
  assert.ok(result.reverse.animated, `${name}: rapid reversal stays animated`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await locator.evaluate(element => {
    element.focus();
    const surface = element.closest('.company-combobox, .shipment-search, .overview-search, .bank-search, .team-search, .table-search, .driver-search, .filter-search, .auth-input-wrap') || element;
    const style = getComputedStyle(surface);
    return { duration: style.transitionDuration, width: style.outlineWidth, colour: style.outlineColor };
  });
  assert.equal(reduced.duration, '0s', `${name}: reduced motion`);
  assert.equal(reduced.width, '1px');
  return { name, ...result, reduced };
}
