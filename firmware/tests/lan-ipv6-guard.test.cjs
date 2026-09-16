'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-lan-ipv6-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const source = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-lan-ipv6-guard'), 'utf8')
  .replace('. /usr/lib/zbt/mwan-runtime.sh', '');

function fixture(options = {}, body = 'zbt_lan_ipv6_once; echo result=$?') {
  const dir = path.join(tmp, String(++serial));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ra'), options.ra ?? 'server');
  fs.writeFileSync(path.join(dir, 'dhcpv6'), options.dhcpv6 ?? 'server');
  const policy4 = options.policy4 ?? 'manual';
  const policy2 = options.policy2 ?? 'manual';
  const script = `
${source}
flock() { :; }
logger() { printf 'log %s\\n' "$*" >> "$DB/calls"; }
zbt_mwan_winner() {
  [ "$1" = 6 ] && { [ -n "$WINNER6" ] && echo "$WINNER6"; [ -n "$WINNER6" ]; return; }
  [ -n "$WINNER4" ] && echo "$WINNER4"
  [ -n "$WINNER4" ]
}
ubus() {
  case "$*" in
    *network.interface.4_1v6*|*network.interface.2_1v6*) echo '{"up":true}' ;;
    *) return 1 ;;
  esac
}
jsonfilter() { [ "$PD" = 1 ] && echo '2001:db8:1234::' || true; }
zbt_lan_ipv6_restart_odhcpd() { echo restart >> "$DB/calls"; [ "$RESTART_FAIL" != 1 ]; }
uci() {
  case "$1 $2" in
    '-q get')
      case "$3" in
        dhcp.lan.ra) cat "$DB/ra" ;;
        dhcp.lan.dhcpv6) cat "$DB/dhcpv6" ;;
        qmodem.4_1) echo modem-device ;;
        qmodem.2_1) echo modem-device ;;
        qmodem.4_1.lan_ipv6_policy) printf '%s\\n' "$POLICY4" ;;
        qmodem.2_1.lan_ipv6_policy) printf '%s\\n' "$POLICY2" ;;
        *) return 1 ;;
      esac ;;
    '-q set')
      case "$3" in
        dhcp.lan.ra=*) printf '%s' "\${3#*=}" > "$DB/ra" ;;
        dhcp.lan.dhcpv6=*) printf '%s' "\${3#*=}" > "$DB/dhcpv6" ;;
        *) return 1 ;;
      esac
      printf 'uci %s\\n' "$3" >> "$DB/calls" ;;
    '-q commit') [ "$3" = dhcp ] || return 1; echo commit >> "$DB/calls" ;;
    *) return 1 ;;
  esac
}
${body}
`;
  const result = spawnSync('busybox', ['sh', '-c', script], {
    encoding: 'utf8', timeout: 8000,
    env: {
      ...process.env,
      DB: dir,
      ZBT_LAN_IPV6_LIB_ONLY: '1',
      ZBT_LAN_IPV6_STATE: path.join(dir, 'state'),
      ZBT_LAN_IPV6_LOCK: path.join(dir, 'lock'),
      WINNER6: options.winner6 ?? '',
      WINNER4: options.winner4 ?? '4_1',
      POLICY4: policy4,
      POLICY2: policy2,
      PD: options.pd ? '1' : '0',
      RESTART_FAIL: options.restartFail ? '1' : '0'
    }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return {
    dir,
    out: result.stdout,
    calls: fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '',
    ra: fs.readFileSync(path.join(dir, 'ra'), 'utf8'),
    dhcpv6: fs.readFileSync(path.join(dir, 'dhcpv6'), 'utf8'),
    state: fs.existsSync(path.join(dir, 'state')) ? fs.readFileSync(path.join(dir, 'state'), 'utf8') : ''
  };
}

test('manual policy is the safe default and never changes LAN IPv6', () => {
  const f = fixture({ winner6: '4_1v6', policy4: 'manual', pd: false });
  assert.equal(f.ra, 'server');
  assert.equal(f.dhcpv6, 'server');
  assert.equal(f.state, '');
  assert.equal(f.calls, '');
});

test('auto suppresses stock LAN IPv6 only when the active cellular WAN has no delegated prefix', () => {
  const f = fixture({ winner6: '4_1v6', policy4: 'auto', pd: false });
  assert.equal(f.ra, 'disabled');
  assert.equal(f.dhcpv6, 'disabled');
  assert.equal(f.state, 'version=1\nra=server\ndhcpv6=server\n');
  assert.match(f.calls, /dhcp\.lan\.ra=disabled/);
  assert.match(f.calls, /dhcp\.lan\.dhcpv6=disabled/);
  assert.equal((f.calls.match(/restart/g) || []).length, 1);
});

test('auto leaves IPv6 server mode intact when a delegated prefix exists', () => {
  const f = fixture({ winner6: '4_1v6', policy4: 'auto', pd: true });
  assert.equal(f.ra, 'server');
  assert.equal(f.dhcpv6, 'server');
  assert.equal(f.state, '');
  assert.equal(f.calls, '');
});

test('guard restores stock LAN IPv6 when prefix returns and is idempotent while suppressed', () => {
  const f = fixture({ winner6: '4_1v6', policy4: 'auto', pd: false }, `
zbt_lan_ipv6_once
zbt_lan_ipv6_once
PD=1
zbt_lan_ipv6_once
echo done
`);
  assert.equal(f.out, 'done\n');
  assert.equal(f.ra, 'server');
  assert.equal(f.dhcpv6, 'server');
  assert.equal(f.state, '');
  assert.equal((f.calls.match(/restart/g) || []).length, 2, 'one suppress and one restore only');
});

test('explicit disabled policy suppresses LAN IPv6 even when carrier delegates a prefix', () => {
  const f = fixture({ winner6: '2_1v6', winner4: '2_1', policy2: 'disabled', pd: true });
  assert.equal(f.ra, 'disabled');
  assert.equal(f.dhcpv6, 'disabled');
  assert.match(f.calls, /action=suppress result=ok/);
});

test('policy follows the active modem and never lets the standby modem control LAN IPv6', () => {
  const manualWinner = fixture({ winner6: '4_1v6', policy4: 'manual', policy2: 'auto', pd: false });
  assert.equal(manualWinner.ra, 'server');
  const autoWinner = fixture({ winner6: '2_1v6', policy4: 'manual', policy2: 'auto', pd: false });
  assert.equal(autoWinner.ra, 'disabled');
});

test('non-cellular IPv6 winner causes Mega to back off', () => {
  const f = fixture({ winner6: 'wan_sfp6', winner4: '4_1', policy4: 'auto', pd: false });
  assert.equal(f.ra, 'server');
  assert.equal(f.dhcpv6, 'server');
  assert.equal(f.calls, '');
});

test('relay, hybrid, mixed and owner-disabled LAN configurations are never overwritten', () => {
  for (const [ra, dhcpv6] of [['relay', 'relay'], ['hybrid', 'hybrid'], ['disabled', 'disabled'], ['server', 'disabled']]) {
    const f = fixture({ winner6: '4_1v6', policy4: 'auto', pd: false, ra, dhcpv6 });
    assert.equal(f.ra, ra);
    assert.equal(f.dhcpv6, dhcpv6);
    assert.equal(f.state, '');
    assert.doesNotMatch(f.calls, /^uci /m, `${ra}:${dhcpv6}`);
  }
});

test('manual owner change while guard is active wins and clears guard state without restoration', () => {
  const f = fixture({ winner6: '4_1v6', policy4: 'auto', pd: false }, `
zbt_lan_ipv6_once
echo relay > "$DB/ra"
echo relay > "$DB/dhcpv6"
PD=1
zbt_lan_ipv6_once
echo done
`);
  assert.equal(f.ra.trim(), 'relay');
  assert.equal(f.dhcpv6.trim(), 'relay');
  assert.equal(f.state, '');
  assert.equal((f.calls.match(/restart/g) || []).length, 1);
  assert.match(f.calls, /action=relinquish reason=lan-config-changed/);
});

test('QModem edit field has safe choices and uses the real LuCI render signature', async () => {
  const patch = fs.readFileSync(path.join(root, 'firmware/patches/qmodem-lan-ipv6-v18.patch'), 'utf8');
  const additions = patch.split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1)).join('\n');
  const renders = [], parses = [], values = [];
  function ListValue() {}
  ListValue.prototype.render = function(optionIndex, sectionId, inTable) {
    renders.push([optionIndex, sectionId, inTable]);
    return Promise.resolve({ sectionId });
  };
  ListValue.prototype.parse = function(sectionId) { parses.push(sectionId); return Promise.resolve(); };
  const option = new ListValue();
  option.value = (key, label) => values.push([key, label]);
  const form = { ListValue };
  const s = { option: (type, key, title) => {
    assert.equal(type, ListValue); assert.equal(key, 'lan_ipv6_policy'); assert.equal(title, 'LAN IPv6'); return option;
  } };
  new Function('form', 's', '_', 'E', 'var o;\n' + additions)(form, s, x => x, tag => ({ tag }));
  assert.equal(option.default, 'manual');
  assert.equal(option.rmempty, false);
  assert.equal(option.modalonly, true);
  assert.equal(option.retain, true);
  assert.deepEqual(values.map(v => v[0]), ['manual', 'auto', 'disabled']);
  await option.render(19, '4_1', false);
  await option.render(19, '2_1', false);
  await option.render(19, 'external', false);
  assert.deepEqual(renders, [[19, '4_1', false], [19, '2_1', false]]);
  await option.parse('4_1'); await option.parse('2_1'); await option.parse('external');
  assert.deepEqual(parses, ['4_1', '2_1']);
  assert.match(option.description, /no delegated IPv6 prefix/);
});
