#!/bin/bash
# Exercise real socket marks and packets in disposable network namespaces.
# Invoke only inside an isolated network AND mount namespace (or privileged
# disposable container); never alter a running router's/host's routing rules.
set -eu
[ "${MEGA_ISOLATED_NETWORK_TEST:-0}" = 1 ] || exit 77
: "${MEGA_TEST_REPO:?repository required}"
: "${MEGA_MWAN_SOCKOPT_SOURCE:?pinned mwan3 sockopt_wrap.c required}"
fixture=$(mktemp -d)
cleanup() {
	for ns in mega-health1 mega-health2; do ip netns del "$ns" 2>/dev/null || true; done
	rm -rf "$fixture"
}
trap cleanup EXIT
cc -shared -fPIC -DCONFIG_IPV6 -o "$fixture/mwan-sockopt.so" "$MEGA_MWAN_SOCKOPT_SOURCE" -ldl
export ZBT_MWAN_SOCKOPT="$fixture/mwan-sockopt.so"
eval "$(sed '/^\. \/usr\/lib\/zbt\/dual-modem.sh$/d' "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/modem-health.sh")"
uci() { [ "$*" != '-q get mwan3.globals.mmx_mask' ] || echo 0x3f00; }
zbt_health_socket_ready
ip link set lo up
for n in 1 2; do
	ns=mega-health$n
	ip netns add "$ns"
	ip link add "wwan$n" type veth peer name eth0 netns "$ns"
	ip link set "wwan$n" up
	ip -n "$ns" link set lo up
	ip -n "$ns" link set eth0 up
	# Real cellular CLAT modems can present identical IPv4 address/gateway
	# pairs. The physical device binding must still identify the selected slot.
	ip addr add 192.0.0.2/27 dev "wwan$n"
	ip -n "$ns" addr add 192.0.0.1/27 dev eth0
	ip -6 addr add "2001:db8:$n::2/64" dev "wwan$n" nodad
	ip -n "$ns" -6 addr add "2001:db8:$n::1/64" dev eth0 nodad
	ip -n "$ns" addr add 198.18.0.1/32 dev lo
	ip -n "$ns" -6 addr add 2001:db8:ffff::1/128 dev lo nodad
	ip route add default via 192.0.0.1 dev "wwan$n" metric "$((190+n*10))"
	ip -6 route add default via "2001:db8:$n::1" dev "wwan$n" metric "$((190+n*10))"
	ip route add table "$((n+2))" default via 192.0.0.1 dev "wwan$n"
	ip -6 route add table "$((n+2))" default via "2001:db8:$n::1" dev "wwan$n"
	for family in 4 6; do
		ip -"$family" rule add pref "$((2000+n))" fwmark "$(((n+2)<<8))/0x3f00" lookup "$((n+2))"
		ip -"$family" rule add pref "$((3000+n))" fwmark "$(((n+2)<<8))/0x3f00" unreachable
	done
	ip netns exec "$ns" iptables -A INPUT -p icmp --icmp-type echo-request -j ACCEPT
	ip netns exec "$ns" ip6tables -A INPUT -p ipv6-icmp --icmpv6-type echo-request -j ACCEPT
done
ping() { busybox ping "$@"; }
for key in /proc/sys/net/ipv4/conf/*/rp_filter; do printf 0 > "$key"; done
for family in 4 6; do ip -"$family" rule add pref 2062 fwmark 0x3e00/0x3f00 unreachable; done
policy() {
	for tool in iptables ip6tables; do
		"$tool" -t mangle -F OUTPUT
		"$tool" -t mangle -A OUTPUT -m mark --mark 0/0x3f00 -j MARK --set-xmark "$1/0x3f00"
	done
}
count() { ip netns exec "mega-health$1" "$2" -nvxL INPUT | awk '$3 == "ACCEPT" {print $1}'; }
policy 0x400
for family in 4 6; do
	target=198.18.0.1; [ "$family" = 4 ] || target=2001:db8:ffff::1
	if ping -"$family" -I wwan1 -c 1 -W 1 "$target" >/dev/null 2>&1; then
		echo "OBSERVED: unmarked primary IPv$family probe succeeds under backup policy" >&2
	else
		echo "REPRODUCED: unmarked primary IPv$family probe fails under backup policy" >&2
	fi
	ping -"$family" -I wwan2 -c 1 -W 2 "$target" >/dev/null
done
policy 0x3e00
for family in 4 6; do
	target=198.18.0.1; [ "$family" = 4 ] || target=2001:db8:ffff::1
	if ping -"$family" -I wwan1 -c 1 -W 1 "$target" >/dev/null 2>&1; then
		echo "OBSERVED: unmarked primary IPv$family probe succeeds under unreachable policy" >&2
	else
		echo "REPRODUCED: unmarked primary IPv$family probe fails under unreachable policy" >&2
	fi
done
for mark in 0x400 0x300 0x3e00; do
	policy "$mark"
	for family in 4 6; do
		target=198.18.0.1; tool=iptables
		[ "$family" = 4 ] || { target=2001:db8:ffff::1; tool=ip6tables; }
		for n in 1 2; do
			peer=$((3-n)); own_before=$(count "$n" "$tool"); peer_before=$(count "$peer" "$tool")
			source=192.0.0.2; [ "$family" = 4 ] || source="2001:db8:$n::2"
			zbt_health_exec "$family" "wwan$n" "$source" ping -"$family" -I "wwan$n" -c 1 -W 2 "$target" >/dev/null
			[ "$(count "$n" "$tool")" = "$((own_before + 1))" ]
			[ "$(count "$peer" "$tool")" = "$peer_before" ]
		done
	done
	echo "PASS: production health socket binding probes each physical modem over IPv4/IPv6 with OUTPUT mark=$mark; peer receives no probe"
done
for tool in iptables ip6tables; do
	ip netns exec mega-health1 "$tool" -F INPUT
	ip netns exec mega-health1 "$tool" -A INPUT -j DROP
done
policy 0x400
for family in 4 6; do
	target=198.18.0.1; source=192.0.0.2
	[ "$family" = 4 ] || { target=2001:db8:ffff::1; source=2001:db8:1::2; }
	if zbt_health_exec "$family" wwan1 "$source" ping -"$family" -I wwan1 -c 1 -W 1 "$target" >/dev/null 2>&1; then
		echo "FAIL: unavailable primary IPv$family passed through its healthy backup" >&2; exit 1
	fi
	[ "$family" = 4 ] || source=2001:db8:2::2
	zbt_health_exec "$family" wwan2 "$source" ping -"$family" -I wwan2 -c 1 -W 2 "$target" >/dev/null
done
echo 'PASS: genuine primary data failure stays failed while backup remains reachable; peer cannot satisfy either family probe'
