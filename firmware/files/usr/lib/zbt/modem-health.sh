#!/bin/sh
# Direct end-to-end evidence, independent of signal, IP assignment and mwan3.
. /usr/lib/zbt/dual-modem.sh
ZBT_HEALTH_DIR=${ZBT_HEALTH_DIR:-/tmp/zbt-modem-health}
zbt_health_now() { cut -d. -f1 /proc/uptime; }
zbt_modem_enabled() {
	case "$1" in 4_1|2_1) ;; *) return 1 ;; esac
	zbt_slot "$1" || return 1
	[ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" 2>/dev/null)" != 0 ] || return 1
	[ "$(uci -q get qmodem.main.enable_dial)" = 1 ] &&
	[ "$(uci -q get "qmodem.$1.enable_dial")" = 1 ] &&
	[ "$(uci -q get "qmodem.$1.en_bridge")" != 1 ]
}
zbt_health_probe() {
	local section="$1" device index family target targets before after
	ZBT_HEALTH4=absent; ZBT_HEALTH6=absent; ZBT_HEALTH=offline
	ZBT_HEALTH_DEVICE=absent; ZBT_HEALTH_INDEX=0
	zbt_modem_enabled "$section" || { ZBT_HEALTH=disabled; return 1; }
	device=$(zbt_netdev "$section") || return 1
	[ ! -e "${ZBT_SYSFS:-/sys}/class/net/$device/master" ] || return 1
	index=$(cat "${ZBT_SYSFS:-/sys}/class/net/$device/ifindex") || return 1
	ZBT_HEALTH_DEVICE=$device; ZBT_HEALTH_INDEX=$index
	for family in 4 6; do
		before=$(ip -o -"$family" addr show dev "$device" scope global 2>/dev/null | awk '/ inet/ && !/ tentative| dadfailed/ {print $4}')
		[ -n "$before" ] || continue
		eval "ZBT_HEALTH$family=offline"
		if [ "$family" = 4 ]; then
			targets="$(uci -q get modem_watchdog.global.ping_target) 8.8.8.8"
			[ "$targets" != ' 8.8.8.8' ] || targets='1.1.1.1 8.8.8.8'
		else
			targets="$(uci -q get modem_watchdog.global.ping6_target) 2001:4860:4860::8888"
			[ "$targets" != ' 2001:4860:4860::8888' ] || targets='2606:4700:4700::1111 2001:4860:4860::8888'
		fi
		for target in $targets; do
			# Numeric destinations only: DNS and the peer WAN cannot satisfy this probe.
			case "$target" in ''|*[!0-9a-fA-F:.]*) continue ;; esac
			if ping -"$family" -I "$device" -c 1 -W 2 "$target" >/dev/null 2>&1; then
				eval "ZBT_HEALTH$family=online"; break
			fi
		done
		after=$(ip -o -"$family" addr show dev "$device" scope global 2>/dev/null | awk '/ inet/ && !/ tentative| dadfailed/ {print $4}')
		[ "$before" = "$after" ] || eval "ZBT_HEALTH$family=offline"
	done
	[ "$(zbt_netdev "$section")" = "$device" ] &&
	[ "$(cat "${ZBT_SYSFS:-/sys}/class/net/$device/ifindex" 2>/dev/null)" = "$index" ] || {
		ZBT_HEALTH4=offline; ZBT_HEALTH6=offline; return 1;
	}
	if [ "$ZBT_HEALTH4" = online ] || [ "$ZBT_HEALTH6" = online ]; then ZBT_HEALTH=online; return 0; fi
	return 1
}
zbt_health_save() {
	umask 077
	mkdir -p "$ZBT_HEALTH_DIR"
	printf '%s %s %s %s %s %s\n' "$(zbt_health_now)" "$ZBT_HEALTH_DEVICE" "$ZBT_HEALTH_INDEX" "$ZBT_HEALTH" "$ZBT_HEALTH4" "$ZBT_HEALTH6" > "$ZBT_HEALTH_DIR/$1.new"
	mv "$ZBT_HEALTH_DIR/$1.new" "$ZBT_HEALTH_DIR/$1"
}
zbt_health_online() {
	local stamp device index state v4 v6 now
	zbt_modem_enabled "$1" || return 1
	local owner
	if read -r owner 2>/dev/null < "${ZBT_RECOVERY_DIR:-/tmp/modem-watchdog}/$1.recovering"; then
		case "$owner" in ''|*[!0-9]*|0|1) ;; *) kill -0 "$owner" 2>/dev/null && return 1 ;; esac
	fi
	read -r stamp device index state v4 v6 2>/dev/null < "$ZBT_HEALTH_DIR/$1" || return 1
	case "$stamp:$index" in *[!0-9:]*|:*|*:) return 1 ;; esac
	now=$(zbt_health_now)
	[ "$state" = online ] && [ "$stamp" -le "$now" ] && [ $((now - stamp)) -le 75 ] &&
	[ "$(zbt_netdev "$1")" = "$device" ] &&
	[ "$(cat "${ZBT_SYSFS:-/sys}/class/net/$device/ifindex" 2>/dev/null)" = "$index" ]
}
