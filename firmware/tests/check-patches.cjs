'use strict';
// Download only the exact public, pinned source files that our patches
// modify, apply in an isolated temporary tree, and exercise the result.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zbt-pinned-patches-'));
const specs = [
  ['qmodem-firstboot', '0xFar5eer/openwrt25.12_ZBT_Z8803BE', 'edc738504fe8fae81eb15de967456204699b1830', 'zbt-qmodem-rpc-firstboot.patch', ''],
  ['qmodem', 'FUjr/QModem', 'a8b8a63e5b0853c79d2ad3f1ebbb673a724872bf', ['qmodem-dual-runtime.patch', 'qmodem-cell-discovery.patch', 'qmodem-5g-deployment.patch', 'qmodem-performance-ui.patch', 'qmodem-mega-policy-ui.patch', 'qmodem-connectivity-v5.patch', 'qmodem-at-transport-v6.patch', 'qmodem-radio-rpc-v6.patch', 'qmodem-session-lifecycle-v7.patch', 'qmodem-adaptive-v8.patch', 'qmodem-health-v9.patch', 'qmodem-netifd-serialization-v10.patch', 'qmodem-netifd-arming-v11.patch', 'qmodem-netifd-disabled-v12.patch', 'qmodem-adaptive-safety-v13.patch', 'qmodem-fixed-slot-state-v14.patch', 'qmodem-fixed-slot-dial-v15.patch', 'qmodem-network-apply-v16.patch'], ''],
  ['mt76', 'openwrt/mt76', '39c960c3ada558b4c2e7915772483d3731573d09', ['mt76-mt7996-ps-buffering.patch', 'mt76-mt7996-legacy-client-followup.patch'], ''],
  ['wifi-firstboot', '0xFar5eer/openwrt25.12_ZBT_Z8803BE', 'edc738504fe8fae81eb15de967456204699b1830', 'zbt-wifi-firstboot-v7.patch', ''],
  ['packages', 'openwrt/packages', 'db3b315119519f9194dad8aa668aa40618df9b20', ['mwan3-speed-policy.patch', 'mwan3-mega-lifecycle.patch'], ''],
  ['mwan3-luci', 'openwrt/luci', 'a611522a2bfc24ca2625e8cd2fcc9404288532a6', 'luci-app-mwan3-route-metric.patch', ''],
  ['luci-first-login', 'openwrt/luci', 'a611522a2bfc24ca2625e8cd2fcc9404288532a6', 'luci-first-login-password.patch', ''],
  ['luci-resource-version', 'openwrt/luci', 'a611522a2bfc24ca2625e8cd2fcc9404288532a6', 'luci-mega-resource-version.patch', ''],
  ['luci-wireless', 'openwrt/luci', 'a611522a2bfc24ca2625e8cd2fcc9404288532a6', 'luci-wireless-mlo-toggle.patch', ''],
  ['argon-mobile', 'immortalwrt/luci', '2a84422e7c999d038b36b9555ba5a3abc4adaa4b', 'luci-theme-argon-mega-mobile.patch', ''],
  ['ksmbd', 'openwrt/packages', 'db3b315119519f9194dad8aa668aa40618df9b20', 'ksmbd-server-disabled.patch', 'net/ksmbd-tools/'],
  ['ksmbd-luci', 'openwrt/luci', 'a611522a2bfc24ca2625e8cd2fcc9404288532a6', 'luci-app-ksmbd-enable-toggle.patch', 'applications/luci-app-ksmbd/'],
  ['mlo', '0xFar5eer/openwrt25.12_ZBT_Z8803BE', 'edc738504fe8fae81eb15de967456204699b1830', ['luci-app-mlo-shared-iface.patch', 'luci-app-mlo-safe-edit.patch'], 'package/luci-app-mlo/']
];
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, ...options });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${command}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
(async () => {
  await require('./check-ethernet-leds.cjs')(root, tmp, run);
  await require('./pcie-clocks.cjs')(root, tmp, run);
  const dtsURL = 'https://raw.githubusercontent.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE/edc738504fe8fae81eb15de967456204699b1830/target/linux/mediatek/dts/mt7988a-zbtlink-zbt-z8803be.dts';
  const response = await fetch(dtsURL, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  const dts = await response.text();
  assert.match(dts, /gpio-export,name = "5g1";\s*gpio-export,output = <1>;\s*gpios = <&pio 17 GPIO_ACTIVE_HIGH>/);
  assert.match(dts, /gpio-export,name = "5g2";\s*gpio-export,output = <0>;\s*gpios = <&pio 52 GPIO_ACTIVE_HIGH>/);
  assert.match(dts, /function-enumerator = <1>;\s*gpios = <&pio 61 GPIO_ACTIVE_LOW>/);
  assert.match(dts, /function-enumerator = <2>;\s*gpios = <&pio 53 GPIO_ACTIVE_LOW>/);
  console.log('Pinned board modem power and LED GPIO definitions verified (unchanged)');
  for (const [name, repo, commit, patchSpec, prefix] of specs) {
    const patchNames = Array.isArray(patchSpec) ? patchSpec : [patchSpec];
    const patches = patchNames.map(patchName => fs.readFileSync(path.join(root, 'firmware/patches', patchName), 'utf8'));
    const tree = path.join(tmp, name);
    const files = [...new Set(patches.flatMap(patch => [...patch.matchAll(/^--- a\/(.+)$/gm)].map(m => m[1])))];
    if (name === 'qmodem-firstboot') files.push('target/linux/mediatek/filogic/base-files/etc/uci-defaults/56-zbt-qmodem-soft-reboot-overlay');
    if (name === 'luci-resource-version') {
      // Test the real pinned apply lifecycle, whose API returns no completion
      // Promise. A Promise-only stub would hide premature service reloads.
      files.push('modules/luci-base/htdocs/luci-static/resources/luci.js',
        'modules/luci-base/htdocs/luci-static/resources/ui.js',
        'modules/luci-base/src/jsmin.c');
    }
    if (name === 'qmodem') {
      files.push('application/qmodem/files/etc/init.d/qmodem_network');
      for (const file of ['main.h', 'operations.c', 'operations.h', 'transport.c', 'transport.h',
        'ttydevice.c', 'ttydevice.h', 'modem_types.h', 'extlib/pdu.c', 'extlib/pdu.h', 'extlib/ucs2_to_utf8.c'])
        files.push('application/tom_modem/src/' + file);
    }
    await Promise.all(files.map(async p => {
      assert.ok(!p.includes('..') && /^[a-zA-Z0-9_/.+-]+$/.test(p));
      const response = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${prefix}${p}`, { signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200, p);
      fs.mkdirSync(path.dirname(path.join(tree, p)), { recursive: true });
      fs.writeFileSync(path.join(tree, p), await response.text());
    }));
    for (const patch of patches) {
      run('patch', ['--dry-run', '--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });
      run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });
    }
    // Dependent patches can intentionally refine lines introduced by an
    // earlier patch. Verify reversibility in stack order, then restore the
    // patched tree used by the behavioral tests below.
    for (const patch of [...patches].reverse()) {
      run('patch', ['--dry-run', '--batch', '--fuzz=0', '--reverse', '-p1', '-d', tree], { input: patch });
      run('patch', ['--batch', '--fuzz=0', '--reverse', '-p1', '-d', tree], { input: patch });
    }
    for (const patch of patches) {
      if (name === 'qmodem' && patch === patches.at(-1)) {
        // A cache from the preceding release has all but the newest patch.
        // GNU patch --batch -R guesses forward here unless --force is used.
        const absent = spawnSync('patch', ['--dry-run', '--force', '--fuzz=0', '--reverse', '-p1', '-d', tree],
          { input: patch, encoding: 'utf8' });
        assert.notEqual(absent.status, 0, 'absent latest patch must not be applied while reversing a cached build');
      }
      run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });
    }
    for (const p of files) {
      const contents = fs.readFileSync(path.join(tree, p), 'utf8');
      if (p.endsWith('.js')) new Function(contents);
      else if (p.endsWith('.json')) JSON.parse(contents);
      else if (contents.startsWith('#!/bin/sh')) run('busybox', ['sh', '-n', path.join(tree, p)]);
    }
    if (name === 'luci-first-login') {
      const dispatcher = fs.readFileSync(path.join(tree, 'modules/luci-base/ucode/dispatcher.uc'), 'utf8');
      const password = fs.readFileSync(path.join(tree, 'modules/luci-mod-system/htdocs/luci-static/resources/view/system/password.js'), 'utf8');
      assert.match(dispatcher, /password'\) \+ '\?first=1'/, 'forced setup route carries a one-time completion marker');

      let formData;
      let replacement = '';
      let renderCalls = 0;
      function Value() {}
      Value.prototype.renderWidget = function() {};
      const form = {
        NamedSection: function() {}, Value,
        JSONMap: function(data) {
          formData = data;
          this.section = () => ({ option: () => ({}) });
          this.render = () => Promise.resolve();
        }
      };
      const dom = { callClassMethod: (node, method) => {
        if (method === 'render') renderCalls++;
        return Promise.resolve();
      } };
      const ui = { addNotification: () => {} };
      const rpc = { declare: () => (username, value) => Promise.resolve(username === 'root' && value === 'Good-password-1!') };
      const location = { search: '?first=1', replace: target => { replacement = target; } };
      const passwordView = new Function('view', 'dom', 'ui', 'form', 'rpc', 'E', '_', 'L', 'window', 'document', password)(
        { extend: value => value }, dom, ui, form, rpc, () => ({}), value => value,
        { hasViewPermission: () => true, url: (...parts) => '/cgi-bin/luci/' + parts.join('/') },
        { location }, { querySelector: () => ({}) }
      );
      passwordView.render();
      formData.password.pw1 = formData.password.pw2 = 'Good-password-1!';
      await passwordView.handleSave();
      assert.equal(replacement, '/cgi-bin/luci/admin/about', 'successful required password continues to About');
      assert.equal(renderCalls, 0, 'completed setup is not rendered again before navigation');

      replacement = '';
      location.search = '';
      formData.password.pw1 = formData.password.pw2 = 'Good-password-1!';
      await passwordView.handleSave();
      assert.equal(replacement, '/cgi-bin/luci/admin/about', 'ordinary successful password changes also continue to About');
      assert.equal(renderCalls, 0, 'a successful save is never rendered again before navigation');
    }
    console.log(`${name}: exact pinned patch, reverse/idempotence check and syntax passed (${commit})`);
    if (name === 'qmodem-firstboot') require('./qmodem-firstboot.cjs')(root, tree, run);
    if (name === 'wifi-firstboot') require('./wifi-firstboot.cjs')(root, tree, run);
    if (name === 'qmodem') {
      const init = fs.readFileSync(path.join(tree, 'application/qmodem/files/etc/init.d/qmodem_init'), 'utf8');
      const dial = fs.readFileSync(path.join(tree, 'application/qmodem/files/usr/share/qmodem/modem_dial.sh'), 'utf8');
      assert.match(init, /4-1\|2-1\) logger -t modem_init "fixed modem slot \$slot not enumerated yet/,
        'late fixed-slot enumeration must not persist discovery-disabled state');
      assert.match(dial, /4_1\|2_1\) state_fullfill=1/,
        'fixed-slot dial readiness must use enable_dial rather than transient discovery state');
      assert.match(dial, /case "\$modem_config" in[\s\S]*4_1\|2_1\)[\s\S]*dial;;[\s\S]*case "\$state" in/,
        'fixed-slot final dial dispatch must not turn a retry into hang for stale discovery state');
      const dispatch = dial.slice(dial.lastIndexOf('case "$2" in'));
      const dispatchOutput = run('busybox', ['sh', '-c', `
state=disabled
hang() { echo hang; }
dial() { echo dial; }
update_config() { :; }
set -- 4_1 dial
modem_config=$1
${dispatch}
set -- external dial
modem_config=$1
${dispatch}
`]);
      assert.equal(dispatchOutput, 'dial\nhang\n',
        'stale fixed slot dials while an unrelated disabled QModem section still hangs');
      assert.doesNotMatch(dial.slice(dial.indexOf('for logical in 4_1'), dial.indexOf('if [ "$firewall_reload_flag"')),
        /qmodem\.\$[^\n]*\.state/,
        'netifd re-arm must not reject a live fixed slot because discovery state is stale');
      const source = path.join(tree, 'application/tom_modem/src');
      const binary = path.join(tmp, 'tom_modem');
      run('gcc', ['-o', binary, ...['main.c', 'utils.c', 'operations.c', 'transport.c', 'ttydevice.c',
        'extlib/pdu.c', 'extlib/ucs2_to_utf8.c'].map(file => path.join(source, file)), '-pthread']);
      process.stdout.write(run('python3', [path.join(__dirname, 'tom-modem-transport.py'), binary]));
    }
    if (name === 'mt76') {
      const header = fs.readFileSync(path.join(tree, 'mt76.h'), 'utf8');
      const mcu = fs.readFileSync(path.join(tree, 'mt7996/mcu.c'), 'utf8');
      const tx = fs.readFileSync(path.join(tree, 'tx.c'), 'utf8');
      assert.match(header, /MT_DRV_HW_PS_BUFFERING/, 'mt76 exposes hardware PS buffering capability');
      assert.match(mcu, /MCU_UNI_EVENT_PS_SYNC/, 'MT7996 consumes firmware power-save transitions');
      assert.match(tx, /starving all other stations/,
        'an undrainable sleeping client cannot starve all radio queues');
      assert.match(tx, /more_data \|= mt76_ps_tids_pending/,
        'buffered-frame release preserves the more-data indication');
      assert.match(tx, /IEEE80211_QOS_CTL_EOSP/,
        'the final U-APSD frame closes the client service period on air');
      assert.match(tx, /ieee80211_is_disassoc/,
        'disassociation frames bypass stale per-station hardware queues');
      const main = fs.readFileSync(path.join(tree, 'mt7996/main.c'), 'utf8');
      assert.match(main, /wcid\.tx_info &= ~MT_WCID_TX_INFO_SET/,
        'MT7996 clears stale station queue state before disconnect teardown');
    }
  }
  const result = run(process.execPath, ['--test', path.join(__dirname, 'mwan-reconcile.test.cjs'), path.join(__dirname, 'mwan-apply.test.cjs'), path.join(__dirname, 'modem-health.test.cjs'), path.join(__dirname, 'adaptive.test.cjs'), path.join(__dirname, 'speedify-routing.test.cjs'), path.join(__dirname, 'speedify-control.test.cjs'), path.join(__dirname, 'runtime.test.cjs'), path.join(__dirname, 'qmi-session.test.cjs'), path.join(__dirname, 'qmi-publish.test.cjs'), path.join(__dirname, 'qmodem-network-apply.test.cjs'), path.join(__dirname, 'connectivity.test.cjs'), path.join(__dirname, 'led-labels.test.cjs'), path.join(__dirname, 'ttl.test.cjs'), path.join(__dirname, 'bands.test.cjs'), path.join(__dirname, 'band-ui.test.cjs'), path.join(__dirname, 'mlo-ui.test.cjs'), path.join(__dirname, 'quick-wifi-ui.test.cjs')], {
    env: {
      ...process.env,
      QMODEM_TEST_TREE: path.join(tmp, 'qmodem'),
      LUCI_TEST_TREE: path.join(tmp, 'luci-resource-version'),
      MWAN3_TEST_TREE: path.join(tmp, 'packages'),
      MWAN3_LUCI_TEST_TREE: path.join(tmp, 'mwan3-luci'),
      MLO_TEST_TREE: path.join(tmp, 'mlo')
    }
  });
  process.stdout.write(result);
  process.stdout.write(run(process.execPath, ['--test', path.join(__dirname, 'wireless-mlo-toggle.test.cjs'), path.join(__dirname, 'wifi-build-cache.test.cjs')], {
    env: { ...process.env, WIRELESS_TEST_TREE: path.join(tmp, 'luci-wireless'), LUCI_TEST_TREE: path.join(tmp, 'luci-resource-version'), MLO_TEST_TREE: path.join(tmp, 'mlo') }
  }));
  process.stdout.write(run(process.execPath, ['--test',
    path.join(__dirname, 'modem-usb-reset.test.cjs'),
    path.join(__dirname, 'modem-usb-reset-write-effect.test.cjs'),
    path.join(__dirname, 'qmi-publish-scope.test.cjs')
  ]));
  process.stdout.write(run(process.execPath, ['--test', path.join(__dirname, 'mwan-lifecycle.test.cjs')], {
    env: {...process.env, MWAN3_TEST_TREE:path.join(tmp,'packages')}
  }));
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
