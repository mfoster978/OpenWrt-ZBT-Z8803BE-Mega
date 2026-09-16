from pathlib import Path
import hashlib
import subprocess

expected = {
    'firmware/files/usr/lib/zbt/qmi-session.sh': '9c2ebf2fff0e9de16aba8b1504c96366399f559f',
    'firmware/docker/build-openwrt.sh': 'f1d9bfcd736f7a28af9ca1b1d8b49b3c9185b07e',
    'firmware/scripts/check-build-inputs.sh': '5c1f15abc9f63b61c272ac8ec5c8035ce8d370be',
    'firmware/tests/check-patches.cjs': 'd84c5042a6a76d9eca1935d73bff92b47d7403ff',
    'firmware/patches/qmodem-mtu-v17.patch': 'b9b04b58f0d9d15f2884ccefece2c7ea0bd12f17',
    'firmware/tests/qmi-mtu.test.cjs': '93a0030a65a2bafe15adf015292ec136d43ee523',
    'firmware/docs/per-modem-mtu.md': '553895bdc2483b7c880c8d942388598a1459cfe4',
}
for name, sha in expected.items():
    actual = subprocess.check_output(['git', 'hash-object', name], text=True).strip()
    assert actual == sha, (name, actual, sha)


def replace_once(name, before, after):
    p = Path(name)
    s = p.read_text()
    assert s.count(before) == 1, (name, 'unexpected match count', s.count(before), before)
    p.write_text(s.replace(before, after))


qmi = 'firmware/files/usr/lib/zbt/qmi-session.sh'
helper = '''# Per-slot host-interface policy. Missing or malformed configuration keeps the
# proven 1500-byte default; never persist a replacement over the user's UCI.
# Four decimal digits also bound arithmetic and reject lists/shell expressions.
zbt_qmi_target_mtu() {
\tlocal configured_mtu
\tconfigured_mtu=$(uci -q get "qmodem.$modem_config.mtu") || configured_mtu=''
\tcase "$configured_mtu" in
\t\t[1-9][0-9][0-9][0-9])
\t\t\tif [ "$configured_mtu" -ge 1280 ] && [ "$configured_mtu" -le 1500 ]; then
\t\t\t\tprintf '%s\\n' "$configured_mtu"
\t\t\t\treturn 0
\t\t\tfi
\t\t\t;;
\tesac
\tprintf '%s\\n' 1500
}

'''
replace_once(qmi, 'zbt_qmi_normalize_mtu() {', helper + 'zbt_qmi_normalize_mtu() {')
replace_once(qmi, 'local raw_ip current_mtu verified_mtu', 'local raw_ip current_mtu verified_mtu target_mtu')
replace_once(qmi, '''\t[ "$current_mtu" -lt 1500 ] || return 0
\tip link set dev "$modem_netcard" mtu 1500 || return 1
\tverified_mtu=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/mtu" 2>/dev/null)
\t[ "$verified_mtu" = 1500 ] || return 1
\tlogger -t zbt-qmi "slot=$modem_config device=$modem_netcard action=normalize-mtu old=$current_mtu new=1500 result=verified"''', '''\ttarget_mtu=$(zbt_qmi_target_mtu)
\t[ "$current_mtu" != "$target_mtu" ] || return 0
\t# Recheck the physical device after reading configuration. A prior
\t# supervisor must never change a replacement device or the other modem.
\tzbt_qmi_owned || return 1
\tip link set dev "$modem_netcard" mtu "$target_mtu" || return 1
\tzbt_qmi_owned || return 1
\tverified_mtu=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/mtu" 2>/dev/null)
\t[ "$verified_mtu" = "$target_mtu" ] || return 1
\tlogger -t zbt-qmi "slot=$modem_config device=$modem_netcard action=normalize-mtu old=$current_mtu new=$target_mtu result=verified"''')
replace_once(qmi, 'action=normalize-mtu new=1500 result=failed',
             'action=normalize-mtu new=$(zbt_qmi_target_mtu) result=failed')
assert subprocess.check_output(['git', 'hash-object', qmi], text=True).strip() == '56d69d2bbeb90b446a65b9584ae2b8d3f49fb876'

builder = 'firmware/docker/build-openwrt.sh'
replace_once(builder, 'for patch_name in qmodem-network-apply-v16.patch ',
             'for patch_name in qmodem-mtu-v17.patch qmodem-network-apply-v16.patch ')
apply_v16 = 'patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-network-apply-v16.patch"'
replace_once(builder, apply_v16, apply_v16 + '\n# Per-slot MTU UI; a separate patch preserves old cached-build unwinding.\n' +
             apply_v16.replace('qmodem-network-apply-v16.patch', 'qmodem-mtu-v17.patch'))
replace_once(builder, 'ip link set dev "$modem_netcard" mtu 1500',
             'ip link set dev "$modem_netcard" mtu "$target_mtu"')

checks = 'firmware/scripts/check-build-inputs.sh'
replace_once(checks, 'ip link set dev "$modem_netcard" mtu 1500',
             'ip link set dev "$modem_netcard" mtu "$target_mtu"')
replace_once(checks, 'bash -n firmware/docker/build-openwrt.sh\n',
             'bash -n firmware/docker/build-openwrt.sh\nnode --test firmware/tests/qmi-mtu.test.cjs\n')
replace_once(checks, "grep -Fq 'zbt_qmi_normalize_mtu' firmware/files/usr/lib/zbt/qmi-session.sh\n",
             "grep -Fq 'zbt_qmi_normalize_mtu' firmware/files/usr/lib/zbt/qmi-session.sh\n" +
             "grep -Fq 'zbt_qmi_target_mtu' firmware/files/usr/lib/zbt/qmi-session.sh\n" +
             "test -s firmware/patches/qmodem-mtu-v17.patch\n" +
             "grep -Fq 'qmodem-mtu-v17.patch' firmware/docker/build-openwrt.sh\n")

patches = 'firmware/tests/check-patches.cjs'
replace_once(patches, "'qmodem-network-apply-v16.patch'], '']",
             "'qmodem-network-apply-v16.patch', 'qmodem-mtu-v17.patch'], '']")
anchor = "        assert.notEqual(absent.status, 0, 'absent latest patch must not be applied while reversing a cached build');"
replace_once(patches, anchor, anchor + '''
        // Exercise the builder's previous-release cache path: the new MTU
        // patch is absent but all older patches are still installed.
        for (const cachedPatch of [...patches].reverse()) {
          const reverse = spawnSync('patch', ['--dry-run', '--force', '--fuzz=0', '--reverse', '-p1', '-d', tree],
            { input: cachedPatch, encoding: 'utf8' });
          assert.ifError(reverse.error);
          if (reverse.status === 0)
            run('patch', ['--force', '--fuzz=0', '--reverse', '-p1', '-d', tree], { input: cachedPatch });
          else
            run('patch', ['--dry-run', '--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: cachedPatch });
        }
        for (const previousPatch of patches.slice(0, -1))
          run('patch', ['--batch', '--fuzz=0', '--forward', '-p1', '-d', tree], { input: previousPatch });
''')

changed = set(subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines())
assert changed == {qmi, builder, checks, patches}, changed
subprocess.run(['git', 'diff', '--check'], check=True)
subprocess.run(['git', 'diff', '--stat'], check=True)
