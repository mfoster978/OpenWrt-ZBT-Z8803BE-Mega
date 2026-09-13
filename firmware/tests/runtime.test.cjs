'use strict';
// Host-side regression tests. Hardware, SIM registration and flashability
// are explicitly outside these tests; all device/AT/HTTP calls are mocked.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zbt-runtime-tests-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let counter = 0;
const file = p => fs.readFileSync(path.join(root, p), 'utf8');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function sandbox() {
  const p = path.join(temporary, String(++counter));
  fs.mkdirSync(p);
  return p;
}
function source(p) {
  return file(p).replaceAll('/usr/lib/zbt/', root + '/firmware/files/usr/lib/zbt/');
}
function shell(script, env = {}, args = []) {
  const r = spawnSync('busybox', ['sh', '-c', script, 'test', ...args], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env }
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  return r.stdout.trim();
}
function usbFixture() {
  const dir = sandbox(), sys = path.join(dir, 'sys');
  for (const [usb, net, tty] of [['4-1', 'wwan8', 'ttyUSB6'], ['2-1', 'wwan3', 'ttyUSB2']]) {
    const device = path.join(sys, 'devices', usb);
    fs.mkdirSync(path.join(device, usb + ':1.4/net', net), { recursive: true });
    fs.mkdirSync(path.join(device, usb + ':1.2', tty), { recursive: true });
    fs.mkdirSync(path.join(sys, 'bus/usb/devices'), { recursive: true });
    fs.symlinkSync(device, path.join(sys, 'bus/usb/devices', usb));
    fs.mkdirSync(path.join(sys, 'class/tty', tty), { recursive: true });
    fs.symlinkSync(path.join(device, usb + ':1.2', tty), path.join(sys, 'class/tty', tty, 'device'));
  }
  return { dir, sys, env: { ZBT_SYSFS: sys } };
}
const dual = source('firmware/files/usr/lib/zbt/dual-modem.sh');

test('slot mapping follows physical USB paths, not enumeration order', () => {
  const f = usbFixture();
  assert.equal(shell(dual + '\nzbt_netdev 4_1; zbt_netdev 2_1; zbt_slot 2_1; echo "$ZBT_POWER $ZBT_LED"', f.env),
    'wwan8\nwwan3\n5g2 blue:mobile-2');
  assert.equal(shell(dual + '\nzbt_port_matches 4_1 /dev/ttyUSB6 && echo own; zbt_port_matches 4_1 /dev/ttyUSB2 || echo rejected', f.env), 'own\nrejected');
  fs.rmSync(path.join(f.sys, 'devices/2-1/2-1:1.4/net/wwan3'), { recursive: true });
  assert.equal(shell(dual + '\nzbt_netdev 2_1 || echo absent; zbt_netdev 4_1', f.env), 'absent\nwwan8');
  fs.mkdirSync(path.join(f.sys, 'devices/4-1/4-1:1.4/net/wwan9'));
  assert.equal(shell(dual + '\nzbt_netdev 4_1 || echo ambiguous', f.env), 'ambiguous');
});

test('unknown slot or stale AT path is rejected; no fallback to the other modem', () => {
  const f = usbFixture();
  assert.equal(shell(dual + '\nzbt_slot 4_2 || echo unknown; zbt_port_matches 4_1 /dev/ttyUSB99 || echo stale', f.env), 'unknown\nstale');
});

test('blank and auto APNs preserve carrier negotiation, manual APNs stay manual', () => {
  assert.equal(shell(dual + '\nzbt_apn_mode ""; zbt_apn_mode auto; zbt_apn_mode private.example'), 'auto\nauto\nmanual');
  const cmd = dual + '\nuci() { case "$3" in qmodem.2_1.apn) echo "$SIM2_APN";; qmodem.4_1.apn) echo "$SIM1_APN";; esac; }; zbt_dial_fingerprint 4_1; zbt_dial_fingerprint 2_1';
  const a = shell(cmd, { SIM1_APN: '', SIM2_APN: '' }).split('\n');
  const b = shell(cmd, { SIM1_APN: '', SIM2_APN: 'private.operator' }).split('\n');
  assert.equal(a[0], b[0], 'modem2 settings must not alter modem1 service fingerprint');
  assert.notEqual(a[1], b[1]);
});

test('AT&T US gets broadband only in auto mode and manual APNs always win', () => {
  const script = dual + `
at() { printf '%s\\r\\nOK\\r\\n' "$TEST_IMSI"; }
result=$(zbt_effective_apn "$TEST_APN" /dev/ttyUSB-test)
printf '<%s>\\n' "$result"`;
  assert.equal(shell(script, { TEST_IMSI: '310410000000001', TEST_APN: '' }), '<broadband>');
  assert.equal(shell(script, { TEST_IMSI: '310410000000001', TEST_APN: 'auto' }), '<broadband>');
  assert.equal(shell(script, { TEST_IMSI: '310410000000001', TEST_APN: 'mvno.custom' }), '<mvno.custom>');
  assert.equal(shell(script, { TEST_IMSI: '310260123456789', TEST_APN: '' }), '<>');
  assert.equal(shell(script, { TEST_IMSI: 'invalid', TEST_APN: '' }), '<>');
});

test('QModem offers matching editable US APN presets for both SIM selectors', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const sourceText = fs.readFileSync(path.join(process.env.QMODEM_TEST_TREE,
    'luci/luci-app-qmodem-next/htdocs/luci-static/resources/view/qmodem/network_config.js'), 'utf8');
  assert.match(sourceText, /form\.Value, 'apn'/, 'primary APN must remain an editable Value');
  assert.match(sourceText, /form\.Value, 'apn2'/, 'secondary APN must remain an editable Value');
  for (const apn of ['broadband', 'NXTGENPHONE', 'ENHANCEDPHONE', 'firstnet-broadband',
    'fast.t-mobile.com', 'vzwinternet', 'h2g2', 'h2g2-t', 'usccinternet']) {
    const escaped = apn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal((sourceText.match(new RegExp(`o\\.value\\('${escaped}'`, 'g')) || []).length, 2,
      `${apn} must be offered for both physical SIM selectors`);
  }
});

