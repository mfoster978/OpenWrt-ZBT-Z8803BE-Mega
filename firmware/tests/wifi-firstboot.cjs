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
  const late = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-wifi-firstboot'), 'utf8');
  assert.match(late, /ubus -t 2 list network\.wireless/);
  assert.doesNotMatch(late.replace(/^#.*$/gm, ''), /network restart|wifi reset|wifi detect/);
  const pending = path.join(fixtures, 'pending'); fs.mkdirSync(pending);
  const calls = path.join(fixtures, 'calls');
  const state = path.join(fixtures, 'state'); fs.writeFileSync(state, 'initial');
  const deferred = late.replaceAll('/sys/class/ieee80211', fixtures + '/phys')
    .replaceAll('/etc/uci-defaults', pending).replaceAll('/sbin/wifi', 'wifi');
  const mocks = `
sleep() { :; }
ubus() { [ "$NETIFD" = ready ] && echo network.wireless; }
uci() { cat "$STATE_FILE"; }
wifi() { echo "wifi $*" >> "$CALLS"; }
logger() { :; }
`;
  const env = { NETIFD: 'ready', STATE_FILE: state, CALLS: calls };
  const first = path.join(pending, '72-zbt-z8803be-wifi');
  fs.writeFileSync(first, 'printf updated > "$STATE_FILE"\n');
  const waiting = execute(mocks + deferred, { ...env, NETIFD: 'starting' });
  assert.equal(waiting.status, 1);
  assert.equal(fs.existsSync(first), true, 'pending default retained until netifd is ready');
  assert.equal(fs.readFileSync(state, 'utf8'), 'initial');
  const ready = execute(mocks + deferred, env);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'wifi reload\n', 'one late reload after actual configuration change');
  fs.writeFileSync(first, 'exit 0\n');
  assert.equal(execute(mocks + deferred, env).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'wifi reload\n', 'no reload when preserved configuration is unchanged');
  console.log('Wi-Fi defaults: absent PHY, empty generation and preserved custom SSID behavior passed');
};
