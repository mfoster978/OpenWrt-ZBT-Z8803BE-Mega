'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const js = fs.readFileSync(path.join(root, 'firmware/files/www/luci-static/resources/view/system/mega-storage.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'firmware/files/www/luci-static/resources/view/system/mega-apps.css'), 'utf8');

const fixture = `
window.calls=[];window._=s=>s;
window.E=(tag,attrs,children)=>{const el=document.createElement(tag);Object.entries(attrs||{}).forEach(([k,v])=>typeof v==='function'?el.addEventListener(k,v):el.setAttribute(k,v));(Array.isArray(children)?children:children==null?[]:[children]).forEach(c=>el.appendChild(c instanceof Node?c:document.createTextNode(String(c))));return el;};
window.ui={showModal:()=>{},hideModal:()=>{}};
window.rpc={declare:spec=>async(...args)=>{calls.push({method:spec.method,args});if(spec.method==='status')return {ok:true,configured:false,mounted:false,mount:'/mnt/mega-apps'};if(spec.method==='candidates')return {ok:true,candidates:[{id:'a'.repeat(32),kind:'adopt',eligible:true,model:'USB',device:'/dev/sdb1',size:536870912,fstype:'ext4'}]};if(spec.method==='prepare')return {ok:true,id:'b'.repeat(32)};if(spec.method==='job')return {ok:true,id:'b'.repeat(32),phase:'working',error:''};if(spec.method==='release')return {ok:true};return {ok:false,error:'unknown'};}};
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
		assert.equal(await page.getByRole('heading', { name: 'Prepare safe storage for router applications' }).count(), 1);
		assert.equal(await page.locator('.zapp-device').count(), 1);
		assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'prepare').length), 0);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		console.log('Mega storage UI fixture: renders USB candidate list without side effects on load');
	} finally {
		await browser.close();
		server.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