test('QModem reports every Quectel component carrier and distinguishes active from idle SCCs', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const quectel = fs.readFileSync(path.join(process.env.QMODEM_TEST_TREE,
    'application/qmodem/files/usr/share/qmodem/vendor/quectel.sh'), 'utf8');
  const start = quectel.indexOf('add_quectel_ca_report()');
  const end = quectel.indexOf('\ncell_info()', start);
  assert.ok(start >= 0 && end > start);
  const helper = quectel.slice(start, end);
  const result = shell(`
add_plain_info_entry() { printf '%s|%s|%s\\n' "$1" "$2" "$extra_info"; }
get_bandwidth() { [ "$2" = 12 ] && printf '100\\n'; }
${helper}
add_quectel_ca_report "$CA_SAMPLE"`, {
    CA_SAMPLE: '+QCAINFO: "PCC",875,100,"LTE BAND 2",1,10,-90,-8,-60,20\r\n' +
      '+QCAINFO: "SCC",66786,100,"LTE BAND 66",2,11,-91,-9,-61,19,0,-,-\r\n' +
      '+QCAINFO: "SCC",5035,100,"LTE BAND 12",1,12,-92,-10,-62,18,0,-,-\r\n' +
      '+QCAINFO: "SCC",520110,12,"NR5G BAND 41",2,13,1,3,135600\r\nOK\r\n'
  });
  assert.match(result, /Carrier Aggregation\|3 active \/ 4 reported\|/);
  assert.match(result, /Component Carrier 1\|LTE BAND 2; channel 875; bandwidth 20 MHz; PCI 10; registered\|PCC/);
  assert.match(result, /Component Carrier 2\|LTE BAND 66; channel 66786; bandwidth 20 MHz; PCI 11; active\|SCC/);
  assert.match(result, /Component Carrier 3\|LTE BAND 12; channel 5035; bandwidth 20 MHz; PCI 12; configured, idle\|SCC/);
  assert.match(result, /Component Carrier 4\|NR5G BAND 41; channel 520110; bandwidth 100 MHz; PCI 13; active\|SCC/);

  const modernNr = shell(`
add_plain_info_entry() { printf '%s|%s|%s\\n' "$1" "$2" "$extra_info"; }
get_bandwidth() { [ "$2" = 12 ] && printf '100\\n'; }
${helper}
add_quectel_ca_report "$CA_SAMPLE"`, {
    CA_SAMPLE: '+QCAINFO: "PCC",520110,12,"NR5G BAND 41",436,-101,-11,3\r\n' +
      '+QCAINFO: "SCC",125290,3,"NR5G BAND 71",2,709,-102,-12,2\r\nOK\r\n'
  });
  assert.match(modernNr, /Carrier Aggregation\|2 active \/ 2 reported/);
  assert.match(modernNr, /NR5G BAND 41; channel 520110; bandwidth 100 MHz; PCI 436; serving/);
  assert.doesNotMatch(modernNr, /state 436/);
});

const cellDiscovery = source('firmware/files/usr/lib/zbt/qmodem-cell-discovery.sh');
const bandRuntime = source('firmware/files/usr/lib/zbt/quectel-bands.sh');

test('Quectel subscriber number scans the full CNUM response then the Own Numbers phonebook', () => {
  const log = path.join(sandbox(), 'at.log');
  const cnum = shell(cellDiscovery + `
at() {
  printf '%s\\n' "$2" >> "$CALL_LOG"
  case "$2" in
    AT+CNUM) printf 'AT+CNUM\\r\\nnoise\\r\\n+CNUM: "Line 1","+15551234567",145\\r\\nOK\\r\\n' ;;
  esac
}
zbt_quectel_sim_number /dev/ttyTEST`, { CALL_LOG: log });
  assert.equal(cnum, '+15551234567');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'AT+CNUM');

  fs.writeFileSync(log, '');
  const fallback = shell(cellDiscovery + `
at() {
  printf '%s\\n' "$2" >> "$CALL_LOG"
  case "$2" in
    AT+CNUM) printf 'AT+CNUM\\r\\nOK\\r\\n' ;;
    'AT+CPBS?') printf '+CPBS: "SM",3,100\\r\\nOK\\r\\n' ;;
    'AT+CPBS="ON"') printf 'OK\\r\\n' ;;
    'AT+CPBR=?') printf '+CPBR: (1-5),40,20\\r\\nOK\\r\\n' ;;
    'AT+CPBR=1,5') printf '+CPBR: 1,"+15557654321",145,"Own"\\r\\nOK\\r\\n' ;;
    'AT+CPBS="SM"') printf 'OK\\r\\n' ;;
  esac
}
zbt_quectel_sim_number /dev/ttyTEST`, { CALL_LOG: log });
  assert.equal(fallback, '+15557654321');
  assert.match(fs.readFileSync(log, 'utf8'), /AT\+CPBS="ON"[\s\S]*AT\+CPBR=1,5[\s\S]*AT\+CPBS="SM"/);
});

test('Quectel nearby-cell parser keeps LTE/NR scan records and the serving cell', () => {
  const out = shell(cellDiscovery + `
json_select() { :; }
json_add_object() { printf 'object=%s\\n' "$1"; }
json_close_object() { :; }
json_add_string() { printf '%s=%s\\n' "$1" "$2"; }
zbt_quectel_cell_count=0
zbt_quectel_parse_qscan "$QSCAN"
zbt_quectel_parse_serving_cells "$SERVING"
printf 'count=%s\\n' "$zbt_quectel_cell_count"`, {
    QSCAN: '+QSCAN: "LTE",310,260,66786,340,-101,-12\r\n' +
      '+QSCAN: "NR5G",310,260,520110,436,-98,-10,0,30,0,0,0,41\r\nOK\r\n',
    SERVING: '+QENG: "LTE","FDD",310,260,ABC,265,875,2,5,5,310,-96,-9,-62,16\r\n' +
      '+QENG: "NR5G-NSA",310,260,685,-98,-11,18,520110,41,12,30\r\nOK\r\n'
  });
  assert.match(out, /source=Nearby scan[\s\S]*arfcn=66786[\s\S]*pci=340/);
  assert.match(out, /source=Nearby scan[\s\S]*arfcn=520110[\s\S]*pci=436[\s\S]*band=41/);
  assert.match(out, /source=Serving cell/);
  assert.match(out, /count=4/);
});

