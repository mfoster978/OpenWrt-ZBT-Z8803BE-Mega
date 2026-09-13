'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-speedify-routing-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const library = fs.readFileSync(path.join(root, 'firmware/files/usr/lib/zbt/speedify-routing.sh'), 'utf8');
let count = 0;
function fixture(extra = {}) {
  const dir = path.join(tmp, String(++count)); fs.mkdirSync(dir);
  const values = {
    'network.speedify': 'interface', 'network.speedify.device': 'connectify0',
    'firewall.defaults': 'defaults', 'firewall.@defaults[0].flow_offloading': '1', 'firewall.@defaults[0].flow_offloading_hw': '1',
    'firewall.lan': 'zone', 'firewall.lan.name': 'lan', 'firewall.lan.device': 'br-lan connectify0', 'firewall.lan.network': 'lan speedify',
    'firewall.wan': 'zone', 'firewall.wan.name': 'wan', 'firewall.wan.device': 'eth1 connectify0', 'firewall.wan.network': 'wan 4_1 2_1 speedify',
    'firewall.cfg01': 'zone', 'firewall.cfg01.name': 'speedify', 'firewall.cfg01.device': 'connectify0', 'firewall.cfg01.network': 'speedify',
    'firewall.to_vpn': 'forwarding', 'firewall.to_vpn.src': 'lan', 'firewall.to_vpn.dest': 'speedify',
    'firewall.from_vpn': 'forwarding', 'firewall.from_vpn.src': 'speedify', 'firewall.from_vpn.dest': 'lan',
    'firewall.to_wan': 'forwarding', 'firewall.to_wan.src': 'lan', 'firewall.to_wan.dest': 'wan',
    'speedify_bootstrap.main': 'installer', settings: '{"bondingMode":"streaming","fixedDelay":75,"pep":true}', state: '{"state":"CONNECTED"}',
    ...extra
  };
  for (const [key, value] of Object.entries(values)) fs.writeFileSync(path.join(dir, key), value);
  return { dir, get: key => fs.existsSync(path.join(dir, key)) ? fs.readFileSync(path.join(dir, key), 'utf8') : '',
    put: (key, value) => fs.writeFileSync(path.join(dir, key), value) };
}
const mocks = `
uci() {
  local cmd key val entry word result='' n
  while [ "$1" = -q ] || [ "$1" = -X ]; do shift; done
  cmd=$1; key=$2
  case "$cmd" in
    get) [ -f "$DB/$key" ] && cat "$DB/$key" ;;
    changes) [ "$PENDING" != "$key" ] || echo 'user pending edit' ;;
    show) for entry in "$DB/$key".*; do
      [ -f "$entry" ] && printf '%s=%s\\n' "\${entry##*/}" "$(cat "$entry")"
      done ;;
    set) printf '%s' "\${key#*=}" > "$DB/\${key%%=*}"; echo "$cmd $key" >> "$DB/writes" ;;
    add) n=$(cat "$DB/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DB/count"
      printf '%s' "$3" > "$DB/$key.new$n"; echo "new$n"; echo "$cmd $key" >> "$DB/writes" ;;
    delete) rm -f "$DB/$key" "$DB/$key".*; echo "$cmd $key" >> "$DB/writes" ;;
    add_list|del_list)
      val=\${key#*=}; key=\${key%%=*}
      for word in $(cat "$DB/$key" 2>/dev/null); do
        [ "$cmd:$word" = "del_list:$val" ] || result="$result $word"
      done
      [ "$cmd" != add_list ] || result="$result $val"
      printf '%s' "\${result# }" > "$DB/$key"; echo "$cmd $key $val" >> "$DB/writes" ;;
    commit) echo "commit $key" >> "$DB/writes" ;;
    *) return 1 ;;
  esac
}
logger() { :; }
sf_firewall_reload() { echo reload >> "$DB/actions"; }
ip() { case "$*" in
  '-4 route show table all') cat "$DB/routes4" 2>/dev/null ;;
  '-6 route show table all') cat "$DB/routes6" 2>/dev/null ;;
  '-4 rule show') cat "$DB/rules" 2>/dev/null ;;
  *) echo "ip $*" >> "$DB/actions" ;;
esac; }
nft() { case "$*" in
  'list table ip connectify_pep') [ -f "$DB/pep_table" ] ;;
  'delete table ip connectify_pep') echo "nft $*" >> "$DB/actions"; rm "$DB/pep_table" ;;
  *) return 1 ;;
esac; }
timeout() {
  shift; shift
  case "$*" in
    'show settings') cat "$DB/settings" ;;
    state) cat "$DB/state" ;;
    'mode speed'|'fixeddelay 0'|'pep off')
      echo "cli $*" >> "$DB/actions"
      [ "$FAIL_CLI" != "$*" ] || return 1
      case "$1" in mode) val='.bondingMode="speed"';; fixeddelay) val='.fixedDelay=0';; pep) val='.pep=false';; esac
      jq "$val" "$DB/settings" > "$DB/settings.new" && mv "$DB/settings.new" "$DB/settings" ;;
    disconnect|'connect last') echo "cli $*" >> "$DB/actions" ;;
    *) return 1 ;;
  esac
}
`;
function run(f, commands, env = {}) {
  const result = spawnSync('busybox', ['sh', '-c', library + mocks + '\n' + commands], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DB: f.dir, ...env }
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}
test('vendor triple-zone config is repaired; modem membership and LAN fallback survive; repeat is a no-op', () => {
  const f = fixture(); run(f, 'sf_repair_firewall');
  assert.equal(f.get('firewall.lan.device'), 'br-lan'); assert.equal(f.get('firewall.lan.network'), 'lan');
  assert.equal(f.get('firewall.wan.device'), 'eth1'); assert.equal(f.get('firewall.wan.network'), 'wan 4_1 2_1');
  assert.equal(f.get('firewall.cfg01.network'), 'speedify'); assert.equal(f.get('firewall.cfg01.device'), '');
  for (const [key, value] of Object.entries({ input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1' }))
    assert.equal(f.get('firewall.cfg01.' + key), value);
  assert.equal(f.get('firewall.from_vpn'), ''); assert.equal(f.get('firewall.to_wan.dest'), 'wan');
  const writes = f.get('writes'), actions = f.get('actions'); run(f, 'sf_repair_firewall');
  assert.equal(f.get('writes'), writes); assert.equal(f.get('actions'), actions);
  assert.doesNotMatch(writes + actions, /mwan3|metric|band|ifdown|network restart/);
});
test('stable IDs prune duplicate Speedify zones/forwards, including alias memberships', () => {
  const f = fixture({ 'firewall.cfg02': 'zone', 'firewall.cfg02.name': 'speedify', 'firewall.cfg02.device': 'connectify0',
    'firewall.dup': 'forwarding', 'firewall.dup.src': 'lan', 'firewall.dup.dest': 'speedify',
    'network.vpn_alias': 'interface', 'network.vpn_alias.device': 'connectify0', 'firewall.wan.network': 'wan vpn_alias' });
  run(f, 'sf_repair_firewall'); assert.equal(f.get('firewall.cfg02'), ''); assert.equal(f.get('firewall.wan.network'), 'wan');
  assert.equal(['dup', 'to_vpn'].filter(name => f.get('firewall.' + name)).length, 1);
});
test('ambiguous custom zones, wrong tunnel device and pending LuCI changes cause no writes', () => {
  for (const [extra, env] of [[{ 'firewall.cfg01.network': 'speedify guest' }, {}], [{ 'network.speedify.device': 'eth2' }, {}], [{}, { PENDING: 'firewall' }]]) {
    const f = fixture(extra); assert.equal(run(f, 'sf_repair_firewall && echo changed || echo deferred', env), 'deferred'); assert.equal(f.get('writes'), '');
  }
});
test('throughput profile is verified and applied once; later choices and account identity survive', () => {
  const f = fixture(); run(f, 'sf_migrate_profile');
  assert.deepEqual(JSON.parse(f.get('settings')), { bondingMode: 'speed', fixedDelay: 0, pep: false });
  assert.match(f.get('actions'), /cli mode speed\ncli fixeddelay 0\ncli pep off\ncli disconnect\ncli connect/);
  const actions = f.get('actions'); f.put('settings', '{"bondingMode":"streaming","fixedDelay":50,"pep":true}');
  run(f, 'sf_migrate_profile'); assert.equal(f.get('actions'), actions);
  assert.equal(JSON.parse(f.get('settings')).fixedDelay, 50); assert.doesNotMatch(actions, /login|logout|reset|restart/);
});
test('failed reads/writes never mark the profile complete or connect a logged-out account', () => {
  const bad = fixture({ settings: '{}' }); assert.equal(run(bad, 'sf_migrate_profile && echo done || echo failed'), 'failed'); assert.equal(bad.get('writes'), '');
  const failed = fixture(); assert.equal(run(failed, 'sf_migrate_profile && echo done || echo failed', { FAIL_CLI: 'fixeddelay 0' }), 'failed');
  assert.equal(failed.get('speedify_bootstrap.main.throughput_v1'), ''); assert.doesNotMatch(failed.get('actions'), /cli connect/);
  const out = fixture({ state: '{"state":"LOGGED_OUT"}' }); run(out, 'sf_migrate_profile'); assert.doesNotMatch(out.get('actions'), /connect|login/);
});
test('only routed tunnels disable both offloads; split defaults and IPv6 are recognized', () => {
  const f = fixture(); assert.equal(run(f, 'sf_tunnel_routes && echo yes || echo no'), 'no');
  f.put('routes4', 'default via 10.0.0.1 dev wwan0\n10.202.0.0/24 dev connectify0\n'); assert.equal(run(f, 'sf_tunnel_routes && echo yes || echo no'), 'no');
  for (const [key, value] of [['routes4', '128.0.0.0/1 dev connectify0\n'], ['routes6', 'default dev connectify0 table 100\n']]) {
    f.put('routes4', ''); f.put(key, value); run(f, 'sf_tunnel_routes && sf_disable_offload');
  }
  assert.equal(f.get('firewall.@defaults[0].flow_offloading'), '0'); assert.equal(f.get('firewall.@defaults[0].flow_offloading_hw'), '0');
  assert.equal(f.get('actions'), 'reload\n');
});
test('PEP listener probe uses decimal port 9332, loopback/wildcard and TCP LISTEN state', () => {
  const f = fixture(); const probe = library.slice(library.indexOf('sf_pep_listener()'), library.indexOf('sf_pep_table()')).replace('/proc/net/tcp', '"$DB/tcp"');
  for (const [socket, state, expected] of [['0100007F:2474', '0A', 'yes'], ['00000000:2474', '0A', 'yes'], ['0100007F:2474', '01', 'no'], ['0100007F:9332', '0A', 'no'], ['0100000A:2474', '0A', 'no']]) {
    f.put('tcp', '0: ' + socket + ' 00000000:0000 ' + state + '\n');
    assert.equal(run(f, probe + '\nsf_pep_listener && echo yes || echo no'), expected);
  }
});
test('dead PEP cleanup touches only its table, exact mark and local default; healthy PEP is unchanged', () => {
  const f = fixture({ pep_table: 'yes', rules: '100: from all fwmark 0x9332 lookup 807\n101: from all fwmark 0x9332/0xff00 lookup 807\n102: from all fwmark 0x1234 lookup 807\n103: from all lookup 254\n' });
  run(f, 'sf_pep_listener() { return 0; }; sf_clear_dead_pep'); assert.equal(f.get('actions'), '');
  run(f, 'sf_pep_listener() { return 1; }; sf_clear_dead_pep');
  assert.match(f.get('actions'), /nft delete table ip connectify_pep/);
  assert.match(f.get('actions'), /ip -4 rule del pref 100 fwmark 0x9332\/0xffffffff table 807/);
  assert.match(f.get('actions'), /ip -4 route del local default dev lo table 807/);
  assert.doesNotMatch(f.get('actions'), /pref 101|pref 102|pref 103|flush|restart/);
});
