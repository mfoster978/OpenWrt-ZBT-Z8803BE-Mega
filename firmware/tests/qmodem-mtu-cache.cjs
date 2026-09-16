'use strict';
// Run the actual builder cache-cleanup block against real isolated Git trees.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
module.exports = function(root, patchedTree, patches, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mtu-cache-'));
  try {
    const tree = path.join(tmp, 'feeds/qmodem');
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    fs.cpSync(patchedTree, tree, { recursive: true });
    for (const patch of [...patches].reverse())
      run('patch', ['--force', '--fuzz=0', '--reverse', '-p1', '-d', tree], { input: patch });
    run('git', ['init', '-q', tree]);
    run('git', ['-C', tree, 'add', '.']);
    run('git', ['-C', tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Pinned QModem baseline']);
    const builder = fs.readFileSync(path.join(root, 'firmware/docker/build-openwrt.sh'), 'utf8');
    const start = builder.indexOf('if ! git -C feeds/qmodem diff --quiet; then');
    const end = builder.indexOf('[[ "$(git -C feeds/packages rev-parse HEAD)"', start);
    assert.ok(start >= 0 && end > start, 'actual QModem cache cleanup must be found');
    const cleanup = 'set -euo pipefail\n' + builder.slice(start, end);
    const options = { cwd: tmp, env: { ...process.env, FILES_OVERLAY_DIR: path.join(root, 'firmware/files') } };
    const legacy = fs.readFileSync(path.join(root, 'firmware/patches/qmodem-mtu-legacy-v16.patch'), 'utf8');
    const view = path.join(tree, 'luci/luci-app-qmodem-next/htdocs/luci-static/resources/view/qmodem/network_config.js');
    for (const variant of ['clean', 'original-v16', 'mtu-in-v16', 'versioned-v17', 'versioned-v18']) {
      if (variant !== 'clean') {
        const applied = variant === 'versioned-v18' ? patches
          : variant === 'versioned-v17' ? patches.slice(0, -1)
          : patches.slice(0, -2);
        for (const patch of applied)
          run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });
        if (variant === 'mtu-in-v16')
          run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: legacy });
      }
      if (variant === 'versioned-v17' || variant === 'versioned-v18' || variant === 'mtu-in-v16') {
        const js = fs.readFileSync(view, 'utf8');
        assert.equal((js.match(/s\.option\(form\.Value, 'mtu'/g) || []).length, 1, 'exactly one MTU control');
        if (variant === 'versioned-v18')
          assert.equal((js.match(/s\.option\(form\.ListValue, 'lan_ipv6_policy'/g) || []).length, 1, 'exactly one LAN IPv6 policy control');
        new Function(js);
      }
      run('bash', ['-c', cleanup], options);
      run('git', ['-C', tree, 'diff', '--exit-code']);
      console.log('QModem real builder cache migration passed: ' + variant);
    }
    fs.appendFileSync(view, '\n// unrelated-owner-edit-must-survive\n');
    const failed = spawnSync('bash', ['-c', cleanup], { ...options, encoding: 'utf8', timeout: 60000 });
    assert.ifError(failed.error);
    assert.equal(failed.status, 3, 'unrecognized owner edits must fail closed');
    assert.match(fs.readFileSync(view, 'utf8'), /unrelated-owner-edit-must-survive/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