test('zero SA band reply is informational only when NSA-only mode is verified', () => {
  const out = shell(bandRuntime + `
zbt_port_matches() { return 0; }
uci() {
  case "$4" in
    *gw_band) printf '1/2\\n' ;;
    *lte_band) printf '2/66\\n' ;;
    *sa_band) printf '41/71\\n' ;;
    *nsa_band) printf '41/71\\n' ;;
  esac
}
at() {
  case "$2" in
    *nr5g_disable_mode*) printf '+QNWPREFCFG: "nr5g_disable_mode",1\\r\\nOK\\r\\n' ;;
    *nsa_nr5g_band*) printf '+QNWPREFCFG: "nsa_nr5g_band",41:71\\r\\nOK\\r\\n' ;;
    *nr5g_band*) printf '+QNWPREFCFG: "nr5g_band",0\\r\\nOK\\r\\n' ;;
    *lte_band*) printf '+QNWPREFCFG: "lte_band",2:66\\r\\nOK\\r\\n' ;;
    *gw_band*) printf '+QNWPREFCFG: "gw_band",1:2\\r\\nOK\\r\\n' ;;
  esac
}
json_add_object() { printf 'section=%s\\n' "$1"; }
json_add_array() { :; }
json_close_array() { :; }
json_close_object() { :; }
json_add_string() { printf '%s=%s\\n' "$1" "$2"; }
add_avalible_band_entry() { :; }
config_section=2_1
zbt_get_lockband_nr /dev/ttyTEST`, { ZBT_SYSFS: '/nonexistent' });
  assert.match(out, /section=NR[\s\S]*read_state=disabled[\s\S]*deployment_mode=nsa/);
  assert.match(out, /Standalone NR is disabled/);
  assert.match(out, /section=NR_NSA[\s\S]*read_state=verified/);
});

// Transactional 5G policy regressions live in connectivity.test.cjs.

test('fresh slow samples demote after threshold and two good samples recover', () => {
  const policy = source('firmware/files/usr/lib/zbt/speed-policy.sh');
  assert.equal(shell(policy + `
bad=0; good=0; blocked=0
zbt_speed_transition 2 5 2; echo "$bad:$good:$blocked"
zbt_speed_transition '' 5 2; echo "$bad:$good:$blocked"
zbt_speed_transition . 5 2; echo "$bad:$good:$blocked"
zbt_speed_transition 3 5 2; echo "$bad:$good:$blocked"
zbt_speed_transition 10 5 2; echo "$bad:$good:$blocked"
zbt_speed_transition 10 5 2; echo "$bad:$good:$blocked"`),
    '1:0:0\n1:0:0\n1:0:0\n2:0:1\n0:1:1\n0:2:0');
});

test('speed samples cannot override configured MWAN3 member metrics', () => {
  const dir = sandbox();
  const policy = source('firmware/files/usr/lib/zbt/mwan3-speed-metric.sh').replaceAll('/tmp/modem-watchdog', dir);
  const expiry = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0])) + 100;
  fs.writeFileSync(path.join(dir, '4_1.metric'), `${expiry} 5\n`);
  assert.equal(shell(policy + '\nzbt_speed_metric failover_4_1 4_1 4; zbt_speed_metric failover_wan wan 2; zbt_speed_metric custom 4_1 4; zbt_speed_metric failover_4_1 4_1 7'), '4\n2\n4\n7');
  fs.writeFileSync(path.join(dir, '4_1.metric'), '0 5\n');
  assert.equal(shell(policy + '\nzbt_speed_metric failover_4_1 4_1 4'), '4');
});

test('shared measurement lease rejects overlap and recovers expired workers', () => {
  const dir = sandbox();
  const lib = source('firmware/files/usr/lib/zbt/speed-lock.sh');
  const env = { ZBT_SPEED_STATE: dir };
  shell(lib + '\nzbt_speed_lock', env);
  assert.equal(shell(lib + '\nzbt_speed_lock || echo busy', env), 'busy');
  fs.writeFileSync(path.join(dir, 'lock/lease'), '0 dead-worker\n');
  shell(lib + '\nzbt_speed_lock && zbt_speed_unlock', env);
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
});

test('disabled/removed modem clears stale watchdog measurements', () => {
  const dir = sandbox();
  let code = source('firmware/files/usr/lib/zbt/modem-recovery.sh').replace(/^\. .*$/gm, '');
  code = code.replaceAll('/tmp/modem-watchdog', dir).replaceAll('/tmp/zbt-speedtest', path.join(dir, 'speed'));
  fs.writeFileSync(path.join(dir, '2_1.state'), '100 1 5 0 1 4 0\n');
  shell(code + '\nzbt_health_now() { echo 300; }; zbt_recovery_allowed() { return 1; }; zbt_recovery_check 2_1 modem2');
  assert.equal(fs.existsSync(path.join(dir, '2_1.state')), false);
});

test('QModem starts both instances without nested procd transactions; redial targets one', () => {
  let svc = source('firmware/files/etc/init.d/qmodem_network').replace('mkdir -p /var/run/qmodem', ':');
  const mocks = `
extra_command() { :; }
ready() { return 0; }
procd_open_instance() { echo "open:$1"; }
procd_set_param() { [ "$1" != command ] || echo "command:$3:$4"; }
procd_close_instance() { :; }
procd_kill() { echo "kill:$1:$2"; }
rc_procd() { echo "transaction:$1:$2"; "$@"; }
`;
  const run = 'extra_command() { :; }\n' + dual + '\n' + svc + mocks + '\nzbt_dial_fingerprint() { echo stable; }; start_service; dial 2_1; hang 4_1';
  const out = shell(run);
  assert.equal(out.split('transaction:').length - 1, 1, 'only targeted dial opens its own transaction');
  assert.match(out, /open:modem_4_1/);
  assert.match(out, /open:modem_2_1/);
  assert.match(out, /kill:qmodem_network:modem_4_1/);
  assert.doesNotMatch(out, /kill:qmodem_network:modem_2_1/);
});

