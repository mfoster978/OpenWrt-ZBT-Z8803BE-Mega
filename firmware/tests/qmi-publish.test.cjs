'use strict';
// Real BusyBox/CM-shaped child lifetimes; kernel route and netifd calls are
// mocked here. The native image test separately exercises the kernel/netifd.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-qmi-publish-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const publicationPath = path.join(root, 'firmware/files/usr/lib/zbt/qmi-publish.sh');
const originalPublication = fs.readFileSync(publicationPath, 'utf8');
const publicationMode = fs.statSync(publicationPath).mode & 0o777;
const migrationSource = fs.readFileSync(path.join(root,
  'firmware/files/etc/uci-defaults/99-zbt-qmi-route-recovery-v17'), 'utf8');
let counter = 0;

function migrationFixture(contents = originalPublication) {
  const dir = fs.mkdtempSync(path.join(temporary, 'migration-'));
  const helper = path.join(dir, 'qmi-publish.sh');
  const migration = path.join(dir, 'migration');
  fs.writeFileSync(helper, contents, { mode: publicationMode });
  fs.writeFileSync(migration, migrationSource.replace('file=/usr/lib/zbt/qmi-publish.sh',
    'file="$PATCH_HELPER"'), { mode: 0o644 });
  return {
    run: () => spawnSync('busybox', ['sh', '-c', 'logger() { :; }; ( . "$PATCH_MIGRATION" )'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATCH_HELPER: helper, PATCH_MIGRATION: migration }
    }),
    source: () => fs.readFileSync(helper, 'utf8'),
    files: () => fs.readdirSync(dir).sort(),
    mode: () => fs.statSync(helper).mode & 0o777
  };
}

function installedPublication() {
  const f = migrationFixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  return f.source();
}
const publication = installedPublication();

