'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../files/www/luci-static/resources/view/network/quick-wifi.js'), 'utf8');
  const boundary = source.indexOf('\nreturn view.extend({');
  assert.ok(boundary > 0, 'unable to isolate Quick Wi-Fi model functions');

  const devices = [
    { '.name': 'radioA', band: '2g', channel: '11' },
    { '.name': 'radioB', band: '5g', channel: '149' },
    { '.name': 'radioC', band: '6g', channel: '37' }
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
      const row = devices.concat(ifaces).find(item => item['.name'] === section);
      assert.ok(row, `unknown interface ${section}`);
      row[option] = value;
    },
    unset(config, section, option) {
      assert.equal(config, 'wireless');
      const row = devices.concat(ifaces).find(item => item['.name'] === section);
      assert.ok(row, `unknown section ${section}`);
      delete row[option];
    },
    save() { saves++; return Promise.resolve(); }
  };
  const ui = { changes: { apply() { applies++; return Promise.resolve(); } } };
  const api = new Function('uci', 'ui', 'TextEncoder', source.slice(0, boundary) +
    '\nreturn { quickWifiTargets, validateQuickWifi, applyQuickWifi, cameraCompatibilityTarget, applyCameraCompatibility };')(uci, ui, TextEncoder);
  return { api, devices, ifaces, counters: () => ({ saves, applies }) };
}

test('Quick Wi-Fi updates only the primary AP on all three physical bands', async () => {
  const { api, devices, ifaces, counters } = fixture();
  const radiosBefore = JSON.stringify(devices);
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
  assert.equal(JSON.stringify(devices), radiosBefore, 'ordinary name/password setup does not apply the opt-in channel profile');
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
  assert.deepEqual(acl['zbt-quick-wifi'].read.ubus['zbt.wifi'], [ 'diagnostics' ]);
});

test('legacy device compatibility applies channel 1 and repairs settings without changing credentials or other bands', async () => {
  const { api, devices, ifaces, counters } = fixture();
  const ap = ifaces.find(row => row['.name'] === 'default_radioA');
  const radio = devices[0];
  Object.assign(radio, { htmode: 'EHT40', legacy_rates: '0', cell_density: '3', basic_rate: ['24000'], require_mode: 'n' });
  Object.assign(ap, { encryption: 'sae', ieee80211w: '2', ieee80211r: '1', basic_rate: ['24000'] });
  const otherIfaces = JSON.stringify(ifaces.filter(row => row !== ap));
  const otherRadios = JSON.stringify(devices.slice(1));
  await api.applyCameraCompatibility(api.quickWifiTargets());
  assert.equal(ap.ssid, 'Old-2G');
  assert.equal(ap.key, 'old-password');
  assert.equal(ap.encryption, 'psk2+ccmp');
  assert.equal(ap.ieee80211w, '0');
  assert.equal(ap.ieee80211r, '0');
  assert.equal(ap.wmm, '1');
  assert.equal(radio.channel, '1');
  assert.equal(radio.htmode, 'HT20');
  assert.equal(radio.legacy_rates, '1');
  assert.equal(radio.cell_density, '0');
  assert.equal(radio.require_mode, undefined);
  assert.equal(radio.basic_rate, undefined);
  assert.equal(ap.basic_rate, undefined);
  assert.equal(JSON.stringify(ifaces.filter(row => row !== ap)), otherIfaces);
  assert.equal(JSON.stringify(devices.slice(1)), otherRadios);
  assert.deepEqual(counters(), { saves: 1, applies: 1 });
});

