'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tree = process.env.QMODEM_TEST_TREE;
assert.ok(tree, 'QMODEM_TEST_TREE is required to test the actual pinned view');
const pinnedView = fs.readFileSync(path.join(tree,
  'luci/luci-app-qmodem-next/htdocs/luci-static/resources/view/qmodem/network_config.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(__dirname,
  '../files/etc/uci-defaults/99-zbt-qmodem-network-apply-v16'), 'utf8');
const luciTree = process.env.LUCI_TEST_TREE;
assert.ok(luciTree, 'LUCI_TEST_TREE is required to exercise the actual base Save & Apply lifecycle');
const luciSource = fs.readFileSync(path.join(luciTree,
  'modules/luci-base/htdocs/luci-static/resources/luci.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(luciTree,
  'modules/luci-base/htdocs/luci-static/resources/ui.js'), 'utf8');
const baseMethod = luciSource.match(/\t\thandleSaveApply\(ev, mode\) \{\n[\s\S]*?\n\t\t\},/);
const applyMethod = uiSource.match(/\t\tapply\(checked\) \{\n[\s\S]*?\n\t\t\},/);
assert.ok(baseMethod, 'unable to isolate pinned base handleSaveApply');
assert.ok(applyMethod, 'unable to isolate pinned changes.apply');
const handler = /\thandleSaveApply: function\(ev, mode\) \{\n[\s\S]*?\n\t\},/;
assert.match(pinnedView, handler);
const originalView = pinnedView.replace(handler, `\thandleSaveApply: function(ev, mode) {
\t\treturn this.handleSave(ev).then(function() {
\t\t\treturn callInitAction('qmodem_network', 'reload');
\t\t});
\t},`);

function fixture(contents = pinnedView) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-network-apply-'));
  const viewPath = path.join(dir, 'network_config.js');
  const migrationPath = path.join(dir, 'migration');
  const logPath = path.join(dir, 'log');
  fs.writeFileSync(viewPath, contents);
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(migrationPath, migrationSource.replace(
    'file=/www/luci-static/resources/view/qmodem/network_config.js', 'file="$PATCH_VIEW"'), { mode: 0o644 });
  return {
    run() {
      // OpenWrt boot sources UCI defaults in a subshell; executable mode is
      // not required. Match that invocation instead of chmodding the hook.
      return spawnSync('busybox', ['sh', '-c', 'logger() { printf "%s\\n" "$*" >> "$PATCH_LOG"; }; ( . "$PATCH_MIGRATION" )'], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env,
          PATCH_VIEW: viewPath, PATCH_LOG: logPath, PATCH_MIGRATION: migrationPath }
      });
    },
    source: () => fs.readFileSync(viewPath, 'utf8'),
    log: () => fs.readFileSync(logPath, 'utf8'),
    files: () => fs.readdirSync(dir),
    close: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function patchedView() {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const source = f.source();
    new Function(source);
    return source;
  } finally { f.close(); }
}

function minifiedBuildView() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-network-jsmin-'));
  try {
    const binary = path.join(dir, 'jsmin');
    const compile = spawnSync('cc', ['-O2', '-o', binary, path.join(luciTree, 'modules/luci-base/src/jsmin.c')],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(compile.status, 0, compile.stderr);
    const minify = spawnSync(binary, [], { input: pinnedView, encoding: 'utf8', timeout: 5000 });
    assert.equal(minify.status, 0, minify.stderr);
    new Function(minify.stdout);
    assert.doesNotMatch(minify.stdout, /zbt-network-apply: config-change-trigger/,
      'the build minifier must strip the source comment marker, as on the real image');
    return minify.stdout;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function loadView(source, calls, apply) {
  const ui = { changes: { apply } };
  const base = new Function('classes', 'return ({' + baseMethod[0] + '}).handleSaveApply;')({ ui });
  const view = new Function('view', 'rpc', 'ui', source)(
    { extend: value => value },
    { declare: () => (...args) => { calls.push(['service', ...args]); return Promise.resolve(); } },
    ui
  );
  view.super = function(method, args) {
    assert.equal(method, 'handleSaveApply');
    return base.apply(this, args);
  };
  return view;
}

function actualApply({ affected = false } = {}) {
  let finishHttp;
  const http = new Promise(resolve => { finishHttp = resolve; });
  const statuses = [];
  let cancelApply;
  const changes = {
    displayStatus: value => statuses.push(value),
    checkConnectivityAffected: () => Promise.resolve(affected),
    confirm: () => statuses.push('confirmed')
  };
  const UI = { prototype: { changes } };
  const method = new Function('UI', 'E', '_', 'request', 'L', 'window',
    'return ({' + applyMethod[0] + '}).apply;')(
    UI, (tag, attributes) => {
      if (tag === 'button' && !cancelApply)
        cancelApply = attributes.click;
      return null;
    }, text => ({ format: () => text }),
    { request: () => http },
    { url: (...parts) => parts.join('/'), env: { sessionid: 'fixture', token: 'fixture', apply_rollback: 90, apply_display: 1 } },
    { setTimeout: () => 0 }
  );
  return { apply: method.bind(changes), finishHttp, statuses, http,
    cancel() { assert.ok(cancelApply, 'actual LuCI checked-apply prompt must be open'); cancelApply(); } };
}

test('build-patched pinned view is already safe and the mode-0644 migration is a no-op', () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    const patched = f.source();
    new Function(patched);
    assert.equal(patched, pinnedView, 'the fix must be installed before package minification');
    assert.match(patched, /ui\.changes\.apply\(mode == '0'\)/);
    assert.match(patched, /\/\/ zbt-network-apply: config-change-trigger/);
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(f.source(), patched);
    assert.deepEqual(f.files().sort(), ['log', 'migration', 'network_config.js']);
  } finally { f.close(); }
});

