'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
