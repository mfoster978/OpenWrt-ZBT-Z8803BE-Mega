'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-mtu-profile-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dual = fs.readFileSync(path.join(root, 'firmware/files/usr/lib/zbt/dual-modem.sh'), 'utf8');
const profile = fs.readFileSync(path.join(root, 'firmware/files/usr/sbin/zbt-qmodem-profile'), 'utf8')
  .replace('. /usr/lib/zbt/dual-modem.sh', dual)
  .replaceAll('/usr/sbin/zbt-qmodem-performance-policy', '${DB}/performance-policy');
let serial = 0;
function fixture(slot, saved) {
  const dir = path.join(tmp, String(++serial)); fs.mkdirSync(dir);
  if (saved !== undefined) fs.writeFileSync(path.join(dir, 'mtu'), saved);
  const result = spawnSync('busybox', ['sh', '-c', `
uci() {
  if [ "$1 $2" = '-q get' ]; then
    case "$3" in
      qmodem.4_1|qmodem.2_1) echo modem-device ;;
      *.display_name) echo 'Owner modem' ;;
      *.alias) echo "$SLOT" ;;
      *.mtu) cat "$DB/mtu" 2>/dev/null; return $? ;;
      *) echo preserved ;;
    esac
  elif [ "$1" = set ]; then
    [ "$2" = "qmodem.$SLOT.mtu=1500" ] || return 9
    printf '%s' 1500 > "$DB/mtu"
    printf '%s\\n' "$*" >> "$DB/calls"
  elif [ "$1 $2" = 'commit qmodem' ]; then
    printf '%s\\n' "$*" >> "$DB/calls"
  else
    return 9
  fi
}
profile_once() {
${profile}
}
profile_once "$SLOT"
profile_once "$SLOT"
`], { encoding: 'utf8', timeout: 8000, env: { ...process.env, DB: dir, SLOT: slot } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  return { value: fs.existsSync(path.join(dir, 'mtu')) ? fs.readFileSync(path.join(dir, 'mtu'), 'utf8') : undefined,
    calls: fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '' };
}
test('profile seeds MTU 1500 only once on each fixed modem', () => {
  for (const slot of ['4_1', '2_1']) {
    const f = fixture(slot);
    assert.equal(f.value, '1500');
    assert.equal(f.calls, `set qmodem.${slot}.mtu=1500\ncommit qmodem\n`);
  }
});
test('profile preserves existing owner MTU settings including malformed values for runtime fallback', () => {
  for (const slot of ['4_1', '2_1']) for (const saved of ['1280', '1430', '1472', '1500', '', 'bad']) {
    const f = fixture(slot, saved);
    assert.equal(f.value, saved);
    assert.equal(f.calls, '');
  }
});
test('profile ignores unrelated devices and MTU remains outside the redial fingerprint', () => {
  assert.deepEqual(fixture('external'), { value: undefined, calls: '' });
  const fingerprint = dual.slice(dual.indexOf('zbt_dial_fingerprint()'));
  assert.doesNotMatch(fingerprint, /\bmtu\b/);
});
