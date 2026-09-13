#!/bin/sh
# Wait for one enabled physical modem to finish USB enumeration, then replace
# this process with its QModem dialer. procd supervises one copy per slot.
# Never fall back to the peer modem and never rewrite modem/network settings.

. /usr/lib/zbt/dual-modem.sh

zbt_qmodem_armed() {
	case "$1" in 4_1|2_1) ;; *) return 1 ;; esac
	[ "$(uci -q get qmodem.main.enable_dial 2>/dev/null)" = 1 ] || return 1
	[ "$(uci -q get "qmodem.$1.enable_dial" 2>/dev/null)" = 1 ] || return 1
	[ "$(uci -q get "qmodem.$1.state" 2>/dev/null)" = enabled ]
}

zbt_qmodem_recovery_busy() {
	local owner recovery="/tmp/modem-watchdog/$1.recovering"
	[ -f "$recovery" ] || return 1
	read -r owner < "$recovery"
	case "$owner" in ''|*[!0-9]*|0|1) return 1 ;; esac
	kill -0 "$owner" 2>/dev/null
}

zbt_qmodem_port_present() {
	[ -c "$1" ]
}

zbt_qmodem_ready() {
	local section="$1" path expected port device
	zbt_slot "$section" || return 1
	path=$(uci -q get "qmodem.$section.path" 2>/dev/null) || return 1
	[ -n "$path" ] || return 1
	expected=$(readlink -f "${ZBT_SYSFS:-/sys}/bus/usb/devices/$ZBT_USB" 2>/dev/null) || return 1
	[ -n "$expected" ] || return 1
	[ "$(readlink -f "$path" 2>/dev/null)" = "$expected" ] || return 1
	device=$(zbt_netdev "$section") || return 1
	[ -n "$device" ] || return 1
	port=$(uci -q get "qmodem.$section.at_port" 2>/dev/null) || return 1
	[ -n "$port" ] && zbt_qmodem_port_present "$port" || return 1
	zbt_port_matches "$section" "$port"
}

zbt_qmodem_launch() {
	exec /usr/share/qmodem/modem_dial.sh "$1" dial
}

zbt_qmodem_start() {
	local section="$1" attempts=0 delay=2 reason last_reason=''
	case "$section" in 4_1|2_1) ;; *) return 2 ;; esac
	while zbt_qmodem_armed "$section"; do
		if zbt_qmodem_recovery_busy "$section"; then
			reason=recovery-in-progress
		elif zbt_qmodem_ready "$section"; then
			logger -t qmodem_network "slot=$section action=auto-dial readiness=ready attempts=$attempts"
			zbt_qmodem_launch "$section"
			return $?
		else
			reason=waiting-for-own-usb-netdev-and-at-port
		fi
		if [ "$reason" != "$last_reason" ] || [ $((attempts % 30)) -eq 0 ]; then
			logger -t qmodem_network "slot=$section action=auto-dial readiness=$reason attempts=$attempts"
			last_reason=$reason
		fi
		sleep "$delay"
		attempts=$((attempts + 1))
		[ "$attempts" -lt 30 ] || delay=5
	done
	logger -t qmodem_network "slot=$section action=auto-dial readiness=disarmed attempts=$attempts"
	return 0
}

zbt_qmodem_start "$@"
