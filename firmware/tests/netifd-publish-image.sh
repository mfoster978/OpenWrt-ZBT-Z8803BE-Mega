#!/bin/sh
# Run only in a disposable container with NET_ADMIN, not on the host/router.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 77
: "${MEGA_TEST_ROOTFS:?image required}" "${MEGA_TEST_REPO:?repository required}"
fixture=$(mktemp -d)
trap 'result=$?; [ "$result" = 0 ] || { cat "$fixture/netifd.log" "$fixture/ubusd.log" 2>/dev/null; }; kill ${cm1_pid:-} ${cm2_pid:-} ${netifd_pid:-} ${ubusd_pid:-} 2>/dev/null || true; rm -rf "$fixture"' EXIT
export MEGA_TEST_CONFIG="$fixture/config" MEGA_TEST_SOCKET="$fixture/ubus.sock"
export NETIFD_MAIN_DIR="$fixture/addons"
export MODEM_RUNDIR="$fixture/qmodem"
mkdir -p "$MEGA_TEST_CONFIG" "$fixture/addons/proto" /lib/functions /lib/config /usr/share/libubox
cp "$MEGA_TEST_ROOTFS/lib/functions.sh" /lib/functions.sh
cp "$MEGA_TEST_ROOTFS/lib/functions/"*.sh /lib/functions/
cp "$MEGA_TEST_ROOTFS/lib/config/uci.sh" /lib/config/uci.sh
cp "$MEGA_TEST_ROOTFS/usr/share/libubox/jshn.sh" /usr/share/libubox/jshn.sh
cp "$MEGA_TEST_ROOTFS/lib/netifd/netifd-proto.sh" "$MEGA_TEST_ROOTFS/lib/netifd/utils.sh" "$fixture/addons/"
cp "$MEGA_TEST_REPO/firmware/files/lib/netifd/proto/zbtqmi.sh" "$fixture/addons/proto/"
for name in ubus uci jshn; do install -m 755 "$MEGA_TEST_REPO/firmware/tests/image-tool-wrapper" "/usr/local/bin/$name"; done
touch "$MEGA_TEST_CONFIG/network" "$MEGA_TEST_CONFIG/qmodem"
uci set qmodem.main=global
uci set qmodem.main.enable_dial=1
for slot in 4_1 2_1; do
	uci set "qmodem.$slot=modem-device"
	uci set "qmodem.$slot.enable_dial=1"
	# QModem's late/remove scan may transiently leave discovery state disabled.
	# A live supervised CM session plus enable_dial must remain authoritative.
	uci set "qmodem.$slot.state=disabled"
done
uci commit qmodem
for interface in 4_1 4_1v6 2_1 2_1v6; do
	case "$interface" in 4_1*) slot=4_1; device=qmitest ;; *) slot=2_1; device=qmitest2 ;; esac
	uci set "network.$interface=interface"
	uci set "network.$interface.device=$device"
	uci set "network.$interface.proto=zbtqmi"
	uci set "network.$interface.modem_config=$slot"
	uci set "network.$interface.metric=200"
	uci set "network.$interface.auto=1"
