#!/bin/bash
# Real forwarded packets in a disposable network namespace. A bridge port
# models each client class; no physical Wi-Fi radio or live router is touched.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 77
: "${MEGA_TEST_REPO:?repository required}"
fixture=$(mktemp -d)
cleanup() {
	for ns in mega-wired mega-wifi mega-wan1 mega-wan2; do ip netns del "$ns" 2>/dev/null || true; done
	rm -rf "$fixture"
}
trap cleanup EXIT
if [ -n "${MEGA_MWAN_LIBRARY:-}" ]; then
	cp "$MEGA_MWAN_LIBRARY" "$fixture/mwan3.sh"
else
	curl -fsSL --max-time 30 'https://raw.githubusercontent.com/openwrt/packages/db3b315119519f9194dad8aa668aa40618df9b20/net/mwan3/files/lib/mwan3/mwan3.sh' -o "$fixture/mwan3.sh"
fi
# The actual pinned policy builder, not a reimplementation of tier selection.
eval "$(sed -n '/^mwan3_set_policy()/,/^mwan3_set_sticky_iptables()/p' "$fixture/mwan3.sh" | sed '$d')"
mwan3_push_update() { update="$update"$'\n'"$*"; }
LOG() { echo "$*" >&2; exit 1; }
IPT4='iptables -t mangle -w'; IPT4R='iptables-restore -n'
IPT6='ip6tables -t mangle -w'; IPT6R='ip6tables-restore -n'
NO_IPV6=0; DEFAULT_LOWEST_METRIC=256; MMX_MASK=0x3f00
MMX_DEFAULT=0x3f00; MMX_UNREACHABLE=0x3e00; MMX_BLACKHOLE=0x3d00
MWAN3_STATUS_IPTABLES_LOG_DIR=$fixture
config_get() {
	local value="${4:-}"
	case "$2:$3" in
		failover:last_resort|failover6:last_resort) value=unreachable ;;
		failover_4_1:interface) value=4_1 ;; failover_2_1:interface) value=2_1 ;;
		failover6_4_1v6:interface) value=4_1v6 ;; failover6_2_1v6:interface) value=2_1v6 ;;
		failover_4_1:metric|failover6_4_1v6:metric) value=4 ;;
		failover_2_1:metric|failover6_2_1v6:metric) value=5 ;;
		*:weight) value=1 ;; *v6:family) value=ipv6 ;; *:family) value=ipv4 ;;
	esac
	printf -v "$1" '%s' "$value"
}
config_list_foreach() {
	if [ "$1" = failover ]; then "$3" failover_4_1; "$3" failover_2_1;
	else "$3" failover6_4_1v6; "$3" failover6_2_1v6; fi
}
network_get_device() { case "$2" in 4_1*) printf -v "$1" wan1 ;; *) printf -v "$1" wan2 ;; esac; }
mwan3_get_iface_id() { case "$2" in 4_1) printf -v "$1" 4 ;; 2_1) printf -v "$1" 5 ;; 4_1v6) printf -v "$1" 6 ;; 2_1v6) printf -v "$1" 7 ;; esac; }
mwan3_id2mask() { printf '0x%x' "$(( ${!1} << 8 ))"; }
mwan3_get_iface_hotplug_state() { case "$1" in 4_1*) echo "$primary" ;; *) echo online ;; esac; }
ip link add br-lan type bridge
ip addr add 192.168.88.1/24 dev br-lan
ip -6 addr add fd00:88::1/64 dev br-lan nodad
ip link set br-lan up
for pair in wired:10 wifi:11; do
	client=${pair%:*}; suffix=${pair#*:}; ns=mega-$client
	ip netns add "$ns"
	ip link add "$client" type veth peer name eth0 netns "$ns"
	ip link set "$client" master br-lan; ip link set "$client" up
	ip -n "$ns" link set lo up; ip -n "$ns" link set eth0 up
	ip -n "$ns" addr add "192.168.88.$suffix/24" dev eth0
	ip -n "$ns" -6 addr add "fd00:88::$suffix/64" dev eth0 nodad
	ip -n "$ns" route add default via 192.168.88.1
	ip -n "$ns" -6 route add default via fd00:88::1
done
for n in 1 2; do
	ns=mega-wan$n
	ip netns add "$ns"
	ip link add "wan$n" type veth peer name eth0 netns "$ns"
	ip link set "wan$n" up; ip -n "$ns" link set lo up; ip -n "$ns" link set eth0 up
	ip addr add "192.0.$n.1/24" dev "wan$n"; ip -n "$ns" addr add "192.0.$n.2/24" dev eth0
	ip -6 addr add "2001:db8:$n::1/64" dev "wan$n" nodad; ip -n "$ns" -6 addr add "2001:db8:$n::2/64" dev eth0 nodad
	ip -n "$ns" addr add 198.18.0.1/32 dev lo
	ip -n "$ns" -6 addr add 2001:db8:ffff::1/128 dev lo nodad
	ip route add table "$((n+3))" default via "192.0.$n.2" dev "wan$n"
	ip -6 route add table "$((n+5))" default via "2001:db8:$n::2" dev "wan$n"
	ip rule add pref "$((2000+n))" fwmark "$(( (n+3)<<8 ))/0x3f00" lookup "$((n+3))"
	ip -6 rule add pref "$((2000+n))" fwmark "$(( (n+5)<<8 ))/0x3f00" lookup "$((n+5))"
	ip route add default via "192.0.$n.2" dev "wan$n" metric "$((190+n*10))"
	ip -6 route add default via "2001:db8:$n::2" dev "wan$n" metric "$((190+n*10))"
	iptables -t nat -A POSTROUTING -o "wan$n" -j MASQUERADE
	ip6tables -t nat -A POSTROUTING -o "wan$n" -j MASQUERADE
done
sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
for key in /proc/sys/net/ipv4/conf/*/rp_filter; do printf 0 > "$key"; done
primary=online
mwan3_create_policies_iptables failover || true
mwan3_create_policies_iptables failover6 || true
iptables -t mangle -A PREROUTING -i br-lan -j mwan3_policy_failover
ip6tables -t mangle -A PREROUTING -i br-lan -j mwan3_policy_failover6
for primary in online offline online; do
	mwan3_create_policies_iptables failover || true
	mwan3_create_policies_iptables failover6 || true
	for client in wired wifi; do
		ip netns exec "mega-$client" ping -c 1 -W 2 198.18.0.1 >/dev/null
		ip netns exec "mega-$client" ping -6 -c 1 -W 2 2001:db8:ffff::1 >/dev/null
	done
	if [ "$primary" = online ]; then mark4=0x400; mark6=0x600; else mark4=0x500; mark6=0x700; fi
	iptables -t mangle -S mwan3_policy_failover | grep -q -- "--set-xmark $mark4/0x3f00"
	ip6tables -t mangle -S mwan3_policy_failover6 | grep -q -- "--set-xmark $mark6/0x3f00"
done
echo 'PASS: actual pinned mwan3 policy builder routes both bridged client classes over IPv4/NAT66: primary -> backup -> primary'
