#!/bin/sh
# Runtime only: no learned IP, gateway, device or DNS is written into UCI.
zbt_qmi_publish() {
	local family="$1" interface="$2" addresses routes payload snapshot current
	case "$interface:$family" in "$modem_config:4"|"${modem_config}v6:6") ;; *) return 1 ;; esac
	[ "$(uci -q get "network.$interface.modem_config")" = "$modem_config" ] || return 1
	[ "$(uci -q get "network.$interface.proto")" = zbtqmi ] || return 1
	zbt_qmi_owned || return 1
	addresses=$(ip -j -"$family" addr show dev "$modem_netcard" scope global 2>/dev/null | jq -ce '[.[].addr_info[] | select(.scope == "global" and (.tentative // false | not) and (.dadfailed // false | not)) | {ipaddr:.local, mask:(.prefixlen|tostring)}]') || return 1
	[ "$addresses" != '[]' ] || return 1
	routes=$(ip -j -"$family" route show dev "$modem_netcard" table main 2>/dev/null | jq -ce --arg f "$family" '[.[] | select(.dst == "default") | {target:(if $f == "4" then "0.0.0.0" else "::" end), netmask:"0", metric:(.metric // 0)} + (if .gateway then {gateway:.gateway} else {} end)]') || return 1
	[ "$routes" != '[]' ] || return 1
	payload=$(jq -cn --arg d "$modem_netcard" --arg f "$family" --argjson a "$addresses" --argjson r "$routes" '{action:0,ifname:$d,"link-up":true,"address-external":true} + (if $f=="4" then {"ipaddr":$a,routes:$r} else {"ip6addr":$a,routes6:$r} end)') || return 1
	snapshot=$(printf '%s' "$payload" | sha256sum | cut -d' ' -f1)
	eval "current=\${qmi_published$family:-}"
	# A netifd reload needs a new update even if the modem retained its IP.
	if [ "$snapshot" != "$current" ] || ! ubus -t 3 call "network.interface.$interface" status 2>/dev/null | jq -e '.up == true' >/dev/null; then
		ubus -t 5 call "network.interface.$interface" notify_proto "$payload" >/dev/null 2>&1 || return 1
		eval "qmi_published$family=\$snapshot"
	fi
	return 0
}
