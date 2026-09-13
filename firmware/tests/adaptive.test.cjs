'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-adaptive-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const read = p => fs.readFileSync(path.join(root, 'firmware/files', p), 'utf8');
const adaptive = read('usr/lib/zbt/5g-adaptive.sh').replaceAll('/usr/sbin/mwan3', 'mwan3').replaceAll('/usr/sbin/zbt-speed-sample', 'sample');
const state = read('usr/lib/zbt/5g-state.sh');
const mwan = read('usr/lib/zbt/mwan-runtime.sh').replaceAll('/usr/sbin/mwan3', 'mwan3');
function shell(script, env = {}) {
  const result = spawnSync('busybox', ['sh', '-c', script], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}
function fixture(env = {}) {
  const dir = path.join(tmp, String(++serial)); fs.mkdirSync(dir);
  return { dir, env: { DB: dir, ZBT_5G_USAGE: dir, ZBT_5G_STATE: dir, ...env } };
}
const sa = '+QENG: "servingcell","NOCONN","NR5G-SA","TDD",310,260,1234,495,0123,520110,41,100,-101,-11,18,1,-\r\nOK\r\n';
const nsa = '+QENG: "servingcell","CONNECT"\r\n+QENG: "LTE","FDD",310,260,1234,20,675,2,15,15,123,-100,-10,-75,10,9,0,-\r\n+QENG: "NR5G-NSA",310,260,400,-90,16,-10,520110,41,100,1\r\nOK\r\n';
test('serving-cell parser requires real registered SA/NSA and valid signals; never accepts LTE/SEARCH/invalid NSA placeholders', () => {
  for (const [reply, expected] of [[sa, 'sa -101 18'], [nsa, 'nsa -90 16']])
    assert.equal(shell(adaptive + '\nzbt_adaptive_serving_parse "$REPLY"', { REPLY: reply }), expected);
  for (const reply of [sa.replace('OK', 'ERROR'), sa.replace('NOCONN', 'SEARCH'), sa.replace('NR5G-SA', 'LTE'), nsa.replace('-90,16', '-32768,-32768'), 'OK', sa + nsa])
    assert.equal(shell(adaptive + '\nzbt_adaptive_serving_parse "$REPLY" || echo rejected', { REPLY: reply }), 'rejected');
});
test('capability query requires complete explicit support for selector 0,1,2', () => {
  for (const modes of ['(0,1,2)', '(0-2)'])
    assert.equal(shell(adaptive + '\nat() { printf \'%s\\n\' "$REPLY"; }; zbt_adaptive_capable && echo supported', { REPLY: '+QNWPREFCFG: "nr5g_disable_mode",' + modes + '\nOK' }), 'supported');
  assert.equal(shell(adaptive + '\nat() { echo ERROR; }; zbt_adaptive_capable || echo deferred'), 'deferred');
});
test('background adaptive testing is impossible without an explicit per-modem opt-in', () => {
  const output = shell(adaptive + `
config_section=4_1
zbt_5g_policy() { echo auto_adaptive; }
uci() {
  [ "$1" != -q ] || shift
  [ "$1" = get ] || return 1
  case "$2" in
    qmodem.4_1.zbt_5g_adaptive_opt_in) echo "$OPT_IN" ;;
    qmodem.main.enable_dial|qmodem.4_1.enable_dial) echo 1 ;;
    qmodem.4_1.state) echo enabled ;;
    qmodem.4_1.en_bridge) echo 0 ;;
  esac
}
OPT_IN=0; zbt_adaptive_enabled && echo unexpected || echo blocked
OPT_IN=1; zbt_adaptive_enabled && echo enabled`);
  assert.equal(output, 'blocked\nenabled');
});
test('measurement rejects unstable/failed values and requires all three candidate samples to improve 15%', () => {
  const f = fixture();
  for (const [scores, valid] of [[[100, 102, 110], true], [[100, 101, 300], false], [[0, 100, 101], false], [[100, 100], false]]) {
    fs.writeFileSync(path.join(f.dir, 'scores'), JSON.stringify(scores));
    assert.equal(shell(adaptive + '\nzbt_adaptive_scores "$DB/scores" >/dev/null && echo yes || echo no', f.env), valid ? 'yes' : 'no');
  }
  assert.equal(shell(adaptive + '\nzbt_adaptive_better 100 114.9 && echo yes || echo no'), 'no');
  assert.equal(shell(adaptive + '\nzbt_adaptive_better 100 115 && echo yes || echo no'), 'yes');
});
test('persistent test reservation enforces hourly and 24h limits, survives restarts, respects zero budget and clock rollback', () => {
  const f = fixture();
  const run = (now, budget = '300') => shell(adaptive + `
config_section=4_1
date() { echo "$NOW"; }
uci() { echo "$BUDGET"; }
zbt_adaptive_reserve && echo reserved || echo deferred`, { ...f.env, NOW: String(now), BUDGET: budget });
  assert.equal(run(1800000000), 'reserved');
  assert.equal(run(1800000100), 'deferred');
  assert.equal(run(1800003600), 'reserved');
  assert.equal(run(1800007200), 'deferred');
  assert.equal(run(1799999999), 'deferred');
  assert.equal(run(1800086401, '0'), 'deferred');
  assert.equal(run(1800086401), 'reserved');
  fs.writeFileSync(path.join(f.dir, '5g-adaptive-4_1.json'), 'not json');
  assert.equal(run(1800172802), 'deferred');
});
test('runtime hint and rollback journal never become a persistent manual policy', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.dir, '4_1'));
  const run = () => shell(state + '\nconfig_section=4_1; zbt_5g_hint', f.env);
  assert.equal(run(), 'auto');
  fs.writeFileSync(path.join(f.dir, '4_1/verified'), 'nsa'); assert.equal(run(), 'nsa');
  fs.writeFileSync(path.join(f.dir, '4_1/rollback'), 'auto'); assert.equal(run(), 'auto');
  fs.writeFileSync(path.join(f.dir, '4_1/rollback'), 'bad-command'); assert.equal(run(), 'auto');
});
function round(options = {}) {
  const f = fixture(options);
  const mock = `
config_section=4_1; zbt_5g_dir="$DB"; adaptive_device=wwan8
zbt_adaptive_enabled() { [ "$MANUAL" != 1 ]; }
zbt_adaptive_recovery_stable() { [ "$UNSTABLE" != 1 ]; }
zbt_mwan_online() { [ "$OFFLINE" != 1 ]; }
zbt_adaptive_probe() { :; }
zbt_adaptive_serving() { echo "\${BASE_MODE:-sa} -90 16"; }
zbt_adaptive_capable() { [ "$UNSUPPORTED" != 1 ]; }
zbt_5g_hint() { echo auto; }
zbt_5g_policy() { echo auto_adaptive; }
zbt_5g_value() { echo 0; }
zbt_5g_read() { zbt_5g_read_value=0; [ "$1" != mode_pref ] || zbt_5g_read_value=AUTO; }
zbt_adaptive_idle() { [ "$BUSY" != 1 ]; }
zbt_adaptive_trial_safe() { [ "$NO_BACKUP" != 1 ]; }
zbt_mwan_now() { echo 1000; }
uci() { [ "$IPV6" != 1 ] || echo 1; }
ip() { [ "$IPV6" != 1 ] || echo '17: wwan8 inet6 2001:db8::1/64 scope global'; }
zbt_adaptive_reserve() { [ "$BUDGET" != 0 ]; }
zbt_adaptive_samples() {
  printf '%s\\n' "sample $1" >> "$DB/calls"
  case "$2" in
    */baseline.json) [ "$BAD_BASE" != 1 ] || return 1; echo '[100,101,102]' > "$2" ;;
    *) [ "$BAD_CANDIDATE" != 1 ] || return 1; printf '%s' "\${SCORES:-[130,131,132]}" > "$2" ;;
  esac
}
mwan3() { printf '%s\\n' "tracker $*" >> "$DB/calls"; }
zbt_5g_apply() {
  printf '%s\\n' "apply $1" >> "$DB/calls"
  [ "$1" != "$FAIL_WRITE" ]
}
zbt_adaptive_wait_data() {
  printf '%s\\n' "verify $1" >> "$DB/calls"
  [ "$1" != "$NO_REGISTER" ]
}
zbt_adaptive_resume() { echo resume >> "$DB/calls"; }
zbt_adaptive_round || true
cat "$DB/status"
`;
  const output = shell(adaptive + mock, f.env);
  return { ...f, output, calls: fs.existsSync(path.join(f.dir, 'calls')) ? fs.readFileSync(path.join(f.dir, 'calls'), 'utf8') : '' };
}
test('successful comparison selects measured NSA or SA, journals before changes and resumes only the selected tracker', () => {
  for (const [base, winner] of [['sa', 'nsa'], ['nsa', 'sa']]) {
    const f = round({ BASE_MODE: base });
    assert.match(f.output, new RegExp('Verified ' + winner));
    assert.equal(fs.readFileSync(path.join(f.dir, 'verified'), 'utf8').trim(), winner);
    assert.equal(fs.existsSync(path.join(f.dir, 'rollback')), false);
    assert.equal(fs.existsSync(path.join(f.dir, 'maintenance')), false);
    assert.equal(f.calls, `sample ${base}\ntracker ifdown 4_1\napply ${winner}\nverify ${winner}\nsample ${winner}\nresume\n`);
  }
});
test('IPv6-enabled trials withdraw both families before a radio write and do not resume before sampling',()=>{
  const f=round({IPV6:'1'});
  assert.match(f.calls,/tracker ifdown 4_1\ntracker ifdown 4_1v6\napply nsa/);
  assert.match(f.calls,/verify nsa\nsample nsa\nresume/);
});
test('losing the backup before a mode change prevents applying the candidate',()=>{
  const f=round({NO_BACKUP:'1'});
  assert.doesNotMatch(f.calls,/apply nsa/);
  assert.match(f.calls,/apply auto\nverify any\nresume/);
});
test('readiness failure does not install the failed-trial cooldown',()=>{
  for(const env of [{OFFLINE:'1'},{UNSTABLE:'1'},{BUSY:'1'},{UNSUPPORTED:'1'}]) {
    const f=round(env);
    assert.equal(fs.existsSync(path.join(f.dir,'attempt')),false);
  }
});
test('IPv4 backup alone is insufficient when the tested modem has IPv6',()=>{
  const out=shell(adaptive.replaceAll('/usr/sbin/zbt-mwan-standby-ready','standby')+`
config_section=4_1; adaptive_ipv6=1
zbt_adaptive_backup() { :; }
zbt_mwan_online() { [ "$1" = 2_1v6 ]; }
standby() { [ "$READY6" = 1 ]; }
READY6=0; zbt_adaptive_trial_safe && echo unsafe || echo deferred
READY6=1; zbt_adaptive_trial_safe && echo ready`);
  assert.equal(out,'deferred\nready');
});
test('candidate reconnection aborts promptly when backup is lost, but rollback still attempts recovery',()=>{
  const out=shell(adaptive+`
zbt_speed_renew() { :; }; zbt_adaptive_device() { :; }; zbt_adaptive_enabled() { :; }
zbt_adaptive_trial_safe() { return 1; }; zbt_adaptive_probe() { echo unexpected; return 1; }
zbt_adaptive_wait_data nsa || echo aborted`);
  assert.equal(out,'aborted');
});
test('adaptive command execution uses MWAN socket bypass, not just a source IP',()=>{
  const out=shell(adaptive+`
config_section=2_1
mwan3() { printf '%s\\n' "$*"; }
zbt_adaptive_exec curl --interface if!wwan3 https://www.gstatic.com/generate_204`);
  assert.equal(out,'use 2_1 curl --interface if!wwan3 https://www.gstatic.com/generate_204');
});
test('failed write, missing 5G registration, failed sample or insufficient improvement restores verified automatic', () => {
  for (const env of [{ FAIL_WRITE: 'nsa' }, { NO_REGISTER: 'nsa' }, { BAD_CANDIDATE: '1' }, { SCORES: '[101,102,103]' }]) {
    const f = round(env);
    assert.match(f.calls, /apply auto\nverify any\nresume/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'verified'), 'utf8').trim(), 'auto');
    assert.equal(fs.existsSync(path.join(f.dir, 'rollback')), false);
  }
});
test('manual policy, unstable/no Internet, unreadable capabilities, busy traffic, quota and bad baseline never write radio settings', () => {
  for (const env of [{ MANUAL: '1' }, { OFFLINE: '1' }, { UNSTABLE: '1' }, { UNSUPPORTED: '1' }, { BUSY: '1' }, { BUDGET: '0' }, { BAD_BASE: '1' }]) {
    const f = round(env); assert.doesNotMatch(f.calls, /apply|tracker/);
  }
});
test('failed rollback is not marked verified and its journal remains for supervised recovery', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.dir, 'rollback'), 'nsa');
  const output = shell(adaptive + `
zbt_5g_dir="$DB"; config_section=4_1
zbt_5g_policy() { echo auto_adaptive; }
zbt_speed_renew() { :; }
zbt_5g_apply() { echo "apply $1"; }
zbt_adaptive_wait_data() { return 1; }
mwan3() { :; }
zbt_adaptive_resume() { return 1; }
zbt_adaptive_restore || true
cat "$DB/status"`, f.env);
  assert.match(output, /apply nsa\napply auto/);
  assert.match(output, /not yet verified/);
  assert.equal(fs.existsSync(path.join(f.dir, 'rollback')), true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'rollback'), 'utf8').trim(), 'auto', 'failed rollback must not oscillate SA/NSA on every retry');
  assert.equal(fs.existsSync(path.join(f.dir, 'verified')), false);
});
test('full five-WAN priority is deterministic and ignores stale, paused or offline tracker results', () => {
  const f = fixture(); const order = ['wan_sfp', 'wan', 'usb_tether', '4_1', '2_1'];
  for (let unavailable = 0; unavailable < order.length; unavailable++) {
    for (const [i, name] of order.entries()) {
      const dir = path.join(f.dir, name); fs.mkdirSync(dir, { recursive: true });
      for (const [key, value] of Object.entries({ STATUS: i < unavailable ? 'offline' : 'online', STARTED: '1', TIME: '1000', PID: String(process.pid) }))
        fs.writeFileSync(path.join(dir, key), value);
    }
    assert.equal(shell(mwan + '\nuci() { echo 1; }; zbt_mwan_now() { echo 1010; }; zbt_mwan_winner', { ...f.env, ZBT_MWAN_TRACK: f.dir }), order[unavailable]);
  }
  fs.writeFileSync(path.join(f.dir, '2_1/TIME'), '900');
  assert.equal(shell(mwan + '\nuci() { echo 1; }; zbt_mwan_now() { echo 1010; }; zbt_mwan_winner || echo none', { ...f.env, ZBT_MWAN_TRACK: f.dir }), 'none');
});
test('post-address refresh re-arms only the physical modem tracker, throttles paused retries, and rejects wrong ownership', () => {
  const f = fixture();
  const out = shell(mwan + `
uci() { case "$*" in *mwan3*) echo 1 ;; *) echo 4_1 ;; esac; }
zbt_netdev() { echo wwan8; }
TEST_CLOCK=100; zbt_mwan_now() { echo "$TEST_CLOCK"; }
mwan3() { echo "$*" >> "$DB/calls"; }
zbt_mwan_refresh 4_1 wwan8 192.0.0.2/27
zbt_mwan_refresh 4_1 wwan8 192.0.0.2/27
TEST_CLOCK=161; zbt_mwan_refresh 4_1 wwan8 192.0.0.2/27
TEST_CLOCK=162; zbt_mwan_refresh 4_1 wwan8 192.0.0.2/27 new-session
TEST_CLOCK=163; zbt_mwan_refresh 4_1 wwan8 192.0.0.2
TEST_CLOCK=222; zbt_mwan_refresh 4_1 wwan3 192.0.0.2/27 || true
cat "$DB/calls"
`, { ...f.env, ZBT_MWAN_REFRESH: f.dir, ZBT_MWAN_TRACK: f.dir });
  assert.equal(out, 'ifup 4_1\nifup 4_1');
});
test('actual sample collector checks modem binding, address stability, traffic contamination and serving mode for every download', () => {
  for (const [env, expected] of [[{}, 'accepted'], [{ WRONG_DEVICE: '1' }, 'rejected'], [{ EXTRA_TRAFFIC: '1' }, 'rejected'], [{ LOST_IP: '1' }, 'rejected'], [{ LTE_FALLBACK: '1' }, 'rejected']]) {
    const f = fixture(env);
    const out = shell(adaptive + `
config_section=4_1; adaptive_device=wwan8
echo 0 > "$DB/bytes"
zbt_adaptive_enabled() { :; }; zbt_speed_renew() { :; }; zbt_mwan_online() { :; }
zbt_adaptive_trial_safe() { :; }; zbt_adaptive_exec() { "$@"; }
sleep() { :; }
zbt_adaptive_address() { [ "$LOST_IP" != 1 ] || [ ! -f "$DB/downloaded" ] || return 1; echo 192.0.0.2/27; }
zbt_adaptive_serving() { [ "$LTE_FALLBACK" != 1 ] || [ ! -f "$DB/downloaded" ] || return 1; echo 'sa -90 16'; }
zbt_adaptive_bytes() { cat "$DB/bytes"; }
sample() {
  [ "$1:$2" = 4_1:download ] || return 1
  touch "$DB/downloaded"
  local amount=26000000 dev=wwan8
  [ "$EXTRA_TRAFFIC" != 1 ] || amount=50000000
  [ "$WRONG_DEVICE" != 1 ] || dev=wwan3
  echo "$(( $(cat "$DB/bytes") + amount ))" > "$DB/bytes"
  printf '{"ok":true,"interface":"4_1","device":"%s","download_mbps":120}' "$dev"
}
zbt_adaptive_samples sa "$DB/scores" && echo accepted || echo rejected`, f.env);
    assert.equal(out, expected);
  }
});
test('adaptive reachability requires exact HTTPS 204 and binds the selected device, never follows a portal redirect', () => {
  for (const [code, expected] of [['204', 'yes'], ['200', 'no'], ['302', 'no'], ['000', 'no']]) {
    const f = fixture({ CODE: code });
    const out = shell(adaptive + `
adaptive_device=wwan8
zbt_adaptive_exec() { "$@"; }
zbt_adaptive_address() { echo 192.0.0.2/27; }
curl() { printf '%s\\n' "$*" > "$DB/curl"; echo "$CODE"; }
zbt_adaptive_probe && echo yes || echo no`, f.env);
    assert.equal(out, expected);
    assert.match(fs.readFileSync(path.join(f.dir, 'curl'), 'utf8'), /--interface if!wwan8.*https:\/\/www.gstatic.com\/generate_204/);
    assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'curl'), 'utf8'), /--location| -L /);
  }
});
test('radio lock excludes another process and is released on process exit', () => {
  const f = fixture();
  const lib = path.join(f.dir, 'state.sh'); fs.writeFileSync(lib, state);
  const out = shell(state + `
config_section=4_1
zbt_5g_lock || exit 1
busybox sh -c '. "$DB/state.sh"; config_section=4_1; zbt_5g_lock && echo unsafe || echo locked'
zbt_5g_unlock
busybox sh -c '. "$DB/state.sh"; config_section=4_1; zbt_5g_lock && echo available'
`, f.env);
  assert.equal(out, 'locked\navailable');
});
test('reconnection probes can wake idle NSA; candidate still requires two consecutive post-probe NR verifications', () => {
  const f = fixture();
  const out = shell(adaptive + `
zbt_speed_renew() { :; }; zbt_adaptive_device() { :; }; sleep() { :; }
zbt_adaptive_enabled() { :; }; zbt_adaptive_trial_safe() { :; }
zbt_adaptive_probe() { touch "$DB/active"; echo probe >> "$DB/calls"; }
zbt_adaptive_serving() { [ -f "$DB/active" ] || return 1; echo 'nsa -90 16'; }
zbt_adaptive_wait_data nsa && echo verified
cat "$DB/calls"
`, f.env);
  assert.equal(out, 'verified\nprobe\nprobe');
  assert.equal(shell(adaptive + `
zbt_speed_renew() { :; }; zbt_adaptive_device() { :; }; sleep() { :; }
zbt_adaptive_enabled() { :; }; zbt_adaptive_trial_safe() { :; }
zbt_adaptive_probe() { :; }; zbt_adaptive_serving() { return 1; }
zbt_adaptive_wait_data nsa && echo unsafe || echo rejected`, f.env), 'rejected');
});
