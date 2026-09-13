'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mwan-reconcile-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const source = p => fs.readFileSync(path.join(root, p), 'utf8');
const lib = ['dual-modem.sh', 'modem-health.sh', 'mwan-runtime.sh', 'mwan-reconcile.sh']
  .map(p => source('firmware/files/usr/lib/zbt/' + p).replace(/^\. \/usr\/lib\/zbt\/.*$/gm, '')).join('\n');
function run(before='', env={}) {
  const d = fs.mkdtempSync(path.join(temp, 'case-'));
  const write = (p, value) => { fs.mkdirSync(path.dirname(path.join(d, p)), {recursive:true}); fs.writeFileSync(path.join(d,p), value+'\n'); };
  fs.mkdirSync(path.join(d,'sys/bus/usb/devices/2-1/2-1:1.4/net/wwan3'),{recursive:true});
  write('sys/class/net/wwan3/ifindex',23); write('sys/class/gpio/5g2/value',1);
  for (const [key,value] of Object.entries({
    'qmodem.main.enable_dial':1, 'qmodem.2_1.enable_dial':1,
    'mwan3.2_1.enabled':1, 'mwan3.2_1.family':'ipv4', 'network.2_1.modem_config':'2_1'
  })) write('uci/'+key,value);
  for (const [key,value] of Object.entries({STATUS:'online',STARTED:1,TIME:1000,PID:process.pid})) write('track/2_1/'+key,value);
  write('health/2_1','1000 wwan3 23 online online absent');
  write('state/iface_state/2_1','offline'); write('policy','unreachable');
  const mocks = `
uci() {
  [ "$1" != -q ] || shift
  case "$1" in changes) printf '%s' "$PENDING" ;; get) cat "$DB/uci/$2" 2>/dev/null ;;
    *) echo "UNEXPECTED UCI WRITE: $*" >> "$DB/calls"; return 77 ;; esac
}
logger() { echo "$*" >> "$DB/log"; }
zbt_health_now() { echo 1010; }; zbt_mwan_now() { echo 1010; }
network_flush_cache() { :; }
network_is_up() { [ "$NO_LINK" != 1 ]; }
network_get_device() { eval "$1=wwan3"; }
network_get_ipaddr() { [ "$NO_NETIFD_ADDRESS" = 1 ] || eval "$1=10.0.0.2"; }
zbt_qmi_reconcile_publication() {
  [ "$PUBLICATION_FAIL" != 1 ] || return 1
  if [ "$NO_LINK" = 1 ]; then echo "publish $*" >> "$DB/calls"; NO_LINK=0; fi
  [ "$LEGACY" != 1 ] || return 2
}
config_foreach() { if [ "$2" = interface ]; then "$1" 4_1; "$1" 2_1; else "$1" failover; fi; }
config_list_foreach() { "$3" backup; }
config_get() {
  local value
  case "$2:$3" in backup:interface) value=2_1 ;; backup:metric) value=5 ;; backup:weight) value=1 ;; 2_1:family) value=ipv4 ;; esac
  eval "$1=\\$value"
}
mwan3_get_iface_id() { eval "$1=4"; }
mwan3_get_iface_hotplug_state() { cat "$DB/state/iface_state/$1"; }
mwan3_set_iface_hotplug_state() { echo "$2" > "$DB/state/iface_state/$1"; echo "state $1 $2" >> "$DB/calls"; }
mwan3_set_policies_iptables() { echo build >> "$DB/calls"; echo online > "$DB/policy"; }
mwan3_create_iface_route() { echo "route $*" >> "$DB/calls"; [ "$ROUTE_FAIL" = 1 ] || touch "$DB/route"; }
mwan3_create_iface_rules() { echo "rules $*" >> "$DB/calls"; }
zbt_mwan_tracker_ifup() {
  echo "ifup $1" >> "$DB/calls"
  if [ "$AUTO_ONLINE" = 1 ]; then
    echo online > "$DB/track/$1/STATUS"; echo 1 > "$DB/track/$1/STARTED"
  fi
}
iptables() {
  case "$*" in *mwan3_hook*) [ "$NO_HOOK" != 1 ] ;;
    *) if [ "$(cat "$DB/policy")" = unreachable ]; then echo '-A mwan3_policy_failover --set-xmark 0x3e00/0x3f00'; else echo '-A mwan3_policy_failover --set-xmark 0x400/0x3f00'; fi ;;
  esac
}
ip() {
  case "$*" in
    *addr*) [ "$WRONG_ADDRESS" = 1 ] || echo '23: wwan3 inet 10.0.0.2/30 scope global' ;;
    *'table main'*) [ "$NO_MAIN" = 1 ] || echo 'default via 10.0.0.1 dev wwan3' ;;
    *'table 4'*) [ "$NO_TABLE" != 1 ] || [ -f "$DB/route" ] || return 0; echo 'default via 10.0.0.1 dev wwan3' ;;
  esac
}
IPT4=iptables; IPT6=iptables; DEFAULT_LOWEST_METRIC=256; MMX_MASK=0x3f00; MMX_UNREACHABLE=0x3e00
`;
  const result = spawnSync('busybox',['sh','-c',lib+'\n'+mocks+'\n'+before+'\nzbt_mwan_reconcile; zbt_mwan_reconcile'],{
    encoding:'utf8',timeout:10000,env:{...process.env,DB:d,ZBT_SYSFS:path.join(d,'sys'),ZBT_HEALTH_DIR:path.join(d,'health'),
      ZBT_MWAN_TRACK:path.join(d,'track'),ZBT_MWAN_REFRESH:path.join(d,'refresh'),MWAN3_STATUS_DIR:path.join(d,'state'),...env}
  });
  assert.ifError(result.error); assert.equal(result.status,0,result.stderr);
  return {calls:fs.existsSync(path.join(d,'calls'))?fs.readFileSync(path.join(d,'calls'),'utf8'):'',
    log:fs.existsSync(path.join(d,'log'))?fs.readFileSync(path.join(d,'log'),'utf8'):''};
}
test('online tracker with stale offline policy state repairs once, then is idempotent',()=>{
  const f=run();
  assert.equal(f.calls,'state 2_1 online\nbuild\n');
  assert.match(f.log,/action=resynchronize/);
});
test('online hotplug state with unreachable installed policy still rebuilds',()=>{
  assert.equal(run('echo online > "$DB/state/iface_state/2_1"').calls,'build\n');
});
test('healthy existing policy is left untouched',()=>{
  assert.equal(run('echo online > "$DB/state/iface_state/2_1"; echo online > "$DB/policy"').calls,'');
});
test('paused or stopped tracker with verified direct Internet receives one targeted ifup',()=>{
  for (const change of ['echo paused > "$DB/track/2_1/STATUS"',
    'echo disabled > "$DB/track/2_1/STATUS"', 'echo 0 > "$DB/track/2_1/STARTED"']) {
    const f=run(change);
    assert.equal(f.calls,'ifup 2_1\n',change);
    assert.match(f.log,/direct_health=online[\s\S]*action=tracker_ifup/);
  }
});
test('targeted recovery requires a later fresh-online pass before policy promotion',()=>{
  const f=run('echo paused > "$DB/track/2_1/STATUS"',{AUTO_ONLINE:'1'});
  assert.equal(f.calls,'ifup 2_1\nstate 2_1 online\nbuild\n');
});
test('working CM with missing netifd publication is repaired before paused MWAN setup',()=>{
  const before='echo zbtqmi > "$DB/uci/network.2_1.proto"; echo disabled > "$DB/track/2_1/STATUS"; echo 0 > "$DB/track/2_1/STARTED"';
  const f=run(before,{NO_LINK:'1',NO_TABLE:'1',AUTO_ONLINE:'1'});
  assert.equal(f.calls,'publish 2_1 4 wwan3 23\nifup 2_1\nroute 2_1 wwan3\nrules 2_1 wwan3\nstate 2_1 online\nbuild\n');
  assert.equal(run(before,{NO_LINK:'1',PUBLICATION_FAIL:'1'}).calls,'');
  assert.equal(run(before+'; echo 0 > "$DB/uci/mwan3.2_1.enabled"',{NO_LINK:'1'}).calls,'');
});
test('reported proto=none/autostart=false state uses verified kernel address after targeted rearm',()=>{
  const before='echo none > "$DB/uci/network.2_1.proto"; echo disabled > "$DB/track/2_1/STATUS"; echo 0 > "$DB/track/2_1/STARTED"';
  const f=run(before,{NO_LINK:'1',NO_NETIFD_ADDRESS:'1',LEGACY:'1',NO_TABLE:'1',AUTO_ONLINE:'1'});
  assert.equal(f.calls,'publish 2_1 4 wwan3 23\nifup 2_1\nroute 2_1 wwan3\nrules 2_1 wwan3\nstate 2_1 online\nbuild\n');
});
test('active offline, stale, dead or intentionally disabled trackers are never promoted',()=>{
  for (const change of ['echo 800 > "$DB/track/2_1/TIME"',
    'echo offline > "$DB/track/2_1/STATUS"', 'echo 2147483647 > "$DB/track/2_1/PID"',
    'echo 0 > "$DB/uci/mwan3.2_1.enabled"', 'echo 0 > "$DB/uci/qmodem.2_1.enable_dial"',
    'echo 24 > "$DB/sys/class/net/wwan3/ifindex"',
    'echo "800 wwan3 23 online online absent" > "$DB/health/2_1"',
    'echo "1000 wwan3 23 online offline online" > "$DB/health/2_1"']) assert.equal(run(change).calls,'',change);
});
test('pending user edits, missing netifd link/address or uninitialized MWAN are left alone',()=>{
  for(const env of [{PENDING:'mwan3.edit=1'},{NO_LINK:'1'},{WRONG_ADDRESS:'1'},{NO_HOOK:'1'}]) assert.equal(run('',env).calls,'',JSON.stringify(env));
});
test('missing forwarding route is repaired only from an existing main-table route',()=>{
  assert.equal(run('',{NO_TABLE:'1'}).calls,'route 2_1 wwan3\nrules 2_1 wwan3\nstate 2_1 online\nbuild\n');
  assert.equal(run('',{NO_TABLE:'1',NO_MAIN:'1'}).calls,'');
  const f=run('',{NO_TABLE:'1',ROUTE_FAIL:'1'});
  assert.doesNotMatch(f.calls,/state |build/); assert.match(f.log,/route_repair_failed/);
});
