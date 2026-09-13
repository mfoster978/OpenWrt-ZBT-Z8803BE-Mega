'use strict';
// Browser regression for the Mega mobile layer applied to ordinary Argon/CBI pages.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'firmware/files/www/luci-static/resources/zbt-mega-mobile.css'), 'utf8');
const argonPatch = fs.readFileSync(path.join(root, 'firmware/patches/luci-theme-argon-mega-mobile.patch'), 'utf8');
const resourcePatch = fs.readFileSync(path.join(root, 'firmware/patches/luci-mega-resource-version.patch'), 'utf8');
assert.match(argonPatch, /zbt-mega-mobile\.css\?v=\{\{ pkgs_update_time \}\}/);
assert.match(argonPatch, /luci\.js\?v=\{\{ pkgs_update_time \}\}/);
assert.doesNotMatch(argonPatch.split('\n').filter(line => line.startsWith('+')).join('\n'), /luci\.js\?v=\{\{ version\.luciversion \}\}/);
assert.match(resourcePatch, /\/rom\/etc\/zbt-mega-build\.json/);
const markup = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mega mobile configuration fixture</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:16px Arial,sans-serif}
header{background:#5e72e4}.fill>.container{padding:12px}.main{min-height:100vh}.brand{color:#fff}
#maincontent>.container{margin:24px}.cbi-map>h2{background:#ddd;padding:16px}.cbi-section{background:#fff;padding:16px}
.cbi-section-table-row{display:flex;flex-wrap:wrap}.cbi-section-table-cell{flex:1 1 50%}
.td[data-title]::before{content:attr(data-title)}.cbi-value-title{display:inline-block;width:15rem}
.cbi-value-field input,.cbi-value-field select{min-width:18rem}.btn{display:inline-block}
</style><style>${css}</style>
<body class="logged-in" data-page="admin-network-qmodem-network_config">
<div class="main"><div class="main-right">
<header class="bg-primary"><div class="fill"><div class="container"><a class="showSide">☰</a> <a class="brand">OpenWrt · Mega</a></div></div></header>
<div id="maincontent"><div class="container"><div id="view"><div class="cbi-map">
<h2>Network configuration</h2><div class="cbi-map-descr">Manage physical modem slots and their connection settings.</div>
<div class="cbi-section"><h3>Dial Configuration</h3><div class="cbi-section-node">
<ul class="cbi-tabmenu"><li class="cbi-tab">5G &amp; Network Mode</li><li class="cbi-tab-disabled">Preferred Bands</li><li class="cbi-tab-disabled">Neighbor Cell</li><li class="cbi-tab-disabled">Dial Mode</li><li class="cbi-tab-disabled">Set IMEI</li><li class="cbi-tab-disabled">Reboot Modem</li></ul>
<div class="tr cbi-section-table-row" data-title="Modem 1">
<div class="td cbi-section-table-cell" data-title="Status"><span class="status">Connected</span></div>
<div class="td cbi-section-table-cell" data-title="Enable Dial"><input type="checkbox" checked></div>
<div class="td cbi-section-table-cell" data-title="Modem Model"><span>RM551E-GL</span></div>
<div class="td cbi-section-table-cell" data-title="Modem Alias"><span>modem1</span></div>
<div class="td cbi-section-table-cell" data-title="Dial Control"><span><button class="btn">Hang up</button> <button class="btn primary">Redial</button></span></div>
<div class="td cbi-section-table-cell cbi-section-actions"><button class="btn">Edit Modem 1</button></div>
</div>
<div class="cbi-value"><label class="cbi-value-title">Access point name</label><div class="cbi-value-field"><input value="broadband"></div></div>
<div class="cbi-value"><label class="cbi-value-title">Network mode</label><div class="cbi-value-field"><select><option>Automatic</option></select><div class="cbi-value-description">The modem negotiates the best supported mode.</div></div></div>
</div></div><div class="cbi-page-actions"><button class="btn">Reset</button><button class="btn primary cbi-button-apply">Save & Apply</button></div>
</div></div></div></div></div></div></body>`;

(async () => {
	const server = http.createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(markup);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
		await page.goto(`http://127.0.0.1:${server.address().port}`);
		assert.equal(await page.locator('header').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(26, 28, 32)', 'mobile header matches About surface');
		assert.equal(await page.locator('.cbi-section').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(26, 28, 32)', 'configuration sections match About cards');
		assert.equal(await page.locator('.cbi-section-table-row').evaluate(element => getComputedStyle(element).display), 'block', 'modem records become separate cards');
		assert.equal(await page.locator('.td[data-title]').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length), 1, 'phone fields use one readable column');
		assert.equal(await page.locator('.cbi-value').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length), 1, 'form labels and controls stack');
		assert.equal(await page.locator('.cbi-tabmenu').evaluate(element => getComputedStyle(element).display), 'grid', 'QModem tabs use a discoverable grid');
		assert.equal(await page.locator('.cbi-tabmenu').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length), 2, 'QModem tabs use two phone-width columns');
		assert.ok(await page.locator('.cbi-tabmenu>li').first().evaluate(element => element.getBoundingClientRect().height) >= 44, 'plain QModem tab items are touch sized');
		assert.ok(await page.locator('.cbi-button-apply').evaluate(element => element.getBoundingClientRect().height) >= 44, 'touch target is at least 44px');
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile horizontal overflow');
		assert.equal(await page.locator('.cbi-value-field input').evaluate(element => element.getBoundingClientRect().right <= innerWidth), true, 'inputs stay inside the viewport');
		if (process.env.ZBT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ZBT_UI_SCREENSHOTS, 'mega-mobile-configuration.png'), fullPage: true });

		await page.setViewportSize({ width: 1440, height: 900 });
		assert.equal(await page.locator('header').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(94, 114, 228)', 'mobile layer does not replace desktop Argon');
		assert.equal(await page.locator('.cbi-section-table-row').evaluate(element => getComputedStyle(element).display), 'flex', 'desktop configuration layout remains intact');
		console.log('Mega mobile theme checks passed: About palette, card-based modem rows, stacked controls, touch targets, no overflow, and desktop isolation.');
	} finally {
		await browser.close();
		server.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
