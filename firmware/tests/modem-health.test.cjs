'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-health-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const source = p => fs.readFileSync(path.join(root, p), 'utf8');
// Socket behavior is exercised with the real mwan3 wrapper by the namespace
// regression. These command mocks need a harmless, loadable host library.
const mockSockopt = ['/lib/x86_64-linux-gnu/libc.so.6', '/lib/aarch64-linux-gnu/libc.so.6'].find(p => fs.existsSync(p));
assert.ok(mockSockopt, 'host libc is required for mocked socket environment');
const lib = ['dual-modem.sh', 'modem-health.sh', '5g-state.sh', 'modem-recovery.sh'].map(p =>
  source('firmware/files/usr/lib/zbt/' + p).replace(/^\. \/usr\/lib\/zbt\/.*$/gm, '')).join('\n')
  .replaceAll('/etc/init.d/qmodem_network', 'service');
function fixture(body, options={}) {
  const d = fs.mkdtempSync(path.join(temp, 'case-'));
  const write = (p, v) => { fs.mkdirSync(path.dirname(path.join(d,p)),{recursive:true}); fs.writeFileSync(path.join(d,p), v+'\n'); };
  for (const [slot, usb, dev, gpio, index] of [['4_1','4-1','wwan8','5g1',17], ['2_1','2-1','wwan3','5g2',23]]) {
    fs.mkdirSync(path.join(d,`sys/bus/usb/devices/${usb}/${usb}:1.4/net/${dev}`),{recursive:true});
    write(`sys/class/net/${dev}/ifindex`,index); write(`sys/class/net/${dev}/statistics/rx_errors`,0);
    write(`sys/class/gpio/${gpio}/value`,1);
    write(`uci/qmodem.${slot}.enable_dial`,1); write(`uci/qmodem.${slot}.state`,'enabled');
  }
  for (const [k,v] of Object.entries({'qmodem.main.enable_dial':1,'modem_watchdog.global.enabled':1,'modem_watchdog.global.actions_enabled':1,
    'modem_watchdog.modem1.enabled':1,'modem_watchdog.modem2.enabled':1,'modem_watchdog.modem1.action':'power_cycle','modem_watchdog.modem2.action':'power_cycle',
    'modem_watchdog.modem1.redial_attempts':1,'modem_watchdog.modem2.redial_attempts':1,'modem_watchdog.global.redial_verify_seconds':60})) write('uci/'+k,v);
  write('clock',300); fs.mkdirSync(path.join(d,'recovery'));
  const mocks = `
uci() { [ "$1" != -q ] || shift; [ "$1" = get ] && cat "$DB/uci/$2" 2>/dev/null; }
zbt_health_now() { cat "$DB/clock"; }
ip() {
 case "$*" in
  '-o -4 addr show'*) [ "$ADDR4" = 0 ] || echo '17: wwan inet 192.0.0.2/27 scope global' ;;
  '-o -6 addr show'*) [ "$ADDR6" != 1 ] || echo '17: wwan inet6 2001:db8::2/64 scope global' ;;
 esac
}
ping() {
 echo "socket family=$FAMILY device=$DEVICE source=$SRCIP mark=$FWMARK" >> "$DB/calls"
 echo "ping $*" >> "$DB/calls"
 case "$*" in *"$GOOD_FAMILY -I $GOOD_DEVICE"*) [ -n "$GOOD_DEVICE" ] ;; *) return 1 ;; esac
}
curl() {
 echo "socket family=$FAMILY device=$DEVICE source=$SRCIP mark=$FWMARK" >> "$DB/calls"
 echo "curl $*" >> "$DB/calls"
 case "$*" in *"--interface if!$GOOD_HTTP_DEVICE"*) [ -n "$GOOD_HTTP_DEVICE" ] && printf 204 ;; *) return 1 ;; esac
}
service() {
 echo "service $*" >> "$DB/calls"
 case "$1:$2" in
  hang:4_1|hang:2_1) rm -f "$DB/worker-$2" ;;
  dial:4_1|dial:2_1) [ "$REGISTER_WORKER" = 0 ] || touch "$DB/worker-$2" ;;
 esac
}
logger() { echo "log $*" >> "$DB/calls"; }
ubus() {
 for section in 4_1 2_1; do
  [ ! -f "$DB/worker-$section" ] || {
   printf '{"qmodem_network":{"instances":{"modem_%s":{"running":true,"pid":4321}}}}\n' "$section"
   return
  }
 done
 echo '{}'
}
sleep() {
 echo "sleep $1 power=$(cat "$DB/sys/class/gpio/5g1/value")/$(cat "$DB/sys/class/gpio/5g2/value")" >> "$DB/calls"
 if [ "$1" = 8 ]; then
  for pair in '5g1 wwan8' '5g2 wwan3'; do set -- $pair
   if [ "$(cat "$DB/sys/class/gpio/$1/value")" = 0 ]; then echo $(( $(cat "$DB/sys/class/net/$2/ifindex") + 1 )) > "$DB/sys/class/net/$2/ifindex"; fi
  done
 fi
}
cycle() { zbt_health_probe 4_1 || :; zbt_health_save 4_1; zbt_recovery_check 4_1 modem1; echo $(( $(cat "$DB/clock") + 30 )) > "$DB/clock"; }
`;
  const result=spawnSync('busybox',['sh','-c',lib+'\n'+mocks+'\n'+body], {encoding:'utf8',timeout:10000,
    env:{...process.env,DB:d,ZBT_SYSFS:path.join(d,'sys'),ZBT_HEALTH_DIR:path.join(d,'health'),ZBT_5G_STATE:path.join(d,'radio'),ZBT_RECOVERY_DIR:path.join(d,'recovery'),ZBT_MWAN_SOCKOPT:mockSockopt,GOOD_FAMILY:'-4',GOOD_DEVICE:'',REGISTER_WORKER:'1',...options}});
  assert.ifError(result.error); assert.equal(result.status,0,result.stderr+result.stdout);
  return {d,out:result.stdout,calls:fs.existsSync(path.join(d,'calls'))?fs.readFileSync(path.join(d,'calls'),'utf8'):''};
}
test('direct probes cannot succeed through the working peer; either family can prove this slot',()=>{
  const f=fixture('zbt_health_probe 4_1 || :; echo "$ZBT_HEALTH:$ZBT_HEALTH4:$ZBT_HEALTH6"; zbt_health_probe 2_1 || :; echo "$ZBT_HEALTH"',{GOOD_DEVICE:'wwan3'});
  assert.equal(f.out,'offline:offline:absent\nonline\n');
  assert.match(f.calls,/-4 -I wwan8 -c 1 -W 2 1.1.1.1/);
  assert.match(f.calls,/socket family=ipv4 device=wwan8 source=192\.0\.0\.2 mark=16128/);
  const v6=fixture('zbt_health_probe 4_1; zbt_health_save 4_1; zbt_health_online 4_1; echo "$ZBT_HEALTH:$ZBT_HEALTH4:$ZBT_HEALTH6"',{ADDR4:'0',ADDR6:'1',GOOD_FAMILY:'-6',GOOD_DEVICE:'wwan8'});
  assert.equal(v6.out,'online:absent:online\n');
  assert.doesNotMatch(v6.calls,/-4 -I/);
  assert.match(v6.calls,/socket family=ipv6 device=wwan8 source=2001:db8::2 mark=16128/);
});
test('physical health probes use the configured mwan3 bypass mask before netifd publication',()=>{
  const f=fixture('echo 0x7f00 > "$DB/uci/mwan3.globals.mmx_mask"; zbt_health_probe 4_1; echo "$ZBT_HEALTH"',{GOOD_DEVICE:'wwan8'});
  assert.equal(f.out,'online\n');
  assert.match(f.calls,/socket family=ipv4 device=wwan8 source=192\.0\.0\.2 mark=32512/);
  assert.doesNotMatch(f.calls,/service /);
});
test('missing socket wrapper or invalid bypass mark cannot be counted as a modem outage',()=>{
  for (const body of ['ZBT_MWAN_SOCKOPT=/missing/mwan-wrapper', 'echo invalid > "$DB/uci/mwan3.globals.mmx_mask"']) {
    const f=fixture(`${body}; cycle; cycle; cycle; cycle; cat "$DB/recovery/4_1.state"; echo "$ZBT_HEALTH"`);
    assert.match(f.out,/^0 0 0 0 .*\nunknown\n$/);
    assert.match(f.calls,/result=deferred reason=mwan-socket-binding-unavailable/);
    assert.doesNotMatch(f.calls,/service |^ping /m);
  }
  const deferred=fixture('cycle; cycle; cycle; ZBT_MWAN_SOCKOPT=/missing/mwan-wrapper; echo 700 > "$DB/clock"; cycle; cycle; cycle');
  assert.equal((deferred.calls.match(/service hang 4_1/g)||[]).length,1,'indeterminate checks cannot escalate an earlier redial to GPIO');
});
test('strict device-bound HTTPS 204 proves Internet when the carrier drops ICMP',()=>{
  const f=fixture('zbt_health_probe 4_1; echo "$ZBT_HEALTH:$ZBT_HEALTH4:$ZBT_HEALTH6"',{GOOD_HTTP_DEVICE:'wwan8'});
  assert.equal(f.out,'online:online:absent\n');
  assert.match(f.calls,/--interface if!wwan8[\s\S]*generate_204/);
  const portal=fixture('zbt_health_probe 4_1 || :; echo "$ZBT_HEALTH:$ZBT_HEALTH4"',{GOOD_HTTP_DEVICE:''});
  assert.equal(portal.out,'offline:offline\n');
});
test('LED health rejects stale, re-enumerated, disabled and recovering slots',()=>{
  const f=fixture(`zbt_health_probe 4_1; zbt_health_save 4_1; zbt_health_online 4_1 && echo fresh
echo 400 > "$DB/clock"; zbt_health_online 4_1 || echo stale
echo 300 > "$DB/clock"; echo 99 > "$DB/sys/class/net/wwan8/ifindex"; zbt_health_online 4_1 || echo replaced
echo 17 > "$DB/sys/class/net/wwan8/ifindex"; echo $$ > "$DB/recovery/4_1.recovering"; zbt_health_online 4_1 || echo recovering
rm "$DB/recovery/4_1.recovering"; echo 0 > "$DB/uci/qmodem.4_1.enable_dial"; zbt_health_online 4_1 || echo disabled`,{GOOD_DEVICE:'wwan8'});
  assert.equal(f.out,'fresh\nstale\nreplaced\nrecovering\ndisabled\n');
});
test('three failed probes trigger only selected GPIO, then explicitly dial; cooldown prevents storms',()=>{
  const f=fixture('echo 0 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; cycle; cycle; cycle; cycle; cycle; cycle');
  assert.equal((f.calls.match(/service hang 4_1/g)||[]).length,1);
  assert.match(f.calls,/service hang 4_1\nsleep 8 power=0\/1\nservice dial 4_1/);
  assert.doesNotMatch(f.calls,/service (?:redial|.*2_1)/);
  assert.equal(fs.readFileSync(path.join(f.d,'sys/class/gpio/5g1/value'),'utf8').trim(),'1');
});
test('first confirmed boot outage uses boot grace without an extra action cooldown',()=>{
  const f=fixture('echo 0 > "$DB/clock"; cycle; cycle; grep -q "service " "$DB/calls" && echo premature || :; cycle');
  assert.equal(f.out,'');
  assert.equal((f.calls.match(/service hang 4_1/g)||[]).length,1);
  assert.match(f.calls,/requesting redial[\s\S]*service hang 4_1/);
});
test('IPv6-only and dual-stack partial success prevent GPIO recovery',()=>{
  for(const ADDR4 of ['0','1']) {
    const f=fixture('cycle; cycle; cycle; cycle; cycle',{ADDR4,ADDR6:'1',GOOD_FAMILY:'-6',GOOD_DEVICE:'wwan8'});
    assert.doesNotMatch(f.calls,/service /);
  }
});
test('Modem 2 GPIO recovery leaves Modem 1 alone and explicitly starts Modem 2',()=>{
  const f=fixture('echo 0 > "$DB/uci/modem_watchdog.modem2.redial_attempts"; for n in 1 2 3 4; do zbt_health_probe 2_1 || :; zbt_recovery_check 2_1 modem2; done');
  assert.match(f.calls,/service hang 2_1\nsleep 8 power=1\/0\nservice dial 2_1/);
  assert.doesNotMatch(f.calls,/service .*4_1/);
});
test('GPIO recovery registers the persistent dial worker before USB/netdev re-enumeration',()=>{
  const f=fixture('echo 0 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; zbt_netdev() { return 1; }; cycle; cycle; cycle');
  assert.match(f.calls,/service hang 4_1\nsleep 8 power=0\/1\nservice dial 4_1/);
  assert.doesNotMatch(f.calls,/sleep 1 power=/, 'recovery must not time out polling for a netdev before dispatching dial');
  assert.doesNotMatch(f.calls,/service .*2_1/);
});
test('recovery does not report dispatch until the persistent slot worker is visible',()=>{
  const f=fixture('echo 0 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; cycle; cycle; cycle',{REGISTER_WORKER:'0'});
  assert.equal((f.calls.match(/service dial 4_1/g)||[]).length,5);
  assert.match(f.calls,/worker-registration-failed attempts=5/);
  assert.match(f.calls,/action=power_cycle result=incomplete/);
  assert.doesNotMatch(f.calls,/action=power_cycle result=dispatched/);
});
test('only an interrupted owned GPIO pulse is restored; manual power-off is preserved',()=>{
  const f=fixture(`echo 0 > "$DB/sys/class/gpio/5g1/value"
zbt_recovery_resume 4_1; cat "$DB/sys/class/gpio/5g1/value"
echo 99999999 > "$DB/recovery/4_1.power-off"
zbt_recovery_resume 4_1; cat "$DB/sys/class/gpio/5g1/value"
test ! -e "$DB/recovery/4_1.power-off"`);
  assert.equal(f.out,'0\n1\n');
});
test('busy peer recovery consumes no slot attempt or cooldown',()=>{
  const f=fixture('exec 6>"$DB/recovery/action.lock"; flock -n 6; cycle; cycle; cycle; cycle; cat "$DB/recovery/4_1.state"');
  assert.doesNotMatch(f.calls,/service /);
  assert.match(f.out,/^4 0 0 0 /);
});
test('confirmed QMI process loss receives the configured soft redial first',()=>{
  const f=fixture('echo 1 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; touch "$DB/recovery/4_1.qmi-lost"; cycle; cycle; cycle');
  assert.match(f.calls,/qmi_session_lost; requesting redial/);
  assert.doesNotMatch(f.calls,/requesting power_cycle/);
});
test('disabled modem and disabled recovery are read-only; missing GPIO never hangs a modem',()=>{
  for(const key of ['qmodem.4_1.enable_dial','qmodem.main.enable_dial','modem_watchdog.global.enabled','modem_watchdog.modem1.enabled']) {
    const f=fixture(`echo 0 > "$DB/uci/${key}"; cycle; cycle; cycle; cycle`);
    assert.doesNotMatch(f.calls,/service /,key);
  }
  const f=fixture('echo 0 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; rm "$DB/sys/class/gpio/5g1/value"; cycle; cycle; cycle; cycle');
  assert.doesNotMatch(f.calls,/service /);
});
test('bounded redial-first option escalates to GPIO; growing RX errors bypass soft retry',()=>{
  const f=fixture('echo 1 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; cycle; cycle; cycle; echo 700 > "$DB/clock"; cycle; cycle; cycle');
  assert.match(f.calls,/requesting redial[\s\S]*requesting power_cycle/);
  assert.match(f.calls,/slot=4_1 action=redial result=dispatched[\s\S]*slot=4_1 action=power_cycle result=dispatched/);
  const bad=fixture('echo 2 > "$DB/uci/modem_watchdog.modem1.redial_attempts"; cycle; cycle; echo 300 > "$DB/sys/class/net/wwan8/statistics/rx_errors"; cycle');
  assert.match(bad.calls,/rx_errors_growing; requesting power_cycle/);
  assert.doesNotMatch(bad.calls,/requesting redial/);
});
test('three consecutive successes clear failure streak, not a single stray success',()=>{
  const f=fixture('cycle; cycle; cycle; GOOD_DEVICE=wwan8; cycle; GOOD_DEVICE=""; cycle');
  assert.match(f.calls,/requesting redial/);
  const recovered=fixture('cycle; cycle; GOOD_DEVICE=wwan8; cycle; cycle; cycle; GOOD_DEVICE=""; cycle');
  assert.doesNotMatch(recovered.calls,/service /);
});
test('adaptive radio lock excludes GPIO recovery and does not consume attempt budget',()=>{
  const f=fixture('config_section=4_1; zbt_5g_lock; cycle; cycle; cycle; cycle; zbt_5g_unlock; cat "$DB/recovery/4_1.state"');
  assert.doesNotMatch(f.calls,/service /);
  assert.match(f.out,/^4 0 0 0 /);
});
test('persistent outage is capped at three actions per hour, including service restarts',()=>{
  const f=fixture('for n in 1 2 3 4 5; do cycle; cycle; cycle; cycle; echo $(( $(cat "$DB/clock") + 180 )) > "$DB/clock"; done');
  assert.equal((f.calls.match(/service hang 4_1/g)||[]).length,3);
});
test('netifd publication waits for address AND route, uses external addresses, and covers IPv6-only',()=>{
  const pub=source('firmware/files/usr/lib/zbt/qmi-publish.sh');
  const f=fixture(pub+`
modem_config=4_1; modem_netcard=wwan8
echo 4_1 > "$DB/uci/network.4_1.modem_config"; echo zbtqmi > "$DB/uci/network.4_1.proto"
echo 4_1 > "$DB/uci/network.4_1v6.modem_config"; echo zbtqmi > "$DB/uci/network.4_1v6.proto"
zbt_qmi_owned() { return 0; }
ip() {
 case "$*" in
  '-j -4 addr'*) echo '[{"addr_info":[{"local":"192.0.0.2","prefixlen":27,"scope":"global"}]}]' ;;
  '-j -6 addr'*) echo '[{"addr_info":[{"local":"2001:db8::2","prefixlen":64,"scope":"global"}]}]' ;;
  *route*) if [ "$NO_ROUTE" = 1 ]; then echo '[]'; else echo '[{"dst":"default","gateway":"192.0.0.1","metric":200}]'; fi ;;
 esac
}
ubus() {
 if [ "$5" = notify_proto ]; then
  echo "$6" >> "$DB/payload"
  [ "$DROP_UPDATE" != 1 ] || return 0
  printf '%s' "$6" | jq '{up:true,l3_device:.ifname,"ipv4-address":((.ipaddr//[])|map({address:.ipaddr})),"ipv6-address":((.ip6addr//[])|map({address:.ipaddr}))}' > "$DB/status-$4"
 else cat "$DB/status-$4" 2>/dev/null || echo '{"up":true,"l3_device":"stale-device"}'; fi
}
NO_ROUTE=1; zbt_qmi_publish 4 4_1 || echo waiting
NO_ROUTE=0; zbt_qmi_publish 4 4_1; zbt_qmi_publish 4 4_1
zbt_qmi_publish 6 4_1v6
zbt_qmi_publish 4 lan || echo reject
# A successful notify that netifd ignores must not be remembered as published.
echo '{"up":true,"l3_device":"stale-device"}' > "$DB/status-network.interface.4_1"
DROP_UPDATE=1; zbt_qmi_publish 4 4_1 || echo unverified
DROP_UPDATE=0; zbt_qmi_publish 4 4_1; zbt_qmi_publish 4 4_1
`);
  assert.equal(f.out,'waiting\nreject\nunverified\n');
  const payloads=fs.readFileSync(path.join(f.d,'payload'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(payloads.length,4,'unchanged publication is idempotent; stale readback retries until verified');
  assert.equal(payloads[0]['address-external'],true);
  assert.deepEqual(payloads[0].ipaddr,[{ipaddr:'192.0.0.2',mask:'27'}]);
  assert.equal(payloads[0].routes[0].gateway,'192.0.0.1');
  assert.equal(payloads[1].ip6addr[0].ipaddr,'2001:db8::2');
  assert.equal(payloads[1].routes6[0].target,'::');
});
