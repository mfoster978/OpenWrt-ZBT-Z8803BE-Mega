#!/bin/sh
# Reconcile MWAN3 runtime state only. Never change UCI policies, priorities,
# radio settings, modem sessions or firewall-zone membership.

zbt_mwan_reconcile_iface() {
	local interface="$1" section family device address id current tracker started
	case "$interface" in
		4_1|2_1) section=$interface; family=4 ;;
		4_1v6|2_1v6) section=${interface%v6}; family=6 ;;
		*) return 0 ;;
	esac
	[ ! -f "/tmp/zbt-5g/$section/maintenance" ] || return 0
	# Never override an intentionally disabled interface. A paused or absent
	# runtime tracker may still need a targeted ifup after QMI has published a
	# valid address and a direct, device-bound probe has proven Internet access.
	[ "$(uci -q get "mwan3.$interface.enabled")" = 1 ] || return 0
	zbt_health_online "$section" || return 0
	local stamp health_device index health v4 v6
	read -r stamp health_device index health v4 v6 < "$ZBT_HEALTH_DIR/$section" || return 0
	case "$family:$v4:$v6" in 4:online:*|6:*:online) ;; *) return 0 ;; esac
	local configured_family
	configured_family=$(uci -q get "mwan3.$interface.family")
	[ "${configured_family:-ipv4}" = "ipv$family" ] || return 0
	[ "$(uci -q get "network.$interface.modem_config")" = "$section" ] || return 0
	network_is_up "$interface" || {
		logger -t zbt-mwan-reconcile "iface=$interface direct_health=online result=netifd_not_up tracker_not_promoted"
		return 0
	}
	network_get_device device "$interface" || return 0
	[ "$device" = "$health_device" ] && [ "$device" = "$(zbt_netdev "$section")" ] || return 0
	if [ "$family" = 4 ]; then network_get_ipaddr address "$interface";
	else network_get_ipaddr6 address "$interface"; fi
	[ -n "$address" ] || return 0
	# Do not fabricate reachability from a modem address or a default route.
	# Confirm the published address is still on the verified physical device.
	ip -o -"$family" addr show dev "$device" scope global | awk -v ip="$address" '
		/ inet/ && !/ tentative| dadfailed/ { split($4,a,"/"); if(a[1]==ip) found=1 }
		END { exit !found }' || return 0
	if ! zbt_mwan_online "$interface"; then
		tracker=$(cat "${ZBT_MWAN_TRACK:-/var/run/mwan3track}/$interface/STATUS" 2>/dev/null)
		started=$(cat "${ZBT_MWAN_TRACK:-/var/run/mwan3track}/$interface/STARTED" 2>/dev/null)
		case "$tracker:$started" in
			paused:*|disabled:*|:0|:|online:0|offline:0)
				zbt_mwan_refresh "$section" "$device" "$address" '' "$family"
				[ "$ZBT_MWAN_REFRESHED" = 1 ] &&
					logger -t zbt-mwan-reconcile "iface=$interface family=$family direct_health=online tracker=${tracker:-missing} started=${started:-missing} action=tracker_ifup"
				;;
		esac
		# Promotion remains fail-closed. The next watchdog cycle must observe a
		# fresh online tracker before routes or policy state can be rebuilt.
		return 0
	fi
	mwan3_get_iface_id id "$interface"
	case "$id" in ''|*[!0-9]*|0) return 0 ;; esac
	# A tracker uses its own bound socket. It can pass even if the forwarding
	# table was lost. Rebuild only this interface's table/rules when necessary.
	if [ -z "$(ip -"$family" route show table "$id" default dev "$device" 2>/dev/null)" ]; then
		[ -n "$(ip -"$family" route show table main default dev "$device" 2>/dev/null)" ] || return 0
		mwan3_create_iface_route "$interface" "$device"
		mwan3_create_iface_rules "$interface" "$device"
		[ -n "$(ip -"$family" route show table "$id" default dev "$device" 2>/dev/null)" ] || {
			logger -t zbt-mwan-reconcile "iface=$interface family=$family result=route_repair_failed"
			return 0
		}
		zbt_mwan_rebuild=1
	fi
	# Recheck after route operations, before changing the runtime policy state.
	zbt_mwan_online "$interface" && zbt_health_online "$section" || return 0
	current=$(mwan3_get_iface_hotplug_state "$interface")
	if [ "$current" != online ]; then
		mwan3_set_iface_hotplug_state "$interface" online
		zbt_mwan_rebuild=1
		logger -t zbt-mwan-reconcile "iface=$interface family=$family tracker=online policy_state=$current action=resynchronize"
	fi
	zbt_mwan_verified="$zbt_mwan_verified $interface "
}

zbt_mwan_reconcile_member() {
	local interface metric weight family chain
	config_get interface "$1" interface
	[ -n "$interface" ] || return 0
	case "$zbt_mwan_verified" in *" $interface "*) ;; *) return 0 ;; esac
	config_get metric "$1" metric 1
	config_get weight "$1" weight 1
	case "$metric:$weight" in *[!0-9:]*|:*|*:) return 0 ;; esac
	[ "$metric" -le "$DEFAULT_LOWEST_METRIC" ] && [ "$weight" -gt 0 ] || return 0
	config_get family "$interface" family ipv4
	if [ "$family" = ipv4 ]; then chain=$IPT4; else chain=$IPT6; fi
	# The normal builder removes the last-resort rule when a member is usable.
	# Keeping it despite a verified member reproduces the reported black hole.
	if $chain -S "mwan3_policy_$zbt_mwan_policy" 2>/dev/null |
		grep -q -- "--set-xmark $MMX_UNREACHABLE/$MMX_MASK"; then
		zbt_mwan_rebuild=1
		logger -t zbt-mwan-reconcile "iface=$interface family=$family policy=$zbt_mwan_policy action=repair_unreachable"
	fi
}

zbt_mwan_reconcile_policy() {
	local zbt_mwan_policy="$1"
	config_list_foreach "$1" use_member zbt_mwan_reconcile_member
}

zbt_mwan_reconcile() {
	local zbt_mwan_rebuild=0 zbt_mwan_verified=' '
	# Caller holds the SAME lock as mwan3's hotplug and init scripts.
	[ -z "$(uci -q changes mwan3)$(uci -q changes network)" ] || return 0
	$IPT4 -S mwan3_hook >/dev/null 2>&1 || return 0
	[ -d "$MWAN3_STATUS_DIR/iface_state" ] || return 0
	network_flush_cache
	config_foreach zbt_mwan_reconcile_iface interface
	config_foreach zbt_mwan_reconcile_policy policy
	[ "$zbt_mwan_rebuild" = 1 ] || return 0
	# Reuse MWAN3's builder, including user-defined weights and policies.
	# No hand-written default route or alternate priority authority is added.
	mwan3_set_policies_iptables
	logger -t zbt-mwan-reconcile 'action=rebuild_configured_policies result=dispatched'
}
