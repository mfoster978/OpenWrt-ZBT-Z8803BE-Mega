'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('MLO editor rewrites legacy per-band records as one shared multi-radio iface', () => {
  const tree = process.env.MLO_TEST_TREE;
  assert.ok(tree, 'MLO_TEST_TREE is required');
  const file = path.join(tree, 'htdocs/luci-static/resources/view/mlo/main.js');
  const source = fs.readFileSync(file, 'utf8');
  const boundary = source.indexOf('\nreturn view.extend({');
  assert.ok(boundary > 0, 'unable to isolate MLO model functions');

  const wifiDevices = [
    { '.type': 'wifi-device', '.name': 'radio0', band: '2g', htmode: 'EHT20' },
    { '.type': 'wifi-device', '.name': 'radio1', band: '5g', htmode: 'EHT80' },
    { '.type': 'wifi-device', '.name': 'radio2', band: '6g', htmode: 'EHT160' }
  ];
  let ifaces = [
    { '.type': 'wifi-iface', '.name': 'old_2g', device: 'radio0', mode: 'ap', network: 'lan', ssid: 'Fostah Logistics', encryption: 'sae', key: 'test-password', mlo: '1' },
    { '.type': 'wifi-iface', '.name': 'old_5g', device: 'radio1', mode: 'ap', network: 'lan', ssid: 'Fostah Logistics', encryption: 'sae', key: 'test-password', mlo: '1' },
    { '.type': 'wifi-iface', '.name': 'old_6g', device: 'radio2', mode: 'ap', network: 'lan', ssid: 'Fostah Logistics', encryption: 'sae', key: 'test-password', mlo: '1' }
  ];
  const uci = {
    sections(config, type) {
      assert.equal(config, 'wireless');
      return (type === 'wifi-device' ? wifiDevices : ifaces).slice();
    },
    get(config, section, option) {
      assert.equal(config, 'wireless');
      const row = wifiDevices.concat(ifaces).find(x => x['.name'] === section);
      return row && row[option];
    },
    add(config, type, name) {
      assert.equal(config, 'wireless');
      assert.equal(type, 'wifi-iface');
      assert.ok(!ifaces.some(x => x['.name'] === name), `duplicate section ${name}`);
      ifaces.push({ '.type': type, '.name': name });
      return name;
    },
    set(config, section, option, value) {
      assert.equal(config, 'wireless');
      const row = ifaces.find(x => x['.name'] === section);
      assert.ok(row, `missing section ${section}`);
      row[option] = value;
    },
    unset(config, section, option) {
      assert.equal(config, 'wireless');
      delete ifaces.find(x => x['.name'] === section)[option];
    },
    remove(config, section) {
      assert.equal(config, 'wireless');
      ifaces = ifaces.filter(x => x['.name'] !== section);
    }
  };

  const api = new Function('uci', source.slice(0, boundary) + '\nreturn { loadMlds, applyMld };')(uci);
  const before = api.loadMlds().mlds.old_2g;
  assert.deepEqual(Array.from(before.bands).sort(), [ '2g', '5g', '6g' ]);
  api.applyMld(before);

  const mlo = ifaces.filter(x => x.mlo === '1');
  assert.equal(mlo.length, 1, 'one logical MLD must be one wifi-iface');
  assert.deepEqual(mlo[0].device, [ 'radio0', 'radio1', 'radio2' ]);
  assert.equal(mlo[0].ieee80211w, '2');
  assert.equal(mlo[0].ssid, 'Fostah Logistics');
  assert.equal(mlo[0].network, 'lan');

  const migration = fs.readFileSync(path.join(__dirname, '../files/etc/uci-defaults/74-zbt-mlo-shared-iface-repair'), 'utf8');
  assert.match(migration, /original network and security preserved/);
  assert.doesNotMatch(migration, /(?:set|add_list) "wireless\.\$\{first\}\.network=/);
  assert.doesNotMatch(migration, /wifi reload|zbt-wifi-reload-deferred/);
  const builder = fs.readFileSync(path.join(__dirname, '../docker/build-openwrt.sh'), 'utf8');
  assert.match(builder, /make package\/luci-app-mlo\/clean/);
  assert.match(builder, /rsync -a --delete "\$\{FILES_OVERLAY_DIR\}\/?" files\//);
});

