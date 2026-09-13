#!/bin/sh
# Samples have at most two 30-second curl requests. A bounded lease also
# recovers a worker killed before its EXIT trap, without waiting for reboot.
zbt_speed_lock() {
	local expiry owner stamp
	ZBT_SPEED_STATE=${ZBT_SPEED_STATE:-/tmp/zbt-speedtest}
	umask 077
	mkdir -p "$ZBT_SPEED_STATE"
	stamp=$(cut -d. -f1 /proc/uptime)
	if ! mkdir "$ZBT_SPEED_STATE/lock" 2>/dev/null; then
		read -r expiry owner < "$ZBT_SPEED_STATE/lock/lease" 2>/dev/null || return 1
		case "$expiry" in ''|*[!0-9]*) return 1 ;; esac
		[ "$stamp" -gt "$expiry" ] || return 1
		rm -f "$ZBT_SPEED_STATE/lock/lease"
		rmdir "$ZBT_SPEED_STATE/lock" 2>/dev/null || return 1
		mkdir "$ZBT_SPEED_STATE/lock" 2>/dev/null || return 1
	fi
	ZBT_SPEED_TOKEN="$$-$stamp"
	printf '%s %s\n' "$((stamp + 120))" "$ZBT_SPEED_TOKEN" > "$ZBT_SPEED_STATE/lock/lease"
}
zbt_speed_unlock() {
	local expiry owner
	[ -n "${ZBT_SPEED_TOKEN:-}" ] || return 0
	read -r expiry owner < "$ZBT_SPEED_STATE/lock/lease" 2>/dev/null || return 0
	[ "$owner" = "$ZBT_SPEED_TOKEN" ] || return 0
	rm -f "$ZBT_SPEED_STATE/lock/lease"
	rmdir "$ZBT_SPEED_STATE/lock" 2>/dev/null || true
	ZBT_SPEED_TOKEN=''
}
zbt_speed_renew() {
	local expiry owner stamp
	read -r expiry owner < "$ZBT_SPEED_STATE/lock/lease" 2>/dev/null || return 1
	[ -n "$ZBT_SPEED_TOKEN" ] && [ "$owner" = "$ZBT_SPEED_TOKEN" ] || return 1
	stamp=$(cut -d. -f1 /proc/uptime)
	[ "$stamp" -le "$expiry" ] || return 1
	printf '%s %s\n' "$((stamp + 120))" "$owner" > "$ZBT_SPEED_STATE/lock/lease"
}
