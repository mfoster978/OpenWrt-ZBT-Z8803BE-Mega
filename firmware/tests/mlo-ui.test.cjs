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
    { '.type': 'wifi-device', '.name': 'radio0', band: '2g' },
    { '.type': 'wifi-device', '.name': 'radio1', band: '5g' },
    { '.type': 'wifi-device', '.name': 'radio2', band: '6g' }
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
    remove(config, section) {
      assert.equal(config, 'wireless');
      ifaces = ifaces.filter(x => x['.name'] !== section);
    }
  };

  const api = new Function('uci', source.slice(0, boundary) + '\nreturn { loadMlds, applyMld };')(uci);
  const before = api.loadMlds().mlds['Fostah Logistics'];
  assert.deepEqual(Array.from(before.bands).sort(), [ '2g', '5g', '6g' ]);
  api.applyMld(before);

  const mlo = ifaces.filter(x => x.mlo === '1');
  assert.equal(mlo.length, 1, 'one logical MLD must be one wifi-iface');
  assert.deepEqual(mlo[0].device, [ 'radio0', 'radio1', 'radio2' ]);
  assert.equal(mlo[0].ieee80211w, '2');
  assert.equal(mlo[0].ssid, 'Fostah Logistics');
  assert.equal(mlo[0].network, 'lan');

  const migration = fs.readFileSync(path.join(__dirname, '../files/etc/uci-defaults/74-zbt-mlo-shared-iface-repair'), 'utf8');
  assert.match(migration, /add_list "wireless\.\$\{first\}\.network=lan"/);
  assert.doesNotMatch(migration, /wifi reload|zbt-wifi-reload-deferred/);
  const builder = fs.readFileSync(path.join(__dirname, '../docker/build-openwrt.sh'), 'utf8');
  assert.match(builder, /make package\/luci-app-mlo\/clean/);
  assert.match(builder, /rsync -a --delete "\$\{FILES_OVERLAY_DIR\}\/?" files\//);
});

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
    mld_2g: mloInterface('radio0', { network: 'lan', mld_ap: '1', mld_id: '0' }),
    mld_5g: mloInterface('radio1'),
    mld_6g: mloInterface('radio2')
  });
  try {
    const { state } = fixture.run();
    assert.deepEqual(state.mld_2g, mloInterface(['radio1', 'radio2']));
    assert.equal(state.mld_5g, undefined);
    assert.equal(state.mld_6g, undefined);
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