test('QModem stopped instance uses the marker expected by upstream RPC', () => {
  const svc = source('firmware/files/etc/init.d/qmodem_network');
  assert.equal(shell('extra_command() { :; }\n' + svc + '\nubus() { echo "{}"; }; modem_status 2_1'), 'modem_2_1 Not Running');
});

test('targeted redial waits for old cleanup and refuses overlapping dialers', () => {
  const svc = source('firmware/files/etc/init.d/qmodem_network');
  const mocks = `
extra_command() { :; }
ubus() { echo '{"qmodem_network":{"instances":{"modem_2_1":{"pid":201}}}}'; }
hang() { [ "$1" = 2_1 ]; }
dial() { echo "dial:$1:$attempts"; }
kill() { [ "$2" = 201 ] && [ "$attempts" -lt "$WAIT_SECONDS" ]; }
sleep() { :; }
logger() { :; }
`;
  assert.equal(shell('extra_command() { :; }\n' + svc + mocks + '\nredial 2_1', { WAIT_SECONDS: '2' }), 'dial:2_1:2');
  assert.equal(shell('extra_command() { :; }\n' + svc + mocks + '\nredial 2_1 || echo refused', { WAIT_SECONDS: '30' }), 'refused');
});

const bands = source('firmware/files/usr/lib/zbt/quectel-bands.sh');
test('band parser accepts quoted/CRLF masks, rejects ERROR, zero and wrong key', () => {
  const readback = '+QNWPREFCFG: "nr5g_band","78:41:77:41"\r\n\r\nOK\r\n';
  assert.equal(shell(bands + '\nzbt_band_values "$READBACK" nr5g_band', { READBACK: readback }), '41\n77\n78');
  for (const bad of ['', 'ERROR', '+QNWPREFCFG: "nr5g_band",0', '+QNWPREFCFG: "lte_band",41:77', '+QNWPREFCFG: "nr5g_band",41\nERROR']) {
    assert.equal(shell(bands + '\nzbt_band_values "$READBACK" nr5g_band || echo unreadable', { READBACK: bad }), 'unreadable');
  }
});

test('SA band write checks own AT port, modem result and exact readback', () => {
  const f = usbFixture();
  const mock = `
uci() { echo '41/77/78'; }
at() {
  printf '%s\\n' "$1:$2" >> "$CALLS"
  case "$2" in *'",'*) printf '%s\\n' "$WRITE_REPLY";; *) printf '%s\\n' "$READ_REPLY";; esac
}
config_section=2_1; at_port=/dev/ttyUSB2; band_class=NR; lock_band=77,41
zbt_set_lockband_nr
echo "$res"
`;
  const env = { ...f.env, CALLS: path.join(f.dir, 'at.log'), WRITE_REPLY: 'OK', READ_REPLY: '+QNWPREFCFG: "nr5g_band",41:77\nOK' };
  assert.equal(shell(bands + mock, env), 'OK (readback verified)');
  assert.match(fs.readFileSync(env.CALLS, 'utf8'), /ttyUSB2:AT\+QNWPREFCFG="nr5g_band",41:77/);
  assert.match(shell(bands + mock, { ...env, WRITE_REPLY: 'ERROR' }), /^ERROR: Modem rejected/);
  assert.match(shell(bands + mock, { ...env, READ_REPLY: '+QNWPREFCFG: "nr5g_band",78\nOK' }), /^ERROR: Band readback/);
  fs.writeFileSync(env.CALLS, '');
  assert.match(shell(bands + mock.replace('at_port=/dev/ttyUSB2', 'at_port=/dev/ttyUSB6'), env), /^ERROR: AT port/);
  assert.equal(fs.readFileSync(env.CALLS, 'utf8'), '', 'no command sent to peer modem');
  assert.match(shell(bands + mock.replace('lock_band=77,41', 'lock_band=99'), env), /^ERROR: Band not/);
  assert.equal(fs.readFileSync(env.CALLS, 'utf8'), '');
});

function runSample(args, extraEnv = {}) {
  const f = usbFixture();
  const calls = path.join(f.dir, 'curl.log');
  const mock = `
ip() { echo '    inet 192.0.0.2/27 scope global'; }
ubus() { echo '{"l3_device":"eth1"}'; }
curl() {
  printf '%s\\n' "$@" >> "$CALLS"
  [ "\${FAIL_HTTP:-0}" = 0 ] || return 28
  case "$*" in
    *'__up'*) echo '{"http_code":200,"speed_upload":1250000}' ;;
    *) echo '{"http_code":200,"size_download":25000000,"speed_download":12500000,"time_connect":0.015}' ;;
  esac
}
`;
  const result = JSON.parse(shell(mock + source('firmware/files/usr/sbin/zbt-speed-sample'), { ...f.env, CALLS: calls, ...extraEnv }, args));
  return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}
test('speed sample binds physical netdev even with overlapping IPs, reports Mbps', () => {
  const a = runSample(['4_1']);
  assert.equal(a.result.download_mbps, 100);
  assert.equal(a.result.upload_mbps, 10);
  assert.equal(a.result.latency_ms, 15);
  assert.match(a.calls, /--interface\nif!wwan8\n/);
  assert.doesNotMatch(a.calls, /--insecure|^-k$|--interface\n192\.0\.0\.2/m);
  const b = runSample(['2_1', 'download']);
  assert.equal(b.result.upload_mbps, null);
  assert.match(b.calls, /if!wwan3/);
  assert.doesNotMatch(b.calls, /__up/, 'watchdog download-only mode must not upload');
});
test('speed sample errors are not fabricated zero-speed successes', () => {
  const failed = runSample(['2_1'], { FAIL_HTTP: '1' });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.download_mbps, undefined);
  const rejected = runSample([';reboot']);
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.calls, '');
});

