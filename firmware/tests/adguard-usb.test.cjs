'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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
	assert.match(src, /MEGA_PARTED="\$\{MEGA_PARTED:-\/sbin\/parted\}"/);
	assert.match(src, /MEGA_PARTPROBE="\$\{MEGA_PARTPROBE:-\/sbin\/partprobe\}"/);
	const builder = read('firmware/docker/build-openwrt.sh');
	assert.match(builder, /for app_tool in sbin\/block sbin\/parted sbin\/partprobe usr\/sbin\/mkfs.ext4/);
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

test('storage IDs reject traversal and shell characters, not only wrong lengths', () => {
	const src = read('firmware/files/usr/lib/zbt/app-storage.sh');
	for (const [id, valid] of [['a'.repeat(32), true], ['0123456789abcdef'.repeat(2), true],
		['../' + 'a'.repeat(29), false], ['/'.repeat(32), false], ['g'.repeat(32), false], ['a'.repeat(31), false]]) {
		const result = spawnSync('sh', ['-c', src + '\nmega_valid_id "$1"', 'test', id], { encoding: 'utf8' });
		assert.equal(result.status === 0, valid, id + ': ' + result.stderr);
	}
});

test('AdGuard guard cannot restore DNS in the middle of initial configuration', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-adguard-lock-'));
	try {
		const script = read('firmware/files/usr/sbin/zbt-adguard-guard')
			.replaceAll('/var/lock/zbt-adguard.lock', path.join(dir, 'guard.lock'))
			.replaceAll('/usr/sbin/zbt-adguard', 'mock_adguard');
		const setup = `
sleep() { [ ! -f "$TEST_DIR/ticked" ] || exit 0; touch "$TEST_DIR/ticked"; }
uci() { echo 0; }
mock_adguard() { echo "$*" >> "$TEST_DIR/calls"; }
`;
		fs.writeFileSync(path.join(dir, 'guard.sh'), setup + script);
		const held = spawnSync('sh', ['-c', 'exec 8>"$TEST_DIR/guard.lock"; flock -n 8; sh "$TEST_DIR/guard.sh"'], {
			encoding: 'utf8', timeout: 5000, env: { ...process.env, TEST_DIR: dir }
		});
		assert.equal(held.status, 0, held.stderr);
		assert.equal(fs.existsSync(path.join(dir, 'calls')), false, 'guard must not undo setup DNS ownership while lifecycle lock is held');
		fs.unlinkSync(path.join(dir, 'ticked'));
		const idle = spawnSync('sh', [path.join(dir, 'guard.sh')], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TEST_DIR: dir } });
		assert.equal(idle.status, 0, idle.stderr);
		assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), 'dns-restore\n', 'disabled guard still restores DNS after setup finishes');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AdGuard guard retains its failure streak across unlocked passes', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-adguard-restart-'));
	try {
		const script = read('firmware/files/usr/sbin/zbt-adguard-guard')
			.replaceAll('/var/lock/zbt-adguard.lock', path.join(dir, 'guard.lock'))
			.replaceAll('/usr/sbin/zbt-app-storage', 'mock_storage')
			.replaceAll('/usr/sbin/zbt-adguard', 'mock_adguard')
			.replaceAll('/etc/init.d/zbt-adguard', 'mock_service');
		const setup = `
ticks=0
sleep() { [ "$1" = 3 ] || return 0; ticks=$((ticks + 1)); [ "$ticks" -le 3 ] || exit 0; }
uci() { echo 1; }
pidof() { return 1; }
logger() { :; }
mock_storage() { return 0; }
mock_adguard() { echo "adguard $*"; }
mock_service() { echo "service $*"; }
`;
		const result = spawnSync('sh', ['-c', setup + script], { encoding: 'utf8', timeout: 5000 });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, 'service start\nservice stop\nadguard dns-restore\n');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verified USB cannot redirect AdGuard data through an adopted symlink', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-adguard-path-'));
	try {
		const src = read('firmware/files/usr/lib/zbt/adguard.sh').replace('. /usr/lib/zbt/app-storage.sh', '');
		const check = () => spawnSync('sh', ['-c', src + '\nuci() { echo configured; }; mega_mount_verified() { return 0; }; agh_storage_ready'], {
			encoding: 'utf8', env: { ...process.env, MEGA_APPS_MOUNT: dir }
		});
		assert.equal(check().status, 0, 'empty verified USB is ready');
		fs.mkdirSync(path.join(dir, 'adguardhome'));
		fs.symlinkSync('/tmp', path.join(dir, 'adguardhome/work'));
		assert.equal(check().status, 1, 'work must stay on USB');
		fs.unlinkSync(path.join(dir, 'adguardhome/work'));
		fs.symlinkSync('/tmp', path.join(dir, 'adguardhome/.staging'));
		assert.equal(check().status, 1, 'download staging must stay on USB');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
