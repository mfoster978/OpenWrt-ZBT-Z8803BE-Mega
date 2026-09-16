'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const js = fs.readFileSync(path.join(root, 'firmware/files/www/luci-static/resources/view/services/adguard-home.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'firmware/files/www/luci-static/resources/view/system/mega-apps.css'), 'utf8');

const fixture = `
window.calls=[];window._=s=>s;
window.E=(tag,attrs,children)=>{const el=document.createElement(tag);Object.entries(attrs||{}).forEach(([k,v])=>typeof v==='function'?el.addEventListener(k,v):el.setAttribute(k,v));(Array.isArray(children)?children:children==null?[]:[children]).forEach(c=>el.appendChild(c instanceof Node?c:document.createTextNode(String(c))));return el;};
window.ui={showModal:()=>{},hideModal:()=>{}};
window.rpc={declare:spec=>async(...args)=>{calls.push({method:spec.method,args});if(spec.method==='status')return {ok:true,storage_ready:true,installed:false,enabled:false,running:false,dns_owned:false,release:'v0.107.79',web_port:3000};if(spec.method==='offer')return {ok:true,token:'a'.repeat(32),release:'v0.107.79',download_size:11332212};if(spec.method==='install')return {ok:true,id:'b'.repeat(32)};if(spec.method==='job')return {ok:true,id:'b'.repeat(32),phase:'downloading',error:''};if(spec.method==='configure')return {ok:true,enabled:true};if(spec.method==='set_enabled')return {ok:true,enabled:!!args[0]};if(spec.method==='uninstall')return {ok:true,installed:false};return {ok:false,error:'unknown'};}};
window.poll={add:()=>{}};
window.view={extend:v=>v};
window.L={resource:p=>'/'+p,url:(...p)=>'/cgi-bin/luci/'+p.join('/'),hasViewPermission:()=>true};
window.pageDef=new Function('view','rpc','poll','ui','E','_','L',${JSON.stringify(js)})(view,rpc,poll,ui,E,_,L);
pageDef.load().then(data=>document.body.appendChild(pageDef.render(data)));
`;

(async () => {
	const server = http.createServer((req, res) => {
		if (req.url.endsWith('.css')) { res.setHeader('content-type', 'text/css'); res.end(css); return; }
		res.setHeader('content-type', 'text/html');
		res.end('<!doctype html><meta charset="utf-8"><body><script>' + fixture.replaceAll('</script', '<\\/script') + '</script></body>');
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	try {
		await page.goto(url);
		await page.waitForSelector('.zapp-hero');
		assert.equal(await page.getByRole('heading', { name: 'Network-wide DNS protection without filling router flash' }).count(), 1);
		assert.equal(await page.getByRole('button', { name: 'Install full AdGuard Home to USB…' }).count(), 1);
		assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'install').length), 0);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		console.log('AdGuard Home UI fixture: renders install CTA and performs no lifecycle mutation on load');
	} finally {
		await browser.close();
		server.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