test('Speedify health requires an HTTP-to-HTTPS application redirect and authenticated HTTPS route', () => {
  const installer = source('firmware/files/usr/sbin/speedify-installer-loop').split('\n[ "$(cat /etc/apk/arch')[0]
    .replace('\t[ -S /var/run/luci-webui.socket ] || return 1', '\t: # fixture models an available uWSGI socket');
  const mocks = `
service_running() { return 0; }
nginx() { return 0; }
curl() {
  case "$*" in
    *http://127.0.0.1/luci-app-speedify/view/index.html*) echo "$HTTP_UI_CODE" ;;
    *https://127.0.0.1/luci-app-speedify/view/index.html*) echo "$HTTPS_UI_CODE" ;;
    *) echo 200 ;;
  esac
}
luci_healthy && echo healthy || echo unhealthy
`;
  assert.equal(shell('uci() { echo 1; }\n' + installer + mocks,
    { HTTP_UI_CODE: '307', HTTPS_UI_CODE: '401' }), 'healthy');
  for (const [http, https] of [['404', '401'], ['502', '401'], ['401', '401'], ['307', '404'], ['307', '502']])
    assert.equal(shell('uci() { echo 1; }\n' + installer + mocks,
      { HTTP_UI_CODE: http, HTTPS_UI_CODE: https }), 'unhealthy');
  assert.doesNotMatch(installer, /restore_uhttpd/);
  const redirect = file('firmware/files/etc/nginx/conf.d/zbt-speedify-https.locations');
  assert.match(redirect, /return 307 https:\/\/\$host\$request_uri/);
  assert.ok(redirect.includes('/cgi-bin/luci/(?:[^/?]+/)*speedify'));
  assert.match(redirect, /\/luci-app-speedify/);
  const runtimeLoop = file('firmware/files/usr/sbin/speedify-installer-loop').split('while :; do')[1];
  const installedBranch = runtimeLoop.split('if packages_complete; then')[1].split('\n\tfi')[0];
  assert.doesNotMatch(installedBranch, /install_bundle|download_bundle/);
});

