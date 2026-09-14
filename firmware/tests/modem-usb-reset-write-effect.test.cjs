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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-usb-write-effect-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function run(mode) {
  const d = fs.mkdtempSync(path.join(temp, 'case-'));
  fs.mkdirSync(path.join(d, 'sys/bus/usb/devices/4-1'), { recursive: true });
  fs.mkdirSync(path.join(d, 'sys/class/gpio/5g1'), { recursive: true });
  fs.mkdirSync(path.join(d, 'sys/class/net/wwan0'), { recursive: true });
  fs.mkdirSync(path.join(d, 'recovery'), { recursive: true });
  fs.writeFileSync(path.join(d, 'sys/bus/usb/devices/4-1/authorized'), '1\n');
  fs.writeFileSync(path.join(d, 'sys/class/gpio/5g1/value'), '1\n');

  const mocks = String.raw`
zbt_recovery_allowed() { return 0; }
zbt_recovery_authorized() { return 0; }
zbt_health_probe() { ZBT_HEALTH=offline; return 1; }
zbt_5g_lock() { return 0; }
zbt_5g_unlock() { return 0; }
zbt_slot() { ZBT_USB=4-1; ZBT_POWER=5g1; }
zbt_netdev() { [ "$(cat "$DB/sys/bus/usb/devices/4-1/authorized" 2>/dev/null)" = 1 ] && echo wwan0; }
zbt_recovery_worker_pid() { echo 4321; }
flock() { return 0; }
ubus() { echo '{}'; }
jq() { cat >/dev/null; }
logger() { echo "log $*" >> "$DB/calls"; }
service() { echo "service $*" >> "$DB/calls"; }
sleep() { echo "sleep $1 auth=$(cat "$DB/sys/bus/usb/devices/4-1/authorized" 2>/dev/null)" >> "$DB/calls"; }
zbt_recovery_usb_write() {
  if [ "$MODE" = no-effect ] && [ "$1" = 0 ]; then return 5; fi
  printf '%s\n' "$1" > "$2"
  [ "$MODE" != error-after-effect ] || return 5
}
`;
  const result = spawnSync('busybox', ['sh', '-c', recovery + '\n' + mocks + '\nzbt_recovery_action 4_1 usb_reset'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DB: d, MODE: mode, ZBT_SYSFS: path.join(d, 'sys'), ZBT_RECOVERY_DIR: path.join(d, 'recovery') },
  });
  return {
    d,
    status: result.status,
    out: result.stdout,
    err: result.stderr,
    calls: fs.existsSync(path.join(d, 'calls')) ? fs.readFileSync(path.join(d, 'calls'), 'utf8') : '',
  };
}

test('USB reset trusts observed deauthorization and reauthorization when sysfs writes return errors after taking effect', () => {
  const f = run('error-after-effect');
  assert.equal(f.status, 0, f.err + f.out);
  assert.match(f.calls, /stage=usb-deauthorize result=complete write_code=5/);
  assert.match(f.calls, /sleep 5 auth=0/);
  assert.match(f.calls, /stage=usb-reauthorize result=complete write_code=5/);
  assert.match(f.calls, /service dial 4_1/);
  assert.doesNotMatch(f.calls, /verify-failed|netdev-timeout/);
  assert.equal(fs.readFileSync(path.join(f.d, 'sys/bus/usb/devices/4-1/authorized'), 'utf8').trim(), '1');
});

test('USB reset still fails when a reported write error produces no observable deauthorization', () => {
  const f = run('no-effect');
  assert.equal(f.status, 1, f.err + f.out);
  assert.match(f.calls, /stage=usb-deauthorize result=verify-failed write_code=5 wait_seconds=5/);
  assert.doesNotMatch(f.calls, /service dial 4_1/);
  assert.equal(fs.readFileSync(path.join(f.d, 'sys/bus/usb/devices/4-1/authorized'), 'utf8').trim(), '1');
});
