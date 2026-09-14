'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../files/www/luci-static/resources/view/network/quick-wifi.js'), 'utf8');
  const boundary = source.indexOf('\nreturn view.extend({');
  const devices = [
    { '.name': 'radioA', band: '2g' },
    { '.name': 'radioB', band: '5g' },
    { '.name': 'radioC', band: '6g' }
  ];
  const ifaces = [
    { '.name': 'default_radioA', mode: 'ap', device: 'radioA', network: 'lan', ssid: 'Legacy', encryption: 'psk2', key: 'legacy-pass', disabled: '0' },
    { '.name': 'default_radioB', mode: 'ap', device: 'radioB', network: 'lan', ssid: 'Fostah Logistics', encryption: 'sae', key: 'mlo-pass-1', disabled: '0' },
    { '.name': 'default_radioC', mode: 'ap', device: 'radioC', network: 'lan', ssid: 'Fostah Logistics', encryption: 'sae', key: 'mlo-pass-1', disabled: '0' },
    { '.name': 'mld_primary', mode: 'ap', device: ['radioB','radioC'], network: 'lan', ssid: 'Fostah Logistics', encryption: 'sae', key: 'mlo-pass-1', mlo: '1', disabled: '0' },
    { '.name': 'guest', mode: 'ap', device: 'radioC', network: 'guest', ssid: 'Fostah Logistics', encryption: 'sae', key: 'guest-pass', disabled: '0' }
  ];
  let saves=0, applies=0;
  const uci = {
    sections(config, type) { return (type === 'wifi-device' ? devices : ifaces).slice(); },
    get(config, section, option) { return devices.concat(ifaces).find(x => x['.name']===section)?.[option]; },
    set(config, section, option, value) { const row=devices.concat(ifaces).find(x => x['.name']===section); assert.ok(row); row[option]=value; },
    unset(config, section, option) { const row=devices.concat(ifaces).find(x => x['.name']===section); delete row[option]; },
    save() { saves++; return Promise.resolve(); }
  };
  const ui = { changes: { apply() { applies++; return Promise.resolve(); } } };
  const api = new Function('uci','ui','TextEncoder', source.slice(0,boundary) + '\nreturn {quickWifiTargets,quickWifiMloState,mloStandaloneConflicts,applyQuickWifi};')(uci,ui,TextEncoder);
  return {api, ifaces, counts:()=>({saves,applies})};
}

test('keeps legacy separate and disables exact 5/6 duplicates', async () => {
  const {api,ifaces,counts}=fixture();
  const targets=api.quickWifiTargets();
  assert.deepEqual(targets.byBand,{'2g':'default_radioA','5g':'mld_primary','6g':'mld_primary'});
  const state=api.quickWifiMloState(targets);
  assert.equal(state.activeMlo,true);
  assert.equal(state.legacyEnabled,true);
  assert.equal(state.sharedName,false);
  assert.deepEqual(api.mloStandaloneConflicts(targets,'Fostah Logistics'),['default_radioB','default_radioC']);
  await api.applyQuickWifi(targets,'Fostah Logistics','new-mlo-password',{shareLegacy:false});
  const legacy=ifaces.find(x=>x['.name']==='default_radioA');
  const mld=ifaces.find(x=>x['.name']==='mld_primary');
  assert.equal(legacy.ssid,'Legacy');
  assert.equal(legacy.key,'legacy-pass');
  assert.equal(legacy.encryption,'psk2');
  assert.equal(mld.ssid,'Fostah Logistics');
  assert.equal(mld.key,'new-mlo-password');
  assert.equal(ifaces.find(x=>x['.name']==='default_radioB').disabled,'1');
  assert.equal(ifaces.find(x=>x['.name']==='default_radioC').disabled,'1');
  assert.equal(ifaces.find(x=>x['.name']==='guest').disabled,'0');
  assert.deepEqual(counts(),{saves:1,applies:1});
});

test('can deliberately share legacy name/password without changing security', async () => {
  const {api,ifaces}=fixture();
  // Avoid duplicate AP warning path by starting secondaries disabled.
  ifaces.find(x=>x['.name']==='default_radioB').disabled='1';
  ifaces.find(x=>x['.name']==='default_radioC').disabled='1';
  const targets=api.quickWifiTargets();
  await api.applyQuickWifi(targets,'One Network','SharedPass123',{shareLegacy:true});
  const legacy=ifaces.find(x=>x['.name']==='default_radioA');
  const mld=ifaces.find(x=>x['.name']==='mld_primary');
  assert.equal(legacy.ssid,'One Network');
  assert.equal(legacy.key,'SharedPass123');
  assert.equal(legacy.encryption,'psk2');
  assert.equal(mld.ssid,'One Network');
  assert.equal(mld.key,'SharedPass123');
  assert.equal(mld.encryption,'sae');
  const state=api.quickWifiMloState(api.quickWifiTargets());
  assert.equal(state.sharedCredentials,true);
});