test('network Save & Apply migration repairs an original unminified handler', () => {
  const f = fixture(originalView);
  try {
    assert.equal(f.run().status, 0);
    const patched = f.source();
    new Function(patched);
    assert.notEqual(patched, originalView);
    assert.match(patched, /\/\/ zbt-network-apply: config-change-trigger/);
    assert.doesNotMatch(patched, /return callInitAction\('qmodem_network', 'reload'\)/);
    assert.equal(f.run().status, 0);
    assert.equal(f.source(), patched);
  } finally { f.close(); }
});

test('actual jsmin build output remains safe and the first-boot migration accepts it unchanged', async () => {
  const minified = minifiedBuildView();
  const f = fixture(minified);
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.source(), minified);
    assert.equal(f.run().status, 0);
    assert.equal(f.source(), minified);
    assert.deepEqual(f.files().sort(), ['log', 'migration', 'network_config.js']);
    const calls = [];
    const actual = actualApply();
    const view = loadView(minified, calls, checked => {
      calls.push(['apply', checked]);
      return actual.apply(checked);
    });
    view.handleSave = () => Promise.resolve();
    await view.handleSaveApply({}, '0');
    assert.deepEqual(calls, [['apply', true]], 'the delivered minified view cannot reload while apply is pending');
  } finally { f.close(); }
});

test('network Save & Apply migration replaces both previously shipped non-awaiting reload forms', () => {
  const previousHandlers = [
    `\thandleSaveApply: function(ev, mode) {
\t\treturn this.handleSave(ev).then(function() {
\t\t\treturn ui.changes.apply(mode == '0');
\t\t}).then(function() {
\t\t\treturn callInitAction('qmodem_network', 'reload');
\t\t});
\t},`,
    `\thandleSaveApply: function(ev, mode) {
\t\tvar self = this;
\t\treturn this.super('handleSaveApply', arguments).then(function() {
\t\t\treturn callInitAction('qmodem_network', 'reload');
\t\t});
\t},`
  ];
  assert.match(pinnedView, handler);
  for (const previous of previousHandlers) {
    const source = pinnedView.replace(handler, previous);
    const f = fixture(source);
    try {
      const first = f.run();
      assert.equal(first.status, 0, first.stderr);
      const patched = f.source();
      new Function(patched);
      assert.notEqual(patched, source);
      assert.match(patched, /\/\/ zbt-network-apply: config-change-trigger/);
      assert.doesNotMatch(patched, /return callInitAction\('qmodem_network', 'reload'\)/);
      assert.doesNotMatch(patched, /this\.super\('handleSaveApply', arguments\)/);
      assert.equal(f.run().status, 0);
      assert.equal(f.source(), patched);
    } finally { f.close(); }
  }
});

test('network Save & Apply migration fails closed on zero, duplicate, or commented handler matches', () => {
  const needle = 'handleSaveApply: function(ev, mode)';
  for (const source of [
    originalView.replace(needle, 'handleDifferentApply: function(ev, mode)'),
    originalView + '\n' + needle + ' {\n},\n',
    originalView.replace(needle, '// ' + needle)
  ]) {
    const f = fixture(source);
    try {
      const result = f.run();
      assert.equal(result.status, 1, result.stderr);
      assert.equal(f.source(), source);
      assert.match(f.log(), /skipped|failed/);
      assert.deepEqual(f.files().sort(), ['log', 'migration', 'network_config.js']);
    } finally { f.close(); }
  }
});

