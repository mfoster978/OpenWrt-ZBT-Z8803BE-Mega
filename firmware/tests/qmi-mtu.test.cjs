'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-qmi-mtu-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const library = ['dual-modem.sh', 'qmi-session.sh'].map(name =>
  fs.readFileSync(path.join(root, 'firmware/files/usr/lib/zbt', name), 'utf8')).join('\n');

function fixture(options = {}, body = 'zbt_qmi_normalize_mtu; echo result=$?') {
  const dir = path.join(tmp, String(++serial));
  fs.mkdirSync(dir);
  for (const [slot, usb, dev, index, mtu] of [
    ['4_1', '4-1', 'wwan8', '17', options.current || '1472'],
    ['2_1', '2-1', 'wwan3', '23', '1430']
  ]) {
    fs.mkdirSync(path.join(dir, 'sys/bus/usb/devices', usb, usb + ':1.4/net', dev), { recursive: true });
    const net = path.join(dir, 'sys/class/net', dev);
    fs.mkdirSync(path.join(net, 'qmi'), { recursive: true });
    fs.writeFileSync(path.join(net, 'ifindex'), index + '\n');
    fs.writeFileSync(path.join(net, 'qmi/raw_ip'), 'Y\n');
    fs.writeFileSync(path.join(net, 'mtu'), mtu + '\n');
    if (options[slot] !== undefined) fs.writeFileSync(path.join(dir, slot + '.mtu'), options[slot]);
  }
  const script = library + `
modem_config=4_1; modem_netcard=wwan8; qmi_ifindex=17; bridge_enabled=0
uci() {
  [ "$1 $2" = '-q get' ] || { echo unexpected-uci-write >&2; return 1; }
  case "$3" in
    qmodem.4_1.mtu) cat "$DB/4_1.mtu" 2>/dev/null; return $? ;;
    qmodem.2_1.mtu) cat "$DB/2_1.mtu" 2>/dev/null; return $? ;;
    *) return 1 ;;
  esac
}
ip() {
  printf 'ip %s\\n' "$*" >> "$DB/calls"
  [ "$#" = 6 ] && [ "$1 $2 $3 $5" = 'link set dev mtu' ] || return 99
  case "$4" in wwan8|wwan3|wwan9) ;; *) return 99 ;; esac
  [ "$MTU_FAIL" != write ] || return 2
  [ "$MTU_FAIL" = readback ] || printf '%s\\n' "$6" > "$ZBT_SYSFS/class/net/$4/mtu"
  [ "$MTU_FAIL" != replaced ] || echo 99 > "$ZBT_SYSFS/class/net/$4/ifindex"
  return 0
}
logger() { printf 'log %s\\n' "$*" >> "$DB/calls"; }
` + body;
  const result = spawnSync('busybox', ['sh', '-c', script], {
    encoding: 'utf8', timeout: 8000,
    env: { ...process.env, DB: dir, ZBT_SYSFS: path.join(dir, 'sys'), MTU_FAIL: options.fail || '' }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '', 'configuration should not cause shell arithmetic or command errors');
  return { dir, out: result.stdout,
    mtu: dev => fs.readFileSync(path.join(dir, 'sys/class/net', dev, 'mtu'), 'utf8').trim(),
    calls: fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '' };
}

test('MTU default remains 1500 on both physical slots and never writes UCI', () => {
  const f = fixture({}, 'zbt_qmi_normalize_mtu; modem_config=2_1; modem_netcard=wwan3; qmi_ifindex=23; zbt_qmi_normalize_mtu; echo done');
  assert.equal(f.mtu('wwan8'), '1500');
  assert.equal(f.mtu('wwan3'), '1500');
  assert.equal(fs.existsSync(path.join(f.dir, '4_1.mtu')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '2_1.mtu')), false);
  assert.equal((f.calls.match(/ip link set/g) || []).length, 2);
});

