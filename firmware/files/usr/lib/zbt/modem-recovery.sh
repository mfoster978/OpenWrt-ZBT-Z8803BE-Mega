#!/bin/sh
# One recovery owner. No route rankings, band masks, SIM pins or peer resets.
. /usr/lib/zbt/modem-health.sh
. /usr/lib/zbt/5g-state.sh
ZBT_RECOVERY_DIR=${ZBT_RECOVERY_DIR:-/tmp/modem-watchdog}
zbt_recovery_get() { uci -q get "modem_watchdog.$1" 2>/dev/null; }
zbt_recovery_uint() {
	case "$1" in ''|*[!0-9]*) echo "$2" ;; *)
		[ "$1" -ge "$3" ] && [ "$1" -le "$4" ] && echo "$1" || echo "$2" ;; esac
}
zbt_recovery_allowed() {
	local key=modem1
	[ "$1" != 2_1 ] || key=modem2
	zbt_modem_enabled "$1" &&
	[ "$(zbt_recovery_get global.enabled)" = 1 ] &&
	[ "$(zbt_recovery_get global.actions_enabled)" = 1 ] &&
	[ "$(zbt_recovery_get "$key.enabled")" = 1 ]
}
zbt_recovery_action() (
	local section="$1" action="$2" config_section="$1" path pid tries=0 powered_off=0 oldindex='' device newindex owner rest
	zbt_recovery_allowed "$section" || exit 1
	exec 6>"$ZBT_RECOVERY_DIR/action.lock"
	flock -n 6 || exit 75
	zbt_5g_lock || exit 75
	# The connection may have recovered since the parent collected its sample.
	zbt_health_probe "$section" && exit 0
	# Active adaptive trials hold this same flock. A crashed trial may leave
	# its journal; preserve it so the next dial restores the previous mode.
	mkdir -p "$ZBT_RECOVERY_DIR"
	path="$ZBT_RECOVERY_DIR/$section.recovering"
	# $$ is inherited by ash subshells. Read this process's actual PID so a
	# killed recovery cannot leave a marker pointing at the healthy daemon.
	read -r owner rest < /proc/self/stat
	printf '%s\n' "$owner" > "$path"
	finish() {
		# A stop during the three-second pulse must never leave power off.
		[ "$powered_off" != 1 ] || printf '1\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value"
		[ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" 2>/dev/null)" != 1 ] || rm -f "$ZBT_RECOVERY_DIR/$section.power-off"
		rm -f "$path"
		zbt_5g_unlock
	}
	trap 'finish' EXIT
	trap 'exit 1' INT TERM
	zbt_slot "$section" || exit 1
	if [ "$action" = power_cycle ]; then
		[ -w "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" ] || exit 1
		device=$(zbt_netdev "$section")
		oldindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$device/ifindex" 2>/dev/null)
	fi
	# Block new starts before stopping the old instance, including USB hotplug.
	pid=$(ubus -t 5 call service list '{"name":"qmodem_network"}' | jq -r --arg n "modem_$section" '.qmodem_network.instances[$n].pid // empty')
	case "$pid" in ''|*[!0-9]*|0|1) pid='' ;; esac
	/etc/init.d/qmodem_network hang "$section" >/dev/null 2>&1 || true
	while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do
		[ "$tries" -lt 20 ] || exit 1
		sleep 1; tries=$((tries + 1))
	done
	zbt_recovery_allowed "$section" || exit 1
	if [ "$action" = power_cycle ]; then
		powered_off=1
		printf '%s\n' "$owner" > "$ZBT_RECOVERY_DIR/$section.power-off"
		printf '0\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" || exit 1
		[ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value")" = 0 ] || exit 1
		sleep 3
		printf '1\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" || exit 1
		[ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value")" = 1 ] || exit 1
		powered_off=0
		rm -f "$ZBT_RECOVERY_DIR/$section.power-off"
	fi
	[ "$action" != disconnect ] || exit 0
	tries=0
	while [ "$tries" -lt 60 ]; do
		zbt_recovery_allowed "$section" || exit 1
		device=$(zbt_netdev "$section")
		newindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$device/ifindex" 2>/dev/null)
		if [ -n "$device" ] && { [ "$action" != power_cycle ] || [ "$newindex" != "$oldindex" ]; } &&
			[ "$(uci -q get "qmodem.$section.state")" = enabled ]; then
			# Release exclusion before explicit targeted start; ready() also
			# verifies the newly enumerated USB path and AT port ownership.
			rm -f "$path"
			if /etc/init.d/qmodem_network dial "$section" >/dev/null 2>&1; then exit 0; fi
			printf '%s\n' "$owner" > "$path"
		fi
		sleep 1; tries=$((tries + 1))
	done
	exit 1
)
zbt_recovery_resume() (
	# Finish only our interrupted pulse, never an unmarked manual power-off.
	local config_section="$1" owner rest
	read -r owner 2>/dev/null < "$ZBT_RECOVERY_DIR/$1.power-off" || exit 0
	case "$owner" in ''|*[!0-9]*|0|1) exit 0 ;; esac
	kill -0 "$owner" 2>/dev/null && exit 0
	zbt_5g_lock || exit 0
	zbt_slot "$1" || exit 1
	[ -w "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" ] || exit 1
	if printf '1\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" &&
		[ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value")" = 1 ]; then
		rm -f "$ZBT_RECOVERY_DIR/$1.power-off" "$ZBT_RECOVERY_DIR/$1.recovering"
		logger -t modem-watchdog "$1: restored power after interrupted owned GPIO pulse"
	fi
	zbt_5g_unlock
)
zbt_recovery_check() {
	local previous_last previous_fails result
	local section="$1" key="$2" now fails=0 good=0 last=0 attempts=0 window=0 cycles=0 rx=0 oldrx=0 oldindex=0 index delta=0 reason=unreachable threshold cooldown limit action grace
	now=$(zbt_health_now)
	mkdir -p "$ZBT_RECOVERY_DIR"
	if ! zbt_recovery_allowed "$section"; then
		rm -f "$ZBT_RECOVERY_DIR/$section.state"
		return 0
	fi
	if [ -f "$ZBT_RECOVERY_DIR/$section.state" ]; then
		read -r fails good last attempts window cycles oldrx oldindex < "$ZBT_RECOVERY_DIR/$section.state"
	fi
	# State is private RAM, but reject truncated/interrupted records safely.
	for item in "$fails" "$good" "$last" "$attempts" "$window" "$cycles" "$oldrx" "$oldindex"; do
		case "$item" in ''|*[!0-9]*) fails=0; good=0; last=$now; attempts=0; window=$now; cycles=0; oldrx=0; oldindex=0 ;; esac
	done
	index=$ZBT_HEALTH_INDEX
	rx=$(cat "${ZBT_SYSFS:-/sys}/class/net/$ZBT_HEALTH_DEVICE/statistics/rx_errors" 2>/dev/null)
	case "$rx" in ''|*[!0-9]*) rx=0 ;; esac
	[ "$index" != "$oldindex" ] || [ "$rx" -lt "$oldrx" ] || delta=$((rx - oldrx))
	[ "$delta" -lt 100 ] || reason=rx_errors_growing
	[ -f "$ZBT_RECOVERY_DIR/$section.qmi-lost" ] && reason=qmi_session_lost
	threshold=$(zbt_recovery_uint "$(zbt_recovery_get global.ping_fail_threshold)" 4 2 20)
	cooldown=$(zbt_recovery_uint "$(zbt_recovery_get global.cooldown_seconds)" 180 180 3600)
	grace=$(zbt_recovery_uint "$(zbt_recovery_get global.boot_grace_seconds)" 120 60 600)
	if [ "$ZBT_HEALTH" = online ]; then
		good=$((good + 1))
		if [ "$good" -ge 3 ]; then fails=0; attempts=0; rm -f "$ZBT_RECOVERY_DIR/$section.qmi-lost"; fi
	else
		good=0; fails=$((fails + 1))
	fi
	[ $((now - window)) -lt 3600 ] || { window=$now; cycles=0; }
	# Every destructive request is bounded, serialized with radio changes,
	# and gated on current direct failures, never on an old mwan3 status.
	if [ "$ZBT_HEALTH" != online ] && [ "$fails" -ge "$threshold" ] &&
		[ "$now" -ge "$grace" ] && [ $((now - last)) -ge "$cooldown" ] && [ "$cycles" -lt 3 ]; then
		action=$(zbt_recovery_get "$key.action")
		limit=$(zbt_recovery_uint "$(zbt_recovery_get "$key.redial_attempts")" 0 0 2)
		if [ "$action" = power_cycle ] && [ "$attempts" -lt "$limit" ] && [ "$reason" = unreachable ]; then action=redial; fi
		case "$action" in
			power_cycle|redial|disconnect)
				# A busy adaptive worker is not an attempt and consumes no budget.
				if (config_section="$section"; zbt_5g_lock && zbt_5g_unlock); then
					previous_last=$last; previous_fails=$fails
					last=$now; attempts=$((attempts + 1)); cycles=$((cycles + 1)); fails=0
					printf '%s %s %s %s %s %s %s %s\n' "$fails" "$good" "$last" "$attempts" "$window" "$cycles" "$rx" "$index" > "$ZBT_RECOVERY_DIR/$section.state"
					logger -t modem-watchdog "$section: $reason; requesting $action (attempt $cycles/3 this hour)"
					result=0
					zbt_recovery_action "$section" "$action" || result=$?
					if [ "$result" = 75 ]; then
						last=$previous_last; fails=$previous_fails
						attempts=$((attempts - 1)); cycles=$((cycles - 1))
					else
						[ "$result" = 0 ] || logger -t modem-watchdog "$section: recovery incomplete; retaining cooldown"
						last=$(zbt_health_now)
					fi
				fi ;;
		esac
	fi
	printf '%s %s %s %s %s %s %s %s\n' "$fails" "$good" "$last" "$attempts" "$window" "$cycles" "$rx" "$index" > "$ZBT_RECOVERY_DIR/$section.state"
}