test('network Save & Apply must not reload while the actual pinned LuCI apply HTTP request is pending', async () => {
  const source = patchedView();
  for (const [mode, checked] of [['0', true], ['1', false]]) {
    const calls = [];
    let finishSave;
    const actual = actualApply();
    const view = loadView(source, calls, value => { calls.push(['apply', value]); return actual.apply(value); });
    view.handleSave = () => { calls.push(['save']); return new Promise(resolve => { finishSave = resolve; }); };
    const pending = view.handleSaveApply({}, mode);
    await Promise.resolve();
    assert.deepEqual(calls, [['save']]);
    finishSave();
    await pending;
    assert.deepEqual(calls, [['save'], ['apply', checked]],
      'Save & Apply must not resolve into a service reload while the actual apply HTTP request is still pending');
  }
});

test('cancelling the actual LuCI checked-apply prompt must not reload QModem', async () => {
  const calls = [];
  const actual = actualApply({ affected: 'lan' });
  const view = loadView(patchedView(), calls, checked => {
    calls.push(['apply', checked]);
    return actual.apply(checked);
  });
  view.handleSave = () => Promise.resolve();
  await view.handleSaveApply({}, '0');
  actual.cancel();
  await Promise.resolve();
  assert.ok(actual.statuses.includes(false), 'actual LuCI dismissed the cancelled apply prompt');
  assert.deepEqual(calls, [['apply', true]], 'cancelling before commit must not precede or follow a modem reload');
});

test('failed save or failed asynchronous apply cannot trigger a separate QModem reload', async () => {
  const source = patchedView();
  const calls = [];
  const view = loadView(source, calls, value => { calls.push(['apply', value]); });
  view.handleSave = () => Promise.reject(new Error('save failed'));
  await assert.rejects(view.handleSaveApply({}, '0'), /save failed/);
  assert.deepEqual(calls, []);

  // Execute the actual pinned UI apply method and deliver an HTTP failure.
  const actual = actualApply();
  const asyncView = loadView(source, calls, value => {
    calls.push(['apply', value]);
    return actual.apply(value);
  });
  asyncView.handleSave = () => Promise.resolve();
  await asyncView.handleSaveApply({}, '0');
  actual.finishHttp({ status: 500, responseText: 'fixture failure' });
  await actual.http;
  await Promise.resolve();
  assert.ok(actual.statuses.includes('warning'), 'the real LuCI apply reports the failed HTTP request');
  assert.deepEqual(calls, [['apply', true]], 'failed HTTP apply must not be preceded or followed by a QModem reload');
});

test('successful actual LuCI apply uses its normal confirmation flow without a separate QModem RPC', async () => {
  for (const [mode, checked, status] of [['0', true, 200], ['1', false, 204]]) {
    const calls = [];
    const actual = actualApply();
    const view = loadView(patchedView(), calls, value => {
      calls.push(['apply', value]);
      return actual.apply(value);
    });
    view.handleSave = () => Promise.resolve();
    await view.handleSaveApply({}, mode);
    actual.finishHttp({ status, json: () => ({ token: 'fixture-confirm-token' }) });
    await actual.http;
    await Promise.resolve();
    assert.ok(actual.statuses.includes('confirmed'), 'real apply hands the accepted transaction to LuCI confirmation');
    assert.deepEqual(calls, [['apply', checked]]);
  }
});

test('actual pinned LuCI apply returns undefined rather than an apply-completion promise', async () => {
  const actual = actualApply();
  assert.equal(actual.apply(false), undefined);
  actual.finishHttp({ status: 500, responseText: 'fixture failure' });
  await actual.http;
  await Promise.resolve();
  assert.ok(actual.statuses.includes('warning'));
});

test('pinned QModem service already reloads through the qmodem config-change trigger', () => {
  const init = fs.readFileSync(path.join(tree, 'application/qmodem/files/etc/init.d/qmodem_network'), 'utf8');
  assert.match(init, /service_triggers\(\)[\s\S]*?procd_add_reload_trigger "qmodem"/);
});

test('installed overlay QModem service registers the config-change trigger and routes reload to procd start', () => {
  const init = fs.readFileSync(path.join(__dirname, '../files/etc/init.d/qmodem_network'), 'utf8');
  const trigger = init.match(/^service_triggers\(\) \{[^\n]+\}$/m);
  const reload = init.match(/^reload_service\(\) \{[^\n]+\}$/m);
  assert.ok(trigger);
  assert.ok(reload);
  const result = spawnSync('busybox', ['sh', '-c', `
procd_add_reload_trigger() { printf 'trigger=%s\\n' "$*"; }
start() { echo reload=procd-start; }
${trigger[0]}
${reload[0]}
service_triggers
reload_service
`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'trigger=qmodem\nreload=procd-start\n');
});
