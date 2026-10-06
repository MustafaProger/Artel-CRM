import assert from 'node:assert/strict';

// Sample real CSS transitions and enforce one border, including composed fields.
export async function verifyFocusFeedback(page, locator, name) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await locator.evaluate(element => {
    const surface = element.closest('.company-combobox, .shipment-search, .overview-search, .bank-search, .team-search, .table-search, .driver-search, .filter-search, .auth-input-wrap') || element;
    const native = element.matches('input:is([type="checkbox"], [type="radio"], [type="range"], [type="file"])');
    const style = () => getComputedStyle(surface);
    const colour = () => native ? style().outlineColor : style().borderTopColor;
    const finish = () => { colour(); surface.getAnimations().forEach(animation => animation.finish()); colour(); };
    const geometry = () => {
      const rect = surface.getBoundingClientRect(), css = style();
      return [rect.width, rect.height, ...['Top', 'Right', 'Bottom', 'Left'].map(side => css[`border${side}Width`])];
    };
    const layers = () => ({ outline: style().outlineWidth, shadow: style().boxShadow, innerOutline: getComputedStyle(element).outlineWidth, innerShadow: getComputedStyle(element).boxShadow });
    const sample = () => {
      colour();
      const animation = surface.getAnimations().find(animation => animation.transitionProperty === (native ? 'outline-color' : 'border-top-color'));
      if (!animation) return { animated: false, colour: colour() };
      animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      return { animated: true, duration: animation.effect.getTiming().duration, colour: colour() };
    };
    element.blur(); finish();
    const before = geometry(), rest = colour();
    element.focus(); const enter = sample(); finish();
    const focused = colour(), focusLayers = layers();
    element.blur(); const leave = sample();
    element.focus(); const reverse = sample(); finish();
    const after = geometry();
    element.blur(); finish();
    return { native, rest, enter, focused, focusLayers, leave, reverse, end: colour(), before, after, endLayers: layers(), hasBorder: parseFloat(style().borderTopWidth) > 0 };
  });
  assert.notEqual(result.rest, result.focused, `${name}: focus changes colour`);
  assert.equal(result.focused, 'rgb(23, 102, 71)', `${name}: green focus`);
  assert.equal(result.end, result.rest, `${name}: original colour restored`);
  assert.deepEqual(result.after, result.before, `${name}: border thickness and dimensions preserved`);
  if (!result.native) {
    assert.ok(result.hasBorder, `${name}: existing border is present`);
    for (const layers of [result.focusLayers, result.endLayers]) {
      assert.deepEqual(layers, { outline: '0px', shadow: 'none', innerOutline: '0px', innerShadow: 'none' }, `${name}: no second layer`);
    }
  }
  for (const direction of ['enter', 'leave']) {
    const sample = result[direction];
    assert.ok(sample.animated && sample.duration === 160 && sample.colour !== result.rest && sample.colour !== result.focused, `${name}: ${direction} ${JSON.stringify(result)}`);
  }
  assert.ok(result.reverse.animated, `${name}: rapid reversal stays animated`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await locator.evaluate(element => {
    element.focus();
    const surface = element.closest('.company-combobox, .shipment-search, .overview-search, .bank-search, .team-search, .table-search, .driver-search, .filter-search, .auth-input-wrap') || element;
    const style = getComputedStyle(surface);
    return { duration: style.transitionDuration, outline: style.outlineWidth, colour: style.borderTopColor };
  });
  assert.equal(reduced.duration, '0s', `${name}: reduced motion`);
  if (!result.native) { assert.equal(reduced.outline, '0px'); assert.equal(reduced.colour, result.focused); }
  return { name, ...result, reduced };
}