test('MTU custom policy is per slot, not a peer modem or network-wide setting', () => {
  const f = fixture({ '4_1': '1472', '2_1': '1430', current: '1500' });
  assert.equal(f.out, 'result=0\n');
  assert.equal(f.mtu('wwan8'), '1472');
  assert.equal(f.mtu('wwan3'), '1430');
  assert.doesNotMatch(f.calls, /wwan3|flush|restart|down|up |metric|AT\+/);
  assert.equal(fs.readFileSync(path.join(f.dir, '4_1.mtu'), 'utf8'), '1472');
  const peer = fixture({ '4_1': '1472', '2_1': '1400' }, 'modem_config=2_1; modem_netcard=wwan3; qmi_ifindex=23; zbt_qmi_normalize_mtu; echo result=$?');
  assert.equal(peer.mtu('wwan3'), '1400');
  assert.equal(peer.mtu('wwan8'), '1472');
  assert.doesNotMatch(peer.calls, /wwan8/);
});

test('MTU accepts every integer from 1280 to 1500', () => {
  const f = fixture({}, `
for mtu in $(seq 1280 1500); do
  printf '%s' "$mtu" > "$DB/4_1.mtu"
  actual=$(zbt_qmi_target_mtu)
  [ "$actual" = "$mtu" ] || { echo "mismatch=$mtu:$actual"; break; }
done
echo checked
`);
  assert.equal(f.out, 'checked\n');
  assert.equal(f.calls, '');
  for (const mtu of ['1280', '1281', '1430', '1472', '1499', '1500']) {
    const applied = fixture({ '4_1': mtu, current: '1600' });
    assert.equal(applied.mtu('wwan8'), mtu);
    assert.match(applied.calls, new RegExp('new=' + mtu + ' result=verified'));
  }
});

test('MTU malformed, out-of-range, list and shell-like values safely default without rewriting saved input', () => {
  for (const value of ['', 'auto', '0', '-1', '1279', '1501', '1600', '9999999999999999999999999', '01400',
    '1400.5', ' 1400', '1400 ', '1400 1500', '1400\n1500', '1e3', '0x578', '1400;false', '$(false)']) {
    const f = fixture({ '4_1': value });
    assert.equal(f.out, 'result=0\n', value);
    assert.equal(f.mtu('wwan8'), '1500', value);
    assert.equal(fs.readFileSync(path.join(f.dir, '4_1.mtu'), 'utf8'), value);
  }
});

test('MTU is idempotent, reapplied after CM changes it, and follows edits without redial', () => {
  const f = fixture({ '4_1': '1430' }, `
zbt_qmi_normalize_mtu
zbt_qmi_normalize_mtu
echo 1472 > "$ZBT_SYSFS/class/net/wwan8/mtu"
zbt_qmi_normalize_mtu
printf 1400 > "$DB/4_1.mtu"
zbt_qmi_normalize_mtu
rm "$DB/4_1.mtu"
zbt_qmi_normalize_mtu
echo done
`);
  assert.equal(f.mtu('wwan8'), '1500');
  assert.deepEqual([...f.calls.matchAll(/ip link set dev wwan8 mtu (\d+)/g)].map(m => m[1]), ['1430', '1430', '1400', '1500']);
  assert.doesNotMatch(f.calls, /flush|restart|down|metric/);
});

test('MTU keeps bridge, raw-IP, physical-device and stale-generation guards', () => {
  const cases = [
    'bridge_enabled=1',
    'touch "$ZBT_SYSFS/class/net/wwan8/master"',
    'echo N > "$ZBT_SYSFS/class/net/wwan8/qmi/raw_ip"',
    'rm "$ZBT_SYSFS/class/net/wwan8/qmi/raw_ip"',
    'echo 99 > "$ZBT_SYSFS/class/net/wwan8/ifindex"',
    'modem_netcard=wwan3; qmi_ifindex=23',
    'modem_config=external',
    'echo invalid > "$ZBT_SYSFS/class/net/wwan8/mtu"'
  ];
  for (const setup of cases) {
    const f = fixture({ '4_1': '1400' }, setup + '; zbt_qmi_normalize_mtu; echo result=$?');
    assert.doesNotMatch(f.calls, /ip link set/, setup);
    assert.equal(f.mtu('wwan3'), '1430', setup);
  }
});

