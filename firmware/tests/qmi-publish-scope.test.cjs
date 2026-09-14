'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const base = require('node:os').tmpdir();
const temporary = fs.mkdtempSync(path.join(base, 'qmi-v18-fixture-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const raw = read('firmware/files/usr/lib/zbt/qmi-publish.sh');
const session = read('firmware/files/usr/lib/zbt/qmi-session.sh');
const sessionOwned = session.slice(session.indexOf('zbt_qmi_owned() {'), session.indexOf('zbt_qmi_flush() {'));
let serial = 0;
function shell(script, env = {}) {
  const result = spawnSync('busybox', ['sh', '-c', script], {
    encoding: 'utf8', timeout: 8000, env: { ...process.env, ...env }
  });
  assert.ifError(result.error);
  return result;
}
function migrated(input = raw, versions = ['17', '18']) {
  const dir = path.join(temporary, String(++serial)); fs.mkdirSync(dir);
  const helper = path.join(dir, 'qmi-publish.sh');
  fs.writeFileSync(helper, input, { mode: 0o644 });
  for (const version of versions) {
    const name = version === '17' ? '99-zbt-qmi-route-recovery-v17' : '99-zbt-qmi-publish-scope-v18';
    fs.writeFileSync(path.join(dir, version), read('firmware/files/etc/uci-defaults/' + name)
      .replace('file=/usr/lib/zbt/qmi-publish.sh', 'file="$PATCH_HELPER"'), { mode: 0o644 });
    const result = shell('logger() { :; }; ( . "$PATCH_MIGRATION" )', {
      PATCH_HELPER: helper, PATCH_MIGRATION: path.join(dir, version)
    });
    if (result.status !== 0) return { dir, source: fs.readFileSync(helper, 'utf8'), status: result.status };
  }
  return { dir, source: fs.readFileSync(helper, 'utf8'), status: 0 };
}
const installed = migrated().source;

test('exact v17 then v18 migration changes only the three publish-local identifiers', () => {
  const expected = raw
    .replace('local family="$1" interface="$2" addresses routes payload snapshot current qmi_ifindex',
      'local family="$1" interface="$2" addresses routes payload snapshot current publish_ifindex')
    .replace('qmi_ifindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)',
      'publish_ifindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)')
    .replace('zbt_qmi_cache_ipv4_route "$modem_config" "$modem_netcard" "$qmi_ifindex" || true',
      'zbt_qmi_cache_ipv4_route "$modem_config" "$modem_netcard" "$publish_ifindex" || true');
  assert.equal(installed, expected);
  assert.equal(shell(installed).status, 0);
  const repeat = migrated(installed, ['17', '18', '18']);
  assert.equal(repeat.status, 0);
  assert.equal(repeat.source, installed);
  assert.equal(fs.statSync(path.join(repeat.dir, 'qmi-publish.sh')).mode & 0o777, 0o644);
  assert.equal(installed.slice(installed.indexOf('zbt_qmi_reconcile_publication()')),
    raw.slice(raw.indexOf('zbt_qmi_reconcile_publication()')), 'lock/revalidation ordering is unchanged');
  assert.equal(installed.slice(0, installed.indexOf('zbt_qmi_published()')),
    raw.slice(0, raw.indexOf('zbt_qmi_published()')), 'PID-bound additive route protection is unchanged');
});

test('v18 rejects missing or duplicated exact inputs without changing the helper', () => {
  const anchors = [
    'local family="$1" interface="$2" addresses routes payload snapshot current qmi_ifindex',
    'qmi_ifindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)',
    'zbt_qmi_cache_ipv4_route "$modem_config" "$modem_netcard" "$qmi_ifindex" || true'
  ];
  for (const anchor of anchors) {
    for (const input of [raw.replace(anchor, ': # changed shape'), raw + '\n' + anchor + '\n']) {
      const result = migrated(input, ['18']);
      assert.equal(result.status, 1);
      assert.equal(result.source, input);
      assert.deepEqual(fs.readdirSync(result.dir).sort(), ['18', 'qmi-publish.sh']);
    }
  }
});

function publicationFixture(helper, closure, extra = '') {
  const dir = path.join(temporary, String(++serial)); fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'sys/class/net/wwan8'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sys/class/net/wwan8/ifindex'), '17\n');
  fs.mkdirSync(path.join(dir, '4_1_dir'));
  fs.writeFileSync(path.join(dir, 'events'), '');
  fs.writeFileSync(path.join(dir, 'quectel-CM-M'), '#!/bin/sh\ntrap "exit 0" TERM INT\ntouch "$DB/ready-$$"\nwhile :; do busybox sleep 0.02; done\n');
  const script = helper.replaceAll('/var/lock/zbt-qmi-netifd.lock', dir + '/netifd.lock') + '\n' + sessionOwned + `
MODEM_RUNDIR="$DB"
modem_config=4_1; modem_netcard=wwan8
uci() {
  case "$3" in
    qmodem.main.enable_dial|qmodem.4_1.enable_dial) echo "\${ENABLED:-1}" ;;
    qmodem.4_1.en_bridge) echo 0 ;;
    network.4_1.modem_config|network.4_1v6.modem_config) echo 4_1 ;;
    network.4_1.proto|network.4_1v6.proto) echo zbtqmi ;;
    network.4_1.metric) echo 200 ;;
  esac
}
zbt_netdev() { [ "$1" = 4_1 ] && echo wwan8; }
ip() {
  case "$*" in
    '-j -4 addr show dev wwan8 scope global') echo '[{"addr_info":[{"local":"192.0.0.2","prefixlen":27,"scope":"global"}]}]' ;;
    '-j -6 addr show dev wwan8 scope global') echo '[{"addr_info":[{"local":"2001:db8::2","prefixlen":64,"scope":"global"}]}]' ;;
    '-j -4 route show dev wwan8 table main') echo '[{"dst":"default","gateway":"192.0.0.1","metric":200}]' ;;
    '-j -6 route show dev wwan8 table main') echo '[{"dst":"default","gateway":"2001:db8::1","metric":200}]' ;;
    '-o -4 addr show dev wwan8 scope global') echo '17: wwan8 inet 192.0.0.2/27 scope global' ;;
    '-o -6 addr show dev wwan8 scope global') echo '17: wwan8 inet6 2001:db8::2/64 scope global' ;;
    '-4 route show table main default dev wwan8') echo 'default via 192.0.0.1 dev wwan8 metric 200' ;;
    '-6 route show table main default dev wwan8') echo 'default via 2001:db8::1 dev wwan8 metric 200' ;;
    *) echo "unexpected-ip:$*" >> "$DB/events"; return 99 ;;
  esac
}
ubus() {
  case "$5" in
    notify_proto)
      echo "notify:$4" >> "$DB/events"
      printf '%s' "$6" | jq '{up:true,available:true,autostart:true,l3_device:.ifname,"ipv4-address":((.ipaddr//[])|map({address:.ipaddr})),"ipv6-address":((.ip6addr//[])|map({address:.ipaddr}))}' > "$DB/status-$4"
      ;;
    status) cat "$DB/status-$4" 2>/dev/null || echo '{"up":true,"available":true,"autostart":true,"l3_device":"wwan8"}' ;;
    *) echo "unexpected-ubus:$*" >> "$DB/events"; return 99 ;;
  esac
}
logger() { :; }
zbt_qmi_repair_netifd_config() { return 0; }
busybox sh "$DB/quectel-CM-M" -i wwan8 & TEST_PID=$!
trap 'kill "$TEST_PID" 2>/dev/null || true; wait 2>/dev/null || true' EXIT
echo "$TEST_PID" > "$DB/4_1_dir/4_1.pid"
while [ ! -f "$DB/ready-$TEST_PID" ]; do busybox sleep 0.01; done
${extra}
session_closure() {
  local qmi_ifindex=17 qmi_published4='' qmi_published6=''
  zbt_qmi_publish 4 4_1 || echo rejected4
  zbt_qmi_publish 6 4_1v6 || echo rejected6
  zbt_qmi_publish 4 4_1 || echo rejected4
  zbt_qmi_publish 6 4_1v6 || echo rejected6
}
reconciler_closure() {
  zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected4
  zbt_qmi_reconcile_publication 4_1 6 wwan8 17 || echo rejected6
  zbt_qmi_reconcile_publication 4_1 4 wwan8 17 || echo rejected4
  zbt_qmi_reconcile_publication 4_1 6 wwan8 17 || echo rejected6
}
${closure}
`;
  const result = shell(script, { DB: dir, ZBT_SYSFS: path.join(dir, 'sys') });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { out: result.stdout.trim(), events: fs.readFileSync(path.join(dir, 'events'), 'utf8') };
}

for (const closure of ['session_closure', 'reconciler_closure']) {
  test('BusyBox actual ' + closure + ' reproduces pre-v18 rejection and publishes both families after migration', () => {
    const before = publicationFixture(raw, closure);
    assert.equal(before.out, 'rejected4\nrejected6\nrejected4\nrejected6');
    assert.equal(before.events, '');
    const after = publicationFixture(installed, closure);
    assert.equal(after.out, '');
    assert.equal(after.events, 'notify:network.interface.4_1\nnotify:network.interface.4_1v6\n',
      'real readback suppresses duplicate notifications, without replacing the ownership callback');
  });
}

test('actual post-v18 reconciler rejects stale ifindex and user-disabled slot before notification', () => {
  for (const change of ['echo 18 > "$DB/sys/class/net/wwan8/ifindex"', 'ENABLED=0']) {
    const result = publicationFixture(installed, 'reconciler_closure', change);
    assert.equal(result.out, 'rejected4\nrejected6\nrejected4\nrejected6');
    assert.equal(result.events, '');
  }
});

test('post-v18 publication rejects unknown slot/family and LAN aliases without notification', () => {
  const result = publicationFixture(installed, `
zbt_qmi_reconcile_publication unknown 4 wwan8 17 || echo rejected-slot
zbt_qmi_reconcile_publication 4_1 5 wwan8 17 || echo rejected-family
zbt_qmi_publish 4 lan || echo rejected-alias
`);
  assert.equal(result.out, 'rejected-slot\nrejected-family\nrejected-alias');
  assert.equal(result.events, '');
});

