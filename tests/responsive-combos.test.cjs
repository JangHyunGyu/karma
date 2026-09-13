const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const source = fs.readFileSync(path.join(__dirname, '../js/components.js'), 'utf8');
  const start = source.indexOf('// Fixed-position lists');
  const end = source.indexOf('// =====', start);
  const listeners = {};
  const combos = [0, 1].map(() => {
    const combo = { open: true, layerActive: true, focused: false };
    combo.classList = { remove: name => { if (name === 'open') combo.open = false; } };
    combo.contains = element => element === combo;
    combo.querySelector = () => ({ focus: options => { assert.equal(options.preventScroll, true); combo.focused = true; } });
    return combo;
  });
  const target = name => ({ addEventListener: (event, handler) => { listeners[name + ':' + event] = handler; } });
  const context = {
    document: { ...target('document'), activeElement: combos[0], querySelectorAll: () => combos.filter(combo => combo.open) },
    window: { ...target('window'), visualViewport: target('visualViewport') },
    setComboLayerState: (combo, active) => { combo.layerActive = active; }
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { combos, listeners };
}

for (const event of ['window:resize', 'visualViewport:resize', 'visualViewport:scroll']) {
  test(event + ' closes stale fixed lists, releases stacking layers and restores keyboard focus', () => {
    const { combos, listeners } = setup();
    listeners[event]();
    assert.ok(combos.every(combo => !combo.open && !combo.layerActive));
    assert.equal(combos[0].focused, true);
  });
}

test('scrolling options keeps the list open while scrolling its page closes it', () => {
  const { combos, listeners } = setup();
  listeners['window:scroll']({ target: { closest: () => ({}) } });
  assert.ok(combos.every(combo => combo.open));
  listeners['window:scroll']({ target: {} });
  assert.ok(combos.every(combo => !combo.open && !combo.layerActive));
});
