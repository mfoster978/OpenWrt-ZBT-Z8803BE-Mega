'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const tree = process.env.MWAN3_TEST_TREE;
function shell(body, env={}) {
  const r=spawnSync('busybox',['sh','-c',body],{encoding:'utf8',timeout:5000,env:{...process.env,...env}});
  assert.ifError(r.error); assert.equal(r.status,0,r.stderr); return r.stdout.trim();
}
function fn(source,name) {
  const start=source.indexOf(name+'()');
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}\n',start)+3);
}
test('pinned MWAN resolves both Mega modem families to their published parent, not retained dynamic children',{skip:!tree},()=>{
  const common=fs.readFileSync(path.join(tree,'net/mwan3/files/lib/mwan3/common.sh'),'utf8');
  const resolve=fn(common,'mwan3_get_true_iface');
  for (const iface of ['4_1','2_1','4_1v6','2_1v6']) {
    const result=shell(resolve+`
uci() { case "$*" in *.proto) echo "$PROTO" ;; *.modem_config) echo "\${IFACE%v6}" ;; esac; }
config_get() { family=ipv4; case "$IFACE" in *v6) family=ipv6 ;; esac; }
# Simulate a retained dynamic object which still exists, but is down.
ubus() { echo '{"up":false}'; }
mwan3_get_true_iface selected "$IFACE"
echo "$selected"`,{IFACE:iface,PROTO:'zbtqmi'});
    assert.equal(result,iface);
  }
  assert.equal(shell(resolve+`
uci() { echo dhcp; }; config_get() { family=ipv4; }; ubus() { :; }
mwan3_get_true_iface selected wan; echo "$selected"`),'wan_4','ordinary dynamic WAN discovery must be preserved');
});
test('pinned targeted ifup fails honestly for unpublished netifd data instead of claiming success',{skip:!tree},()=>{
  let method=fn(fs.readFileSync(path.join(tree,'net/mwan3/files/lib/mwan3/mwan3.sh'),'utf8'),'mwan3_ifup');
  method=method.replace('/etc/init.d/mwan3 running','service_running');
  for (const up of ['0','1']) {
    const out=shell(method+`
service_running() { :; }; config_load() { :; }
mwan3_get_true_iface() { true_iface=$2; }
ubus() { echo '{}'; }; json_load() { :; }; json_get_vars() { up=$UP; l3_device=wwan8; }
env() { echo 'hotplug ifup 4_1 device=wwan8'; }
mwan3_ifup 4_1 cmd; echo result=$?`,{UP:up});
    assert.equal(out,up==='1'?'hotplug ifup 4_1 device=wwan8\nresult=0':'result=1');
  }
});
test('actual CLI dispatch propagates targeted ifup failure to the recovery caller',{skip:!tree},()=>{
  const cli=fs.readFileSync(path.join(tree,'net/mwan3/files/usr/sbin/mwan3'),'utf8');
  const dispatch=cli.slice(cli.lastIndexOf('case "$1" in'));
  const r=spawnSync('busybox',['sh','-c','mwan3_init() { :; }; ifup() { return 1; }; set -- ifup 4_1;\n'+dispatch],{encoding:'utf8',timeout:5000});
  assert.ifError(r.error); assert.equal(r.status,1,r.stderr);
});
test('pinned hotplug defers candidate promotion for either modem and family while a live trial owns maintenance',{skip:!tree},()=>{
  const hotplug=fs.readFileSync(path.join(tree,'net/mwan3/files/etc/hotplug.d/iface/15-mwan3'),'utf8');
  const guard=hotplug.slice(hotplug.indexOf('# Radio trials'),hotplug.indexOf('if [ "$MWAN3_STARTUP" != "init" ]'));
  assert.ok(guard.includes('trial_owner'));
  for(const iface of ['4_1','2_1','4_1v6','2_1v6','wan']) for(const action of ['ifup','connected','ifdown','disconnected']) {
    // Redirect only the maintenance read, leaving production event matching,
    // owner validation, kill -0 and exit behavior intact.
    const script=guard.replace(/read -r trial_owner[^\n]+/, 'trial_owner=$OWNER');
    const output=shell('LOG() { :; };\n'+script+'\necho proceed', {INTERFACE:iface,ACTION:action,OWNER:String(process.pid)});
    assert.equal(output,iface!=='wan'&&['ifup','connected'].includes(action)?'':'proceed',iface+':'+action);
    assert.equal(shell('LOG() { :; };\n'+script+'\necho proceed',{INTERFACE:iface,ACTION:action,OWNER:'2147483647'}),'proceed','dead worker must not strand WAN');
  }
});
