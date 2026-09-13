'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'https://raw.githubusercontent.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE/edc738504fe8fae81eb15de967456204699b1830/';
module.exports = async function(root, tmp, run) {
  const names = [
    'target/linux/mediatek/patches-6.12/031-v6.14-arm64-dts-mediatek-mt7988-Add-pcie-nodes.patch',
    'target/linux/mediatek/patches-6.12/966-pcie-mediatek-gen3-Add-WIFI-HW-reset-flow.patch',
    'target/linux/mediatek/dts/mt7988a-zbtlink-zbt-z8803be.dts'
  ];
  const [nodes, reset, board] = await Promise.all(names.map(async name => {
    const response = await fetch(base + name, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, name); return response.text();
  }));
  // The pinned 031 patch adds the complete four nodes. Exercise the new
  // clock patch against those exact node bodies, not a fabricated DTSI.
  const original = nodes.split('\n').filter(line => line[0] === '+' && line[1] !== '+').map(line => line.slice(1)).join('\n') + '\n';
  const tree = path.join(tmp, 'pcie');
  const file = path.join(tree, 'arch/arm64/boot/dts/mediatek/mt7988a.dtsi');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original);
  const patch = fs.readFileSync(path.join(root, 'firmware/kernel-patches/967-arm64-dts-mt7988-pcie-external-clocks.patch'), 'utf8');
  run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });
  const result = fs.readFileSync(file, 'utf8');
  assert.equal((result.match(/"pextp_clk"/g) || []).length, 4);
  for (const [address, index] of [['11280000', 2], ['11290000', 3], ['11300000', 0], ['11310000', 1]]) {
    const node = result.split('pcie@' + address + ' {')[1].split('pinctrl-names')[0];
    assert.match(node, new RegExp('CLK_TOP_PEXTP_P' + index + '_SEL'));
    assert.equal((node.match(/<&/g) || []).length, 5, 'four infrastructure clocks plus one external clock');
  }
  run('patch', ['--force', '--fuzz=0', '--reverse', '-p1', '-d', tree], { input: patch });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.match(reset, /gpiod_set_value_cansleep\(pcie->wifi_reset, 1\)/);
  assert.match(reset, /msleep\(pcie->wifi_reset_delay_ms\)/);
  assert.match(reset, /gpiod_set_value_cansleep\(pcie->wifi_reset, 0\)/);
  assert.match(board, /&pcie3 \{[\s\S]*?wifi-reset-gpios = <&pio 7 GPIO_ACTIVE_LOW>;[\s\S]*?wifi-reset-msleep = <100>;/);
  assert.match(board, /nvmem-cells = <&eeprom_factory_0>;/);
  console.log('All four PCIe external clocks verified; inherited reset flow/GPIO7/EEPROM retained');
};
