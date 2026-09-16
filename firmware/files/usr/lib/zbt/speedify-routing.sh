#!/bin/sh
# Mega-only integration around the unmodified, checksum-pinned vendor daemon.
# Never select modem bands, edit mwan3, reset accounts, or restart the network.

sf_log() { logger -t zbt-speedify "$*"; }
sf_get() { uci -q get "$1"; }
sf_set() {
	[ "$(sf_get "$1")" = "$2" ] && return 0
	uci -q set "$1=$2" || return 1
	sf_changed=1
}
sf_remove_member() {
	local value
	for value in $(sf_get "$1"); do
		[ "$value" = "$2" ] || continue
		uci -q del_list "$1=$2" || return 1
		sf_changed=1
		break
	done
}
sf_sections() {
	# Stable IDs avoid shifting anonymous indexes when pruning duplicates.
	uci -q -X show "$1" | sed -n "s/^$1\.\([^.=]*\)=$2$/\1/p"
}
sf_firewall_reload() { /etc/init.d/firewall reload >/dev/null 2>&1; }

sf_repair_firewall() {
	local section name member owner='' forwards='' aliases='speedify' iface
	# Do not commit someone else's pending LuCI edits with our migration.
	[ -z "$(uci -q changes firewall)" ] || return 1
	[ "$(sf_get network.speedify.device)" = connectify0 ] || return 1
	for iface in $(sf_sections network interface); do
		[ "$(sf_get "network.$iface.device")" != connectify0 ] || aliases="$aliases $iface"
	done
	# Refuse an ambiguous custom duplicate before making any edits.
	for section in $(sf_sections firewall zone); do
		[ "$(sf_get "firewall.$section.name")" = speedify ] || continue
		for member in $(sf_get "firewall.$section.device"); do
			[ "$member" = connectify0 ] || return 1
		done
		for member in $(sf_get "firewall.$section.network"); do
			case " $aliases " in *" $member "*) ;; *) return 1 ;; esac
		done
	done
	sf_changed=0
	for section in $(sf_sections firewall zone); do
		name=$(sf_get "firewall.$section.name")
		if [ "$name" = speedify ] && [ -z "$owner" ]; then
			owner=$section
		elif [ "$name" = speedify ]; then
			uci -q delete "firewall.$section" || return 1
			sf_changed=1
			continue
		fi
		sf_remove_member "firewall.$section.device" connectify0 || return 1
		if [ "$section" != "$owner" ]; then
			for member in $aliases; do
				sf_remove_member "firewall.$section.network" "$member" || return 1
			done
		fi
	done
	if [ -z "$owner" ]; then
		owner=$(uci -q add firewall zone) || return 1
		sf_changed=1
	fi
	sf_set "firewall.$owner.name" speedify || return 1
	sf_set "firewall.$owner.input" REJECT || return 1
	sf_set "firewall.$owner.output" ACCEPT || return 1
	sf_set "firewall.$owner.forward" REJECT || return 1
	sf_set "firewall.$owner.masq" 1 || return 1
	sf_set "firewall.$owner.mtu_fix" 1 || return 1
	# Use only the logical interface, never a duplicate device membership.
	if [ "$(sf_get "firewall.$owner.network")" != speedify ]; then
		uci -q delete "firewall.$owner.network" 2>/dev/null || true
		uci -q add_list "firewall.$owner.network=speedify" || return 1
		sf_changed=1
	fi
	for section in $(sf_sections firewall forwarding); do
		name=$(sf_get "firewall.$section.src"):$(sf_get "firewall.$section.dest")
		case "$name" in
			lan:speedify)
				if [ -z "$forwards" ]; then forwards=$section; continue; fi ;;
			speedify:lan) ;; # Remove the vendor's unsolicited reverse forwarding.
			*) continue ;; # Preserve LAN -> WAN fallback and unrelated zones.
		esac
		uci -q delete "firewall.$section" || return 1
		sf_changed=1
	done
	if [ -z "$forwards" ]; then
		forwards=$(uci -q add firewall forwarding) || return 1
		sf_set "firewall.$forwards.src" lan || return 1
		sf_set "firewall.$forwards.dest" speedify || return 1
	fi
	if [ "$sf_changed" = 1 ]; then
		uci -q commit firewall || return 1
		sf_reload_pending=1
	fi
	[ "${sf_reload_pending:-0}" = 1 ] || return 0
	sf_firewall_reload || return 1
	sf_reload_pending=0
	sf_log 'repaired exclusive Speedify egress zone, NAT and LAN forwarding'
}
sf_disable_firewall() {
	local section name member aliases='speedify' iface
	# Never commit someone else's pending LuCI firewall edits.
	[ -z "$(uci -q changes firewall)" ] || return 1
	for iface in $(sf_sections network interface); do
		[ "$(sf_get "network.$iface.device")" != connectify0 ] || aliases="$aliases $iface"
	done
	sf_changed=0
	for section in $(sf_sections firewall zone); do
		name=$(sf_get "firewall.$section.name")
		[ "$name" = speedify ] && continue
		sf_remove_member "firewall.$section.device" connectify0 || return 1
		for member in $aliases; do
			sf_remove_member "firewall.$section.network" "$member" || return 1
		done
	done
	for section in $(sf_sections firewall forwarding); do
		name=$(sf_get "firewall.$section.src"):$(sf_get "firewall.$section.dest")
		case "$name" in
			speedify:*|*:speedify)
				uci -q delete "firewall.$section" || return 1
				sf_changed=1 ;;
		esac
	done
	[ "$sf_changed" = 1 ] || return 0
	uci -q commit firewall || return 1
	sf_firewall_reload || return 1
	sf_log 'removed Speedify forwarding and non-Speedify tunnel memberships'
}

