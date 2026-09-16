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
# Stable administrative authorization. This deliberately ignores transient
# GPIO, USB and netdev state so a recovery that has already torn a modem down
# cannot cancel its own power pulse or restart halfway through.
zbt_recovery_authorized() {
	local section="$1" key=modem1
	case "$section" in 4_1) ;; 2_1) key=modem2 ;; *) return 1 ;; esac
	[ "$(uci -q get qmodem.main.enable_dial)" = 1 ] &&
	[ "$(uci -q get "qmodem.$section.enable_dial")" = 1 ] &&
	[ "$(uci -q get "qmodem.$section.en_bridge")" != 1 ] &&
	[ "$(zbt_recovery_get global.enabled)" = 1 ] &&
	[ "$(zbt_recovery_get global.actions_enabled)" = 1 ] &&
	[ "$(zbt_recovery_get "$key.enabled")" = 1 ]
}
zbt_recovery_allowed() {
	zbt_recovery_authorized "$1" && zbt_modem_enabled "$1"
}
zbt_recovery_worker_pid() {
	local section="$1" pid
	pid=$(ubus -t 5 call service list '{"name":"qmodem_network"}' 2>/dev/null |
		jq -r --arg n "modem_$section" '.qmodem_network.instances[$n] | select(.running == true) | .pid // empty' 2>/dev/null)
	case "$pid" in ''|*[!0-9]*|0|1) return 1 ;; esac
	printf '%s\n' "$pid"
}
# Keep USB sysfs writes behind a helper so recovery can verify the resulting
# kernel state instead of assuming the write return code tells the whole story.
zbt_recovery_usb_write() {
	printf '%s\n' "$1" > "$2"
}
zbt_recovery_action() (
	local section="$1" action="$2" config_section="$1" path pid tries=0 powered_off=0 usb_disabled=0 usb_auth='' usb_write=0 owner rest registered=''
	zbt_recovery_allowed "$section" || exit 1
	exec 6>"$ZBT_RECOVERY_DIR/action.lock"
	flock -n 6 || exit 75
	zbt_5g_lock || exit 75
	zbt_health_probe "$section" && exit 0
	[ "$ZBT_HEALTH" = offline ] || exit 75
	mkdir -p "$ZBT_RECOVERY_DIR"
	path="$ZBT_RECOVERY_DIR/$section.recovering"
	read -r owner rest < /proc/self/stat
	printf '%s\n' "$owner" > "$path"
	finish() {
		[ "$usb_disabled" != 1 ] || zbt_recovery_usb_write 1 "$usb_auth" >/dev/null 2>&1 || true
		[ "$powered_off" != 1 ] || printf '1\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value"
		[ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" 2>/dev/null)" != 1 ] || rm -f "$ZBT_RECOVERY_DIR/$section.power-off"
		rm -f "$path"
		zbt_5g_unlock
	}
	trap 'finish' EXIT
	trap 'exit 1' INT TERM
	zbt_slot "$section" || exit 1
	usb_auth="${ZBT_SYSFS:-/sys}/bus/usb/devices/$ZBT_USB/authorized"
	if [ "$action" = usb_reset ]; then
		[ -w "$usb_auth" ] || exit 1
	fi
	if [ "$action" = power_cycle ]; then
		[ -w "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" ] || exit 1
	fi
	pid=$(ubus -t 5 call service list '{"name":"qmodem_network"}' | jq -r --arg n "modem_$section" '.qmodem_network.instances[$n].pid // empty')
	case "$pid" in ''|*[!0-9]*|0|1) pid='' ;; esac
	/etc/init.d/qmodem_network hang "$section" >/dev/null 2>&1 || true
	while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do
		[ "$tries" -lt 30 ] || {
			logger -t modem-watchdog "slot=$section action=$action stage=teardown result=timeout seconds=30"
			exit 1
		}
		sleep 1; tries=$((tries + 1))
	done
	logger -t modem-watchdog "slot=$section action=$action stage=teardown result=complete wait_seconds=$tries"
	zbt_recovery_authorized "$section" || {
		logger -t modem-watchdog "slot=$section action=$action stage=post-teardown result=cancelled-admin-disabled"
		exit 1
	}
	if [ "$action" = usb_reset ]; then
		logger -t modem-watchdog "slot=$section action=$action stage=usb-deauthorize result=starting"
		usb_disabled=1
		usb_write=0
		zbt_recovery_usb_write 0 "$usb_auth" 2>/dev/null || usb_write=$?
		tries=0
		while [ "$tries" -lt 5 ]; do
			[ "$(cat "$usb_auth" 2>/dev/null)" = 0 ] && break
			zbt_netdev "$section" >/dev/null 2>&1 || break
			tries=$((tries + 1))
			sleep 1
		done
		if [ "$(cat "$usb_auth" 2>/dev/null)" != 0 ] && zbt_netdev "$section" >/dev/null 2>&1; then
			logger -t modem-watchdog "slot=$section action=$action stage=usb-deauthorize result=verify-failed write_code=$usb_write wait_seconds=$tries"
			exit 1
		fi
		logger -t modem-watchdog "slot=$section action=$action stage=usb-deauthorize result=complete write_code=$usb_write wait_seconds=$tries"
		sleep 5
		usb_write=0
		if [ -w "$usb_auth" ]; then
			zbt_recovery_usb_write 1 "$usb_auth" 2>/dev/null || usb_write=$?
		else
			usb_write=1
		fi
		tries=0
		while [ "$tries" -lt 20 ]; do
			zbt_netdev "$section" >/dev/null 2>&1 && break
			tries=$((tries + 1))
			sleep 1
		done
		if ! zbt_netdev "$section" >/dev/null 2>&1; then
			logger -t modem-watchdog "slot=$section action=$action stage=usb-reauthorize result=netdev-timeout write_code=$usb_write seconds=20"
			exit 1
		fi
		usb_disabled=0
		logger -t modem-watchdog "slot=$section action=$action stage=usb-reauthorize result=complete write_code=$usb_write wait_seconds=$tries"
	fi
	if [ "$action" = power_cycle ]; then
		powered_off=1
		printf '%s\n' "$owner" > "$ZBT_RECOVERY_DIR/$section.power-off"
		logger -t modem-watchdog "slot=$section action=$action stage=gpio-low result=starting seconds=10"
		if ! printf '0\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value"; then
			logger -t modem-watchdog "slot=$section action=$action stage=gpio-low result=write-failed"
			exit 1
		fi
		if [ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" 2>/dev/null)" != 0 ]; then
			logger -t modem-watchdog "slot=$section action=$action stage=gpio-low result=verify-failed"
			exit 1
		fi
		sleep 10
		if ! printf '1\n' > "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value"; then
			logger -t modem-watchdog "slot=$section action=$action stage=gpio-high result=write-failed"
			exit 1
		fi
		if [ "$(cat "${ZBT_SYSFS:-/sys}/class/gpio/$ZBT_POWER/value" 2>/dev/null)" != 1 ]; then
			logger -t modem-watchdog "slot=$section action=$action stage=gpio-high result=verify-failed"
			exit 1
		fi
		logger -t modem-watchdog "slot=$section action=$action stage=gpio-high result=complete"
		powered_off=0
		rm -f "$ZBT_RECOVERY_DIR/$section.power-off"
	fi
	[ "$action" != disconnect ] || exit 0
	zbt_recovery_authorized "$section" || {
		logger -t modem-watchdog "slot=$section action=$action stage=restart result=cancelled-admin-disabled"
		exit 1
	}
	rm -f "$path"
	tries=0
	while [ "$tries" -lt 30 ]; do
		/etc/init.d/qmodem_network dial "$section" >/dev/null 2>&1 || true
		registered=$(zbt_recovery_worker_pid "$section" 2>/dev/null || true)
		if [ -n "$registered" ]; then
			logger -t modem-watchdog "slot=$section action=$action result=worker-registered pid=$registered"
			exit 0
		fi
		tries=$((tries + 1))
		[ "$tries" -ge 30 ] || sleep 1
	done
	logger -t modem-watchdog "slot=$section action=$action result=worker-registration-failed attempts=$tries"
	printf '%s\n' "$owner" > "$path"
	exit 1
)
zbt_recovery_resume() (
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
	local previous_last previous_fails result stage cycle_len
	local section="$1" key="$2" now fails=0 good=0 last=0 attempts=0 window=0 cycles=0 rx=0 rx_valid=0 oldrx=0 oldindex=0 index delta=0 reason=unreachable threshold cooldown verify limit action grace
	now=$(zbt_health_now)
	mkdir -p "$ZBT_RECOVERY_DIR"
	if ! zbt_recovery_allowed "$section"; then
		rm -f "$ZBT_RECOVERY_DIR/$section.state"
		return 0
	fi
	if [ -f "$ZBT_RECOVERY_DIR/$section.state" ]; then
		read -r fails good last attempts window cycles oldrx oldindex < "$ZBT_RECOVERY_DIR/$section.state"
	fi
	for item in "$fails" "$good" "$last" "$attempts" "$window" "$cycles" "$oldrx" "$oldindex"; do
		case "$item" in ''|*[!0-9]*) fails=0; good=0; last=$now; attempts=0; window=$now; cycles=0; oldrx=0; oldindex=0 ;; esac
	done
	index=$ZBT_HEALTH_INDEX
	rx=$(cat "${ZBT_SYSFS:-/sys}/class/net/$ZBT_HEALTH_DEVICE/statistics/rx_errors" 2>/dev/null)
	case "$rx" in
		''|*[!0-9]*) rx=0 ;;
		*) rx_valid=1 ;;
	esac
	if [ "$index" = "$oldindex" ] &&
		[ "$rx_valid" -eq 1 ] &&
		[ "$oldrx" -gt 0 ] &&
		[ "$rx" -gt "$oldrx" ]; then
		delta=$((rx - oldrx))
	fi
	[ "$delta" -lt 100 ] || reason=rx_errors_growing
	[ -f "$ZBT_RECOVERY_DIR/$section.qmi-lost" ] && reason=qmi_session_lost
	threshold=$(zbt_recovery_uint "$(zbt_recovery_get global.ping_fail_threshold)" 3 2 20)
	cooldown=$(zbt_recovery_uint "$(zbt_recovery_get global.cooldown_seconds)" 180 180 3600)
	grace=$(zbt_recovery_uint "$(zbt_recovery_get global.boot_grace_seconds)" 60 60 600)
	limit=$(zbt_recovery_uint "$(zbt_recovery_get "$key.redial_attempts")" 1 0 2)
	verify=$(zbt_recovery_uint "$(zbt_recovery_get global.redial_verify_seconds)" 60 30 180)
	[ "$attempts" -eq 0 ] || cooldown=$verify
	if [ "$ZBT_HEALTH" = online ]; then
		good=$((good + 1))
		if [ "$good" -ge 3 ]; then fails=0; attempts=0; rm -f "$ZBT_RECOVERY_DIR/$section.qmi-lost"; fi
	elif [ "$ZBT_HEALTH" = offline ]; then
		good=0; fails=$((fails + 1))
	else
		good=0
	fi
	[ $((now - window)) -lt 3600 ] || { window=$now; cycles=0; }
	if [ "$ZBT_HEALTH" = offline ] && [ "$fails" -ge "$threshold" ] &&
		[ "$now" -ge "$grace" ] && { [ "$last" = 0 ] || [ $((now - last)) -ge "$cooldown" ]; }; then
		action=$(zbt_recovery_get "$key.action")
		if [ "$action" = power_cycle ]; then
			if [ "$reason" = rx_errors_growing ]; then
				stage=$((attempts % 2))
				if [ "$stage" -eq 0 ]; then action=usb_reset; else action=power_cycle; fi
			elif [ "$limit" -gt 0 ]; then
				cycle_len=$((limit + 2))
				stage=$((attempts % cycle_len))
				if [ "$stage" -lt "$limit" ]; then
					action=redial
				elif [ "$stage" -eq "$limit" ]; then
					action=usb_reset
				else
					action=power_cycle
				fi
			fi
		fi
		case "$action" in
			power_cycle|redial|disconnect|usb_reset)
				if (config_section="$section"; zbt_5g_lock && zbt_5g_unlock); then
					previous_last=$last; previous_fails=$fails
					last=$now; attempts=$((attempts + 1)); cycles=$((cycles + 1)); fails=0
					printf '%s %s %s %s %s %s %s %s\n' "$fails" "$good" "$last" "$attempts" "$window" "$cycles" "$rx" "$index" > "$ZBT_RECOVERY_DIR/$section.state"
					logger -t modem-watchdog "$section: $reason; requesting $action (attempt $cycles this hour)"
					result=0
					zbt_recovery_action "$section" "$action" || result=$?
					if [ "$result" = 75 ]; then
						last=$previous_last; fails=$previous_fails
						attempts=$((attempts - 1)); cycles=$((cycles - 1))
					else
						if [ "$result" = 0 ]; then
							logger -t modem-watchdog "slot=$section action=$action result=dispatched hourly_attempt=$cycles"
						else
							logger -t modem-watchdog "slot=$section action=$action result=incomplete code=$result cooldown=retained"
						fi
						last=$(zbt_health_now)
					fi
				fi ;;
		esac
	fi
	printf '%s %s %s %s %s %s %s %s\n' "$fails" "$good" "$last" "$attempts" "$window" "$cycles" "$rx" "$index" > "$ZBT_RECOVERY_DIR/$section.state"
}
