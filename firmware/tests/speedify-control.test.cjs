'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-speedify-control-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const control = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-speedify-control'), 'utf8')
  .replace('. /usr/lib/zbt/speedify-routing.sh', `
sf_disable_firewall() { echo firewall-cleanup >> "$DB/calls"; [ "$FAIL_FIREWALL" != 1 ]; }
sf_clear_dead_pep() { echo pep-cleanup >> "$DB/calls"; [ "$FAIL_PEP" != 1 ]; }`)
  .replace(/service_action\(\) \{[\s\S]*?\n\}/, `service_action() {
  echo "$1 $2" >> "$DB/calls"
  [ "$FAIL_SERVICE" != "$1 $2" ]
}`);

function run(enabled, mode, env = {}) {
  const dir = path.join(tmp, String(++serial));
  fs.mkdirSync(dir);
  const script = `
uci() { [ "$*" != "-q get speedify_bootstrap.main.enabled" ] || echo "$ENABLED"; }
logger() { echo "log $*" >> "$DB/calls"; }
${control}
`;
  const result = spawnSync('busybox', ['sh', '-c', script, 'test', mode], {
    encoding: 'utf8',
    env: { ...process.env, DB: dir, ENABLED: String(enabled), ...env }
  });
  assert.ifError(result.error);
  return {
    status: result.status,
    calls: fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : ''
  };
}

test('disabled state stops and disables every Speedify component and removes routing hooks', () => {
  const result = run(0, 'apply');
  assert.equal(result.status, 0);
  for (const service of ['zbt-speedify-guard', 'speedify-installer', 'speedify', 'sfy-ws-auth']) {
    assert.match(result.calls, new RegExp(`${service} stop\\n${service} disable`));
  }
  assert.match(result.calls, /firewall-cleanup\npep-cleanup/);
  assert.doesNotMatch(result.calls, / restart| installer-armed/);
});

test('enabled sync only arms boot while an interactive apply also starts the installer', () => {
  const sync = run(1, 'sync');
  assert.equal(sync.status, 0);
  assert.match(sync.calls, /^speedify-installer enable$/m);
  assert.doesNotMatch(sync.calls, /restart|cleanup/);
  const apply = run(1, 'apply');
  assert.equal(apply.status, 0);
  assert.match(apply.calls, /speedify-installer enable\nspeedify-installer restart/);
  assert.doesNotMatch(apply.calls, /cleanup/);
});

test('lifecycle failures are returned to the authenticated RPC caller', () => {
  assert.notEqual(run(0, 'apply', { FAIL_FIREWALL: '1' }).status, 0);
  assert.notEqual(run(0, 'apply', { FAIL_SERVICE: 'speedify stop' }).status, 0);
  assert.notEqual(run(1, 'apply', { FAIL_SERVICE: 'speedify-installer restart' }).status, 0);
});
