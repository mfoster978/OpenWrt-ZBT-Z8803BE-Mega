'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const recoveryPath = process.env.RECOVERY_SOURCE || path.join(root, 'firmware/files/usr/lib/zbt/modem-recovery.sh');
const recovery = fs.readFileSync(recoveryPath, 'utf8')
  .replace(/^\. \/usr\/lib\/zbt\/.*$/gm, '')
  .replaceAll('/etc/init.d/qmodem_network', 'service');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-usb-reset-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function run(body, env = {}) {
  const d = fs.mkdtempSync(path.join(temp, 'case-'));
  fs.mkdirSync(path.join(d, 'sys/bus/usb/devices/4-1'), { recursive: true });
  fs.mkdirSync(path.join(d, 'sys/class/gpio/5g1'), { recursive: true });
  fs.mkdirSync(path.join(d, 'sys/class/net/wwan0/statistics'), { recursive: true });
  fs.mkdirSync(path.join(d, 'recovery'), { recursive: true });
  fs.writeFileSync(path.join(d, 'sys/bus/usb/devices/4-1/authorized'), '1\n');
  fs.writeFileSync(path.join(d, 'sys/class/gpio/5g1/value'), '1\n');
  fs.writeFileSync(path.join(d, 'sys/class/net/wwan0/statistics/rx_errors'), '300\n');
  const mocks = String.raw`
zbt_recovery_allowed() { return 0; }
zbt_recovery_authorized() { return 0; }
zbt_health_probe() { ZBT_HEALTH=offline; return 1; }
zbt_5g_lock() { return 0; }
zbt_5g_unlock() { return 0; }
zbt_slot() { ZBT_USB=4-1; ZBT_POWER=5g1; }
zbt_netdev() { [ "$(cat "$DB/sys/bus/usb/devices/4-1/authorized")" = 1 ] && echo wwan0; }
zbt_recovery_worker_pid() { echo 4321; }
flock() { return 0; }
ubus() { echo '{}'; }
jq() { cat >/dev/null; }
logger() { echo "log $*" >> "$DB/calls"; }
service() { echo "service $*" >> "$DB/calls"; }
sleep() {
  echo "sleep $1 auth=$(cat "$DB/sys/bus/usb/devices/4-1/authorized") gpio=$(cat "$DB/sys/class/gpio/5g1/value")" >> "$DB/calls"
  [ "$INTERRUPT_USB" != 1 ] || [ "$1" != 5 ] || exit 9
}
`;
  const result = spawnSync('busybox', ['sh', '-c', recovery + '\n' + mocks + '\n' + body], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DB: d, ZBT_SYSFS: path.join(d, 'sys'), ZBT_RECOVERY_DIR: path.join(d, 'recovery'), ...env },
  });
  assert.ifError(result.error);
  return {
    d,
    status: result.status,
    out: result.stdout,
    err: result.stderr,
    calls: fs.existsSync(path.join(d, 'calls')) ? fs.readFileSync(path.join(d, 'calls'), 'utf8') : '',
  };
}

test('usb_reset deauthorizes the whole modem USB device, reauthorizes it, then redials without GPIO power loss', () => {
  const f = run('zbt_recovery_action 4_1 usb_reset');
  assert.equal(f.status, 0, f.err + f.out);
  assert.equal(fs.readFileSync(path.join(f.d, 'sys/bus/usb/devices/4-1/authorized'), 'utf8').trim(), '1');
  assert.equal(fs.readFileSync(path.join(f.d, 'sys/class/gpio/5g1/value'), 'utf8').trim(), '1');
  assert.match(f.calls, /action=usb_reset stage=usb-deauthorize result=starting/);
  assert.match(f.calls, /sleep 5 auth=0 gpio=1/);
  assert.match(f.calls, /action=usb_reset stage=usb-reauthorize result=complete/);
  assert.match(f.calls, /service dial 4_1/);
  assert.doesNotMatch(f.calls, /gpio-low|sleep 10/);
});

test('interrupted usb_reset always reauthorizes the modem before returning', () => {
  const f = run('rc=0; zbt_recovery_action 4_1 usb_reset || rc=$?; echo rc=$rc', { INTERRUPT_USB: '1' });
  assert.equal(f.status, 0, f.err + f.out);
  assert.match(f.out, /rc=9/);
  assert.equal(fs.readFileSync(path.join(f.d, 'sys/bus/usb/devices/4-1/authorized'), 'utf8').trim(), '1');
  assert.equal(fs.readFileSync(path.join(f.d, 'sys/class/gpio/5g1/value'), 'utf8').trim(), '1');
  assert.doesNotMatch(f.calls, /service dial 4_1/);
});

test('RX error storm uses one USB reset first, then escalates to configured GPIO power cycle', () => {
  const d = fs.mkdtempSync(path.join(temp, 'select-'));
  fs.mkdirSync(path.join(d, 'sys/class/net/wwan0/statistics'), { recursive: true });
  fs.mkdirSync(path.join(d, 'recovery'), { recursive: true });
  fs.writeFileSync(path.join(d, 'sys/class/net/wwan0/statistics/rx_errors'), '300\n');
  const mocks = String.raw`
zbt_recovery_allowed() { return 0; }
zbt_health_now() { echo 500; }
zbt_recovery_get() {
  case "$1" in
    modem1.action) echo power_cycle ;;
    global.ping_fail_threshold) echo 3 ;;
    global.cooldown_seconds) echo 180 ;;
    global.boot_grace_seconds) echo 60 ;;
    modem1.redial_attempts) echo 1 ;;
    global.redial_verify_seconds) echo 60 ;;
  esac
}
zbt_5g_lock() { return 0; }
zbt_5g_unlock() { return 0; }
zbt_recovery_action() { echo "action=$2" >> "$DB/calls"; return 0; }
logger() { echo "log $*" >> "$DB/calls"; }
`;
  const script = recovery + '\n' + mocks + String.raw`
ZBT_HEALTH=offline; ZBT_HEALTH_DEVICE=wwan0; ZBT_HEALTH_INDEX=17
printf '2 0 0 0 0 0 0 17\n' > "$DB/recovery/4_1.state"
zbt_recovery_check 4_1 modem1
printf '2 0 0 1 0 1 0 17\n' > "$DB/recovery/4_1.state"
zbt_recovery_check 4_1 modem1
`;
  const result = spawnSync('busybox', ['sh', '-c', script], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DB: d, ZBT_SYSFS: path.join(d, 'sys'), ZBT_RECOVERY_DIR: path.join(d, 'recovery') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = fs.readFileSync(path.join(d, 'calls'), 'utf8');
  assert.match(calls, /rx_errors_growing; requesting usb_reset[\s\S]*action=usb_reset/);
  assert.match(calls, /rx_errors_growing; requesting power_cycle[\s\S]*action=power_cycle/);
});