test('Speedify has a ROM-resident LuCI setup screen across sysupgrade', () => {
  const menuTree = JSON.parse(file('firmware/files/usr/share/luci/menu.d/zbt-speedify-launcher.json'));
  const menu = menuTree['admin/speedify'];
  const appRoute = menuTree['admin/speedify/app'];
  const acl = JSON.parse(file('firmware/files/usr/share/rpcd/acl.d/luci-app-speedify.json'))['luci-app-speedify'];
  const view = file('firmware/files/www/luci-static/resources/view/speedify/speedify.js');
  const launcher = file('firmware/files/www/luci-static/resources/view/speedify/launcher.js');
  const wrapper = file('firmware/files/usr/share/zbt/speedify-luci-wrapper.js');
  const installer = file('firmware/files/usr/sbin/speedify-installer-loop');
  assert.deepEqual(menu.action, { type: 'view', path: 'speedify/launcher' });
  assert.deepEqual(appRoute.action, { type: 'view', path: 'speedify/speedify' });
  assert.equal(appRoute.firstchild_ineligible, true);
  assert.deepEqual(menu.depends.acl, ['luci-app-speedify']);
  assert.ok(acl.read.ubus['luci.speedify'].includes('read'));
  assert.match(launcher, /L\.url\('admin\/speedify\/app'\)/);
  assert.match(launcher, /target\.protocol = 'https:'/);
  assert.match(launcher, /target\.port = ''/);
  assert.match(launcher, /window\.location\.replace\(target\.href\)/);
  assert.match(view, /Finishing Speedify setup/);
  assert.doesNotMatch(view, /handleSaveApply:\s*function|fetch\(/);
  assert.match(installer, /install_luci_wrapper \|\| return 1/);
  assert.doesNotMatch(wrapper, /syncOuterHash|window\.location\.replace/);
  assert.match(wrapper, /E\('iframe'/);
  assert.match(wrapper, /new URL\('\/luci-app-speedify\/view\/index\.html'/);
  assert.match(wrapper, /app\.search = 'wsPort=match&wsEndpoint=/);
  assert.match(wrapper, /app\.hash = '\/'/);
  assert.doesNotMatch(wrapper, /method: 'activation'|Sign in this router|wsToken=/);
  assert.match(wrapper, /SameSite=Strict/);
  assert.match(file('firmware/files/etc/uci-defaults/99-speedify-bootstrap'), /rm -f \/tmp\/luci-indexcache/);
});

test('LuCI recovery makes nginx the only frontend and repairs a 502 backend once', () => {
  const checker = file('firmware/files/usr/sbin/zbt-luci-backend-check');
  const migration = file('firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery');
  const service = file('firmware/files/etc/init.d/zbt-luci-backend');
  assert.match(service, /^START=81$/m);
  assert.match(service, /procd_set_param oneshot 1/);
  assert.match(migration, /uhttpd disable/);
  assert.match(migration, /uwsgi enable/);
  assert.match(migration, /nginx enable/);
  assert.match(migration, /nginx\._lan\.include='conf\.d\/\*\.locations'/);
  assert.match(migration, /nginx_migrated='2'/);
  assert.match(migration, /\/etc\/init\.d\/uwsgi status/);
  assert.match(migration, /\/etc\/init\.d\/nginx status/);
  assert.match(migration, /attempts.*-lt 60/);
  assert.match(migration, /zbt-luci-backend-check/);
  assert.doesNotMatch(migration, /\( sleep 5;/);
  assert.match(checker, /\[ -S "\$SOCKET" \]/);
  assert.match(checker, /\[ "\$http_status" = 502 \]/);
  assert.match(checker, /restart_uwsgi/);
  assert.match(checker, /\/rom\/etc\/uwsgi/);
  assert.match(checker, /\.pre-zbt-repair/);
  assert.doesNotMatch(checker, /while :/);
  assert.doesNotMatch(checker, /\/etc\/config\/network|qmodem|gpio/);
});

test('Tailscale backend lists methods and survives unavailable/invalid daemon JSON', () => {
  const backend = source('firmware/feeds/luci-app-tailscale/root/usr/libexec/rpcd/zbt.tailscale');
  assert.deepEqual(JSON.parse(shell(backend, {}, ['list'])), { status: {}, login: {}, stop: {} });
  let r = JSON.parse(shell('tailscale() { echo broken; return 1; }\n' + backend, {}, ['call', 'status']));
  assert.equal(r.state, 'Unavailable');
  r = JSON.parse(shell('tailscale() { echo \'{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/example"}\'; return 1; }\n' + backend, {}, ['call', 'status']));
  assert.equal(r.state, 'NeedsLogin');
  assert.equal(r.auth_url, 'https://login.tailscale.com/a/example');
});

test('LuCI read-only utility pages have no Save/Apply, and use authenticated RPC', () => {
  for (const p of ['firmware/feeds/luci-app-speedtest-lite/htdocs/luci-static/resources/view/speedtest-lite/config.js', 'firmware/feeds/luci-app-tailscale/htdocs/luci-static/resources/view/tailscale/status.js']) {
    const js = file(p);
    const view = new Function('view', 'rpc', js)({ extend: x => x }, { declare: () => () => Promise.resolve({}) });
    assert.equal(view.handleSave, null);
    assert.equal(view.handleSaveApply, null);
    assert.equal(view.handleReset, null);
    assert.doesNotMatch(js, /fetch\(|cgi-bin\/speedtest/);
  }
  const acl = JSON.parse(file('firmware/files/usr/share/rpcd/acl.d/zbt-speedtest.json'))['luci-app-speedtest-lite'];
  assert.deepEqual(acl.read.ubus['zbt.speedtest'], ['status']);
  assert.deepEqual(acl.write.ubus['zbt.speedtest'], ['start', 'cancel']);
  assert.ok(JSON.parse(file('firmware/feeds/luci-app-modem-watchdog/root/usr/share/luci/menu.d/luci-app-modem-watchdog.json'))['admin/network/mwan3/speed_failover']);
});

function patchedFile(p) { return fs.readFileSync(path.join(process.env.QMODEM_TEST_TREE, p), 'utf8'); }

test('Warp dialer repair blocks repeated failed SIM PIN attempts without shell-test errors', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, '2_1_dir'));
  const dialer = patchedFile('application/qmodem/files/usr/share/qmodem/modem_dial.sh');
  const fn = dialer.slice(dialer.indexOf('\nunlock_sim()') + 1, dialer.indexOf('\nget_platform_suggest_pdp_index()')).replaceAll('/var/run/qmodem/', dir + '/');
  const result = shell(fn + `
lock() { :; }
m_debug() { :; }
at() { echo tried >> "$ATTEMPTS"; return 1; }
modem_config=2_1
unlock_sim 1234
unlock_sim 1234
unlock_sim 5678
wc -l < "$ATTEMPTS"
`, { ATTEMPTS: path.join(dir, 'attempts') });
  assert.equal(result, '2', 'same failed PIN must not consume another SIM retry');
});

function warpConfigFixture(options) {
  const dialer = patchedFile('application/qmodem/files/usr/share/qmodem/modem_dial.sh');
  const fn = dialer.slice(dialer.indexOf('\nget_platform_suggest_pdp_index()') + 1, dialer.indexOf('\ncheck_dial_prepare()'));
  return shell(fn + `
config_load() { :; }
config_foreach() { :; }
find() { echo /fixture/net; }
ls() { echo wwan_fixture; }
get_driver() { echo qmi; }
update_sim_slot() { sim_slot="$SIM_SLOT"; }
config_get() {
  local v=''
  case "$3" in
    path) v=/fixture/2-1 ;;
    manufacturer) v=quectel ;;
    platform) v="$PLATFORM" ;;
    pdp_index) v="$USER_INDEX" ;;
    suggest_pdp_index) v="$SUGGESTED_INDEX" ;;
    pincode) v=1111 ;;
    pincode2) v="$SECOND_PIN" ;;
  esac
  export "$1=$v"
}
modem_config=2_1
pin="$STALE_PIN"
update_config
printf '%s:%s:%s:%s' "$pdp_index" "$suggest_pdp_index" "$userset_pdp_index" "$pincode"
`, { PLATFORM: 'qualcomm', USER_INDEX: '', SUGGESTED_INDEX: '', SIM_SLOT: '1', SECOND_PIN: '', STALE_PIN: '', ...options });
}

test('Warp PDP fallback uses platform index only when suggestion is absent; explicit index survives', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  assert.equal(warpConfigFixture({}), '1:1:0:1111');
  assert.equal(warpConfigFixture({ PLATFORM: 'lte' }), '3:3:0:1111');
  assert.equal(warpConfigFixture({ SUGGESTED_INDEX: '7' }), '7:7:0:1111');
  assert.equal(warpConfigFixture({ USER_INDEX: '5', SUGGESTED_INDEX: '7' }), '5:7:1:1111');
});

test('Warp PIN fallback uses internal SIM2 PIN when present, otherwise this module SIM1 PIN', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  assert.equal(warpConfigFixture({ SIM_SLOT: '2', SECOND_PIN: '2222' }), '1:1:0:2222');
  assert.equal(warpConfigFixture({ SIM_SLOT: '2', STALE_PIN: '9999' }), '1:1:0:1111');
  assert.equal(warpConfigFixture({ SIM_SLOT: '1', SECOND_PIN: '2222' }), '1:1:0:1111');
});
test('patched QMI dialer gives each modem its own device and APN arguments', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const f = usbFixture(), bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin);
  const cm = path.join(bin, 'quectel-CM-M');
  fs.writeFileSync(cm, '#!/bin/sh\nprintf "%s\\0" "$@" > "$DIAL_ARGS"\n', { mode: 0o755 });
  const dialer = patchedFile('application/qmodem/files/usr/share/qmodem/modem_dial.sh');
  let fn = dialer.slice(dialer.indexOf('\nqmi_dial()') + 1, dialer.indexOf('\necm_dial()'));
  assert.ok(fn.startsWith('qmi_dial()'));
  // Argument construction only; qmi-session.test.cjs exercises the real
  // lifecycle helper with child processes, failures and tracker states.
  fn = fn.replace('. /usr/lib/zbt/qmi-session.sh', 'zbt_qmi_session() { "$@"; }');
  fn = fn.replaceAll('/usr/lib/zbt/', root + '/firmware/files/usr/lib/zbt/').replaceAll('/usr/bin/quectel-CM-M', cm);
  for (const [section, port, net, apn, pdp, force, imsi, expectedApn] of [
    ['4_1', 'ttyUSB6', 'wwan8', '', 'ipv4v6', '', '310260123456789', ''],
    ['2_1', 'ttyUSB2', 'wwan3', 'auto', 'ipv4v6', '', '310260123456789', ''],
    ['2_1', 'ttyUSB2', 'wwan3', 'auto', 'ipv4v6', '', '310410000000001', 'broadband'],
    ['2_1', 'ttyUSB2', 'wwan3', 'private.apn', 'ipv4v6', '', '310410000000001', 'private.apn'],
    ['2_1', 'ttyUSB2', 'wwan3', 'broadband', 'ip', '1', '310410000000001', 'broadband'],
    ['2_1', 'ttyUSB2', 'wwan3', 'broadband', 'ip', '', '310410000000001', 'broadband']
  ]) {
    fs.mkdirSync(path.join(f.dir, section + '_dir'), { recursive: true });
    const argsfile = path.join(f.dir, 'args');
    const script = fn + `
m_debug() { :; }
at() { printf '%s\\nOK\\n' "$TEST_IMSI"; }
sleep() { exit 0; }
modem_config="$SECTION"; at_port="/dev/$PORT"; apn="$APN"
driver=qmi; pdp_type="$PDP"; force_set_apn="$FORCE_PROFILE"; userset_pdp_index=0; do_not_add_dns=1
username='test user'; password='test password'; auth=chap; metric=210
MODEM_RUNDIR="$RUNDIR"; log_file="$RUNDIR/dial.log"
qmi_dial`;
    shell(script, { ...f.env, PATH: bin + ':' + process.env.PATH, SECTION: section, PORT: port, APN: apn, PDP: pdp, FORCE_PROFILE: force, TEST_IMSI: imsi, DIAL_ARGS: argsfile, RUNDIR: f.dir });
    const args = fs.readFileSync(argsfile, 'utf8').split('\0').slice(0, -1);
    assert.equal(args[args.indexOf('-i') + 1], net);
    assert.ok(args.includes('-d'));
    assert.ok(args.includes('-D'));
    assert.ok(args.includes('-4'));
    assert.equal(args.includes('-6'), pdp !== 'ip', 'IPv4-only selection must not request a rejected IPv6 call');
    assert.equal(args.includes('-F'), force === '1', 'removed temporary force override must not persist');
    if (expectedApn) assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 5), ['-s', expectedApn, 'test user', 'test password', 'chap']);
    else assert.equal(args.includes('-s'), false, 'auto mode must not erase the network/modem APN profile');
  }
});