test('legacy device compatibility retains a three-band MLO network on 5 and 6 GHz only', async () => {
  const { api, devices, ifaces, counters } = fixture();
  const shared = { '.name': 'mld_primary', mode: 'ap', device: ['radioA', 'radioB', 'radioC'],
    network: ['lan'], mlo: '1', ssid: 'WiFi7', key: 'mlo-password', encryption: 'sae', ieee80211w: '2', disabled: '0' };
  const unrelated = { '.name': 'mld_other', mode: 'ap', device: ['radioB', 'radioC'],
    network: ['guest'], mlo: true, ssid: 'Guest WiFi7', key: 'other-password', encryption: 'sae', disabled: '0' };
  ifaces.push(shared, unrelated);
  const sharedBefore = structuredClone(shared);
  const otherIfacesBefore = JSON.stringify(ifaces.filter(row => !['default_radioA', 'mld_primary'].includes(row['.name'])));
  const otherRadiosBefore = JSON.stringify(devices.slice(1));

  const targets = api.quickWifiTargets();
  assert.equal(targets.byBand['2g'], 'default_radioA', 'profile still requires the separate legacy AP');
  await api.applyCameraCompatibility(targets);

  assert.deepEqual(shared, { ...sharedBefore, device: ['radioB', 'radioC'] });
  assert.equal(JSON.stringify(ifaces.filter(row => !['default_radioA', 'mld_primary'].includes(row['.name']))), otherIfacesBefore,
    'unrelated MLO and ordinary AP/uplink sections retain all options');
  assert.equal(JSON.stringify(devices.slice(1)), otherRadiosBefore);
  assert.deepEqual(counters(), { saves: 1, applies: 1 });
});

test('legacy device compatibility disables MLO when fewer than two links would remain', async () => {
  for (const links of [['radioA', 'radioB'], ['radioA']]) {
    const { api, ifaces, counters } = fixture();
    const shared = { '.name': 'mld_limited', mode: 'ap', device: links,
      network: ['lan'], mlo: 1, ssid: 'Limited MLO', key: 'mlo-password', encryption: 'sae', ieee80211w: '2', disabled: '0' };
    ifaces.push(shared);
    const before = structuredClone(shared);
    await api.applyCameraCompatibility(api.quickWifiTargets());
    assert.deepEqual(shared, { ...before, disabled: '1' }, 'keep original MLO settings recoverable while disabling incompatible links');
    assert.equal(ifaces.find(row => row['.name'] === 'default_radioA').disabled, '0');
    assert.deepEqual(counters(), { saves: 1, applies: 1 });
  }
});

test('legacy device compatibility refuses shared MLO and invalid keys before any writes', async () => {
  const { api, ifaces, devices, counters } = fixture();
  ifaces.push({ '.name': 'mld_companion', mode: 'ap', device: ['radioA', 'radioB', 'radioC'],
    network: ['lan'], mlo: '1', ssid: 'Companion MLO', key: 'mlo-password', encryption: 'sae', disabled: '0' });
  const ap = ifaces.find(row => row['.name'] === 'default_radioA');
  ap.device = ['radioA', 'radioB', 'radioC'];
  ap.mlo = '1';
  const before = JSON.stringify([devices, ifaces]);
  await assert.rejects(api.applyCameraCompatibility(api.quickWifiTargets()), /separate 2.4 GHz/);
  assert.equal(JSON.stringify([devices, ifaces]), before);
  ap.device = 'radioA';
  delete ap.mlo;
  delete ap.key;
  const noKey = JSON.stringify([devices, ifaces]);
  await assert.rejects(api.applyCameraCompatibility(api.quickWifiTargets()), /valid password/);
  assert.equal(JSON.stringify([devices, ifaces]), noKey);
  assert.deepEqual(counters(), { saves: 0, applies: 0 });
});

test('legacy device compatibility rejects a selected AP outside LAN without changing Quick Wi-Fi selection', async () => {
  const { api, ifaces, devices, counters } = fixture();
  const ap = ifaces.find(row => row['.name'] === 'default_radioA');
  ap.network = 'camera_vlan';
  const targets = api.quickWifiTargets();
  assert.equal(targets.byBand['2g'], ap['.name']);
  const before = JSON.stringify([devices, ifaces]);
  await assert.rejects(api.applyCameraCompatibility(targets), /separate 2.4 GHz/);
  assert.equal(JSON.stringify([devices, ifaces]), before);
  assert.deepEqual(counters(), { saves: 0, applies: 0 });
});