test('QMI route migration preserves the already hardened tree helper and is idempotent', () => {
  const f = migrationFixture();
  const installedMode = f.mode();
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const installed = f.source();
  assert.equal(installed, originalPublication, 'migration must preserve the newer lock-order fix');
  assert.match(installed, /cached_pid/);
  assert.match(installed, /ip -4 route add default via/);
  assert.doesNotMatch(installed, /ip -4 route replace default via/);
  assert.equal(f.mode() & 0o444, 0o444, 'helper is sourced; executable mode is unnecessary');
  assert.equal(f.mode(), installedMode, 'already-hardened tree helper retains its installed mode');
  const syntax = spawnSync('busybox', ['sh', '-n'], { input: installed, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(f.run().status, 0);
  assert.equal(f.source(), installed);
  assert.deepEqual(f.files(), ['migration', 'qmi-publish.sh']);
});

test('QMI route migration replaces an unmarked helper without altering reconciliation lock order', () => {
  const unmarked = originalPublication.replace('exact supervised CM process', 'previous route helper');
  const f = migrationFixture(unmarked);
  assert.equal(f.run().status, 0);
  assert.equal(f.source(), originalPublication);
  assert.equal(f.run().status, 0);
  assert.equal(f.source(), originalPublication);
  assert.deepEqual(f.files(), ['migration', 'qmi-publish.sh']);
});

test('QMI route migration fails closed when an unmarked helper replacement anchor is absent or duplicated', () => {
  const unmarked = originalPublication.replace('exact supervised CM process', 'previous route helper');
  for (const contents of [
    unmarked.replace('zbt_qmi_route_cache_file() {', 'renamed_cache_file() {'),
    unmarked.replace('zbt_qmi_published() {', 'renamed_published() {'),
    unmarked + '\nzbt_qmi_route_cache_file() {\n}\n',
    unmarked + '\nzbt_qmi_published() {\n}\n'
  ]) {
    const f = migrationFixture(contents);
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.source(), contents);
    assert.deepEqual(f.files(), ['migration', 'qmi-publish.sh']);
  }
});

function fixture(body, options = {}) {
  const dir = path.join(temporary, String(++counter));
  fs.mkdirSync(path.join(dir, 'sys/class/net/wwan8'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sys/class/net/wwan8/ifindex'), '17\n');
  fs.mkdirSync(path.join(dir, '4_1_dir'));
  fs.writeFileSync(path.join(dir, 'address'), '192.0.0.2/27\n');
  fs.writeFileSync(path.join(dir, 'route'), 'default via 192.0.0.1 dev wwan8 metric 200\n');
  fs.writeFileSync(path.join(dir, 'calls'), '');
  fs.writeFileSync(path.join(dir, 'quectel-CM-M'), `#!/bin/sh
trap 'exit 0' TERM INT
touch "$DB/ready-$$"
while :; do busybox sleep 0.02; done
`);
  const script = publication.replaceAll('/var/lock/zbt-qmi-netifd.lock', dir + '/netifd.lock') + `
MODEM_RUNDIR="$DB"
TEST_PID=''
trap 'kill \${TEST_PID:-} 2>/dev/null || true; wait 2>/dev/null || true' EXIT
start_cm() {
  busybox sh "$DB/quectel-CM-M" -i wwan8 & TEST_PID=$!
  echo "$TEST_PID" > "$DB/4_1_dir/4_1.pid"
  while [ ! -e "$DB/ready-$TEST_PID" ]; do busybox sleep 0.01; done
}
stop_cm() { kill -TERM "$TEST_PID"; wait "$TEST_PID"; TEST_PID=''; }
uci() {
  case "$3" in
    qmodem.main.enable_dial|qmodem.4_1.enable_dial) echo "\${ENABLED:-1}" ;;
    qmodem.4_1.en_bridge) echo "\${BRIDGE:-0}" ;;
    network.4_1.proto) echo zbtqmi ;;
    network.4_1.metric) echo 200 ;;
  esac
}
zbt_netdev() { echo wwan8; }
ip() {
  case "$*" in
    '-o -4 addr show dev wwan8 scope global')
      [ ! -s "$DB/address" ] || printf '17: wwan8 inet %s scope global wwan8\\n' "$(cat "$DB/address")" ;;
    '-4 route show table main default dev wwan8') cat "$DB/route" ;;
    '-4 route add default via '*|'-4 route replace default via '*)
      echo "route-write:$*" >> "$DB/calls"
      [ "\${RESTORE_ERROR:-0}" = 0 ] || return 2
      if [ "\${PEER_CONFLICT:-0}" = 1 ]; then
        [ "$3" != add ] || return 2
        echo peer-route-overwritten >> "$DB/calls"
      fi
      [ "\${IGNORE_WRITE:-0}" = 0 ] || return 0
      shift 3
      echo "$*" > "$DB/route"
      ;;
    *) echo "unexpected-ip:$*" >> "$DB/calls"; return 99 ;;
  esac
}
flock() {
  echo lock >> "$DB/calls"
  [ "\${INVALIDATE_AT_LOCK:-0}" = 0 ] || echo 0 > "$DB/4_1_dir/4_1.pid"
  command flock "$@"
}
logger() { echo "log:$*" >> "$DB/calls"; }
ubus() { echo '{"up":true,"available":true,"autostart":true,"l3_device":"wwan8"}'; }
zbt_qmi_repair_netifd_config() { return 0; }
zbt_qmi_publish() { echo "publish:$1:$2" >> "$DB/calls"; }
start_cm
zbt_qmi_cache_ipv4_route 4_1 wwan8 17 || exit 90
: > "$DB/route"
` + body;
  const result = spawnSync('busybox', ['sh', '-c', script], {
    encoding: 'utf8', timeout: 8000,
    env: { ...process.env, DB: dir, ZBT_SYSFS: path.join(dir, 'sys'), ...options }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { out: result.stdout.trim(), calls: fs.readFileSync(path.join(dir, 'calls'), 'utf8'),
    route: fs.readFileSync(path.join(dir, 'route'), 'utf8').trim() };
}

test('QMI missing IPv4 default is restored for the same live CM and publication resumes', () => {
  const f = fixture('zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected');
  assert.equal(f.out, '');
  assert.match(f.route, /^default via 192\.0\.0\.1 dev wwan8 metric 200$/);
  assert.match(f.calls, /action=restore_cm_main_route.*result=verified/);
  assert.match(f.calls, /publish:4:4_1/);
  assert.doesNotMatch(f.calls, /unexpected-ip|wwan3|2_1|network restart/);
});

test('QMI cache rejects an old USB index, changed lease, missing lease or missing cache', () => {
  for (const change of [
    'echo 18 > "$DB/sys/class/net/wwan8/ifindex"',
    'echo 192.0.0.3/27 > "$DB/address"',
    ': > "$DB/address"',
    'rm "$DB/4_1_dir/ipv4-main-route"'
  ]) {
    const f = fixture(change + '\nzbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected');
    assert.equal(f.out, 'rejected', change);
    assert.equal(f.route, '', change);
    assert.doesNotMatch(f.calls, /route-write:|publish:/, change);
  }
});

test('QMI cache does not overwrite an existing current-device default', () => {
  const f = fixture(`echo 'default via 192.0.0.30 dev wwan8 metric 205' > "$DB/route"
zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected`);
  assert.equal(f.out, '');
  assert.equal(f.route, 'default via 192.0.0.30 dev wwan8 metric 205');
  assert.doesNotMatch(f.calls, /route-write:/);
});

test('QMI route restoration fails closed when the kernel rejects or ignores the write', () => {
  for (const options of [{ RESTORE_ERROR: '1' }, { IGNORE_WRITE: '1' }]) {
    const f = fixture('zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected', options);
    assert.equal(f.out, 'rejected');
    assert.equal(f.route, '');
    assert.doesNotMatch(f.calls, /result=verified|publish:/);
  }
});

test('QMI route restoration rejects a disabled or bridged slot before mutation', () => {
  for (const change of ['ENABLED=0', 'BRIDGE=1', 'stop_cm', 'rm "$DB/4_1_dir/4_1.pid"']) {
    const f = fixture(change + '\nzbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected');
    assert.equal(f.out, 'rejected', change);
    assert.doesNotMatch(f.calls, /route-write:|publish:/, change);
  }
});

test('QMI route cache rejects a replacement CM PID on an unchanged USB/address', () => {
  const f = fixture(`stop_cm
start_cm
zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected`);
  assert.equal(f.out, 'rejected');
  assert.equal(f.route, '');
  assert.doesNotMatch(f.calls, /route-write:|publish:/);
});

test('QMI route repair cannot replace a live peer default with a conflicting metric', () => {
  const f = fixture('zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected', { PEER_CONFLICT: '1' });
  assert.equal(f.out, 'rejected');
  assert.equal(f.route, '');
  assert.doesNotMatch(f.calls, /peer-route-overwritten|publish:/);
});

test('QMI route restoration revalidates ownership under the netifd lock before writing', () => {
  const f = fixture('zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected', { INVALIDATE_AT_LOCK: '1' });
  assert.equal(f.out, 'rejected');
  assert.equal(f.route, '');
  assert.doesNotMatch(f.calls, /route-write:|publish:/);
});
