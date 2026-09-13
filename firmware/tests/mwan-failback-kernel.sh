#!/bin/sh
# Disposable network namespace only. Real kernel conntrack insertion/filtering
# verifies that Wi-Fi/Ethernet LAN flows expire while router/VPN flows survive.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 77
: "${MEGA_TEST_REPO:?repository required}"
conntrack -L >/dev/null 2>&1
insert() {
	if [ "$1" != "$3" ]; then set -- "$@" --src-nat "$3"; fi
	conntrack -I -p tcp --timeout 300 --state ESTABLISHED \
		--orig-src "$1" --orig-dst 198.51.100.1 --sport "$2" --dport 443 \
		--reply-src 198.51.100.1 --reply-dst "$3" --reply-port-src 443 --reply-port-dst "$2" \
		--mark "$4" ${5:+"$5"} ${6:+"$6"} >/dev/null 2>&1
}
# Two LAN clients (Wi-Fi and wired), plus higher-priority, router, extra VPN
# mark and non-NAT flows which must NOT be removed.
insert 192.168.1.10 41001 192.0.0.2 0x500
insert 192.168.1.11 41002 192.0.0.2 0x500
insert 192.168.1.12 41003 192.0.0.2 0x400
insert 192.168.1.1 41004 192.0.0.2 0x500
insert 192.0.0.2 41005 192.0.0.2 0x500
insert 192.168.1.13 41006 192.0.0.2 0x10500
insert 192.168.1.14 41007 192.168.1.14 0x500
run_failback() {
	# Retain the exact production selector/deletion code. Only OpenWrt UCI,
	# netifd and policy metadata are fixtures; conntrack runs in the kernel.
	{
		printf '%s\n' 'uci() {
case "$*" in *default_rule.use_policy) echo failover ;; esac
}
config_load() { :; }
config_foreach() { :; }
config_get() { eval "$1=0x3F00"; }
zbt_mwan_winner() { echo 4_1; }
mwan3_get_iface_id() { case "$2" in 4_1) eval "$1=4" ;; 2_1) eval "$1=5" ;; *) eval "$1=1" ;; esac; }
mwan3_id2mask() { eval "value=\$$1"; printf "0x%x" "$((value << 8))"; }
network_get_device() { eval "$1=br-lan"; }
policy() { echo "-A mwan3_policy_failover -j MARK --set-xmark 0x400/0x3f00"; }
IPT4=policy
ip() { echo "10: br-lan inet 192.168.1.1/24 scope global br-lan"; }'
		sed '/^\. /d' "$MEGA_TEST_REPO/firmware/files/usr/sbin/zbt-mwan-failback"
	} | sh -s 4_1
}
run_failback
entries=$(conntrack -L -f ipv4 -o extended 2>/dev/null)
for port in 41001 41002; do
	if printf '%s\n' "$entries" | grep -q "sport=$port "; then echo "lower priority LAN flow survived: $port" >&2; exit 1; fi
done
for port in 41003 41004 41005 41006 41007; do
	printf '%s\n' "$entries" | grep -q "sport=$port "
done
echo 'PASS: real kernel failback removes only lower-priority NATed LAN flows; primary, router, VPN and non-NAT flows survive'
