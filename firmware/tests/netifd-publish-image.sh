#!/bin/sh
# Run only in a disposable container with NET_ADMIN, not on the host/router.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 77
: "${MEGA_TEST_ROOTFS:?image required}" "${MEGA_TEST_REPO:?repository required}"
fixture=$(mktemp -d)
trap 'result=$?; [ "$result" = 0 ] || { cat "$fixture/netifd.log" "$fixture/ubusd.log" 2>/dev/null; }; kill ${netifd_pid:-} ${ubusd_pid:-} 2>/dev/null || true; rm -rf "$fixture"' EXIT
export MEGA_TEST_CONFIG="$fixture/config" MEGA_TEST_SOCKET="$fixture/ubus.sock"
export NETIFD_MAIN_DIR="$fixture/addons"
mkdir -p "$MEGA_TEST_CONFIG" "$fixture/addons/proto" /lib/functions /lib/config /usr/share/libubox
cp "$MEGA_TEST_ROOTFS/lib/functions.sh" /lib/functions.sh
cp "$MEGA_TEST_ROOTFS/lib/functions/"*.sh /lib/functions/
cp "$MEGA_TEST_ROOTFS/lib/config/uci.sh" /lib/config/uci.sh
cp "$MEGA_TEST_ROOTFS/usr/share/libubox/jshn.sh" /usr/share/libubox/jshn.sh
cp "$MEGA_TEST_ROOTFS/lib/netifd/netifd-proto.sh" "$MEGA_TEST_ROOTFS/lib/netifd/utils.sh" "$fixture/addons/"
cp "$MEGA_TEST_REPO/firmware/files/lib/netifd/proto/zbtqmi.sh" "$fixture/addons/proto/"
for name in ubus uci jshn; do install -m 755 "$MEGA_TEST_REPO/firmware/tests/image-tool-wrapper" "/usr/local/bin/$name"; done
touch "$MEGA_TEST_CONFIG/network"
for interface in 4_1 4_1v6; do
	uci set "network.$interface=interface"
	uci set "network.$interface.device=qmitest"
	uci set "network.$interface.proto=zbtqmi"
	uci set "network.$interface.modem_config=4_1"
	uci set "network.$interface.metric=200"
done
uci commit network
ip link add qmitest type dummy
ip link set qmitest up
run_image() {
	program="$1"; shift
	if [ "${MEGA_NATIVE_NETIFD:-0}" = 1 ]; then
		"/usr/sbin/${program##*/}" "$@"
	else qemu-aarch64 ${MEGA_QEMU_FLAGS:-} -L "$MEGA_TEST_ROOTFS" "$MEGA_TEST_ROOTFS/$program" "$@"; fi
}
run_image sbin/ubusd -s "$MEGA_TEST_SOCKET" > "$fixture/ubusd.log" 2>&1 &
ubusd_pid=$!
sleep 1
run_image sbin/netifd -S -l 7 -c "$MEGA_TEST_CONFIG" -p "$fixture/addons" -s "$MEGA_TEST_SOCKET" -h /bin/true > "$fixture/netifd.log" 2>&1 &
netifd_pid=$!
sleep 2
ubus -t 3 list
ubus -t 5 call network.interface.4_1 status | jq -e '.up==false' >/dev/null
# Simulate CM assigning the two PDP families only after netifd setup.
ip addr add 192.0.0.2/27 dev qmitest
ip route add default via 192.0.0.1 dev qmitest metric 200
ip -6 addr add 2001:db8:1::2/64 dev qmitest nodad
ip -6 route add default via 2001:db8:1::1 dev qmitest metric 200
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/qmi-publish.sh"
modem_config=4_1; modem_netcard=qmitest
zbt_qmi_owned() { [ "$(ip -o link show dev qmitest | cut -d: -f2 | tr -d ' ')" = qmitest ]; }
zbt_qmi_publish 4 4_1 || { cat "$fixture/netifd.log"; exit 1; }
zbt_qmi_publish 6 4_1v6 || { cat "$fixture/netifd.log"; exit 1; }
ubus call network.interface.4_1 status | jq -e '.up==true and .["ipv4-address"][0].address=="192.0.0.2" and .route[0].nexthop=="192.0.0.1"'
ubus call network.interface.4_1v6 status | jq -e '.up==true and .["ipv6-address"][0].address=="2001:db8:1::2"'
ip -o addr show dev qmitest | grep -q '192.0.0.2/27'
ip -o -6 addr show dev qmitest | grep -q '2001:db8:1::2/64'
echo "PASS: netifd/ubus/UCI (native pinned build=${MEGA_NATIVE_NETIFD:-0}) accepts external QMI IPv4 and IPv6 publication; initially down, then correct source addresses/routes visible"
