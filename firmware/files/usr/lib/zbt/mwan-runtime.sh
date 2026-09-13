#!/bin/sh
# Runtime health belongs to mwan3, not QModem or a speed ranking.
zbt_mwan_now() { cut -d. -f1 /proc/uptime; }
zbt_mwan_online() {
	local path="${ZBT_MWAN_TRACK:-/var/run/mwan3track}/$1" stamp pid now
	[ "$(uci -q get "mwan3.$1.enabled")" = 1 ] || return 1
	[ "$(cat "$path/STATUS" 2>/dev/null)" = online ] || return 1
	[ "$(cat "$path/STARTED" 2>/dev/null)" = 1 ] || return 1
	stamp=$(cat "$path/TIME" 2>/dev/null); pid=$(cat "$path/PID" 2>/dev/null)
	case "$stamp:$pid" in *[!0-9:]*|:*|*:|*:0|*:1) return 1 ;; esac
	now=$(zbt_mwan_now)
	[ "$stamp" -le "$now" ] && [ $((now - stamp)) -le 60 ] && kill -0 "$pid" 2>/dev/null
}
zbt_mwan_winner() {
	local interface
	for interface in wan_sfp wan usb_tether 4_1 2_1; do
		if zbt_mwan_online "$interface"; then echo "$interface"; return 0; fi
	done
	return 1
}
zbt_mwan_refresh() {
	local section="$1" device="$2" address="$3" generation="${4:-}" path state now last=0 previous=''
	case "$section" in 4_1|2_1) ;; *) return 1 ;; esac
	[ -n "$address" ] || return 0
	[ "$(uci -q get "mwan3.$section.enabled")" = 1 ] || return 0
	[ "$(uci -q get "network.$section.modem_config")" = "$section" ] || return 1
	[ "$(zbt_netdev "$section")" = "$device" ] || return 1
	# The adaptive worker owns the temporary pause and explicitly resumes it.
	[ ! -f "/tmp/zbt-5g/$section/maintenance" ] || return 0
	path="${ZBT_MWAN_REFRESH:-/tmp/zbt-mwan-refresh}"
	mkdir -p "$path"
	read -r last previous 2>/dev/null < "$path/$section" || true
	case "$last" in ''|*[!0-9]*) last=0 ;; esac
	now=$(zbt_mwan_now)
	state=$(cat "${ZBT_MWAN_TRACK:-/var/run/mwan3track}/$section/STATUS" 2>/dev/null)
	if [ "$previous" != "$device:$address:$generation" ] || {
		case "$state" in paused|disabled|'') [ $((now - last)) -ge 60 ] ;; *) false ;; esac
		}; then
		# QMI can receive its IP after netifd's original proto-none ifup. Rebuild
		# only this tracker/routing table with the now-valid device and source IP.
		printf '%s %s\n' "$now" "$device:$address:$generation" > "$path/$section"
		/usr/sbin/mwan3 ifup "$section" >/dev/null 2>&1
	fi
}