sf_tunnel_routes() {
	# Only disable acceleration for a routed tunnel, not an idle installed UI.
	{ ip -4 route show table all; ip -6 route show table all; } 2>/dev/null | awk '
		$1 == "default" || $1 == "0.0.0.0/1" || $1 == "128.0.0.0/1" || $1 == "::/1" || $1 == "8000::/1" {
			for (i=1; i<NF; i++) if ($i == "dev" && $(i+1) == "connectify0") found=1
		} END { exit !found }'
}
sf_disable_offload() {
	[ -z "$(uci -q changes firewall)" ] || return 1
	sf_changed=0
	sf_set 'firewall.@defaults[0].flow_offloading' 0 || return 1
	sf_set 'firewall.@defaults[0].flow_offloading_hw' 0 || return 1
	if [ "$sf_changed" = 1 ]; then
		uci -q commit firewall || return 1
		sf_reload_pending=1
	fi
	# Repair a stale live flowtable even if UCI already says acceleration is off.
	if [ "${sf_reload_pending:-0}" != 1 ]; then
		nft list flowtable inet fw4 ft >/dev/null 2>&1 || return 0
	fi
	sf_firewall_reload || return 1
	sf_reload_pending=0
	sf_log 'disabled software and hardware flow offloading for Speedify; not automatically re-enabled on disconnect'
}

sf_pep_listener() {
	# 9332 decimal = 2474 hex. Require TCP LISTEN, not an established socket.
	awk '$4 == "0A" && ($2 == "0100007F:2474" || $2 == "00000000:2474") { found=1 }
		END { exit !found }' /proc/net/tcp
}
sf_pep_table() { nft list table ip connectify_pep >/dev/null 2>&1; }
sf_clear_dead_pep() {
	local pref
	# Caller requires repeated absent-listener observations. Recheck immediately
	# before removing only the vendor-owned interception table and exact routes.
	sf_pep_listener && return 0
	sf_pep_table || return 0
	timeout 5 /usr/share/speedify/speedify_cli pep off >/dev/null 2>&1 || true
	sf_pep_listener && return 0
	if sf_pep_table; then nft delete table ip connectify_pep || return 1; fi
	for pref in $(ip -4 rule show | awk '/fwmark 0x9332(\/0xffffffff)? lookup 807( |$)/ { sub(/:$/, "", $1); if ($1 ~ /^[0-9]+$/) print $1 }'); do
		ip -4 rule del pref "$pref" fwmark 0x9332/0xffffffff table 807 || return 1
	done
	# Never flush table 807 or unrelated policy rules.
	ip -4 route del local default dev lo table 807 2>/dev/null || true
	sf_log 'disabled dead Speedify PEP interception; account and modem sessions preserved'
}

sf_migrate_profile() {
	local settings state
	[ "$(sf_get speedify_bootstrap.main.throughput_v1)" != 1 ] || return 0
	[ -z "$(uci -q changes speedify_bootstrap)" ] || return 1
	settings=$(timeout 5 /usr/share/speedify/speedify_cli show settings 2>/dev/null) || return 1
	printf '%s' "$settings" | jq -e '(.bondingMode|type)=="string" and (.fixedDelay|type)=="number" and (.pep|type)=="boolean"' >/dev/null || return 1
	state=$(timeout 5 /usr/share/speedify/speedify_cli state 2>/dev/null | jq -r '.state')
	case "$state" in LOGGED_OUT|LOGGED_IN|CONNECTED) ;; *) return 1 ;; esac
	if [ "$(printf '%s' "$settings" | jq -r '.bondingMode')" != speed ]; then
		timeout 5 /usr/share/speedify/speedify_cli mode speed >/dev/null 2>&1 || return 1
		sf_profile_dirty=1
	fi
	if [ "$(printf '%s' "$settings" | jq -r '.fixedDelay')" != 0 ]; then
		timeout 5 /usr/share/speedify/speedify_cli fixeddelay 0 >/dev/null 2>&1 || return 1
		sf_profile_dirty=1
	fi
	if [ "$(printf '%s' "$settings" | jq -r '.pep')" != false ]; then
		timeout 5 /usr/share/speedify/speedify_cli pep off >/dev/null 2>&1 || return 1
		sf_profile_dirty=1
	fi
	settings=$(timeout 5 /usr/share/speedify/speedify_cli show settings 2>/dev/null) || return 1
	printf '%s' "$settings" | jq -e '.bondingMode=="speed" and .fixedDelay==0 and .pep==false' >/dev/null || return 1
	if [ "${sf_profile_dirty:-0}:$state" = 1:CONNECTED ] && [ "${sf_reconnect_pending:-0}" != 1 ]; then
		timeout 5 /usr/share/speedify/speedify_cli disconnect >/dev/null 2>&1 || return 1
		sf_reconnect_pending=1
	fi
	if [ "${sf_reconnect_pending:-0}" = 1 ]; then
		timeout 10 /usr/share/speedify/speedify_cli connect last >/dev/null 2>&1 || return 1
		sf_reconnect_pending=0
	fi
	uci -q set speedify_bootstrap.main.throughput_v1=1 && uci -q commit speedify_bootstrap || return 1
	sf_profile_dirty=0
	sf_log 'applied one-time speed / zero-delay / PEP-off profile; later user choices are preserved'
}
