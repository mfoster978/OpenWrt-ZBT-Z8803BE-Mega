'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mwan-apply-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const source = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-mwan-apply'), 'utf8')
  .replace(/^\. \/.*$/gm, '')
  .replace('/var/lock/procd_mwan3.lock', '$DB/procd_mwan3.lock')
  .replace('/tmp/zbt-mwan-restart', '$DB/restart')
  .replaceAll('/etc/init.d/mwan3', 'mwan_service');

function run(now) {
  const mocks = `
flock() { echo "flock $*" >> "$DB/calls"; }
uci() { [ "$1" != -q ] || shift; [ "$1" = changes ] && return 0; }
mwan_service() {
  [ "$1" != running ] || return 0
  [ "$1" != restart ] || { echo restart >> "$DB/calls"; return 0; }
}
mwan3_init() { :; }
zbt_mwan_now() { echo "$NOW"; }
zbt_mwan_reconcile() { ZBT_MWAN_RESTART_IFACES=' 4_1 '; return 2; }
logger() { echo "log $*" >> "$DB/calls"; }
`;
  const result = spawnSync('busybox', ['sh', '-c', mocks + '\n' + source], {
    encoding: 'utf8', env: {...process.env, DB:temp, NOW:String(now)}
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test('paused supervised tracker drops the lock and restarts normal mwan3 once per cooldown', () => {
  run(100);
  run(110);
  run(170);
  const calls = fs.readFileSync(path.join(temp, 'calls'), 'utf8');
  assert.equal((calls.match(/^restart$/gm) || []).length, 2);
  assert.match(calls, /flock -u 1000\nrestart/);
  assert.equal((calls.match(/reason=enabled_supervised_session_tracker_paused/g) || []).length, 2);
});
