'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-connectivity-tests-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let id = 0;
const read = name => fs.readFileSync(path.join(root, 'firmware', name), 'utf8');
function shell(script, env = {}, args = []) {
  const r = spawnSync('busybox', ['sh', '-c', script, 'fixture', ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env }
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout.trim();
}
const radio = read('files/usr/lib/zbt/qmodem-5g.sh').replaceAll('/usr/lib/zbt/', root + '/firmware/files/usr/lib/zbt/');
function radioFixture(mode = '0', rat = 'AUTO') {
  const dir = path.join(tmp, String(++id)); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'nr5g_disable_mode'), mode);
  fs.writeFileSync(path.join(dir, 'mode_pref'), rat);
  return { dir, env: { DB: dir }, mock: `
manufacturer=Quectel
at_port=/dev/ttyMODEM1
zbt_5g_target() { [ "$at_port" = /dev/ttyMODEM1 ]; }
at() {
  printf '%s %s\\n' "$1" "$2" >> "$DB/commands"
  local key value
  key=$(printf '%s' "$2" | cut -d '"' -f2)
  case "$2" in
    *,*)
      value=\${2##*,}
      if [ "$FAIL_WRITE" = "$key:$value" ]; then echo ERROR; return 0; fi
      printf '%s' "$value" > "$DB/$key"
      echo OK ;;
    *)
      if [ "$FAIL_READ" = "$key" ]; then echo '+CME ERROR: 3'; return 0; fi
      printf '+QNWPREFCFG: "%s","%s"\\r\\nOK\\r\\n' "$key" "$(cat "$DB/$key")" ;;
  esac
}
` };
}
function apply(f, policy, env = {}) {
  const out = shell(radio + f.mock + '\nzbt_5g_apply "$POLICY"; echo "status=$? changed=$zbt_5g_changed $zbt_5g_message"',
    { ...f.env, POLICY: policy, ...env });
  return { out, commands: fs.readFileSync(path.join(f.dir, 'commands'), 'utf8') };
}
test('5G parser accepts actual CRLF/quoted formats but rejects incomplete or contradictory responses', () => {
  for (const reply of ['+QNWPREFCFG: "nr5g_disable_mode",1\\r\\nOK\\r\\n', '+QNWPREFCFG: NR5G_DISABLE_MODE, "1"\\nOK'])
    assert.equal(shell(radio + '\nzbt_5g_parse "$(printf \'%b\' "$REPLY")" nr5g_disable_mode', { REPLY: reply }), '1');
  for (const reply of ['', 'OK', '+QNWPREFCFG: "nr5g_disable_mode",1',
    '+QNWPREFCFG: "nr5g_disable_mode",3\nOK', '+QNWPREFCFG: "nr5g_disable_mode",1\nERROR\nOK',
    '+QNWPREFCFG: "nr5g_disable_mode",1\n+QNWPREFCFG: "nr5g_disable_mode",0\nOK'])
    assert.equal(shell(radio + '\nzbt_5g_parse "$REPLY" nr5g_disable_mode || echo refused', { REPLY: reply }), 'refused');
});