function mloSource(minified = false) {
  const tree = process.env.MLO_TEST_TREE;
  assert.ok(tree, 'MLO_TEST_TREE is required');
  const source = fs.readFileSync(path.join(tree, 'htdocs/luci-static/resources/view/mlo/main.js'), 'utf8');
  if (!minified) return source;
  const luciTree = process.env.LUCI_TEST_TREE;
  assert.ok(luciTree, 'LUCI_TEST_TREE is required for the real build minifier');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mlo-jsmin-'));
  try {
    const binary = path.join(temp, 'jsmin');
    const compile = spawnSync('cc', ['-O2', '-o', binary, path.join(luciTree, 'modules/luci-base/src/jsmin.c')],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(compile.status, 0, compile.stderr);
    const minify = spawnSync(binary, [], { input: source, encoding: 'utf8', timeout: 5000 });
    assert.equal(minify.status, 0, minify.stderr);
    new Function(minify.stdout);
    assert.ok(minify.stdout.length < source.length);
    return minify.stdout;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function editorFixture(source, interfaces = [], firstMode = 'HT20') {
  let rows = [
    { '.type': 'wifi-device', '.name': 'radio0', band: '2g', htmode: firstMode, channel: '1' },
    { '.type': 'wifi-device', '.name': 'radio1', band: '5g', htmode: 'EHT80', channel: '149' },
    { '.type': 'wifi-device', '.name': 'radio2', band: '6g', htmode: 'EHT160', channel: '37' },
    ...structuredClone(interfaces)
  ];
  const writes = [];
  const uci = {
    sections(config, type) {
      assert.equal(config, 'wireless');
      return rows.filter(row => !type || row['.type'] === type).slice();
    },
    get(config, section, option) {
      assert.equal(config, 'wireless');
      return rows.find(row => row['.name'] === section)?.[option];
    },
    add(config, type, name) {
      assert.equal(config, 'wireless');
      assert.equal(type, 'wifi-iface');
      assert.ok(!rows.some(row => row['.name'] === name), 'section collision: ' + name);
      writes.push(['add', name]);
      rows.push({ '.type': type, '.name': name });
      return name;
    },
    set(config, section, option, value) {
      assert.equal(config, 'wireless');
      const row = rows.find(row => row['.name'] === section);
      assert.ok(row, 'missing section: ' + section);
      writes.push(['set', section, option, value]);
      row[option] = value;
    },
    unset(config, section, option) {
      assert.equal(config, 'wireless');
      writes.push(['unset', section, option]);
      delete rows.find(row => row['.name'] === section)[option];
    },
    remove(config, section) {
      assert.equal(config, 'wireless');
      writes.push(['remove', section]);
      rows = rows.filter(row => row['.name'] !== section);
    }
  };
  const elements = [];
  let modal, hidden = 0;
  function E(tag, attrs = {}, children = []) {
    const node = { tag, attrs, children: Array.isArray(children) ? children : [children], style: {},
      value: attrs.value, checked: !!attrs.checked, textContent: '',
      addEventListener() {},
      querySelector(selector) { assert.equal(selector, 'input'); return this.children.find(child => child.tag === 'input'); } };
    if (tag === 'select') node.value = (node.children.find(child => child.attrs.selected) || node.children[0])?.value;
    elements.push(node);
    return node;
  }
  const translate = text => Object.assign(new String(text), {
    format: (...values) => text.replace(/%s/g, () => String(values.shift()))
  });
  const boundary = source.indexOf('return view.extend({');
  assert.ok(boundary > 0);
  const api = new Function('uci', '_', 'E', 'ui', source.slice(0, boundary) +
    '\nreturn { loadMlds, applyMld, deleteMld, validateMld, openMldEditor };')(
      uci, translate, E, { showModal: (title, contents) => { modal = contents; }, hideModal: () => { hidden++; } });
  return { api, uci, writes, rows: () => structuredClone(rows),
    get: name => structuredClone(rows.find(row => row['.name'] === name)), elements,
    modal: () => modal, hidden: () => hidden };
}

function editorAp(name, options = {}) {
  return { '.type': 'wifi-iface', '.name': name, device: 'radio0', mode: 'ap', network: 'lan',
    ssid: 'TruckWiFi', encryption: 'psk2+ccmp', key: 'fixture-passphrase', ieee80211w: '0', disabled: '0', ...options };
}

function editorMld(name, options = {}) {
  return editorAp(name, { device: ['radio1', 'radio2'], mlo: '1', encryption: 'sae', ieee80211w: '2', ...options });
}

function newMld(options = {}) {
  return { ssid: 'TruckWiFi', encryption: 'sae', key: 'fixture-passphrase', bands: new Set(['5g', '6g']), ...options };
}

for (const minified of [false, true]) {
  test(`MLO safe editor behavior on ${minified ? 'actual pinned jsmin output' : 'patched source'}`, async t => {
    const source = mloSource(minified);

    await t.test('same-name legacy and guest access points survive creation, save and rename', () => {
      const preserved = [editorAp('default_radio0', { wmm: '1', ieee80211r: '0' }),
        editorAp('guest', { network: 'guest', isolate: '1' }),
        editorMld('guest_mld', { network: ['guest'], isolate: '1' }),
        editorAp('uplink', { mode: 'sta' })];
      const f = editorFixture(source, preserved);
      const radioState = f.rows().filter(row => row['.type'] === 'wifi-device');
      f.api.applyMld(newMld());
      for (const original of preserved) assert.deepEqual(f.get(original['.name']), original);
      const owned = f.rows().find(row => row.mlo === '1' && row.network === 'lan');
      assert.deepEqual(owned.device, ['radio1', 'radio2']);
      assert.equal(owned.ieee80211w, '2');
      const groups = f.api.loadMlds().mlds;
      assert.equal(Object.keys(groups).length, 2, 'same-SSID guest MLD is an independent record');
      f.api.applyMld({ ...groups[owned['.name']], ssid: 'Renamed Truck' });
      assert.equal(f.get(owned['.name']).ssid, 'Renamed Truck');
      assert.equal(f.rows().filter(row => row.mlo === '1' && row.network === 'lan').length, 1);
      f.api.applyMld(f.api.loadMlds().mlds[owned['.name']]);
      for (const original of preserved) assert.deepEqual(f.get(original['.name']), original);
      assert.deepEqual(f.rows().filter(row => row['.type'] === 'wifi-device'), radioState);
    });

    await t.test('editing a shared group preserves section options and removes only the selected link', () => {
      const legacy = editorAp('default_radio0', { legacy_option: 'owner-choice' });
      const f = editorFixture(source, [legacy, editorMld('main', {
        device: ['radio0', 'radio1', 'radio2'], network: ['lan'], hidden: '1', isolate: '1'
      })]);
      const before = f.rows();
      f.api.applyMld({ ...f.api.loadMlds().mlds.main, bands: new Set(['5g', '6g']) });
      assert.deepEqual(f.get('default_radio0'), legacy);
      assert.deepEqual(f.get('main').device, ['radio1', 'radio2']);
      assert.deepEqual(f.get('main').network, ['lan']);
      assert.equal(f.get('main').hidden, '1');
      assert.equal(f.get('main').isolate, '1');
      assert.equal(f.rows().length, before.length, 'no unsolicited standalone AP is synthesized');
      assert.deepEqual(f.get('radio0'), before.find(row => row['.name'] === 'radio0'));
    });

    await t.test('legacy per-band consolidation and deletion never merge a same-name guest group', () => {
      const legacy = [editorMld('old5', { device: 'radio1' }), editorMld('old6', { device: 'radio2' }),
        editorMld('guest5', { device: 'radio1', network: 'guest' }), editorMld('guest6', { device: 'radio2', network: 'guest' }),
        editorAp('legacy2g')];
      const f = editorFixture(source, legacy);
      const groups = f.api.loadMlds().mlds;
      assert.deepEqual(groups.old5.sections, ['old5', 'old6']);
      assert.deepEqual(groups.guest5.sections, ['guest5', 'guest6']);
      f.api.applyMld(groups.old5);
      assert.equal(f.get('old6'), undefined);
      assert.deepEqual(f.get('old5').device, ['radio1', 'radio2']);
      for (const original of legacy.slice(2)) assert.deepEqual(f.get(original['.name']), original);
      f.api.deleteMld(f.api.loadMlds().mlds.old5);
      assert.equal(f.get('old5'), undefined);
      for (const original of legacy.slice(2)) assert.deepEqual(f.get(original['.name']), original);
    });

    await t.test('new section names cannot collide with existing sections or SSID slugs', () => {
      const original = editorAp('mld_truckwifi', { ssid: 'Unrelated owner network' });
      const f = editorFixture(source, [original]);
      f.api.applyMld(newMld());
      assert.deepEqual(f.get(original['.name']), original);
      assert.equal(f.get('mld_truckwifi_1').ssid, 'TruckWiFi');
      f.api.applyMld(newMld({ ssid: 'TruckWiFi!' }));
      assert.equal(f.get('mld_truckwifi_2').ssid, 'TruckWiFi!');
    });

    await t.test('invalid bands, non-EHT radios and incompatible security fail before every UCI write', () => {
      const invalid = [
        newMld({ bands: new Set() }), newMld({ bands: new Set(['5g']) }),
        newMld({ bands: new Set(['2g', '5g']) }), newMld({ bands: new Set(['5g', 'missing']) }),
        ...['none', 'psk2', 'psk2+ccmp', 'sae-mixed'].map(encryption => newMld({ encryption })),
        newMld({ ssid: '界'.repeat(11) }), newMld({ ssid: ' ' }),
        newMld({ key: 'short' }), newMld({ key: 'x'.repeat(64) }), newMld({ key: 'line\nbreak' })
      ];
      for (const rec of invalid) {
        const f = editorFixture(source, [editorAp('legacy'), editorMld('main')]);
        const before = f.rows();
        assert.throws(() => f.api.applyMld({ ...rec, sections: ['main'] }));
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.rows(), before);
      }
      const f = editorFixture(source, [], 'EHT20');
      f.api.applyMld(newMld({ bands: new Set(['2g', '5g', '6g']) }));
      assert.deepEqual(f.get('mld_truckwifi').device, ['radio0', 'radio1', 'radio2']);
    });

    await t.test('OWE clears a stale key and still requires PMF without changing a legacy password', () => {
      const legacy = editorAp('legacy');
      const f = editorFixture(source, [legacy, editorMld('main')]);
      f.api.applyMld({ ...f.api.loadMlds().mlds.main, encryption: 'owe', key: '' });
      assert.equal(f.get('main').key, undefined);
      assert.equal(f.get('main').ieee80211w, '2');
      assert.deepEqual(f.get('legacy'), legacy);
    });

    await t.test('stale or non-MLO identities are rejected instead of editing another AP', () => {
      for (const sections of [['missing'], ['legacy'], ['main', 'main']]) {
        const f = editorFixture(source, [editorAp('legacy'), editorMld('main')]);
        assert.throws(() => f.api.applyMld(newMld({ sections })), /group changed/);
        assert.deepEqual(f.writes, []);
      }
    });

    await t.test('modal defaults exclude legacy radio and retain exact identity when renaming', () => {
      const f = editorFixture(source, [editorAp('legacy'), editorMld('main')]);
      let submitted;
      f.api.openMldEditor(null, rec => { submitted = rec; });
      assert.deepEqual(f.elements.filter(node => node.tag === 'input' && node.attrs.type === 'checkbox' && node.checked).map(node => node.value), ['5g', '6g']);
      assert.equal(f.elements.find(node => node.attrs.id === 'mlo-key').attrs.type, 'password');
      assert.equal(f.elements.find(node => node.attrs.id === 'mlo-key').value, '');
      const start = f.elements.length;
      f.api.openMldEditor(f.api.loadMlds().mlds.main, rec => { submitted = rec; f.api.applyMld(rec); });
      const elements = f.elements.slice(start);
      elements.find(node => node.attrs.id === 'mlo-ssid').value = 'Renamed';
      elements.find(node => node.tag === 'button' && node.attrs.class.includes('cbi-button-positive')).attrs.click();
      assert.deepEqual(submitted.sections, ['main']);
      assert.equal(f.get('main').ssid, 'Renamed');
      assert.equal(f.hidden(), 1);
      assert.equal(f.get('legacy').ssid, 'TruckWiFi');
    });
  });
}

// Execute the real migration in BusyBox ash. UCI is a stateful test double;
// this suite validates migration decisions, not libuci serialization itself.
function migrationFixture(radios, interfaces) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mlo-migration-'));
  const statePath = path.join(dir, 'state.json');
  const callsPath = path.join(dir, 'calls.jsonl');
  const logPath = path.join(dir, 'log');
  const initial = { ...radios, ...interfaces };
  fs.writeFileSync(statePath, JSON.stringify(initial));
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(path.join(dir, 'uci'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).filter(arg => arg !== '-q');
const [command, expr] = args;
const state = JSON.parse(fs.readFileSync(process.env.MLO_STATE, 'utf8'));
const [name, value] = String(expr || '').split(/=(.*)/s);
const [config, section, option] = name.split('.');
if (config !== 'wireless') process.exit(2);
if (command === 'show') {
 for (const [key, row] of Object.entries(state)) console.log('wireless.' + key + '=' + row.type);
 process.exit(0);
}
if (command === 'export') {
 console.log('package wireless');
 for (const [key, row] of Object.entries(state)) {
  console.log("config " + row.type + " '" + key + "'");
  // The migration reads only device type/value from the export. Do not emit
  // credentials in this diagnostic fixture.
  if (Array.isArray(row.device)) {
   for (const device of row.device) console.log("\\tlist device '" + device + "'");
  } else if (row.device != null) console.log("\\toption device '" + row.device + "'");
 }
 process.exit(0);
}
if (command === 'get') {
 const result = state[section]?.[option];
 if (result == null) process.exit(1);
 console.log(Array.isArray(result) ? result.join(' ') : result);
 process.exit(0);
}
if (!['set', 'delete', 'add_list', 'commit'].includes(command)) process.exit(2);
fs.appendFileSync(process.env.MLO_CALLS, JSON.stringify(args) + '\\n');
if (command === 'set') state[section][option] = value;
if (command === 'delete') {
 if (option) delete state[section][option];
 else delete state[section];
}
if (command === 'add_list') {
 const old = state[section][option];
 state[section][option] = [...(Array.isArray(old) ? old : old == null ? [] : [old]), value];
}
fs.writeFileSync(process.env.MLO_STATE, JSON.stringify(state));
`, { mode: 0o755 });
  const source = fs.readFileSync(path.join(__dirname, '../files/etc/uci-defaults/74-zbt-mlo-shared-iface-repair'), 'utf8')
    .replace('. /lib/functions.sh', 'board_name() { echo zbtlink,zbt-z8803be; }');
  const run = () => {
    const result = spawnSync('busybox', ['sh', '-c', `
logger() { printf '%s\\n' "$*" >> "$MLO_LOG"; }
wifi() { echo UNEXPECTED_WIFI >&2; return 99; }
ifup() { echo UNEXPECTED_IFUP >&2; return 99; }
ifdown() { echo UNEXPECTED_IFDOWN >&2; return 99; }
${source}`], { encoding: 'utf8', timeout: 30000, env: {
      ...process.env, PATH: dir + path.delimiter + process.env.PATH,
      MLO_STATE: statePath, MLO_CALLS: callsPath, MLO_LOG: logPath
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return {
      state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
      calls: fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
      log: fs.readFileSync(logPath, 'utf8')
    };
  };
  return { initial, run, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function mloRadios(firstMode = 'HT20') {
  return {
    radio0: { type: 'wifi-device', band: '2g', htmode: firstMode, channel: '1' },
    radio1: { type: 'wifi-device', band: '5g', htmode: 'EHT80', channel: '149' },
    radio2: { type: 'wifi-device', band: '6g', htmode: 'EHT160', channel: '37' }
  };
}

function mloInterface(devices, extra = {}) {
  return { type: 'wifi-iface', device: devices, network: ['lan'], mode: 'ap', mlo: '1',
    ssid: 'Shared WiFi7', encryption: 'sae', key: 'owner-password', ieee80211w: '2', disabled: '0', ...extra };
}

test('MLO migration drops the HT20 link from a preserved three-band group while preserving other networks', () => {
  const fixture = migrationFixture(mloRadios(), {
    mld_main: mloInterface(['radio0', 'radio1', 'radio2']),
    default_radio0: { type: 'wifi-iface', device: 'radio0', network: 'lan', mode: 'ap',
      ssid: 'Legacy WiFi', encryption: 'psk2', key: 'legacy-password' },
    owner_custom_mlo: mloInterface(['radio0', 'radio1', 'radio2'], { ssid: 'Owner custom MLO' }),
    mld_station: mloInterface(['radio0', 'radio1'], { ssid: 'Uplink', mode: 'sta' })
  });
  try {
    const { state, calls, log } = fixture.run();
    assert.deepEqual(state.mld_main, { ...fixture.initial.mld_main, device: ['radio1', 'radio2'] });
    for (const name of ['radio0', 'radio1', 'radio2', 'default_radio0', 'owner_custom_mlo', 'mld_station'])
      assert.deepEqual(state[name], fixture.initial[name], name + ' must be preserved');
    assert.match(log, /excluded non-EHT radios: radio0/);
    assert.equal(calls.filter(call => call[0] === 'commit').length, 1);
    assert.deepEqual(fixture.run().state, state, 'second run is state-idempotent');
  } finally { fixture.close(); }
});

test('MLO migration retains all already-valid EHT links and credentials', () => {
  const fixture = migrationFixture(mloRadios('EHT20'), {
    mld_main: mloInterface(['radio0', 'radio1', 'radio2'])
  });
  try {
    const { state, log } = fixture.run();
    assert.deepEqual(state, fixture.initial);
    assert.doesNotMatch(log, /excluded non-EHT radios/);
  } finally { fixture.close(); }
});

test('MLO migration still consolidates old per-band records after excluding a legacy link', () => {
  const fixture = migrationFixture(mloRadios(), {
    mld_shared_2g: mloInterface('radio0', { network: 'lan', mld_ap: '1', mld_id: '0' }),
    mld_shared_5g: mloInterface('radio1', { network: 'lan' }),
    mld_shared_6g: mloInterface('radio2', { network: 'lan' })
  });
  try {
    const { state } = fixture.run();
    assert.deepEqual(state.mld_shared_2g, mloInterface(['radio1', 'radio2'], { network: 'lan' }));
    assert.equal(state.mld_shared_5g, undefined);
    assert.equal(state.mld_shared_6g, undefined);
  } finally { fixture.close(); }
});

test('MLO migration preserves independent same-SSID shared LAN and guest groups across repeated boots', () => {
  const fixture = migrationFixture(mloRadios(), {
    mld_primary: mloInterface(['radio0', 'radio1', 'radio2'], { network: ['lan'], hidden: '1' }),
    mld_guest: mloInterface(['radio1', 'radio2'], { network: ['guest'], key: 'guest-only-password', isolate: '1', disabled: '1' }),
    mld_same_name: mloInterface(['radio1', 'radio2'], { network: ['lan'], key: 'independent-password' }),
    default_radio0: { type: 'wifi-iface', device: 'radio0', mode: 'ap', network: 'lan',
      ssid: 'Shared WiFi7', encryption: 'psk2+ccmp', key: 'legacy-password', ieee80211w: '0' }
  });
  try {
    const first = fixture.run();
    assert.deepEqual(first.state.mld_primary, { ...fixture.initial.mld_primary, device: ['radio1', 'radio2'] });
    for (const section of ['mld_guest', 'mld_same_name', 'default_radio0'])
      assert.deepEqual(first.state[section], fixture.initial[section]);
    const second = fixture.run();
    assert.deepEqual(second.state, first.state);
    assert.deepEqual(second.calls, first.calls, 'valid shared sections make no further UCI writes');
    assert.ok(first.calls.every(call => !/\.(?:network|key|encryption|ieee80211w|disabled)=/.test(call[1] || '')));
  } finally { fixture.close(); }
});

test('MLO migration does not absorb modern one-item lists or unrelated generated-name scalar records', () => {
  for (const candidate of [
    mloInterface(['radio2'], { network: 'lan' }),
    mloInterface('radio2', { network: 'guest' }),
    mloInterface('radio2', { network: 'lan', encryption: 'owe' }),
    mloInterface('radio2', { network: 'lan', key: 'different-password' }),
    mloInterface('radio2', { network: 'lan', ieee80211w: '1' }),
    mloInterface('radio2', { network: 'lan', disabled: '1' })
  ]) {
    const fixture = migrationFixture(mloRadios(), {
      mld_shared_5g: mloInterface('radio1', { network: 'lan' }), mld_shared_6g: candidate,
      mld_different_6g: mloInterface('radio2', { network: 'lan' }),
      named_guest: mloInterface('radio2', { network: 'guest' })
    });
    try {
      const { state, calls } = fixture.run();
      assert.deepEqual(state, fixture.initial);
      assert.deepEqual(calls, []);
    } finally { fixture.close(); }
  }
});

test('MLO migration never promotes or enables generated guest scalar records', () => {
  const fixture = migrationFixture(mloRadios(), {
    mld_guest_5g: mloInterface('radio1', { network: 'guest', disabled: '1' }),
    mld_guest_6g: mloInterface('radio2', { network: 'guest', disabled: '1' })
  });
  try {
    const { state, calls } = fixture.run();
    assert.deepEqual(state, fixture.initial);
    assert.deepEqual(calls, []);
  } finally { fixture.close(); }
});

test('MLO migration logs and makes no changes when fewer than two EHT links remain', () => {
  for (const links of [['radio0', 'radio1'], ['radio0'], ['radio0', 'missing_radio']]) {
    const fixture = migrationFixture(mloRadios(), { mld_main: mloInterface(links) });
    try {
      const { state, calls, log } = fixture.run();
      assert.deepEqual(state, fixture.initial);
      assert.deepEqual(calls, [], 'no UCI mutation or commit for an unrepairable group');
      assert.match(log, /unchanged after excluding non-EHT radios: radio0/);
    } finally { fixture.close(); }
  }
});

test('MLO migration never reloads Wi-Fi or network during boot', () => {
  const source = fs.readFileSync(path.join(__dirname, '../files/etc/uci-defaults/74-zbt-mlo-shared-iface-repair'), 'utf8');
  assert.doesNotMatch(source.replace(/^\s*#.*$/gm, ''), /\bwifi\s+(?:reload|up|down|restart)\b|\b(?:ifup|ifdown)\s|\/etc\/init\.d\/(?:network|wpad|hostapd)/);
});
