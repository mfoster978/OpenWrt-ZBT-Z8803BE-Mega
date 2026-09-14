'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../files/www/luci-static/resources/view/network/quick-wifi.js'), 'utf8');
  const boundary = source.indexOf('\nreturn view.extend({');
  assert.ok(boundary > 0, 'unable to isolate Quick Wi-Fi model functions');

  const devices = [
    { '.name': 'radioA', band: '2g' },
    { '.name': 'radioB', band: '5g' },
    { '.name': 'radioC', band: '6g' }
  ];
  const ifaces = [
    { '.name': 'guest_2g', mode: 'ap', device: 'radioA', network: 'guest', ssid: 'Guest', encryption: 'psk2', key: 'guest-pass' },
    { '.name': 'default_radioA', mode: 'ap', device: 'radioA', network: 'lan', ssid: 'Old-2G', encryption: 'psk2', key: 'old-password', ieee80211w: '0', disabled: '0' },
    { '.name': 'default_radioB', mode: 'ap', device: 'radioB', network: 'lan', ssid: 'Old-5G', encryption: 'sae', key: 'old-password', ieee80211w: '2', disabled: '0' },
    { '.name': 'default_radioC', mode: 'ap', device: 'radioC', network: 'lan', ssid: 'Old-6G', encryption: 'sae', key: 'old-password', ieee80211w: '2', disabled: '0' },
    { '.name': 'uplink', mode: 'sta', device: 'radioA', network: 'wwan', ssid: 'Upstream', encryption: 'psk2', key: 'upstream-pass' }
  ];
  let saves = 0;
  let applies = 0;
  const uci = {
    sections(config, type) {
      assert.equal(config, 'wireless');
      return (type === 'wifi-device' ? devices : ifaces).slice();
    },
    get(config, section, option) {
      assert.equal(config, 'wireless');
      const row = devices.concat(ifaces).find(item => item['.name'] === section);
      return row && row[option];
    },
    set(config, section, option, value) {
      assert.equal(config, 'wireless');
      const row = ifaces.find(item => item['.name'] === section);
      assert.ok(row, `unknown interface ${section}`);
      row[option] = value;
    },
    save() { saves++; return Promise.resolve(); }
  };
  const ui = { changes: { apply() { applies++; return Promise.resolve(); } } };
  const api = new Function('uci', 'ui', 'TextEncoder', source.slice(0, boundary) +
    '\nreturn { quickWifiTargets, validateQuickWifi, applyQuickWifi };')(uci, ui, TextEncoder);
  return { api, devices, ifaces, counters: () => ({ saves, applies }) };
}

test('Quick Wi-Fi updates only the primary AP on all three physical bands', async () => {
  const { api, ifaces, counters } = fixture();
  const targets = api.quickWifiTargets();
  assert.deepEqual(targets.missing, []);
  assert.deepEqual(targets.byBand, {
    '2g': 'default_radioA',
    '5g': 'default_radioB',
    '6g': 'default_radioC'
  });

  await api.applyQuickWifi(targets, 'Truck Cameras', 'CameraPass123');
  for (const name of Object.values(targets.byBand)) {
    const iface = ifaces.find(item => item['.name'] === name);
    assert.equal(iface.ssid, 'Truck Cameras');
    assert.equal(iface.key, 'CameraPass123');
  }
  assert.equal(ifaces.find(item => item['.name'] === 'default_radioA').encryption, 'psk2');
  assert.equal(ifaces.find(item => item['.name'] === 'default_radioA').ieee80211w, '0');
  assert.equal(ifaces.find(item => item['.name'] === 'default_radioB').encryption, 'sae');
  assert.equal(ifaces.find(item => item['.name'] === 'default_radioC').encryption, 'sae');
  assert.equal(ifaces.find(item => item['.name'] === 'guest_2g').ssid, 'Guest');
  assert.equal(ifaces.find(item => item['.name'] === 'uplink').ssid, 'Upstream');
  assert.deepEqual(counters(), { saves: 1, applies: 1 });
});

test('Quick Wi-Fi supports one shared MLO section without duplicate writes', async () => {
  const { api, ifaces } = fixture();
  ifaces.splice(0, ifaces.length, {
    '.name': 'mld_primary', mode: 'ap', device: [ 'radioA', 'radioB', 'radioC' ],
    network: [ 'lan' ], ssid: 'Old MLO', encryption: 'sae', key: 'old-password', mlo: '1', ieee80211w: '2'
  });
  const targets = api.quickWifiTargets();
  assert.deepEqual(targets.sections, [ 'mld_primary' ]);
  assert.deepEqual(targets.missing, []);
  await api.applyQuickWifi(targets, 'One Network', 'NewPassword123');
  assert.equal(ifaces[0].ssid, 'One Network');
  assert.equal(ifaces[0].key, 'NewPassword123');
  assert.equal(ifaces[0].mlo, '1');
  assert.equal(ifaces[0].ieee80211w, '2');
});

test('Quick Wi-Fi validation and band discovery fail closed', () => {
  const { api, devices } = fixture();
  assert.equal(api.validateQuickWifi('', 'Password123'), 'ssid_empty');
  assert.equal(api.validateQuickWifi('x'.repeat(33), 'Password123'), 'ssid_long');
  assert.equal(api.validateQuickWifi('Truck', 'short'), 'password_length');
  assert.equal(api.validateQuickWifi('Truck', 'pässword'), 'password_ascii');
  assert.equal(api.validateQuickWifi('Truck', 'Password123'), null);
  devices.splice(devices.findIndex(device => device.band === '6g'), 1);
  assert.deepEqual(api.quickWifiTargets().missing, [ '6g' ]);
});

test('Quick Wi-Fi menu and ACL stay scoped to wireless configuration', () => {
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '../files/usr/share/luci/menu.d/zbt-quick-wifi.json'), 'utf8'));
  const acl = JSON.parse(fs.readFileSync(path.join(__dirname, '../files/usr/share/rpcd/acl.d/zbt-quick-wifi.json'), 'utf8'));
  assert.equal(menu['admin/network/quick-wifi'].action.path, 'network/quick-wifi');
  assert.deepEqual(acl['zbt-quick-wifi'].write.uci, [ 'wireless' ]);
  assert.deepEqual(Object.keys(acl['zbt-quick-wifi'].write.file), [ '/sbin/wifi' ]);
});
