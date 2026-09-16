from pathlib import Path
import subprocess

expected = {
    'firmware/files/usr/sbin/zbt-qmodem-profile': '9b9dde3e1b7edb83e1400c11d6935351fe981c7c',
    'firmware/docker/build-openwrt.sh': '074aa21d167fcb3703adca7fabfc01eb8dd4b66c',
    'firmware/scripts/check-build-inputs.sh': '66395f5d583edefd98c9ecc99e3f59f866c44e5a',
    'firmware/tests/check-patches.cjs': '21d6a06f622b1348039b0e06935896f44876f2b7',
    'firmware/tests/qmodem-mtu-cache.cjs': '86663938c0a2f3de72d6700b178f86513130948a',
}
for name, sha in expected.items():
    actual = subprocess.check_output(['git', 'hash-object', name], text=True).strip()
    assert actual == sha, (name, actual, sha)


def replace_once(name, before, after):
    p = Path(name)
    s = p.read_text()
    assert s.count(before) == 1, (name, 'unexpected match count', s.count(before), before)
    p.write_text(s.replace(before, after))

profile = 'firmware/files/usr/sbin/zbt-qmodem-profile'
replace_once(profile,
    'monitor_enabled=0 enable_dial=1 zbt_5g_policy=auto mtu=1500; do',
    'monitor_enabled=0 enable_dial=1 zbt_5g_policy=auto mtu=1500 lan_ipv6_policy=manual; do')

builder = 'firmware/docker/build-openwrt.sh'
replace_once(builder,
    'for patch_name in qmodem-mtu-v17.patch qmodem-network-apply-v16.patch',
    'for patch_name in qmodem-lan-ipv6-v18.patch qmodem-mtu-v17.patch qmodem-network-apply-v16.patch')
mtu_apply = 'patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-mtu-v17.patch"'
replace_once(builder, mtu_apply + '\nfor apn in',
    mtu_apply + '\n# Per-modem LAN IPv6 policy UI. Runtime enforcement is an overlay service.\n'
    'patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-lan-ipv6-v18.patch"\nfor apn in')

checks = 'firmware/scripts/check-build-inputs.sh'
replace_once(checks,
    'node --test firmware/tests/qmi-mtu*.test.cjs',
    'node --test firmware/tests/qmi-mtu*.test.cjs firmware/tests/lan-ipv6-guard.test.cjs')
replace_once(checks,
    '  firmware/files/etc/uci-defaults/95-mwan3-defaults \\\n',
    '  firmware/files/etc/uci-defaults/95-mwan3-defaults \\\n  firmware/files/etc/uci-defaults/98-zbt-lan-ipv6-guard \\\n')
replace_once(checks,
    '  firmware/files/usr/sbin/zbt-mwan-preset \\\n',
    '  firmware/files/usr/sbin/zbt-mwan-preset \\\n  firmware/files/usr/sbin/zbt-lan-ipv6-guard \\\n  firmware/files/etc/init.d/zbt-lan-ipv6-guard \\\n')
replace_once(checks,
    'test -x firmware/files/usr/sbin/zbt-speedify-control\n',
    'test -x firmware/files/usr/sbin/zbt-speedify-control\n'
    'test -x firmware/files/usr/sbin/zbt-lan-ipv6-guard\n'
    'test -x firmware/files/etc/init.d/zbt-lan-ipv6-guard\n'
    'test -x firmware/files/etc/uci-defaults/98-zbt-lan-ipv6-guard\n')
replace_once(checks,
    'test -s firmware/patches/qmodem-mtu-v17.patch\n',
    'test -s firmware/patches/qmodem-mtu-v17.patch\n'
    'test -s firmware/patches/qmodem-lan-ipv6-v18.patch\n')
replace_once(checks,
    "grep -Fq 'qmodem-mtu-v17.patch' firmware/docker/build-openwrt.sh\n",
    "grep -Fq 'qmodem-mtu-v17.patch' firmware/docker/build-openwrt.sh\n"
    "grep -Fq 'qmodem-lan-ipv6-v18.patch' firmware/docker/build-openwrt.sh\n"
    "grep -Fq 'lan_ipv6_policy=manual' firmware/files/usr/sbin/zbt-qmodem-profile\n"
    "grep -Fq 'zbt_lan_ipv6_has_pd' firmware/files/usr/sbin/zbt-lan-ipv6-guard\n")

patches = 'firmware/tests/check-patches.cjs'
replace_once(patches,
    "'qmodem-network-apply-v16.patch', 'qmodem-mtu-v17.patch'], '']",
    "'qmodem-network-apply-v16.patch', 'qmodem-mtu-v17.patch', 'qmodem-lan-ipv6-v18.patch'], '']")
replace_once(patches,
    '// Exercise the builder\'s previous-release cache path: the new MTU\n        // patch is absent but all older patches are still installed.',
    '// Exercise the builder\'s previous-release cache path: the newest\n        // QModem patch is absent but all older patches are still installed.')

cache = 'firmware/tests/qmodem-mtu-cache.cjs'
replace_once(cache,
    "for (const variant of ['clean', 'original-v16', 'mtu-in-v16', 'versioned-v17']) {",
    "for (const variant of ['clean', 'original-v16', 'mtu-in-v16', 'versioned-v17', 'versioned-v18']) {")
replace_once(cache,
    "for (const patch of variant === 'versioned-v17' ? patches : patches.slice(0, -1))\n          run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });",
    "const applied = variant === 'versioned-v18' ? patches\n          : variant === 'versioned-v17' ? patches.slice(0, -1)\n          : patches.slice(0, -2);\n        for (const patch of applied)\n          run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: patch });")
replace_once(cache,
    "if (variant === 'versioned-v17' || variant === 'mtu-in-v16') {\n        const js = fs.readFileSync(view, 'utf8');\n        assert.equal((js.match(/s\\.option\\(form\\.Value, 'mtu'/g) || []).length, 1, 'exactly one MTU control');\n        new Function(js);\n      }",
    "if (variant === 'versioned-v17' || variant === 'versioned-v18' || variant === 'mtu-in-v16') {\n        const js = fs.readFileSync(view, 'utf8');\n        assert.equal((js.match(/s\\.option\\(form\\.Value, 'mtu'/g) || []).length, 1, 'exactly one MTU control');\n        if (variant === 'versioned-v18')\n          assert.equal((js.match(/s\\.option\\(form\\.ListValue, 'lan_ipv6_policy'/g) || []).length, 1, 'exactly one LAN IPv6 policy control');\n        new Function(js);\n      }")

# Auto mode must yield to QModem's explicit relay/extended-prefix features.
guard = 'firmware/files/usr/sbin/zbt-lan-ipv6-guard'
replace_once(guard,
    '\tcase "$policy" in\n\t\tauto)\n\t\t\tif zbt_lan_ipv6_has_pd "${modem}v6"; then',
    '\tcase "$policy" in\n\t\tauto)\n\t\t\tif [ "$(uci -q get "qmodem.$modem.ra_master")" = 1 ] || [ "$(uci -q get "qmodem.$modem.extend_prefix")" = 1 ]; then\n\t\t\t\tzbt_lan_ipv6_release\n\t\t\telif zbt_lan_ipv6_has_pd "${modem}v6"; then')

subprocess.run(['chmod', '+x',
    'firmware/files/usr/sbin/zbt-lan-ipv6-guard',
    'firmware/files/etc/init.d/zbt-lan-ipv6-guard',
    'firmware/files/etc/uci-defaults/98-zbt-lan-ipv6-guard'], check=True)
subprocess.run(['git', 'diff', '--check'], check=True)
