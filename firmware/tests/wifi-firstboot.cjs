'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

module.exports = function(root, tree, run) {
  const file = path.join(tree, 'target/linux/mediatek/filogic/base-files/etc/uci-defaults/72-zbt-z8803be-wifi');
  let script = fs.readFileSync(file, 'utf8');
  const fixtures = path.join(tree, 'fixture'); fs.mkdirSync(fixtures);
  script = script.replace('. /lib/functions.sh', 'board_name() { echo zbtlink,zbt-z8803be; }')
    .replaceAll('/sys/class/ieee80211', fixtures + '/phys')
    .replaceAll('/etc/config/wireless', fixtures + '/wireless')
    .replaceAll('/sbin/wifi', 'wifi');
  const execute = (body, env = {}) => spawnSync('busybox', ['sh', '-c', body], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 5000 });
  const noPhy = execute('wifi() { echo UNEXPECTED; }; uci() { echo UNEXPECTED; };\n' + script);
  assert.equal(noPhy.status, 1, 'no PHY retains the default instead of claiming successful initialization');
  assert.equal(noPhy.stdout, '');
  fs.mkdirSync(path.join(fixtures, 'phys/phy0'), { recursive: true });
  const noConfig = execute('wifi() { :; }; uci() { return 1; };\n' + script);
  assert.equal(noConfig.status, 1, 'no generated radios retains pending defaults');
  fs.writeFileSync(path.join(fixtures, 'wireless'), 'preserved custom configuration');
  const preserved = execute(`
wifi() { echo UNEXPECTED_WIFI; }
uci() {
 case "$*" in
  '-q show wireless') printf 'wireless.radio0=wifi-device\nwireless.ap=wifi-iface\n' ;;
  '-q get wireless.ap.ssid') echo 'Owner SSID' ;;
  *) echo UNEXPECTED_WRITE ;;
 esac
}
` + script);
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(preserved.stdout, '', 'preserved custom SSID causes no generation, write or reload');
  assert.equal(fs.readFileSync(path.join(fixtures, 'wireless'), 'utf8'), 'preserved custom configuration');
  assert.doesNotMatch(script.replace(/^#.*$/gm, ''), /wifi detect|wifi reload|sleep 5/);
  assert.match(script, /2g\) ssid="WIFI7-\$\{mac6\}"; encryption=psk2; pmf=0/,
    'factory 2.4 GHz AP uses WPA2-CCMP with protected management frames disabled');
  assert.match(script, /5g\) ssid="WIFI7-5G-\$\{mac6\}"; encryption=sae; pmf=2/,
    'factory 5 GHz AP retains WPA3-SAE and required PMF');
  assert.match(script, /6g\) ssid="WIFI7-6G-\$\{mac6\}"; encryption=sae; pmf=2/,
    'factory 6 GHz AP retains WPA3-SAE and required PMF');
  assert.match(script, /2g\).*htmode=HT20/,
    'factory 2.4 GHz radio uses 20 MHz 802.11n compatibility mode');
  assert.doesNotMatch(script.replace(/^#.*$/gm, ''), /2g\).*htmode=EHT/,
    'factory 2.4 GHz radio must not require an EHT-capable client');
  const late = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-wifi-firstboot'), 'utf8');
  assert.match(late, /ubus -t 2 list network\.wireless/);
  assert.match(late, /configured-ap-not-running phase=boot/);
  assert.match(late, /while sleep "\$ZBT_WIFI_MONITOR_INTERVAL"/);
  assert.doesNotMatch(late.replace(/^#.*$/gm, ''), /network restart|wifi reset|wifi detect/);
  const pending = path.join(fixtures, 'pending'); fs.mkdirSync(pending);
  const calls = path.join(fixtures, 'calls');
  const state = path.join(fixtures, 'state'); fs.writeFileSync(state, 'initial');
  const lock = path.join(fixtures, 'wifi.lock');
  const status = path.join(fixtures, 'status.json');
  const deferred = late.replaceAll('/sbin/wifi', 'wifi').replaceAll('/sbin/modprobe', 'modprobe');
  const mocks = `
sleep() { :; }
flock() { :; }
modprobe() { echo "modprobe $*" >> "$CALLS"; }
ubus() {
 case "$*" in
  *'list network.wireless'*) [ "$NETIFD" = ready ] && echo network.wireless ;;
  *'call network.wireless status'*) cat "$STATUS_FILE" ;;
 esac
}
uci() {
 case "$*" in
  '-q show wireless') printf 'wireless.radio0=wifi-device\nwireless.ap=wifi-iface\n' ;;
  '-q get wireless.ap.mode') echo ap ;;
  '-q get wireless.ap.disabled'|'-q get wireless.radio0.disabled') [ "$AP_DISABLED" = 1 ] && echo 1 ;;
  '-q get wireless.ap.device') echo radio0 ;;
  '-q export wireless') cat "$STATE_FILE" ;;
 esac
}
wifi() { echo "wifi $*" >> "$CALLS"; }
logger() { :; }
`;
  const env = { NETIFD: 'ready', STATE_FILE: state, STATUS_FILE: status, CALLS: calls,
    ZBT_WIFI_SYSFS: fixtures, ZBT_WIFI_DEFAULTS: pending, ZBT_WIFI_LOCK: lock,
    ZBT_WIFI_ONESHOT: '1' };
  fs.writeFileSync(status, '{}\n');
  const noLatePhy = execute(mocks + deferred, { ...env, NETIFD: 'starting' });
  assert.equal(noLatePhy.status, 1);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'modprobe mt7996e\n', 'missing PHY requests only a module load');
  fs.rmSync(calls);
  fs.mkdirSync(path.join(fixtures, 'class/ieee80211/phy0'), { recursive: true });
  const first = path.join(pending, '72-zbt-z8803be-wifi');
  fs.writeFileSync(first, 'printf updated > "$STATE_FILE"\n');
  const waiting = execute(mocks + deferred, { ...env, NETIFD: 'starting' });
  assert.equal(waiting.status, 1);
  assert.equal(fs.existsSync(first), true, 'pending default retained until netifd is ready');
  assert.equal(fs.readFileSync(state, 'utf8'), 'initial');
  fs.rmSync(calls);
  const ready = execute(mocks + deferred, env);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'wifi reload\n', 'one late reload after actual configuration change');
  fs.writeFileSync(status, JSON.stringify({ radio0: { up: true, disabled: false,
    interfaces: [{ ifname: 'phy0-ap0', config: { mode: 'ap' } }] } }) + '\n');
  assert.equal(execute(mocks + deferred, env).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'wifi reload\n', 'healthy preserved AP is not interrupted');
  fs.writeFileSync(status, '{}\n');
  assert.equal(execute(mocks + deferred, env).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'wifi reload\nwifi up\n', 'preserved configured AP gets a late wifi-up retry');
  assert.equal(execute(mocks + deferred, { ...env, AP_DISABLED: '1' }).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'wifi reload\nwifi up\n', 'intentionally disabled AP is never started');
  const init = fs.readFileSync(path.join(root, 'firmware/files/etc/init.d/zbt-wifi-firstboot'), 'utf8');
  assert.doesNotMatch(init, /uci-defaults\/72.*return 0/);
  assert.match(init, /procd_set_param respawn 3600 5 0/);
  console.log('Wi-Fi defaults and kept-config late/runtime AP recovery behavior passed');
};
