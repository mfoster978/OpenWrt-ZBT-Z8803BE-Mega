#!/bin/sh
# Wait for one enabled physical modem to finish USB enumeration, then supervise
# its QModem dialer.  The wrapper deliberately remains alive: a QMI process can
# lose its USB control channel without the modem disappearing, and relying only
# on an outer procd respawn left that slot idle on affected dual-modem boots.
# Never fall back to the peer modem and never rewrite modem/network settings.

. /usr/lib/zbt/dual-modem.sh

zbt_qmodem_armed() {
	case "$1" in 4_1|2_1) ;; *) return 1 ;; esac
	[ "$(uci -q get qmodem.main.enable_dial 2>/dev/null)" = 1 ] || return 1
	[ "$(uci -q get "qmodem.$1.enable_dial" 2>/dev/null)" = 1 ] || return 1
	return 0
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

zbt_qmodem_child_alive() {
	[ -n "$zbt_qmodem_child" ] || return 1
	awk -v parent="$$" '
		/^State:/ { zombie=($2 == "Z") }
		/^PPid:/ { owned=($2 == parent) }
		END { exit !(owned && !zombie) }
	' "/proc/$zbt_qmodem_child/status" 2>/dev/null
}

zbt_qmodem_stop() {
	zbt_qmodem_stopping=1
	zbt_qmodem_child_alive && kill -TERM "$zbt_qmodem_child" 2>/dev/null
}

zbt_qmodem_address_ready() {
	local device
	device=$(zbt_netdev "$1") || return 1
	ip -o -4 addr show dev "$device" scope global 2>/dev/null | grep -q ' inet ' && return 0
	ip -o -6 addr show dev "$device" scope global 2>/dev/null | grep -q ' inet6 '
}

zbt_qmodem_launch_lock() {
	# QModem's set_if phase can reload netifd while importing a newly discovered
	# interface.  Serialize only initial session establishment, then release the
	# lock after this exact slot has held an address for ten seconds.  The other
	# modem is delayed for at most 60 seconds, not for the connection lifetime.
	local waited=0
	exec 8>/var/lock/zbt-qmodem-session-start.lock
	while ! flock -n 8; do
		[ "$zbt_qmodem_stopping" = 0 ] || { exec 8>&-; return 1; }
		[ "$waited" -lt 60 ] || { exec 8>&-; return 1; }
		sleep 1
		waited=$((waited + 1))
	done
}

zbt_qmodem_launch() {
	local section="$1" waited=0 stable=0 result
	case "$section" in 4_1|2_1) ;; *) return 2 ;; esac
	# A procd timeout can kill this parent before the old dialer finishes its
	# cleanup. Let the dialer inherit a per-slot lifetime lock so a replacement
	# cannot race that cleanup even after this parent is forcibly terminated.
	# Never explicitly unlock it: flock -u would release the child's shared
	# open-file-description lock too. Each owner only closes its own descriptor.
	# fd9 belongs to the 5G radio transaction; keep this inherited descriptor
	# separate from it and the upstream procd/MWAN/netifd locks (1000-1002).
	exec 1003>"/var/lock/zbt-qmodem-session-$section.lock"
	if ! flock -n 1003; then
		exec 1003>&-
		logger -t qmodem_network "slot=$section action=auto-dial readiness=previous-session-active retry_seconds=5"
		return 75
	fi
	zbt_qmodem_launch_lock || { exec 1003>&-; return 75; }
	# A stop may arrive while waiting for the startup lock, before a child
	# exists to receive the forwarded signal. Do not spawn after that stop.
	if [ "$zbt_qmodem_stopping" != 0 ]; then
		exec 8>&-
		exec 1003>&-
		return 75
	fi
	(
		exec 8>&-
		exec /usr/share/qmodem/modem_dial.sh "$section" dial
	) &
	zbt_qmodem_child=$!
	# Cover the smaller fork-to-PID-assignment window too. The first trap may
	# have seen no child, so forward the recorded stop once ownership is known.
	[ "$zbt_qmodem_stopping" = 0 ] || zbt_qmodem_stop
	# Do not let the peer's first set_if/CM startup overlap this one.  A missing
	# SIM or carrier still releases the peer after one bounded minute.
	while zbt_qmodem_child_alive && [ "$waited" -lt 60 ]; do
		[ "$zbt_qmodem_stopping" = 0 ] || break
		if zbt_qmodem_address_ready "$section"; then
			stable=$((stable + 2))
			[ "$stable" -lt 10 ] || break
		else
			stable=0
		fi
		sleep 2
		waited=$((waited + 2))
	done
	flock -u 8
	exec 8>&-
	# ash returns from wait as soon as a trapped TERM/INT is delivered. The
	# forwarded signal only begins the dialer's CM/netifd/address cleanup.
	# Keep owning and waiting for that child until it actually exits; recovery
	# uses this parent's lifetime to decide when a replacement may safely dial.
	while :; do
		result=0
		wait "$zbt_qmodem_child" || result=$?
		zbt_qmodem_child_alive || break
	done
	zbt_qmodem_child=''
	exec 1003>&-
	return "$result"
}

zbt_qmodem_start() {
	local section="$1" attempts=0 dial_attempts=0 delay=2 reason last_reason='' result
	case "$section" in 4_1|2_1) ;; *) return 2 ;; esac
	zbt_qmodem_child=''
	zbt_qmodem_stopping=0
	trap 'zbt_qmodem_stop' INT TERM
	# Give the primary worker the first opportunity to own the short startup
	# lock even if procd happens to schedule the second instance first.
	if [ "$section" = 2_1 ] && zbt_qmodem_armed 4_1 && zbt_qmodem_ready 4_1; then sleep 2; fi
	while zbt_qmodem_armed "$section"; do
		[ "$zbt_qmodem_stopping" = 0 ] || break
		if zbt_qmodem_recovery_busy "$section"; then
			reason=recovery-in-progress
		elif zbt_qmodem_ready "$section"; then
			dial_attempts=$((dial_attempts + 1))
			logger -t qmodem_network "slot=$section action=auto-dial readiness=ready dial_attempt=$dial_attempts"
			result=0
			zbt_qmodem_launch "$section" || result=$?
			[ "$zbt_qmodem_stopping" = 0 ] || break
			logger -t qmodem_network "slot=$section action=dialer-exited result=$result retry_seconds=5 dial_attempt=$dial_attempts"
			zbt_qmodem_armed "$section" || break
			reason=dialer-exited
			delay=5
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
	trap - INT TERM
	logger -t qmodem_network "slot=$section action=auto-dial readiness=stopped attempts=$attempts dial_attempts=$dial_attempts"
	return 0
}

zbt_qmodem_start "$@"
