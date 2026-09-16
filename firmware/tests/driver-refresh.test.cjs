'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const wrapperPath = path.join(root, 'firmware/docker/build-openwrt-driver-refresh.sh');
const normalBuilderPath = path.join(root, 'firmware/docker/build-openwrt.sh');
const qmiPatchPath = path.join(root, 'firmware/kernel-patches/762-net-usb-qmi-wwan-rx-urb-size.patch');

function file(p) { return fs.readFileSync(p, 'utf8'); }

test('driver refresh wrapper is syntactically valid and pinned', () => {
  const check = spawnSync('bash', ['-n', wrapperPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const wrapper = file(wrapperPath);
  assert.match(wrapper, /MT76_OLD_VERSION=39c960c3ada558b4c2e7915772483d3731573d09/);
  assert.match(wrapper, /MT76_NEW_VERSION=be5ce7910521492d4a2e4ce7ee3843680a46c047/);
  assert.match(wrapper, /MT76_NEW_DATE=2026-09-01/);
  assert.match(wrapper, /MT76_NEW_HASH=d1d0f7588c5b9ceafcac341ce19dd206ed9ec106847e672ab77e48bacb57f81a/);
  assert.match(wrapper, /762-zbt-qmi-wwan-rx-urb-size\.patch/);
  assert.match(wrapper, /rm -f package\/kernel\/mt76\/patches\/999-zbt-mt7996-ps-buffering\.patch/);
  assert.match(wrapper, /999-zbt-mt7996-ps-zlegacy-followup\.patch/);
  assert.match(wrapper, /normal build recipe mt76 backport block changed; refusing an unreviewed refresh/);
});

test('normal production builder remains unchanged by experimental refresh', () => {
  const normal = file(normalBuilderPath);
  assert.match(normal, /The pinned 2026-03-19 mt76 snapshot predates upstream MT7996 hardware power-/);
  assert.match(normal, /mt76-mt7996-ps-buffering\.patch/);
  assert.match(normal, /mt76-mt7996-legacy-client-followup\.patch/);
  assert.doesNotMatch(normal, /be5ce7910521492d4a2e4ce7ee3843680a46c047/);
});

test('QMI patch is the narrow upstream receive-URB fix', () => {
  const patch = file(qmiPatchPath);
  assert.match(patch, /Upstream commit: 55f854dd5bdd8e19b936a00ef1f8d776ac32c7b0/);
  assert.match(patch, /--- a\/drivers\/net\/usb\/qmi_wwan\.c/);
  assert.match(patch, /--- a\/drivers\/net\/usb\/usbnet\.c/);
  assert.match(patch, /--- a\/include\/linux\/usb\/usbnet\.h/);
  assert.match(patch, /FLAG_WWAN \| FLAG_NOMAXMTU \| FLAG_SEND_ZLP/);
  assert.match(patch, /#define FLAG_NOMAXMTU\s+0x10000/);
  assert.doesNotMatch(patch, /cdc_mbim|rndis|mhi|option\.c/);
});

test('wrapper preserves clean source identity and cleans generated builders on success and failure', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-refresh-wrapper-'));
  const recipe = path.join(temp, 'recipe with spaces');
  const openwrt = path.join(temp, 'openwrt');
  const scratch = path.join(temp, 'scratch');
  function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  }
  function write(relative, contents) {
    const target = path.join(recipe, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  function init(directory) {
    run('git', ['init', '-q', directory]);
    run('git', ['config', 'user.name', 'Fixture'], directory);
    run('git', ['config', 'user.email', 'fixture@example.invalid'], directory);
    run('git', ['add', '.'], directory);
    run('git', ['commit', '-qm', 'fixture'], directory);
    return run('git', ['rev-parse', 'HEAD'], directory);
  }
  try {
    fs.mkdirSync(scratch, { recursive: true });
    write('firmware/docker/build-openwrt-driver-refresh.sh', file(wrapperPath));
    write('firmware/kernel-patches/762-net-usb-qmi-wwan-rx-urb-size.patch', file(qmiPatchPath));
    write('firmware/scripts/mega-release.py', file(path.join(root, 'firmware/scripts/mega-release.py')));
    for (const name of ['mac80211-airtime', 'mac80211-fils-link', 'mac80211-probe-link', 'mt76-6.18-compat'])
      write('firmware/patches/driver-refresh-' + name + '.patch', file(path.join(root, 'firmware/patches/driver-refresh-' + name + '.patch')));
    write('firmware/docker/build-openwrt.sh', `#!/bin/bash
set -euo pipefail
RECIPE_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$OPENWRT_ROOT"
# The pinned 2026-03-19 mt76 snapshot predates upstream MT7996 hardware power-
echo 'this retired backport block must not execute' >&2
exit 99
# mt76's throttle uses the paired mac80211 AQL query
python3 "$RECIPE_ROOT/firmware/scripts/mega-release.py" identity --repository-root "$RECIPE_ROOT" --version firmware-202609150000.1 --output "$OPENWRT_ROOT/identity.json"
exit "\${FIXTURE_EXIT:-0}"
`);
    init(recipe);
    fs.mkdirSync(path.join(openwrt, 'package/kernel/mt76'), { recursive: true });
    fs.mkdirSync(path.join(openwrt, 'package/kernel/mac80211'), { recursive: true });
    fs.writeFileSync(path.join(openwrt, 'package/kernel/mac80211/Makefile'),
      'PKG_VERSION:=6.18.7\nPKG_HASH:=623e5cf46ca8e81fd413f4f465e2580a0143e24929f9c22ce1ba7c34f2872989\n');
    fs.writeFileSync(path.join(openwrt, 'package/kernel/mt76/Makefile'),
      'PKG_RELEASE=2\nPKG_SOURCE_DATE:=2026-03-19\nPKG_SOURCE_VERSION:=39c960c3ada558b4c2e7915772483d3731573d09\nPKG_MIRROR_HASH:=7a9f8ea21eee5324e6638ace627dd305b3650ae6ca86109317d9ee83702140eb\n');
    const baseSha = init(openwrt);
    for (const expectedExit of [0, 42, 0]) {
      const result = spawnSync('bash', [path.join(recipe, 'firmware/docker/build-openwrt-driver-refresh.sh')], {
        env: { ...process.env, OPENWRT_ROOT: openwrt, EXPECTED_OPENWRT_COMMIT: baseSha,
          ALLOW_CLONE_OPENWRT: '0', TMPDIR: scratch, FIXTURE_EXIT: String(expectedExit) },
        encoding: 'utf8', timeout: 15000
      });
      assert.equal(result.status, expectedExit, result.stderr + result.stdout);
      assert.equal(run('git', ['status', '--porcelain'], recipe), '', 'generated build must not dirty recipe');
      assert.deepEqual(fs.readdirSync(scratch), [], 'temporary builder must be removed after either exit status');
      const identity = JSON.parse(fs.readFileSync(path.join(openwrt, 'identity.json'), 'utf8'));
      assert.equal(identity.dirty, false);
      assert.equal(identity.source_sha, run('git', ['rev-parse', 'HEAD'], recipe));
      assert.equal(fs.readFileSync(path.join(openwrt, 'target/linux/generic/backport-6.12/762-zbt-qmi-wwan-rx-urb-size.patch'), 'utf8'), file(qmiPatchPath));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('compatibility patches apply exactly and retain per-link discovery, airtime notifications and frame bounds', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-refresh-api-'));
  const mac = path.join(temp, 'mac80211');
  const mt76 = path.join(temp, 'mt76');
  function apply(tree, patch) {
    for (const dry of [true, false]) {
      const result = spawnSync('patch', [...(dry ? ['--dry-run'] : []), '--batch', '--fuzz=0', '--forward', '-p1', '-d', tree],
        { input: patch, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
    }
  }
  try {
    for (const [tree, base, names] of [
      [mac, 'https://raw.githubusercontent.com/gregkh/linux/v6.18.7/', ['mac80211-airtime', 'mac80211-fils-link', 'mac80211-probe-link']],
      [mt76, 'https://raw.githubusercontent.com/openwrt/mt76/be5ce7910521492d4a2e4ce7ee3843680a46c047/', ['mt76-6.18-compat']]
    ]) {
      const patches = names.map(name => file(path.join(root, 'firmware/patches/driver-refresh-' + name + '.patch')));
      const files = [...new Set(patches.flatMap(patch => [...patch.matchAll(/^--- a\/(.+)$/gm)].map(match => match[1])))];
      await Promise.all(files.map(async name => {
        const response = await fetch(base + name, { signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200, base + name);
        const target = path.join(tree, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await response.text());
      }));
      patches.forEach(patch => apply(tree, patch));
      // Verify strict reversibility, then restore for behavior assertions.
      for (const patch of [...patches].reverse()) {
        const result = spawnSync('patch', ['--force', '--fuzz=0', '--reverse', '-p1', '-d', tree],
          { input: patch, encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr + result.stdout);
      }
      patches.forEach(patch => apply(tree, patch));
    }
    const tx = file(path.join(mac, 'net/mac80211/tx.c'));
    for (const name of ['ieee80211_get_fils_discovery_tmpl', 'ieee80211_get_unsol_bcast_probe_resp_tmpl']) {
      const body = tx.slice(tx.indexOf(name + '('), tx.indexOf('EXPORT_SYMBOL(' + name + ')'));
      assert.match(body, /link_id >= IEEE80211_MLD_MAX_NUM_LINKS/);
      assert.match(body, /guard\(rcu\)\(\)/);
      assert.match(body, /rcu_dereference\(sdata->link\[link_id\]\)/);
      assert.doesNotMatch(body, /sdata->deflink/);
    }
    assert.match(file(path.join(mac, 'include/net/mac80211.h')), /\(\*sta_set_airtime_weight\)/);
    for (const name of ['cfg.c', 'driver-ops.c', 'sta_info.c'])
      assert.match(file(path.join(mac, 'net/mac80211', name)), /drv_sta_set_airtime_weight/);
    assert.match(file(path.join(mt76, 'mt7996/mac.c')), /offsetofend\(struct ieee80211_mgmt,\s*u\.action\.u\.addba_req\.action_code\)/);
    assert.match(file(path.join(mt76, 'mt76_connac_mac.c')), /offsetofend\(struct ieee80211_mgmt,\s*u\.action\.u\.addba_req\.capab\)/);
    const mcu = file(path.join(mt76, 'mt76_connac_mcu.c'));
    assert.doesNotMatch(mcu, /NL80211_IFTYPE_NAN_DATA/);
    for (const type of ['AP', 'STATION', 'MESH_POINT', 'NAN']) assert.match(mcu, new RegExp('case NL80211_IFTYPE_' + type + ':'));
    assert.doesNotMatch(file(normalBuilderPath), /driver-refresh-(mac80211|mt76)/, 'production builder must not install experimental compatibility patches');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
