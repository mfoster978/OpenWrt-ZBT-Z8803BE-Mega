'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-qmi-session-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const helper = fs.readFileSync(path.join(root, 'firmware/files/usr/lib/zbt/qmi-session.sh'), 'utf8')
  .replace('. /usr/lib/zbt/mwan-runtime.sh', 'zbt_mwan_refresh() { :; }')
  .replace('. /usr/lib/zbt/qmi-publish.sh', 'zbt_qmi_publish() { return 1; }')
  .replaceAll('/tmp/modem-watchdog', '${MODEM_RUNDIR}/watchdog'); // separately exercised by adaptive tests
const dual = fs.readFileSync(path.join(root, 'firmware/files/usr/lib/zbt/dual-modem.sh'), 'utf8');

function fixture(options = {}, body = 'zbt_qmi_session "$DB/child"; echo result=$?') {
  const dir = path.join(tmp, String(++serial)); fs.mkdirSync(dir);
  for (const [usb, dev, index] of [['4-1', 'wwan8', '17'], ['2-1', 'wwan3', '23']]) {
    fs.mkdirSync(path.join(dir, 'sys/bus/usb/devices', usb, usb + ':1.4/net', dev), { recursive: true });
    fs.mkdirSync(path.join(dir, 'sys/class/net', dev), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sys/class/net', dev, 'ifindex'), index);
  }
  fs.mkdirSync(path.join(dir, '4_1_dir'));
  fs.writeFileSync(path.join(dir, '4_1_dir/4_1.pid'), '1'); // stale PID must never be killed
  fs.mkdirSync(path.join(dir, 'track/4_1'), { recursive: true });
  for (const [key, value] of Object.entries({ STATUS: 'offline', STARTED: '1', TIME: '100' }))
    fs.writeFileSync(path.join(dir, 'track/4_1', key), value);
  fs.writeFileSync(path.join(dir, 'clock'), '100');
  fs.writeFileSync(path.join(dir, 'child'), '#!/bin/sh\nprintf "child=%s\\n" "$$" >> "$DB/calls"\nexec sleep 60\n', { mode: 0o755 });
  const script = dual + '\n' + helper.replaceAll('/var/run/mwan3track', dir + '/track') + `
modem_config=4_1; modem_netcard=wwan8; interface_name=4_1; interface6_name=4_1v6
MODEM_RUNDIR="$DB"; bridge_enabled=0; qmi_ifindex=17
echo $$ > "$DB/track/4_1/PID"
zbt_qmi_now() { cat "$DB/clock"; }
uci() {
  case "$*" in
    *network.4_1.modem_config|*network.4_1v6.modem_config) echo 4_1 ;;
    *mwan3.4_1.enabled) echo "\${TRACK_ENABLED:-1}" ;;
    *mwan3.4_1.track_ip) echo '1.1.1.1 8.8.8.8' ;;
  esac
}
ip() {
  case "$*" in
    '-o -4 addr show'*) [ "$ADDR4" != 0 ] && echo '17: wwan8 inet 192.0.0.2/27 scope global wwan8' ;;
    '-o -6 addr show'*) [ "$ADDR6" = 1 ] && echo '17: wwan8 inet6 2001:db8::2/64 scope global' ;;
    '-4 route show table main default dev wwan8')
      [ "$ROUTE4" != 0 ] && { [ "$MODE" != route_loss ] || [ "$(cat "$DB/clock")" -lt 140 ]; } && echo 'default via 192.0.0.1 dev wwan8 metric 200' ;;
    '-6 route show table main default dev wwan8')
      [ "$ROUTE6" = 1 ] && { [ "$MODE" != route_loss ] || [ "$(cat "$DB/clock")" -lt 140 ]; } && echo 'default via 2001:db8::1 dev wwan8 metric 200' ;;
    *) printf 'ip %s\n' "$*" >> "$DB/calls" ;;
  esac
}
flock() { :; }
ubus() {
  case "$*" in
    *'network.interface up'*4_1v6*) echo 'up 4_1v6' >> "$DB/calls" ;;
    *'network.interface up'*4_1*) echo 'up 4_1' >> "$DB/calls" ;;
    *'network.interface down'*4_1v6*) echo 'down 4_1v6' >> "$DB/calls" ;;
    *'network.interface down'*4_1*) echo 'down 4_1' >> "$DB/calls" ;;
  esac
}
logger() { printf 'log %s\n' "$*" >> "$DB/calls"; }
sleep() {
  local now
  now=$(( $(cat "$DB/clock") + 40 )); echo "$now" > "$DB/clock"
  [ "$STALE" = 1 ] || echo "$now" > "$DB/track/4_1/TIME"
  case "$MODE" in
    recover) [ "$now" -lt 180 ] || echo online > "$DB/track/4_1/STATUS" ;;
    paused) echo 0 > "$DB/track/4_1/STARTED" ;;
    detach) echo 99 > "$DB/sys/class/net/wwan8/ifindex" ;;
    signal) if [ ! -f "$DB/signalled" ]; then touch "$DB/signalled"; kill -TERM $$; fi ;;
  esac
  # End healthy/unknown sessions using a real child exit after observation.
  if [ "$now" -ge 380 ] && [ -n "$cm_pid" ]; then kill -TERM "$cm_pid" 2>/dev/null; fi
  busybox sleep 0.02
}
` + body;
  const result = spawnSync('busybox', ['sh', '-c', script], {
    encoding: 'utf8', timeout: 8000,
    env: { ...process.env, DB: dir, ZBT_SYSFS: path.join(dir, 'sys'), MODE: 'normal', ADDR4: '1', ROUTE4: '1', ...options }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { dir, out: result.stdout, calls: fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '' };
}
test('QMI child failure cleans the selected slot, both families and stale PID, then returns to procd', () => {
  const f = fixture({ MODE: 'stuck' });
  assert.match(f.out, /result=1/);
  assert.doesNotMatch(f.calls, /data session failed for 120 seconds/);
  assert.ok(fs.existsSync(path.join(f.dir, 'watchdog/4_1.qmi-lost')));
  for (const family of [4, 6]) {
    assert.equal(f.calls.split(`ip -${family} addr flush dev wwan8 scope global`).length - 1, 2);
    assert.equal(f.calls.split(`ip -${family} route flush dev wwan8`).length - 1, 2);
  }
  assert.match(f.calls, /up 4_1\nup 4_1v6/);
  assert.match(f.calls, /down 4_1\ndown 4_1v6/);
  assert.doesNotMatch(f.calls, /wwan3|down 2_1|network restart|mtu|metric/);
  assert.equal(fs.existsSync(path.join(f.dir, '4_1_dir/4_1.pid')), false);
});
test('QMI connectivity recovery is delegated, never an address or stale tracker timer', () => {
  assert.doesNotMatch(fixture({ MODE: 'stuck', ADDR4: '0', ADDR6: '0' }).calls, /failed for 120/);
  assert.doesNotMatch(fixture({ ADDR4: '0', ADDR6: '1' }).calls, /failed for 120/);
});
test('QMI never tears down a live CM because netifd temporarily loses its route', () => {
  const f = fixture({ MODE: 'route_loss' });
  assert.doesNotMatch(f.calls, /kernel-data-path-lost/);
  assert.match(f.out, /result=1/);
  assert.match(f.calls, /child=/);
  assert.ok(fs.existsSync(path.join(f.dir, 'watchdog/4_1.qmi-lost')));
  assert.doesNotMatch(f.calls, /wwan3|down 2_1|network restart/);
});
test('QMI never tears down a live session based on mwan3 health results', () => {
  for (const options of [{ MODE: 'recover' }, { MODE: 'paused' }, { STALE: '1' }, { TRACK_ENABLED: '0' }])
    assert.doesNotMatch(fixture(options).calls, /failed for 120/, JSON.stringify(options));
});
test('QMI interface reuse never flushes the new device after detach', () => {
  const f = fixture({ MODE: 'detach' });
  assert.equal(f.calls.split('ip -4 addr flush').length - 1, 1, 'only pre-dial flush, no flush after ifindex changes');
  assert.match(f.out, /result=1/);
});
test('QMI TERM stops the owned child, cleans once and does not start a replacement', () => {
  const f = fixture({ MODE: 'signal' });
  assert.equal(f.calls.split('down 4_1\n').length - 1, 1);
  assert.equal(fs.existsSync(path.join(f.dir, '4_1_dir/4_1.pid')), false);
  assert.doesNotMatch(f.out, /result=/, 'termination exits the parent');
});
test('QMI logical-interface cleanup rejects LAN aliases and foreign slot bindings', () => {
  const f = fixture({}, 'interface_name=lan; interface6_name=2_1; zbt_qmi_notify down');
  assert.equal(f.calls, '');
});
test('QMI bridging is excluded from WAN-address watchdog and device flushing', () => {
  const f = fixture({}, 'bridge_enabled=1; zbt_qmi_session "$DB/child"; echo result=$?');
  assert.doesNotMatch(f.calls, /failed for 120/);
  assert.doesNotMatch(f.calls, /ip .*flush/);
  const guarded = fixture({}, 'touch "$DB/sys/class/net/wwan8/master"; zbt_qmi_flush; echo safe');
  assert.equal(guarded.calls, '');
});
