#!/bin/sh
# Run ONLY in a disposable network namespace/container with CAP_NET_ADMIN.
# No real modem is queried or reconfigured. Tests real iproute2 route flushing.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 77
: "${MEGA_TEST_REPO:?repository path required}"
for device in megaqmi1 megaqmi2 megalan; do
	if ip link show dev "$device" >/dev/null 2>&1; then
		echo "test interface already exists; refusing to touch it" >&2; exit 1
	fi
done
testdir=$(mktemp -d)
trap 'ip link del megaqmi1 2>/dev/null || true; ip link del megaqmi2 2>/dev/null || true; ip link del megalan 2>/dev/null || true; rm -rf "$testdir"' EXIT
for device in megaqmi1 megaqmi2 megalan; do
	ip link add "$device" type dummy
	ip link set "$device" up
done
ip addr add 192.0.0.2/27 dev megaqmi1
ip addr add 192.0.0.2/27 dev megaqmi2
ip addr add 192.168.1.1/24 dev megalan
ip -6 addr add 2001:db8:1::2/64 dev megaqmi1 nodad
ip -6 addr add 2001:db8:2::2/64 dev megaqmi2 nodad
ip route add default via 192.0.0.1 dev megaqmi1 metric 200
ip route add default via 192.0.0.1 dev megaqmi2 metric 210
ip -6 route add default via 2001:db8:1::1 dev megaqmi1 metric 200
ip -6 route add default via 2001:db8:2::1 dev megaqmi2 metric 210
mkdir -p "$testdir/sys/bus/usb/devices/4-1/4-1:1.4/net/megaqmi1" "$testdir/sys/class/net"
ln -s /sys/class/net/megaqmi1 "$testdir/sys/class/net/megaqmi1"
ZBT_SYSFS="$testdir/sys"
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/dual-modem.sh"
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/qmi-session.sh"
modem_config=4_1; modem_netcard=megaqmi1; bridge_enabled=0
qmi_ifindex=$(cat /sys/class/net/megaqmi1/ifindex)
zbt_qmi_flush
test -z "$(ip -o -4 addr show dev megaqmi1 scope global)"
test -z "$(ip -o -6 addr show dev megaqmi1 scope global)"
test -z "$(ip -4 route show default dev megaqmi1)"
test -z "$(ip -6 route show default dev megaqmi1)"
ip -4 addr show dev megaqmi2 | grep -q '192.0.0.2/27'
ip -6 addr show dev megaqmi2 | grep -q '2001:db8:2::2/64'
ip -4 route show default dev megaqmi2 | grep -q 'metric 210'
ip -6 route show default dev megaqmi2 | grep -q 'metric 210'
ip -4 addr show dev megalan | grep -q '192.168.1.1/24'
echo 'PASS: real IPv4/IPv6 cleanup removes only failed modem routes/addresses; peer modem and LAN preserved'
