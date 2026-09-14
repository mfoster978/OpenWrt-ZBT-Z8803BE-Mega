'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const builder = fs.readFileSync(path.join(root, 'firmware/docker/build-openwrt.sh'), 'utf8');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...options });
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  return result;
}
function block(startText, endText) {
  const start = builder.indexOf(startText), end = builder.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, 'build integration block was not found');
  return builder.slice(start, end);
}
const mloBlock = block('# Later patches refine the shared writer.', 'grep -Eq "uci.set');
const wirelessBlock = block('wireless_mlo_patch=', '# Strict userspace-only patch');
for (const state of ['fresh', 'previous-release', 'current-release']) {
  test(`actual MLO build patch block handles ${state} cache twice without losing changes`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mlo-cache-'));
    try {
      const relative = 'htdocs/luci-static/resources/view/mlo/main.js';
      const packageRoot = path.join(dir, 'package/luci-app-mlo');
      const file = path.join(packageRoot, relative);
      const expected = fs.readFileSync(path.join(process.env.MLO_TEST_TREE, relative));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, expected);
      const reverse = [];
      if (state !== 'current-release') reverse.push('luci-app-mlo-safe-edit.patch');
      if (state === 'fresh') reverse.push('luci-app-mlo-shared-iface.patch');
      for (const name of reverse)
        run('patch', ['--force', '--fuzz=0', '--reverse', '-p1', '-d', packageRoot], {
          input: fs.readFileSync(path.join(root, 'firmware/patches', name), 'utf8')
        });
      fs.writeFileSync(path.join(packageRoot, 'owner-file'), 'preserve unrelated files');
      for (let pass = 0; pass < 2; pass++) {
        run('bash', ['-euc', mloBlock], { cwd: dir,
          env: { ...process.env, FILES_OVERLAY_DIR: path.join(root, 'firmware/files') } });
        assert.deepEqual(fs.readFileSync(file), expected);
        assert.equal(fs.readFileSync(path.join(packageRoot, 'owner-file'), 'utf8'), 'preserve unrelated files');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
test('actual Wireless patch block recognizes both fresh and already-patched LuCI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-wireless-cache-'));
  try {
    const relative = 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js';
    const feed = path.join(dir, 'feeds/luci');
    const file = path.join(feed, relative);
    const expected = fs.readFileSync(path.join(process.env.WIRELESS_TEST_TREE, relative));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, expected);
    run('patch', ['--force', '--fuzz=0', '--reverse', '-p1', '-d', feed], {
      input: fs.readFileSync(path.join(root, 'firmware/patches/luci-wireless-mlo-toggle.patch'), 'utf8')
    });
    for (let pass = 0; pass < 2; pass++) {
      run('bash', ['-euc', wirelessBlock], { cwd: dir,
        env: { ...process.env, FILES_OVERLAY_DIR: path.join(root, 'firmware/files') } });
      assert.deepEqual(fs.readFileSync(file), expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
