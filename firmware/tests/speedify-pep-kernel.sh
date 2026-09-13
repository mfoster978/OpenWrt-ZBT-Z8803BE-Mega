#!/bin/sh
# Run only in a throwaway network namespace/container with NET_ADMIN.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 2
: "${MEGA_TEST_REPO:?repository required}"
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/speedify-routing.sh"
sf_log() { :; }
# Only the proprietary CLI is mocked; nft and policy routing are real.
timeout() { return 1; }
ip link set lo up
nft add table ip connectify_pep
nft add chain ip connectify_pep prerouting '{ type filter hook prerouting priority mangle; policy accept; }'
nft add rule ip connectify_pep prerouting meta l4proto tcp meta mark set 0x9332
nft add table ip mega_test_preserve
nft add chain ip mega_test_preserve unrelated
ip -4 rule add pref 100 fwmark 0x9332 table 807
ip -4 rule add pref 101 fwmark 0x1234 table 807
ip -4 rule add pref 102 fwmark 0x9332/0xffff table 807
ip -4 route add local default dev lo table 807
ip -4 route add 198.18.0.0/15 dev lo table 807
sf_pep_listener && exit 3
sf_clear_dead_pep
if sf_pep_table; then echo 'dead PEP table survived' >&2; exit 1; fi
nft list table ip mega_test_preserve >/dev/null
rules=$(ip -4 rule show)
if printf '%s\n' "$rules" | grep -q '^100:'; then exit 1; fi
printf '%s\n' "$rules" | grep -q '^101:.*fwmark 0x1234 lookup 807'
printf '%s\n' "$rules" | grep -q '^102:.*fwmark 0x9332/0xffff lookup 807'
routes=$(ip -4 route show table 807)
printf '%s\n' "$routes" | grep -q '198.18.0.0/15 dev lo'
if printf '%s\n' "$routes" | grep -q 'local default'; then exit 1; fi
printf 'PASS: real nft/ip: dead PEP table/exact mark/local route removed; unrelated rules/routes preserved\n'
