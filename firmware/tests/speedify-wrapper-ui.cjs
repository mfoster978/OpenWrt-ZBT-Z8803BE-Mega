'use strict';
// Actual pinned vendor Angular UI + Mega wrapper in Chromium. Only daemon
// messages and the external account portal are fixtures; no credentials used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const wrapper = fs.readFileSync(path.join(root, 'firmware/files/usr/share/zbt/speedify-luci-wrapper.js'), 'utf8');
const fixture = `
window._ = value => value;
window.E = (tag, attrs, children) => {
  const element = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => element.setAttribute(key, value));
  (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(child =>
    element.appendChild(child instanceof Node ? child : document.createTextNode(child)));
  return element;
};
window.view = { extend: value => value };
window.rpc = { declare: () => () => Promise.resolve(window.daemonStatus || { ok: true, signed_in: false }) };
window.poll = { add: fn => { window.refreshDaemonStatus = fn; } };
window.L = { env: { sessionid: 'browserTestSession' } };
document.querySelector('main').appendChild(new Function('view', 'E', '_', 'L', 'rpc', 'poll', ${JSON.stringify(wrapper)})(view, E, _, L, rpc, poll).render());
`;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-speedify-native-'));
  let browser, server;
  try {
    // Checksum matches the bootstrap pin. Do not silently test a newer UI.
    const apk = path.join(dir, 'vendor.apk');
    execFileSync('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '20', '--max-time', '180',
      '-o', apk, 'https://downloads.speedify.com/luci-app-speedify_noarch.apk']);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
      'efaa6f7da76e4ad5c6bb407aa503886e6af828100a1263698ec26b4335e14167');
    execFileSync('tar', ['-xf', apk, '-C', dir], { stdio: 'ignore' });
    const vendor = path.join(dir, 'usr/share/luci-app-speedify/docroot');
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    let indexRequests = 0, vendorCookie = '';
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
      const pathname = new URL(request.url, 'https://localhost').pathname;
      if (pathname.startsWith('/luci-app-speedify/view/')) {
        if (pathname.endsWith('/index.html') || pathname.endsWith('/view/')) { indexRequests++; vendorCookie = request.headers.cookie || ''; }
        // Match the vendor nginx HashLocationStrategy rewrite on reload.
        const relative = pathname.slice('/luci-app-speedify/view/'.length) || 'index.html';
        const file = path.resolve(vendor, relative);
        if (!file.startsWith(vendor + path.sep)) { response.writeHead(404); response.end(); return; }
        try {
          const data = fs.existsSync(file) ? fs.readFileSync(file) : zlib.gunzipSync(fs.readFileSync(file + '.gz'));
          const extension = path.extname(file);
          response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' })[extension] || 'application/octet-stream');
          response.end(data);
        } catch { response.writeHead(404); response.end(); }
      } else {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta name="viewport" content="width=device-width"><nav id="router-menu">Router menu</nav><main></main><script>' + fixture.replaceAll('</script', '<\\/script') + '</script>');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
      await context.route('https://my.speedify.com/**', route => route.fulfill({ body: '<title>Account portal fixture</title>No real account used.' }));
      const page = await context.newPage();
      let activationCalls = 0, signedIn = false, report;
      const socketURLs = [];
      await page.routeWebSocket('**/luci-app-speedify/api/ws', ws => {
        socketURLs.push(ws.url());
        report = (type, data) => ws.send(JSON.stringify([type, data]));
        ws.onMessage(raw => {
          const [type] = JSON.parse(raw);
          const replies = {
            request_current_state: ['report_current_state', { state: signedIn ? 2 : 0 }],
            request_accounting_data: ['report_accounting_data', { isAutoAccount: !signedIn, email: signedIn ? 'test@example.invalid' : '', bytesAvailable: 1000000000 }],
            request_version_data: ['report_version_data', { maj: 17, min: 1, bug: 0, build: 12947, branch: 'release' }],
            request_system_data: ['report_system_data', { role: 'router', platform: 'router', uuid: 'test-device', osPlatform: 'OpenWrt' }],
            request_vendor_local_settings: ['report_vendor_local_settings', { completed_intro: true }],
            request_feature_flags: ['report_feature_flags', { disableAutoaccount: true }],
            request_login_params: ['report_login_params', {}],
            request_privacy_settings: ['report_privacy_settings', {}],
            request_referrer_data: ['report_referrer_data', {}],
            request_networks: ['report_networks', []]
          };
          if (type === 'request_activation_code') {
            activationCalls++;
            report('report_activation_code', { type: 0, activation_url: 'https://my.speedify.com/activate?activationCode=1234&role=router&extra=preserved' });
          }
          if (replies[type]) report(...replies[type]);
        });
      });
      const url = 'https://127.0.0.1:' + server.address().port + '/cgi-bin/luci/admin/speedify/app';
      const before = indexRequests;
      await page.goto(url);
      const native = page.frameLocator('iframe');
      await native.locator('app-welcome-screen').getByText('Sign In', { exact: true }).waitFor();
      const popupReady = context.waitForEvent('page');
      await native.locator('app-welcome-screen').getByText('Sign In', { exact: true }).click();
      const popup = await popupReady;
      await popup.waitForURL('https://my.speedify.com/**');
      assert.equal(new URL(popup.url()).searchParams.get('extra'), 'preserved');
      await native.getByText('Finish Signing In', { exact: true }).waitFor();
      assert.equal(activationCalls, 1);
      await popup.close();
      await page.bringToFront();
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal(indexRequests, before + 1, 'returning to the router must not reload the dashboard');
      assert.equal(activationCalls, 1, 'returning must not create another activation request');
      assert.equal(page.url(), url);
      assert.equal(await page.locator('#router-menu').isVisible(), true);
      assert.equal(await page.getByText('Sign in this router', { exact: true }).count(), 0);
      for (const [status, text] of [
        [{ ok: true, signed_in: false, recent_error: 'ERROR_NO_ROUTER_LICENSE' }, 'ERROR_NO_ROUTER_LICENSE'],
        [{ ok: true, signed_in: false, recent_error: 'NETWORK_ERROR' }, 'network error'],
        [{ ok: true, signed_in: true, state: 'LOGGED_IN', tunnel_present: false }, 'VPN is not connected yet'],
        [{ ok: true, signed_in: true, state: 'CONNECTED', tunnel_present: true }, 'VPN connected']
      ]) {
        await page.evaluate(async value => { window.daemonStatus = value; await window.refreshDaemonStatus(); }, status);
        assert.ok((await page.locator('#mega-speedify-status').innerText()).includes(text));
        assert.equal(indexRequests, before + 1, 'diagnostics do not reload native dashboard');
        assert.equal(activationCalls, 1, 'diagnostics do not regenerate activation');
      }
      signedIn = true;
      report('report_accounting_data', { isAutoAccount: false, email: 'test@example.invalid', bytesAvailable: 1000000000 });
      report('report_current_state', { state: 2 });
      await native.getByText('Finish Signing In', { exact: true }).waitFor({ state: 'hidden' });
      await native.getByText('Tap to Connect', { exact: true }).waitFor();
      assert.equal(indexRequests, before + 1, 'native account updates need no wrapper refresh');
      assert.equal(activationCalls, 1);
      assert.match(vendorCookie, /sfy-session=browserTestSession/);
      const cookie = (await context.cookies()).find(item => item.name === 'sfy-session');
      assert.equal(cookie.secure, true); assert.equal(cookie.path, '/luci-app-speedify/'); assert.equal(cookie.sameSite, 'Strict');
      const appFrame = await (await page.locator('iframe').elementHandle()).contentFrame();
      assert.equal(new URL(appFrame.url()).searchParams.get('wsPort'), 'match', 'Angular navigation retains connection parameters');
      await appFrame.evaluate(() => { location.hash = '/'; location.reload(); });
      await native.getByText('Tap to Connect', { exact: true }).waitFor();
      assert.equal(socketURLs.length, 2, 'reload creates one new native connection');
      for (const socketURL of socketURLs) assert.equal(socketURL, 'wss://127.0.0.1:' + server.address().port + '/luci-app-speedify/api/ws');
      assert.doesNotMatch(appFrame.url(), /wsToken|browserTestSession/);
      assert.equal(activationCalls, 1, 'signed-in reload must not restart activation');
      assert.equal(await page.locator('#router-menu').isVisible(), true);
      await context.close();
    }
    console.log('Native Speedify desktop/mobile: vendor sign-in popup, return without reset, native account update, persistent transport on reload, LuCI menu retained. Daemon/account replies are fixtures.');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
