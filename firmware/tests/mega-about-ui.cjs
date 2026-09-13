'use strict';
// Real browser coverage of the read-only About view. No router or live Internet calls.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'firmware/files/www/luci-static/resources/view/zbt8803be');
const js = fs.readFileSync(path.join(directory, 'mega-about-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(directory, 'mega-about-v2.css'), 'utf8');
const repo = 'https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega';
const fixture = `
window.calls = [];
window._ = s => s;
window.E = (tag, attrs, children) => {
  const element = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (typeof value === 'function') element.addEventListener(key, value);
    else element.setAttribute(key, value);
  });
  (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(child =>
    element.appendChild(child instanceof Node ? child : document.createTextNode(child)));
  return element;
};
window.board = { model: 'ZBTLink ZBT-Z8803BE', board_name: 'zbtlink,zbt-z8803be', hostname: 'OpenWrt', kernel: '6.12.74',
  release: { description: 'OpenWrt 25.12.2 r32858' } };
window.info = { uptime: 123456, memory: { total: 1073741824 } };
window.metadata = { installed: { version: 'firmware-42.1', source_sha: '1234567890abcdef1234567890abcdef12345678', built_at: '2026-09-10T22:00:00Z' } };
window.rejectRpc = false;
window.rpc = { declare: spec => () => {
  calls.push(spec.object + '.' + spec.method);
  if (rejectRpc) return Promise.reject(new Error('Unavailable'));
  return Promise.resolve(spec.object === 'zbt.firmware' ? metadata : spec.method === 'board' ? board : info);
} };
window.L = { resource: path => '/' + path, url: (...parts) => '/cgi-bin/luci/' + parts.join('/') };
window.view = { extend: value => value };
window.about = new Function('view', 'rpc', 'E', '_', 'L', ${JSON.stringify(js)})(view, rpc, E, _, L);
window.renderAbout = async () => {
  const previous = document.querySelector('.zma-page');
  if (previous) previous.remove();
  document.body.appendChild(about.render(await about.load()));
};
renderAbout();
`;

(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/view/zbt8803be/mega-about-v2.css') {
      response.setHeader('Content-Type', 'text/css'); response.end(css); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mega About UI fixture</title>' +
      '<style>body{margin:16px;background:#0f1012}</style><body><script>' + fixture.replaceAll('</script', '<\\/script') + '</script></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.route('https://embed-ssl.wistia.com/**', route => route.fulfill({
      status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"/>'
    }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('.zma-page');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.zma-hero')).display === 'grid');
    assert.equal(await page.locator('h1').innerText(), 'About Mega Edition');
    assert.match(await page.locator('.zma-hero-title').innerText(), /ZBT-Z8803BE[\s\S]*Mega Edition/);
    assert.match(await page.locator('.zma-hero-description').innerText(), /workhorse[\s\S]*custom-built features[\s\S]*optional features off/);
    assert.match(await page.locator('.zma-maintainer').innerText(), /DEVELOPER & MAINTAINER[\s\S]*Michael Foster/);
    assert.equal(await page.locator('a[href*="openwrt-zbtlink-zbt-z8803be-dual-modem-build"]').count(), 0);
    assert.equal(await page.getByRole('tab').count(), 6);
    assert.equal(await page.getByRole('tabpanel').count(), 1, 'only the active tab is exposed');
    assert.equal(await page.getByRole('tab', { name: 'Overview', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.zma-page').evaluate(element => getComputedStyle(element).getPropertyValue('--zma-bg').trim()), '#111316', 'dark default even when browser prefers light');
    assert.equal(await page.locator('.zma-card').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(26, 28, 32)', 'no white cards');
    assert.equal(await page.locator('.zma-installed-version').innerText(), 'firmware-42.1');
    assert.equal(await page.locator('a[href="mailto:mfoster978@gmail.com"]').innerText(), 'mfoster978@gmail.com');
    assert.equal(await page.locator('.zma-discord').innerText(), 'mfoster978');
    assert.equal(await page.locator('a[href="https://github.com/0xFar5eer"]').count(), 1);
    assert.ok(await page.locator('a[href="' + repo + '"]').count() >= 1);
    assert.equal(await page.locator('a[href="' + repo + '/issues"]').count(), 1);
    assert.equal(await page.locator('a[href="https://github.com/mfoster978/openwrt-zbtlink-zbt-z8803be-speedify-minimal-build"]').count(), 1);
    assert.equal(await page.locator('a[href*="mega_update"], a[href*="system/flash"]').count(), 0, 'updater and flash controls are not part of About');
    assert.equal(await page.getByRole('img', { name: /Illustration/ }).count(), 1);
    assert.match(await page.locator('.zma-thanks').innerText(), /putting the pieces together[\s\S]*working OpenWrt/);
    assert.match(await page.locator('#zma-speedify').textContent(), /Installed after Internet is ready/);
    assert.match(await page.locator('#zma-speedify').textContent(), /checks the router daemon[\s\S]*keeps the LuCI menu visible/);
    await page.getByRole('tab', { name: 'Speedify', exact: true }).click();
    assert.equal(await page.locator('.zma-speedify-video img[loading="lazy"][referrerpolicy="no-referrer"]').count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Pair & Share | Peer-to-Peer Cellular Bonding | Speedify', exact: true }).getAttribute('href'), 'https://speedify.com/enterprise/pair-and-share-cellular-connection-pooling/?wvideo=lrxei2q3dw');
    await page.getByRole('tab', { name: 'USB & Sharing', exact: true }).click();
    assert.match(await page.locator('#zma-usb').innerText(), /nothing is silently shared[\s\S]*Android & iPhone tethering[\s\S]*USB storage & network drives[\s\S]*Expand OpenWrt with extroot[\s\S]*AdGuard Home[\s\S]*KSMBD network shares[\s\S]*USB over IP/i);
    assert.equal(await page.getByRole('link', { name: 'Open Network Interfaces', exact: true }).getAttribute('href'), '/cgi-bin/luci/admin/network/network');
    assert.equal(await page.getByRole('link', { name: 'Open USB Storage', exact: true }).getAttribute('href'), '/cgi-bin/luci/admin/services/usb-storage');
    assert.equal(await page.getByRole('link', { name: 'Open Network Shares', exact: true }).getAttribute('href'), '/cgi-bin/luci/admin/services/ksmbd');
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    assert.match(await page.locator('#zma-features').textContent(), /Modem 1[\s\S]*Modem 2[\s\S]*IPv4 TTL \/ IPv6 Hop Limit/);
    assert.match(await page.locator('#zma-features').textContent(), /AT\+CNUM[\s\S]*AT\+QCAINFO/);
    assert.match(await page.locator('#zma-features').textContent(), /Automatic adaptive[\s\S]*Modem automatic[\s\S]*NSA only[\s\S]*SA only/);
    assert.match(await page.locator('#zma-features').textContent(), /300 MB per modem per 24 hours/);
    assert.match(await page.locator('#zma-features').textContent(), /USB phone tether[\s\S]*Modem 2 is standby-only/);
    assert.match(await page.locator('#zma-features').textContent(), /clean installation requires root to choose a new password/);
    assert.match(await page.locator('#zma-features').textContent(), /not the official Ookla application/);
    assert.match(await page.locator('#zma-features').textContent(), /Additional watchdog actions are off by default/);
    assert.equal(await page.getByText('Save & Apply', { exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => [about.handleSave, about.handleSaveApply, about.handleReset]), [null, null, null]);
    assert.deepEqual(await page.evaluate(() => calls), ['system.board', 'system.info', 'zbt.firmware.info']);
    assert.equal(await page.locator('a[target="_blank"]').evaluateAll(links => links.every(link => link.rel.includes('noopener') && link.rel.includes('noreferrer'))), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop overflow');
    if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-about-desktop.png'), fullPage: true });

    // Standard roving-focus tabs: arrow keys activate a panel, Home/End wrap.
    const overview = page.getByRole('tab', { name: 'Overview', exact: true });
    await overview.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Features', exact: true }).evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#zma-panel-overview').isVisible(), false);
    assert.equal(await page.locator('#zma-panel-features').isVisible(), true);
    assert.equal(await page.locator('.zma-feature-details[open]').count(), 0, 'feature cards default to concise summaries');
    if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-about-features-desktop.png'), fullPage: true });
    await page.getByText('Explore this feature', { exact: true }).first().click();
    assert.match(await page.locator('.zma-feature-details[open]').innerText(), /IPv4 TTL \/ IPv6 Hop Limit/);
    await page.getByRole('tab', { name: 'Features', exact: true }).focus();
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', { name: 'Project & Credits', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('link', { name: 'mfoster978@gmail.com', exact: true }).isVisible(), true);
    if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-about-credits-desktop.png'), fullPage: true });
    await page.keyboard.press('ArrowRight');
    assert.equal(await overview.getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByRole('tab', { name: 'Project & Credits', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await overview.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[role="tab"][tabindex="0"]').count(), 1);

    for (const width of [780, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const name of ['Overview', 'Features', 'Speedify', 'USB & Sharing', 'Packages', 'Project & Credits']) {
        await page.getByRole('tab', { name, exact: true }).click();
        assert.equal(await page.getByRole('tabpanel').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' horizontal overflow at ' + width);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await overview.click();
    if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-about-mobile.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Packages', exact: true }).click();
    await page.getByText('Cellular control & protocols', { exact: true }).click();
    assert.equal(await page.locator('details[open] code').getByText('quectel-CM-5G-M', { exact: true }).count(), 1);
    await page.getByText('VPN & Speedify support', { exact: true }).click();
    assert.equal(await page.locator('details[open] code').getByText('kmod-tun', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'expanded package overflow');
    if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-about-packages-mobile.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(() => document.body.classList.add('dark'));
    assert.equal(await page.locator('.zma-page').evaluate(element => getComputedStyle(element).getPropertyValue('--zma-bg').trim()), '#111316');
    await page.getByRole('tab', { name: 'Speedify', exact: true }).click();
    if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-about-mobile-dark.png'), fullPage: true });

    await page.evaluate(async () => {
      const injection = '<img src=x onerror="window.injected=true">';
      board.model = injection; board.hostname = injection; metadata.installed.version = injection;
      metadata.installed.source_sha = injection;
      await renderAbout();
    });
    assert.equal(await page.locator('.zma-page img').count(), 1, 'only the fixed Speedify poster is an image');
    assert.equal(await page.locator('.zma-page img[src="x"]').count(), 0, 'metadata is not interpreted as markup');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('.zma-installed-version').innerText(), '<img src=x onerror="window.injected=true">');
    await page.evaluate(async () => { rejectRpc = true; await renderAbout(); });
    assert.equal(await page.locator('.zma-installed-version').innerText(), 'Build metadata unavailable');
    assert.equal(await page.locator('#zbt-mega-about-style-v2').count(), 1, 'stylesheet should not be injected repeatedly');
    assert.equal(await page.locator('a[href="mailto:mfoster978@gmail.com"]').count(), 1, 'RPC failure does not hide static content');
    assert.equal(requests.every(url => {
      const parsed = new URL(url);
      return parsed.hostname === '127.0.0.1' || (parsed.hostname === 'embed-ssl.wistia.com' && parsed.pathname === '/deliveries/d5c4ddf469f498a4e17ed4cb75d9abb8.jpg');
    }), true, 'only the explicitly approved Speedify poster may load remotely');
    assert.deepEqual(errors, [], 'browser errors');
    console.log('Mega About Chromium checks passed: dark-default tabs, keyboard navigation, hidden panels, no updater controls, content, contacts, credits, mobile layout, expansion, read-only RPC, XSS and unavailable metadata.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