test('MTU rejects replacement during configuration read and refuses false readback success', () => {
  const before = fixture({}, `
uci() { echo 99 > "$ZBT_SYSFS/class/net/wwan8/ifindex"; echo 1400; }
zbt_qmi_normalize_mtu; echo result=$?
`);
  assert.equal(before.out, 'result=1\n');
  assert.equal(before.calls, '');
  for (const fail of ['write', 'readback', 'replaced']) {
    const f = fixture({ '4_1': '1400', fail });
    assert.equal(f.out, 'result=1\n', fail);
    assert.doesNotMatch(f.calls, /result=verified/, fail);
  }
});

test('MTU survives re-enumeration while stale owners cannot touch the new generation', () => {
  const f = fixture({ '4_1': '1400' }, `
zbt_qmi_normalize_mtu
mv "$ZBT_SYSFS/bus/usb/devices/4-1/4-1:1.4/net/wwan8" "$ZBT_SYSFS/bus/usb/devices/4-1/4-1:1.4/net/wwan9"
mv "$ZBT_SYSFS/class/net/wwan8" "$ZBT_SYSFS/class/net/wwan9"
echo 29 > "$ZBT_SYSFS/class/net/wwan9/ifindex"
echo 1472 > "$ZBT_SYSFS/class/net/wwan9/mtu"
zbt_qmi_normalize_mtu; echo stale=$?
modem_netcard=wwan9; qmi_ifindex=29
zbt_qmi_normalize_mtu; echo fresh=$?
`);
  assert.equal(f.out, 'stale=1\nfresh=0\n');
  assert.equal(f.mtu('wwan9'), '1400');
  assert.equal(f.mtu('wwan3'), '1430');
  assert.equal((f.calls.match(/ip link set/g) || []).length, 2);
});

test('MTU QModem field defaults, validation and saves match runtime and skip unrelated modems', async () => {
  const patch = fs.readFileSync(path.join(root, 'firmware/patches/qmodem-mtu-v17.patch'), 'utf8');
  const additions = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const writes = [], renders = [], dependencies = [];
  const values = { '4_1': '1472', '2_1': '1430' };
  function Value() {}
  Value.prototype.render = function(id) { renders.push(id); return Promise.resolve({ id }); };
  Value.prototype.parse = function(id) {
    const value = this.formvalue(id);
    if (this.validate(id, value) !== true) return Promise.reject(new Error('invalid MTU'));
    writes.push([id, value]);
    values[id] = value;
    return Promise.resolve();
  };
  const option = new Value();
  option.depends = (...args) => dependencies.push(args);
  option.formvalue = id => values[id] || option.default;
  const s = { option: (type, key, title) => {
    assert.equal(type, Value); assert.equal(key, 'mtu'); assert.equal(title, 'Cellular MTU'); return option;
  } };
  new Function('form', 's', '_', 'E', 'var o;\n' + additions)({ Value }, s, s => s, tag => ({ tag }));
  assert.equal(option.default, '1500');
  assert.equal(option.datatype, 'and(uinteger,range(1280,1500))');
  assert.equal(option.rmempty, false);
  assert.equal(option.modalonly, true);
  assert.equal(option.retain, true);
  assert.deepEqual(dependencies, [['en_bridge', '0']]);
  assert.match(option.description, /lowering it may bring back RX errors/);
  assert.deepEqual(writes, [], 'opening the form never stores defaults');
  for (let mtu = 1280; mtu <= 1500; mtu++) assert.equal(option.validate('4_1', String(mtu)), true);
  for (const invalid of ['', '1279', '1501', '01400', '1400.5', ' 1400', '1400 1500', '$(false)'])
    assert.notEqual(option.validate('4_1', invalid), true, invalid);
  await option.render('external'); await option.parse('external');
  assert.deepEqual(writes, []); assert.deepEqual(renders, []);
  await option.render('4_1'); await option.render('2_1');
  await option.parse('4_1'); await option.parse('2_1');
  assert.deepEqual(writes, [['4_1', '1472'], ['2_1', '1430']]);
  values['4_1'] = '1600';
  await assert.rejects(option.parse('4_1'), /invalid MTU/);
  assert.equal(writes.length, 2);
});
