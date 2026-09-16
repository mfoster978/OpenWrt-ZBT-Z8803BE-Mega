'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('storage backend only targets verified USB block devices and ext4', () => {
	const src = read('firmware/files/usr/lib/zbt/app-storage.sh');
	assert.match(src, /mega_is_usb_block/);
	assert.match(src, /mklabel gpt mkpart primary ext4 1MiB 100%/);
	assert.match(src, /Only an existing ext4 partition with a UUID can be adopted/);
	assert.match(src, /\/proc\/self\/mountinfo/);
	assert.match(src, /mega_token_read/);
	assert.match(src, /TOKEN_REALPATH/);
	assert.match(src, /TOKEN_MAJOR_MINOR/);
	assert.doesNotMatch(src, /\/dev\/sda1|\/dev\/sda[^a-z0-9]/);
});

test('adguard backend pins official release and uses USB-only paths', () => {
	const src = read('firmware/files/usr/lib/zbt/adguard.sh');
	assert.match(src, /AGH_RELEASE='v0\.107\.79'/);
	assert.match(src, /AGH_ARCHIVE='AdGuardHome_linux_arm64\.tar\.gz'/);
	assert.match(src, /AGH_SHA256='3f7893c18e8aaadc456d0452839190561c306ca95175a2254958be80a769c1ae'/);
	assert.match(src, /AGH_ROOT="\$MEGA_APPS_MOUNT\/adguardhome"/);
	assert.match(src, /--no-check-update/);
	assert.match(src, /agh_dns_takeover/);
	assert.match(src, /agh_dns_restore/);
	assert.doesNotMatch(src, /\bopkg\b|\bapk\b|install\.sh/);
});

test('hotplug and guard restore dnsmasq on storage loss', () => {
	const hotplug = read('firmware/files/etc/hotplug.d/block/90-zbt-adguard-storage');
	const guard = read('firmware/files/usr/sbin/zbt-adguard-guard');
	assert.match(hotplug, /ACTION\" = remove/);
	assert.match(hotplug, /zbt-adguard dns-restore/);
	assert.match(guard, /zbt-app-storage verify/);
	assert.match(guard, /zbt-adguard dns-restore/);
});
