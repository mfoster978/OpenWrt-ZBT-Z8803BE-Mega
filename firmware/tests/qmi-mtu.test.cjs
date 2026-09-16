'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const helper = fs.readFileSync(path.join(root, 'firmware/files/usr/lib/zbt/qmi-session.sh'), 'utf8');

function runShell(body, { setting = '', initial = '1500' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-qmi-mtu-'));
  try {
    const net = path.join(dir, 'sys/class/net/wwan0');
    fs.mkdirSync(path.join(net, 'qmi'), { recursive: true });
    fs.writeFileSync(path.join(net, 'ifindex'), '8\n');
    fs.writeFileSync(path.join(net, 'qmi/raw_ip'), 'Y\n');
    fs.writeFileSync(path.join(net, 'mtu'), initial + '\n');
    const script = `${helper}
modem_config=4_1
modem_netcard=wwan0
bridge_enabled=0
qmi_ifindex=8
zbt_netdev() { printf '%s\\n' wwan0; }
uci() {
  case "$*" in
    *qmodem.4_1.mtu) [ -z "$MTU_SETTING" ] || printf '%s\\n' "$MTU_SETTING" ;;
  esac
}
ip() {
  case "$*" in
    'link set dev wwan0 mtu '*)
      value="${'${*##* }'}"
      printf 'set=%s\\n' "$value" >> "$DB/calls"
      printf '%s\\n' "$value" > "$ZBT_SYSFS/class/net/wwan0/mtu" ;;
    *) return 0 ;;
  esac
}
logger() { printf 'log=%s\\n' "$*" >> "$DB/calls"; }
${body}
`;
    const result = spawnSync('busybox', ['sh', '-c', script], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, DB: dir, ZBT_SYSFS: path.join(dir, 'sys'), MTU_SETTING: setting }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '';
    const mtu = fs.readFileSync(path.join(net, 'mtu'), 'utf8').trim();
    return { out: result.stdout.trim(), calls, mtu };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('QMI MTU defaults to the proven 1500 value when unset or invalid', () => {
  for (const setting of ['', '1279', '1501', 'abc', '-1']) {
    const f = runShell('zbt_qmi_target_mtu', { setting });
    assert.equal(f.out, '1500', `setting=${setting}`);
  }
});

test('QMI MTU accepts the full owner-configurable 1280 through 1500 range', () => {
  for (const setting of ['1280', '1430', '1472', '1500']) {
    const f = runShell('zbt_qmi_target_mtu', { setting });
    assert.equal(f.out, setting);
  }
});

test('QMI supervisor enforces a custom owner MTU and verifies readback', () => {
  const f = runShell('zbt_qmi_normalize_mtu; cat "$ZBT_SYSFS/class/net/wwan0/mtu"', {
    setting: '1430', initial: '1500'
  });
  assert.equal(f.out, '1430');
  assert.equal(f.mtu, '1430');
  assert.match(f.calls, /^set=1430$/m);
  assert.match(f.calls, /action=normalize-mtu old=1500 new=1430 result=verified/);
});

test('QMI supervisor still restores 1500 by default and does not rewrite an exact target', () => {
  const restored = runShell('zbt_qmi_normalize_mtu', { initial: '1472' });
  assert.equal(restored.mtu, '1500');
  assert.match(restored.calls, /^set=1500$/m);
  assert.match(restored.calls, /action=normalize-mtu old=1472 new=1500 result=verified/);

  const exact = runShell('zbt_qmi_normalize_mtu', { setting: '1472', initial: '1472' });
  assert.equal(exact.mtu, '1472');
  assert.equal(exact.calls, '');
});

test('profile and LuCI expose 1500 as a preserved, validated per-modem default', () => {
  const profile = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-qmodem-profile'), 'utf8');
  const patch = fs.readFileSync(path.join(root, 'firmware/patches/qmodem-network-apply-v16.patch'), 'utf8');
  assert.match(profile, /zbt_5g_policy=auto mtu=1500/);
  assert.match(profile, /if ! uci -q get "qmodem\.\$1\.\$key"/,
    'scanner profile must only seed missing owner settings');
  assert.match(patch, /form\.Value, 'mtu', _\('QMI MTU'\)/);
  assert.match(patch, /o\.datatype = 'range\(1280,1500\)'/);
  assert.match(patch, /o\.default = '1500'/);
  assert.match(helper, /ip link set dev "\$modem_netcard" mtu 1500/,
    'the proven default path stays explicit for image validation');
});