test('patched scanner repairs existing profiles and qmodem_init passes slot, not path', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const scanner = patchedFile('application/qmodem/files/usr/share/qmodem/modem_scan.sh');
  assert.match(scanner, /fi\n\s*uci -q batch <<EOF\nset qmodem\.\$section_name\.path="\$modem_path"\nset qmodem\.\$section_name\.data_interface="\$slot_type"/);
  const init = patchedFile('application/qmodem/files/etc/init.d/qmodem_init');
  assert.match(init, /modem_scan\.sh add "\$slot" "\$type"/);
  assert.doesNotMatch(init, /modem_scan\.sh add "\$path"/);
  assert.match(patchedFile('application/qmodem/files/usr/share/qmodem/modem_dial.sh'), /qmi\|mbim\|mhi\) proto="zbtqmi"; protov6="zbtqmi"/);
});

test('QModem consumes and preserves MWAN-owned network metrics across redial', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const dialer = patchedFile('application/qmodem/files/usr/share/qmodem/modem_dial.sh');
  const ui = patchedFile('luci/luci-app-qmodem-next/htdocs/luci-static/resources/view/qmodem/network_config.js');
  assert.match(dialer, /network_metric=\$\(uci -q get network\.\$\{interface_name\}\.metric\)/);
  assert.match(dialer, /\*\) metric="\$network_metric"/);
  assert.match(dialer, /if \[ "\$network_cfg" = "\$interface_name" \]; then/);
  assert.match(dialer, /uci -q set network\.\$\{network_cfg\}\.metric="\$\{metric:-200\}"/);
  assert.doesNotMatch(dialer, /if \[ "\$network_cfg" = "\$interface_name" \]; then\s*uci delete network\.\$network_cfg/);
  assert.match(ui, /form\.DummyValue, '_route_metric'/);
  assert.match(ui, /uci\.load\('network'\)/);
});

test('dual QMI startup serializes netifd loading and never uses global-reloading ifup for owned links', { skip: !process.env.QMODEM_TEST_TREE }, () => {
  const dialer = patchedFile('application/qmodem/files/usr/share/qmodem/modem_dial.sh');
  const setIf = dialer.slice(dialer.indexOf('\nset_if()') + 1, dialer.indexOf('\nflush_if()'));
  assert.match(setIf, /exec 1002>\/var\/lock\/zbt-qmi-netifd\.lock\s+flock 1002/);
  assert.match(setIf, /uci -q set network\.\$logical\.auto=0/);
  assert.match(setIf, /ubus -t 15 call network reload[\s\S]*ubus -t 5 call network\.interface up/);
  assert.ok(setIf.indexOf('flock 1002') < setIf.indexOf('uci commit network'));
  assert.ok(setIf.indexOf('uci commit network') < setIf.indexOf('flock -u 1002'));
  const session = file('firmware/files/usr/lib/zbt/qmi-session.sh');
  assert.match(session, /zbt_qmi_notify\(\)[\s\S]*zbt-qmi-netifd\.lock[\s\S]*ubus -t 5 call network\.interface "\$action"/);
  assert.doesNotMatch(session.slice(session.indexOf('zbt_qmi_notify()'), session.indexOf('zbt_qmi_child_alive()')), /\n\s*if(?:up|down)\s/);
});