test('5G target validation rejects a stale AT override pointing at the other physical modem', () => {
  const sys = path.join(tmp, String(++id));
  fs.mkdirSync(path.join(sys, 'bus/usb/devices/4-1/4-1:1.2'), { recursive: true });
  fs.mkdirSync(path.join(sys, 'bus/usb/devices/2-1/2-1:1.2'), { recursive: true });
  fs.mkdirSync(path.join(sys, 'class/tty/null'), { recursive: true });
  const target = path.join(sys, 'class/tty/null/device');
  fs.symlinkSync(path.join(sys, 'bus/usb/devices/2-1/2-1:1.2'), target);
  const run = radio + '\nmanufacturer=Quectel; config_section=4_1; at_port=/dev/null; zbt_5g_target && echo valid || echo rejected';
  assert.equal(shell(run, { ZBT_SYSFS: sys }), 'rejected');
  fs.unlinkSync(target);
  fs.symlinkSync(path.join(sys, 'bus/usb/devices/4-1/4-1:1.2'), target);
  assert.equal(shell(run, { ZBT_SYSFS: sys }), 'valid');
});
test('Quectel vendor and formatted SIM numbers work without BusyBox tr character classes', () => {
  const mock = 'tr() { echo "unsupported character classes must not be called" >&2; return 99; }\n';
  for (const vendor of ['Quectel', 'quectel', 'QUECTEL', 'Quectel Wireless Solutions']) {
    assert.equal(shell(mock + radio + '\nmanufacturer="$VENDOR"; zbt_5g_vendor && echo valid', { VENDOR: vendor }), 'valid');
  }
  assert.equal(shell(mock + radio + '\nmanufacturer=Fibocom; zbt_5g_vendor || echo refused'), 'refused');
  const number = read('files/usr/lib/zbt/qmodem-cell-discovery.sh');
  assert.equal(shell(mock + number + '\nzbt_quectel_normalize_number " +1 (555) 012-3456 "'), '+15550123456');
});
test('Automatic preferred repairs old NSA plus NR-only settings without carrier guessing or band writes', () => {
  const f = radioFixture('1', 'NR5G'); const { out, commands } = apply(f, 'auto_preferred');
  assert.match(out, /status=0 changed=1/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), 'AUTO');
  assert.equal(fs.readFileSync(path.join(f.dir, 'nr5g_disable_mode'), 'utf8'), '0');
  assert.doesNotMatch(commands, /CIMI|band|ttyMODEM2/);
  assert.ok(commands.indexOf('"mode_pref",AUTO') < commands.indexOf('"nr5g_disable_mode",0'));
});
test('NSA enables LTE anchor before disabling SA and only touches the selected modem', () => {
  const f = radioFixture('0', 'NR5G'); const { out, commands } = apply(f, 'nsa');
  assert.match(out, /status=0 changed=1/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), 'LTE:NR5G');
  assert.ok(commands.indexOf('"mode_pref",LTE:NR5G') < commands.indexOf('"nr5g_disable_mode",1'));
  assert.doesNotMatch(commands, /band|ttyMODEM2/);
});
test('already-active policy performs no modem write', () => {
  for (const [mode, rat, policy] of [['0', 'AUTO', 'auto'], ['0', 'AUTO', 'auto_adaptive'], ['1', 'LTE:NR5G', 'nsa'], ['2', 'AUTO', 'sa']]) {
    const { out, commands } = apply(radioFixture(mode, rat), policy);
    assert.match(out, /status=0 changed=0/);
    assert.doesNotMatch(commands, /",/);
  }
});
test('already-automatic deployment preserves every accepted Allowed Network Types selection', () => {
  for (const policy of ['auto', 'auto_preferred', 'auto_adaptive']) {
    for (const rat of ['AUTO', 'LTE', 'NR5G', 'WCDMA', 'LTE:NR5G', 'NR5G:LTE', 'WCDMA:LTE', 'WCDMA:NR5G', 'WCDMA:LTE:NR5G']) {
      const f = radioFixture('0', rat);
      const { out, commands } = apply(f, policy);
      assert.match(out, /status=0 changed=0/);
      assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), rat);
      assert.doesNotMatch(commands, /",/, `${policy}/${rat} must not write a modem setting`);
    }
  }
});
test('leaving explicit SA or NSA for automatic restores AUTO before clearing the deployment selector', () => {
  for (const mode of ['1', '2']) for (const policy of ['auto', 'auto_preferred', 'auto_adaptive']) {
    const f = radioFixture(mode, 'LTE');
    const { out, commands } = apply(f, policy);
    assert.match(out, /status=0 changed=1/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), 'AUTO');
    assert.equal(fs.readFileSync(path.join(f.dir, 'nr5g_disable_mode'), 'utf8'), '0');
    assert.ok(commands.indexOf('"mode_pref",AUTO') < commands.indexOf('"nr5g_disable_mode",0'));
    assert.doesNotMatch(commands, /band|ttyMODEM2/);
  }
});
test('manual SA preserves NR-capable RAT choices and repairs an incompatible LTE-only choice', () => {
  for (const rat of ['AUTO', 'NR5G', 'LTE:NR5G', 'WCDMA:LTE:NR5G']) {
    const f = radioFixture('0', rat);
    const { out, commands } = apply(f, 'sa');
    assert.match(out, /status=0 changed=1/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), rat);
    assert.doesNotMatch(commands, /"mode_pref",/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'nr5g_disable_mode'), 'utf8'), '2');
  }
  const f = radioFixture('0', 'LTE');
  const { out, commands } = apply(f, 'sa');
  assert.match(out, /status=0 changed=1/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), 'NR5G');
  assert.ok(commands.indexOf('"mode_pref",NR5G') < commands.indexOf('"nr5g_disable_mode",2'));
  const rollback = radioFixture('0', 'LTE');
  assert.match(apply(rollback, 'sa', { FAIL_WRITE: 'nr5g_disable_mode:2' }).out, /status=1.*Previous settings restored/);
  assert.equal(fs.readFileSync(path.join(rollback.dir, 'mode_pref'), 'utf8'), 'LTE');
  assert.equal(fs.readFileSync(path.join(rollback.dir, 'nr5g_disable_mode'), 'utf8'), '0');
});
test('automatic is the fallback and adaptive mode requires an explicit persistent opt-in marker', () => {
  const script = radio + `
config_section=4_1
uci() {
  [ "$1" != -q ] || shift
  case "$1" in
    get) [ "$2" != qmodem.4_1.zbt_5g_policy ] || printf '%s\\n' "$SAVED" ;;
    set) printf '%s\\n' "$2" ;;
    delete) printf 'delete %s\\n' "$2" ;;
    commit) printf 'commit %s\\n' "$2" ;;
  esac
}
printf 'policy=%s\\n' "$(zbt_5g_policy)"
zbt_remember_5g_policy auto_adaptive
zbt_remember_5g_policy auto`;
  const output = shell(script, { SAVED: 'legacy-or-unknown' });
  assert.match(output, /^policy=auto$/m);
  assert.match(output, /qmodem\.4_1\.zbt_5g_policy=auto_adaptive/);
  assert.match(output, /qmodem\.4_1\.zbt_5g_adaptive_opt_in=1/);
  assert.match(output, /qmodem\.4_1\.zbt_5g_policy=auto/);
  assert.match(output, /delete qmodem\.4_1\.zbt_5g_adaptive_opt_in/);
});
test('failed reads retry without writing; failed mode write restores prior RAT and selector', () => {
  for (const key of ['nr5g_disable_mode', 'mode_pref']) {
    const f = radioFixture(); const { out, commands } = apply(f, 'nsa', { FAIL_READ: key });
    assert.match(out, /status=1 changed=0/); assert.doesNotMatch(commands, /",/);
    assert.equal(commands.split('\n').filter(line => line.endsWith('"' + key + '"')).length, 2);
  }
  const f = radioFixture('0', 'NR5G');
  const { out } = apply(f, 'nsa', { FAIL_WRITE: 'nr5g_disable_mode:1' });
  assert.match(out, /status=1.*Previous settings restored/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'mode_pref'), 'utf8'), 'NR5G');
  assert.equal(fs.readFileSync(path.join(f.dir, 'nr5g_disable_mode'), 'utf8'), '0');
});
test('compiled RPC and pre-dial path both use the shared radio transaction', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const tree = process.env.QMODEM_TEST_TREE;
  const rpc = fs.readFileSync(path.join(tree, 'application/qmodem/files/usr/libexec/rpcd/qmodem'), 'utf8');
  const dial = fs.readFileSync(path.join(tree, 'application/qmodem/files/usr/share/qmodem/modem_dial.sh'), 'utf8');
  assert.match(rpc, /\. \/usr\/lib\/zbt\/qmodem-5g\.sh/);
  assert.doesNotMatch(rpc, /310260/);
  assert.match(dial, /zbt-qmodem-performance-policy apply "\$modem_config"/);
  assert.match(read('files/usr/sbin/zbt-qmodem-performance-policy'), /use_ubus_flag=-u/);
});
test('full kept-config routing preset preserves 200/210, repairs named WAN zones, and never uses speed overrides', () => {
  const dir = path.join(tmp, String(++id)); fs.mkdirSync(dir);
  for (const [key, value] of Object.entries({
    'network.4_1': 'interface', 'network.2_1': 'interface',
    'qmodem.4_1': 'modem-device', 'qmodem.2_1': 'modem-device',
    'qmodem.4_1.metric': '0', 'qmodem.2_1.metric': '0',
    'firewall.wanzone': 'zone', 'firewall.wanzone.name': 'wan', 'firewall.wanzone.network': '2_1'
  })) fs.writeFileSync(path.join(dir, key), value);
  const mock = `
uci() {
  local cmd key val entry
  [ "$1" != -q ] || shift
  cmd=$1; key=$2
  case "$cmd" in
    get) [ -f "$DB/$key" ] && cat "$DB/$key" ;;
    set) printf '%s' "\${key#*=}" > "$DB/\${key%%=*}" ;;
    delete) rm -f "$DB/$key" ;;
    add_list) val=\${key#*=}; key=\${key%%=*}; printf ' %s' "$val" >> "$DB/$key" ;;
    show) for entry in "$DB/$key".*; do
      [ -f "$entry" ] && printf '%s=%s\\n' "\${entry##*/}" "$(cat "$entry")"
      done ;;
    commit) : ;;
  esac
}
logger() { :; }
`;
  shell(mock + read('files/usr/sbin/zbt-mwan-preset'), { DB: dir, ZBT_MWAN_NO_RELOAD: '1' }, ['failover']);
  for (const pkg of ['network', 'qmodem']) {
    assert.equal(fs.readFileSync(path.join(dir, pkg + '.4_1.metric'), 'utf8'), '200');
    assert.equal(fs.readFileSync(path.join(dir, pkg + '.2_1.metric'), 'utf8'), '210');
  }
  for (const policy of ['failover', 'balanced']) {
    assert.equal(fs.readFileSync(path.join(dir, 'mwan3.' + policy + '_4_1.metric'), 'utf8'), '4');
    assert.equal(fs.readFileSync(path.join(dir, 'mwan3.' + policy + '_2_1.metric'), 'utf8'), '5');
  }
  assert.equal(fs.readFileSync(path.join(dir, 'firewall.wanzone.network'), 'utf8'), '2_1 4_1 4_1v6 2_1v6');
  assert.equal(fs.readFileSync(path.join(dir, 'mwan3.failover6.use_member'), 'utf8').trim(), 'failover6_4_1v6 failover6_2_1v6');
  assert.equal(fs.readFileSync(path.join(dir, 'mwan3.4_1v6.family'), 'utf8'), 'ipv6');
  assert.equal(shell(read('files/usr/lib/zbt/mwan3-speed-metric.sh') + '\nzbt_speed_metric failover_2_1 2_1 5'), '5');
  assert.doesNotMatch(read('files/usr/lib/zbt/mwan3-speed-metric.sh'), /\/tmp\/|expiry/);
});
test('Speedify RPC separates lifecycle control from native account activation', () => {
  const dir = path.join(tmp, String(++id)); fs.mkdirSync(dir);
  const cli = path.join(dir, 'cli');
  fs.writeFileSync(cli, '#!/bin/sh\nif [ "$1" = state ]; then printf \'%s\\n\' "$STATE"; else printf \'%s\\n\' "$REPLY"; fi\nexit ${CLI_EXIT:-0}\n', { mode: 0o755 });
  const rpc = 'uci() { echo 1; }\n' + read('files/usr/libexec/rpcd/zbt.speedify').replace('/usr/share/speedify/speedify_cli', cli);
  const call = (method, reply, code = '0', state = 'LOGGED_IN') => JSON.parse(shell(rpc, { REPLY: JSON.stringify(reply), STATE: JSON.stringify({ state }), CLI_EXIT: code }, ['call', method]));
  assert.equal(call('status', { isAutoAccount: true, email: 'auto' }).signed_in, false);
  assert.equal(call('status', { isAutoAccount: true, email: '' }, '0', 'LOGGING_IN').activation_status, 'pending');
  assert.equal(call('status', { isAutoAccount: false, email: 'test@example.invalid' }).signed_in, true);
  assert.equal(call('status', { isAutoAccount: false, email: 'test@example.invalid' }, '0', 'LOGGED_OUT').signed_in, false);
  assert.equal(call('status', { isAutoAccount: false, email: 'test@example.invalid', bytesAvailable: 0 }, '0', 'CONNECTED').signed_in, true, 'zero/unlimited quota is not proof of logout');
  assert.equal(call('status', {}).ok, false);
  assert.equal(call('status', {}, '1').ok, false);
  assert.deepEqual(JSON.parse(shell(rpc, {}, ['list'])), { status: {}, set_enabled: { enabled: 'Boolean' } });
  assert.doesNotMatch(rpc, /activationcode|activationUrl/);
});
test('Speedify error diagnostics return fixed categories, not log credentials, and suppress old errors after sign-in', () => {
  const dir = path.join(tmp, String(++id)); fs.mkdirSync(dir);
  const cli = path.join(dir, 'cli');
  fs.writeFileSync(cli, '#!/bin/sh\nif [ "$1" = state ]; then echo "$STATE"; else echo "$ACCOUNT"; fi\n', { mode: 0o755 });
  const log = path.join(dir, 'speedify_20260913.log');
  const rpc = ('uci() { echo 1; }\n' + read('files/usr/libexec/rpcd/zbt.speedify')).replace('/usr/share/speedify/speedify_cli', cli)
    .replace('/tmp/speedify-logs', dir).replace('/sys/class/net/connectify0', dir + '/no-tunnel');
  for (const error of ['ERROR_NO_ROUTER_LICENSE', 'NETWORK_ERROR', 'AUTHENTICATION_FAILED']) {
    fs.writeFileSync(log, 'activation_url=https://example.invalid/?token=private-fixture\nNot able to login: ' + error + ' token=private-fixture\n');
    const out = shell(rpc, { STATE: '{"state":"LOGGED_OUT"}', ACCOUNT: '{"isAutoAccount":false,"email":""}' }, ['call', 'status']);
    assert.equal(JSON.parse(out).recent_error, error);
    if (error === 'ERROR_NO_ROUTER_LICENSE') assert.equal(JSON.parse(out).activation_status, 'license_pending');
    assert.doesNotMatch(out, /private-fixture|activation_url|https:/);
  }
  const signed = JSON.parse(shell(rpc, { STATE: '{"state":"LOGGED_IN"}', ACCOUNT: '{"isAutoAccount":false,"email":"test@example.invalid","bytesAvailable":0}' }, ['call', 'status']));
  assert.equal(signed.signed_in, true); assert.equal(signed.tunnel_present, false); assert.equal(signed.recent_error, '');
  assert.equal(signed.activation_status, 'confirmed');
});
