#!/bin/sh
# Run against the BusyBox binary and musl loader extracted from the actual
# released/built SquashFS, not the host distribution's fuller BusyBox config.
# Example (inside an x86 container with qemu-aarch64 installed):
# MEGA_TEST_ROOTFS=/image MEGA_TEST_REPO=/repo sh firmware/tests/router-busybox.sh
set -eu
: "${MEGA_TEST_ROOTFS:?path to extracted router rootfs required}"
: "${MEGA_TEST_REPO:?path to this repository required}"
export MEGA_TEST_ROOTFS MEGA_TEST_REPO
command -v qemu-aarch64 >/dev/null
test -x "$MEGA_TEST_ROOTFS/bin/busybox"
qemu-aarch64 -L "$MEGA_TEST_ROOTFS" "$MEGA_TEST_ROOTFS/bin/busybox" sh -s <<'CHECK'
set -eu
# External applets must use the same router build too. Do not accidentally
# test Alpine's tr/awk while testing the router's ash interpreter.
tr() { qemu-aarch64 -L "$MEGA_TEST_ROOTFS" "$MEGA_TEST_ROOTFS/bin/busybox" tr "$@"; }
awk() { qemu-aarch64 -L "$MEGA_TEST_ROOTFS" "$MEGA_TEST_ROOTFS/bin/busybox" awk "$@"; }
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/qmodem-5g.sh"
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/qmodem-cell-discovery.sh"
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/5g-adaptive.sh"
for manufacturer in Quectel quectel QUECTEL 'Quectel Wireless Solutions'; do
	zbt_5g_vendor
done
manufacturer=Fibocom
if zbt_5g_vendor; then echo 'incorrect vendor accepted' >&2; exit 1; fi
number=$(zbt_quectel_normalize_number ' +1 (555) 012-3456 ')
[ "$number" = +15550123456 ]
reply=$(printf '+QNWPREFCFG: "nr5g_disable_mode",0\r\nOK\r\n')
[ "$(zbt_5g_parse "$reply" nr5g_disable_mode)" = 0 ]
reply=$(printf '+QENG: "servingcell","NOCONN","NR5G-SA","TDD",310,260,1234,495,0123,520110,41,100,-101,-11,18,1,-\r\nOK\r\n')
[ "$(zbt_adaptive_serving_parse "$reply")" = 'sa -101 18' ]
printf 'PASS: actual router ash/tr/awk: vendor checks, SIM formatting and 5G parser\n'
CHECK
