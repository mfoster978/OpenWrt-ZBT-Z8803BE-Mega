from pathlib import Path
import subprocess

expected = {
    'firmware/files/usr/lib/zbt/qmi-session.sh': '56d69d2bbeb90b446a65b9584ae2b8d3f49fb876',
    'firmware/files/usr/sbin/zbt-qmodem-profile': '9b9dde3e1b7edb83e1400c11d6935351fe981c7c',
    'firmware/patches/qmodem-network-apply-v16.patch': '60e313f375f14986f43ddb7f51d3e8f074a825fe',
    'firmware/patches/qmodem-mtu-v17.patch': 'b9b04b58f0d9d15f2884ccefece2c7ea0bd12f17',
    'firmware/patches/qmodem-mtu-legacy-v16.patch': '1148e22d32bff842a8bae4b2462085c09a323de6',
    'firmware/tests/qmi-mtu.test.cjs': '93a0030a65a2bafe15adf015292ec136d43ee523',
    'firmware/tests/qmi-mtu-profile.test.cjs': '72281f06d05198781b9b17f46a1eeb2b5f59c8e5',
    'firmware/docker/build-openwrt.sh': 'e30f4b10ee086d39f226d0fbe4881c163004c4df',
    'firmware/scripts/check-build-inputs.sh': '7fdeff47c9a4365a981f7aef6f006754a8697551',
    'firmware/tests/check-patches.cjs': '1ad4d0fd941dae63e08a37f45514f291ab1cfdda',
    'firmware/docs/per-modem-mtu.md': '553895bdc2483b7c880c8d942388598a1459cfe4',
}
for name, sha in expected.items():
    actual = subprocess.check_output(['git', 'hash-object', name], text=True).strip()
    assert actual == sha, (name, actual, sha)

def replace_once(name, before, after):
    p = Path(name)
    s = p.read_text()
    assert s.count(before) == 1, (name, s.count(before), before)
    p.write_text(s.replace(before, after))

builder = 'firmware/docker/build-openwrt.sh'
anchor = 'if ! git -C feeds/qmodem diff --quiet; then\n'
replace_once(builder, anchor, anchor + '''  # PR #7 briefly embedded an MTU field in v16 itself. Unwind only that
  # exact field before the normal versioned stack so both older caches work.
  # This migration patch is never applied to a new firmware source tree.
  legacy_mtu_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-mtu-legacy-v16.patch"
  if patch --dry-run --force --fuzz=0 --reverse -p1 -d feeds/qmodem < "$legacy_mtu_patch" >/dev/null; then
    patch --force --fuzz=0 --reverse -p1 -d feeds/qmodem < "$legacy_mtu_patch"
  fi
''')
checks = 'firmware/scripts/check-build-inputs.sh'
replace_once(checks, 'node --test firmware/tests/qmi-mtu.test.cjs', 'node --test firmware/tests/qmi-mtu*.test.cjs')
replace_once(checks, 'test -s firmware/patches/qmodem-mtu-v17.patch\n', 'test -s firmware/patches/qmodem-mtu-v17.patch\ntest -s firmware/patches/qmodem-mtu-legacy-v16.patch\n')
patches = 'firmware/tests/check-patches.cjs'
anchor = "    if (name === 'qmodem') {\n      const init ="
replace_once(patches, anchor, "    if (name === 'qmodem') {\n      require('./qmodem-mtu-cache.cjs')(root, tree, patches, run);\n      const init =")
doc = 'firmware/docs/per-modem-mtu.md'
replace_once(doc, 'An absent or malformed UCI value falls back to 1500 at runtime.',
    'The modem profile seeds 1500 only for a missing option and preserves existing\nowner settings. An absent or malformed UCI value falls back to 1500 at runtime.')
replace_once(doc, 'unwound before v16 for cached builds. Existing patches are unchanged. Firmware\ninput checks run `node --test firmware/tests/qmi-mtu.test.cjs`;',
    'unwound before v16 for cached builds. The original pre-MTU v16 patch is restored;\na reverse-only compatibility patch recognizes the brief PR #7 variant that\nembedded MTU in v16. Tests execute the actual builder cleanup on clean, original\nv16, PR #7 v16, and v17 caches, and preserve unrecognized local edits. Firmware\ninput checks run `node --test firmware/tests/qmi-mtu*.test.cjs`;')
changed = set(subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines())
assert changed == {builder, checks, patches, doc}, changed
subprocess.run(['git', 'diff', '--check'], check=True)