test('Wi-Fi report distinguishes authentication from IP assignment and excludes credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-wifi-report-'));
  try {
    const leasefile = path.join(dir, 'leases');
    fs.writeFileSync(leasefile, '0 aa:bb:cc:dd:ee:01 192.168.1.120 dvr *\n1 aa:bb:cc:dd:ee:02 192.168.1.121 expired *\n');
    const source = fs.readFileSync(path.join(__dirname, '../files/usr/libexec/rpcd/zbt.wifi'), 'utf8');
    const mocks = `
uci() {
 case "$*" in
  '-q get wireless.radio0.band') echo 2g ;;
  '-q get wireless.radio1.band') echo 5g ;;
  '-q get dhcp.@dnsmasq[0].leasefile') echo "$LEASEFILE" ;;
  *) echo UNEXPECTED_UCI >&2; return 1 ;;
 esac
}
ubus() {
 case "$*" in
  '-t 3 call network.wireless status')
   printf '%s' '{"radio0":{"interfaces":[{"ifname":"phy0-ap0","config":{"mode":"ap","ssid":"Truck","key":"NEVER-EXPORT-KEY"}}]},"radio1":{"interfaces":[{"ifname":"phy1-ap0","config":{"mode":"ap","ssid":"Other"}}]}}' ;;
  '-t 3 call hostapd.phy0-ap0 get_clients')
   [ "$FAIL_CLIENTS" != 1 ] || return 1
   printf '%s' '{"clients":{"AA:BB:CC:DD:EE:01":{"assoc":true,"authorized":true},"aa:bb:cc:dd:ee:02":{"assoc":true,"authorized":false},"aa:bb:cc:dd:ee:03":{"assoc":true,"authorized":true}}}' ;;
  *) echo UNEXPECTED_UBUS >&2; return 1 ;;
 esac
}
logread() {
 printf '%s\\n' 'hostapd: phy0-ap0: AP-STA-CONNECTED aa:bb:cc:dd:ee:01' 'hostapd: WPA: key NEVER-EXPORT-LOG-KEY' 'unrelated: account NEVER-EXPORT-ACCOUNT' 'hostapd: arbitrary NEVER-EXPORT-SECRET AP-STA-CONNECTED' 'hostapd: STA aa:bb:cc:dd:ee:02 IEEE 802.11: associated (aid 2)' 'hostapd: AP-STA-CONNECTED invalid-MAC NEVER-EXPORT-SECRET'
}
`;
    const run = (env = {}) => spawnSync('busybox', ['sh', '-c', mocks + source, 'wifi-report', 'call', 'diagnostics'],
      { input: '{}\n', encoding: 'utf8', env: { ...process.env, LEASEFILE: leasefile, ...env }, timeout: 10000 });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /NEVER-EXPORT|Other/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.access_points.length, 1);
    const clients = report.access_points[0].clients;
    assert.equal(clients[0].authorized, true);
    assert.deepEqual(clients[0].addresses, ['192.168.1.120']);
    assert.equal(clients[1].associated, true);
    assert.equal(clients[1].authorized, false);
    assert.deepEqual(clients[1].addresses, []);
    assert.equal(clients[2].authorized, true);
    assert.deepEqual(clients[2].addresses, []);
    assert.deepEqual(report.events, ['AP-STA-CONNECTED aa:bb:cc:dd:ee:01', 'associated aa:bb:cc:dd:ee:02']);
    const missing = run({ FAIL_CLIENTS: '1' });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).access_points[0].available, false);
    assert.deepEqual(JSON.parse(missing.stdout).access_points[0].clients, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