test('MWAN3 interface UI edits the persistent network metric', { skip: !process.env.MWAN3_LUCI_TEST_TREE }, () => {
  const tree = process.env.MWAN3_LUCI_TEST_TREE;
  const uiSource = fs.readFileSync(path.join(tree,
    'applications/luci-app-mwan3/htdocs/luci-static/resources/view/mwan3/network/interface.js'), 'utf8');
  const acl = JSON.parse(fs.readFileSync(path.join(tree,
    'applications/luci-app-mwan3/root/usr/share/rpcd/acl.d/luci-app-mwan3.json'), 'utf8'))['luci-app-mwan3'];
  assert.match(uiSource, /form\.Value, '_route_metric'/);
  assert.match(uiSource, /uci\.set\('network', section_id, 'metric', value\)/);
  assert.match(uiSource, /Route metric is already used by interface/);
  assert.ok(acl.write.uci.includes('network'));
});

test('routing presets keep one explicit whole-router priority order', () => {
  const preset = file('firmware/files/usr/sbin/zbt-mwan-preset');
  const migration = file('firmware/files/etc/uci-defaults/99-zbt-route-priority-repair');
  const priorityV4 = file('firmware/files/etc/uci-defaults/99-zbt-modem1-priority-v4');
  const watchdog = file('firmware/feeds/luci-app-modem-watchdog/root/usr/sbin/modem-watchdog');
  const watchdogUi = file('firmware/feeds/luci-app-modem-watchdog/htdocs/luci-static/resources/view/modem-watchdog/config.js');
  assert.match(preset, /ensure_route_metric wan_sfp 9 "\$exact"/);
  assert.match(preset, /ensure_route_metric wan 10 "\$exact"/);
  assert.match(preset, /ensure_route_metric usb_tether 100 "\$exact"/);
  assert.match(preset, /ensure_route_metric 4_1 200 "\$exact"/);
  assert.match(preset, /ensure_route_metric 2_1 210 "\$exact"/);
  assert.match(preset, /configure_member failover_wan_sfp wan_sfp 1 1/);
  assert.match(preset, /configure_member failover_wan wan 2 1/);
  assert.match(preset, /configure_member failover_usb_tether usb_tether 3 1/);
  assert.match(preset, /configure_member failover_4_1 4_1 4 1/);
  assert.match(preset, /configure_member failover_2_1 2_1 5 1/);
  assert.match(preset, /configure_member balanced_4_1 4_1 4 1/);
  assert.match(preset, /configure_member balanced_2_1 2_1 5 1/);
  assert.match(preset, /if \[ "\$\{ZBT_MWAN_NO_RELOAD:-0\}" != 1 \]; then/);
  assert.match(migration, /DEFAULTS_VERSION=4/);
  assert.match(migration, /''\|priority\|fastest\) preset=failover/);
  assert.match(migration, /ZBT_MWAN_NO_RELOAD=1 \/usr\/sbin\/zbt-mwan-preset "\$preset"/);
  assert.match(priorityV4, /zbt-mwan-preset failover/);
  assert.match(priorityV4, /prefer_fastest='0'/);
  assert.doesNotMatch(watchdog, /write_preference|preferred=2/);
  assert.doesNotMatch(watchdogUi, /applyPreset\('fastest'\)|Prefer the fastest cellular modem/);
});

test('Mega phone tethering has a stable hotplug identity ahead of cellular modems', () => {
  const defaults = file('firmware/files/etc/uci-defaults/40-zbt-usb-tether-defaults');
  const hotplug = file('firmware/files/etc/hotplug.d/net/15-zbt-rndis-auto');
  assert.match(defaults, /network\.usb_tether\.proto=dhcp/);
  assert.match(defaults, /network\.usb_tether\.metric=100/);
  assert.match(defaults, /firewall\.\$wan_zone\.network=usb_tether/);
  assert.match(hotplug, /rndis_host\|cdc_ether\|cdc_ncm\|ipheth/);
  assert.match(hotplug, /net_path\/qmi/);
  assert.match(hotplug, /usb4\/4-1\/\*\|\*\/usb2\/2-1\/\*/);
  assert.match(hotplug, /network\.usb_tether\.device="\$DEVICENAME"/);
});

test('Mega SSH banner carries project identity without a donation block', () => {
  const banner = file('firmware/files/etc/banner');
  const shellInfo = file('firmware/files/etc/profile.d/10-zbt-info.sh');
  assert.match(banner, /ZBT-Z8803BE Mega Edition/);
  assert.match(banner, /github\.com\/mfoster978\/OpenWrt-ZBT-Z8803BE-Mega/);
  assert.match(banner, /Developer: Michael Foster \/ GitHub @mfoster978/);
  assert.match(banner, /mfoster978@gmail\.com - Discord: mfoster978/);
  assert.doesNotMatch(banner + shellInfo, /Donate|ERC20|BEP20|TRC20|0xfar5eer@gmail\.com|0xFar5eer#6504/i);
});

test('pinned mwan3 policy builder consumes RAM metric override', { skip: !process.env.MWAN3_TEST_TREE }, () => {
  const code = fs.readFileSync(path.join(process.env.MWAN3_TEST_TREE, 'net/mwan3/files/lib/mwan3/mwan3.sh'), 'utf8');
  assert.match(code, /metric=\$\(zbt_speed_metric "\$1" "\$iface" "\$metric"\)/);
});