done
uci commit network
ip link add qmitest type dummy
ip link set qmitest up
ip link add qmitest2 type dummy
ip link set qmitest2 up
printf '%s\n' '#!/bin/sh' 'while :; do sleep 60; done' > "$fixture/quectel-CM-M"
chmod 755 "$fixture/quectel-CM-M"
mkdir -p "$MODEM_RUNDIR/4_1_dir" "$MODEM_RUNDIR/2_1_dir"
"$fixture/quectel-CM-M" -i qmitest & cm1_pid=$!
"$fixture/quectel-CM-M" -i qmitest2 & cm2_pid=$!
printf '%s\n' "$cm1_pid" > "$MODEM_RUNDIR/4_1_dir/4_1.pid"
printf '%s\n' "$cm2_pid" > "$MODEM_RUNDIR/2_1_dir/2_1.pid"
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
ip addr add 10.233.98.190/30 dev qmitest2
ip route add default via 10.233.98.189 dev qmitest2 metric 210
ip -6 addr add 2001:db8:2::2/64 dev qmitest2 nodad
ip -6 route add default via 2001:db8:2::1 dev qmitest2 metric 210
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/qmi-publish.sh"
modem_config=4_1; modem_netcard=qmitest
zbt_qmi_owned() { [ "$(ip -o link show dev qmitest | cut -d: -f2 | tr -d ' ')" = qmitest ]; }
# The original CM supervisor has missed its notification. Exercise the
# independent repair against real netifd in pending/down state, not a stub.
zbt_netdev() { case "$1" in 4_1) echo qmitest ;; 2_1) echo qmitest2 ;; esac; }
zbt_health_online() { [ "${TEST_HEALTH:-online}" = online ]; }
qmi_ifindex=$(cat /sys/class/net/qmitest/ifindex)
backup_index=$(cat /sys/class/net/qmitest2/ifindex)
# Backup comes up first, as on the reported router.
zbt_qmi_reconcile_publication 2_1 4 qmitest2 "$backup_index"
zbt_qmi_reconcile_publication 2_1 6 qmitest2 "$backup_index"
TEST_HEALTH=offline
zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex"
zbt_qmi_reconcile_publication 4_1 6 qmitest "$qmi_ifindex"
ubus call network.interface.4_1 status | jq -e '.up==true and .["ipv4-address"][0].address=="192.0.0.2" and .route[0].nexthop=="192.0.0.1"'
ubus call network.interface.4_1v6 status | jq -e '.up==true and .["ipv6-address"][0].address=="2001:db8:1::2"'
ip -o addr show dev qmitest | grep -q '192.0.0.2/27'
ip -o -6 addr show dev qmitest | grep -q '2001:db8:1::2/64'
echo "PASS: netifd/ubus/UCI (native pinned build=${MEGA_NATIVE_NETIFD:-0}) accepts external QMI IPv4 and IPv6 publication; initially down, then correct source addresses/routes visible"
# Repeating repair must not emit another protocol notification.
ubus() {
	case "$*" in *notify_proto*) echo 'unexpected repeated publication' >&2; return 99;; esac
	/usr/local/bin/ubus "$@"
}
zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex"
zbt_qmi_reconcile_publication 4_1 6 qmitest "$qmi_ifindex"
unset -f ubus
echo 'PASS: repeated repair emits no notify_proto; stale external probe state does not circularly block tracker startup'
ubus call network reload >/dev/null
sleep 1
ubus call network.interface.4_1 status | jq -e '.autostart==true' >/dev/null
# Do not silently restore the CM path here: doing so would hide a reload
# regression that removes the primary's address/route when its peer starts.
ip -o -4 addr show dev qmitest | grep -q '192.0.0.2/27'
ip -4 route show default dev qmitest | grep -q 'via 192.0.0.1'
ip -o -4 addr show dev qmitest2 | grep -q '10.233.98.190/30'
ip -4 route show default dev qmitest2 | grep -q 'via 10.233.98.189'
zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex"
ubus call network.interface.4_1 status | jq -e '.up==true and .autostart==true and .["ipv4-address"][0].address=="192.0.0.2"' >/dev/null
echo 'PASS: unrelated network reload retains autostart and supervised Modem 1 republishes without touching Modem 2'
ubus call network.interface.4_1 down
sleep 1
ip addr replace 192.0.0.2/27 dev qmitest
ip route replace default via 192.0.0.1 dev qmitest metric 200
# A direct administrative down is stale when QModem itself remains enabled
# and its device-bound Internet health is fresh.
zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex"
ubus call network.interface.4_1 status | jq -e '.up==true and .autostart==true' >/dev/null
ubus call network.interface.4_1 down
ip addr replace 192.0.0.2/27 dev qmitest
ip route replace default via 192.0.0.1 dev qmitest metric 200
uci set qmodem.4_1.enable_dial=0
uci commit qmodem
if zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex"; then exit 1; fi
ubus call network.interface.4_1 status | jq -e '.up==false and .autostart==false' >/dev/null
ubus call network.interface.4_1v6 status | jq -e '.up==true' >/dev/null
ubus call network.interface.2_1 status | jq -e '.up==true and .["ipv4-address"][0].address=="10.233.98.190"' >/dev/null
ubus call network.interface.2_1v6 status | jq -e '.up==true' >/dev/null
echo 'PASS: a live QModem session re-arms stale netifd down; a disabled QModem remains down and backup stays online'
uci set qmodem.4_1.enable_dial=1
# Reproduce the retained configuration from the field report. netifd does not
# parse an interface carrying disabled=1, even though CM still owns a working
# address/default route and the device-bound speed test therefore succeeds.
uci set network.4_1.disabled=1
uci commit qmodem
uci commit network
ubus call network reload >/dev/null
sleep 1
if ubus -t 2 call network.interface.4_1 status >/dev/null 2>&1; then
	echo 'disabled=1 interface unexpectedly survived native netifd reload' >&2
	exit 1
fi
ip addr replace 192.0.0.2/27 dev qmitest
ip route replace default via 192.0.0.1 dev qmitest metric 200
zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex"
if uci -q get network.4_1.disabled >/dev/null 2>&1; then
	echo 'live repair left the netifd disabled option behind' >&2
	exit 1
fi
[ "$(uci -q get network.4_1.auto)" = 1 ]
ubus call network.interface.4_1 status | jq -e '.up==true and .autostart==true and .l3_device=="qmitest" and .["ipv4-address"][0].address=="192.0.0.2"' >/dev/null
# The peer CM loop normally republishes within five seconds after the required
# global config reload. Exercise that same reconciliation explicitly here.
zbt_qmi_reconcile_publication 2_1 4 qmitest2 "$backup_index"
ubus call network.interface.2_1 status | jq -e '.up==true and .["ipv4-address"][0].address=="10.233.98.190"' >/dev/null
echo 'PASS: retained network.4_1.disabled=1 is removed only for its verified live CM session; Modem 1 returns to netifd and backup remains publishable'
uci set network.4_1.proto=none
uci set network.4_1.device=qmitest
uci commit network
ubus call network reload >/dev/null
ubus call network.interface.4_1 down >/dev/null
ip addr replace 192.0.0.2/27 dev qmitest
ip route replace default via 192.0.0.1 dev qmitest metric 200
legacy_result=0
zbt_qmi_reconcile_publication 4_1 4 qmitest "$qmi_ifindex" || legacy_result=$?
[ "$legacy_result" = 2 ]
ubus call network.interface.4_1 status | jq -e '.up==true and .autostart==true and .proto=="none" and (.l3_device=="qmitest" or .device=="qmitest")' >/dev/null
echo 'PASS: reproduced field state proto=none/autostart=false with live CM route and repaired it by targeted logical ifup'
