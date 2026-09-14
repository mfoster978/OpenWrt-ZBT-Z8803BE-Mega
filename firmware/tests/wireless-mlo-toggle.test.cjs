'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const tree = process.env.WIRELESS_TEST_TREE;
assert.ok(tree, 'WIRELESS_TEST_TREE must contain the patched pinned LuCI source');
const source = fs.readFileSync(path.join(tree, 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-wireless-mlo-'));
let minified;
try {
  const binary = path.join(temp, 'jsmin');
  const compile = spawnSync('cc', ['-O2', '-o', binary, path.join(process.env.LUCI_TEST_TREE, 'modules/luci-base/src/jsmin.c')], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(binary, [], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  minified = result.stdout;
  new Function(minified);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

function fixture(code) {
  const rows = [
    { '.name': 'radio0', disabled: '0' }, { '.name': 'radio1', disabled: '0' }, { '.name': 'radio2', disabled: '0' },
    { '.name': 'legacy', device: 'radio0', disabled: '0', mode: 'ap' },
    { '.name': 'standalone5', device: 'radio1', disabled: '0', mode: 'ap' },
    { '.name': 'mld', device: ['radio1', 'radio2'], mlo: '1', disabled: '0', mode: 'ap' }
  ];
  const row = id => { const found = rows.find(item => item['.name'] === id); assert.ok(found, `invalid UCI section: ${id}`); return found; };
  const uci = {
    get: (config, id, key) => row(id)[key],
    set: (config, id, key, value) => { row(id)[key] = value; },
    unset: (config, id, key) => { delete row(id)[key]; },
    sections: () => rows.filter(item => item.device)
  };
  let saves = 0, applies = 0;
  const L = { toArray: value => Array.isArray(value) ? value : value ? [value] : [] };
  const start = code.indexOf('function network_updown(');
  const end = code.indexOf('function next_free_sid(', start);
  assert.ok(start >= 0 && end > start);
  const toggle = new Function('uci', 'L', 'ui', code.slice(start, end) + '\nreturn network_updown;')(
    uci, L, { changes: { apply: () => { applies++; } } });
  return { row, rows, toggle: id => toggle(id, { save: () => { saves++; return Promise.resolve(); } }), counters: () => ({ saves, applies }) };
}

for (const [label, code] of [['source', source], ['packaged-jsmin', minified]]) {
  test(`${label}: disabling standalone 5 GHz leaves the shared MLD and both radios enabled`, async () => {
    const f = fixture(code);
    const peer = structuredClone(f.row('mld'));
    await f.toggle('standalone5');
    assert.equal(f.row('standalone5').disabled, '1');
    assert.equal(f.row('radio1').disabled, '0');
    assert.equal(f.row('radio2').disabled, '0');
    assert.deepEqual(f.row('mld'), peer);
    assert.deepEqual(f.counters(), { saves: 1, applies: 1 });
  });
  test(`${label}: disabling MLD only disables radios without another live AP or station`, async () => {
    const f = fixture(code);
    f.rows.push({ '.name': 'uplink', device: ['radio2'], disabled: '0', mode: 'sta' });
    await f.toggle('mld');
    assert.equal(f.row('mld').disabled, '1');
    assert.equal(f.row('radio1').disabled, '0');
    assert.equal(f.row('radio2').disabled, '0');
    assert.equal(f.row('legacy').disabled, '0');
  });
  test(`${label}: MLD toggle enables each real radio and preserves secondary disabled settings`, async () => {
    const f = fixture(code);
    f.row('standalone5').disabled = '1';
    await f.toggle('mld');
    assert.equal(f.row('radio1').disabled, '1');
    assert.equal(f.row('radio2').disabled, '1');
    await f.toggle('mld');
    assert.equal(f.row('mld').disabled, undefined);
    assert.equal(f.row('radio1').disabled, undefined);
    assert.equal(f.row('radio2').disabled, undefined);
    assert.equal(f.row('standalone5').disabled, '1');
    assert.equal(f.row('radio0').disabled, '0');
  });
  test(`${label}: a partially disabled MLD enables all its links`, async () => {
    const f = fixture(code);
    f.row('radio2').disabled = '1';
    await f.toggle('mld');
    assert.equal(f.row('radio1').disabled, undefined);
    assert.equal(f.row('radio2').disabled, undefined);
    assert.equal(f.row('mld').disabled, undefined);
  });
  test(`${label}: ordinary single-radio AP still disables and enables normally`, async () => {
    const f = fixture(code);
    await f.toggle('legacy');
    assert.equal(f.row('radio0').disabled, '1');
    assert.equal(f.row('radio1').disabled, '0');
    await f.toggle('legacy');
    assert.equal(f.row('radio0').disabled, undefined);
    assert.equal(f.row('legacy').disabled, undefined);
  });
}
