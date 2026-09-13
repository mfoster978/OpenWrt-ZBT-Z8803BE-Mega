#!/bin/sh
# QMI child lifecycle only. MultiWAN owns probes, health and routing policy.
# No modem AT writes, SIM resets, MTU override, network restart or metric edits.

zbt_qmi_now() {
	local uptime rest
	read -r uptime rest < /proc/uptime
	printf '%s\n' "${uptime%%.*}"
}

zbt_qmi_owned() {
	local current index
	current=$(zbt_netdev "$modem_config") || return 1
	[ "$current" = "$modem_netcard" ] || return 1
	index=$(cat "${ZBT_SYSFS:-/sys}/class/net/$current/ifindex" 2>/dev/null)
	[ -n "$qmi_ifindex" ] && [ "$index" = "$qmi_ifindex" ] || return 1
	# Never flush a LAN bridge or a device currently enslaved to one.
	[ ! -e "${ZBT_SYSFS:-/sys}/class/net/$current/master" ]
}

zbt_qmi_flush() {
	[ "$bridge_enabled" != 1 ] || return 0
	zbt_qmi_owned || return 0
	ip -4 addr flush dev "$modem_netcard" scope global >/dev/null 2>&1
	ip -6 addr flush dev "$modem_netcard" scope global >/dev/null 2>&1
	ip -4 route flush dev "$modem_netcard" >/dev/null 2>&1
	ip -6 route flush dev "$modem_netcard" >/dev/null 2>&1
}

zbt_qmi_notify() {
	local action="$1" interface
	for interface in "$interface_name" "$interface6_name"; do
		# An edited alias must never make a stale dialer stop LAN/another WAN.
		case "$interface" in "$modem_config"|"${modem_config}v6") ;; *) continue ;; esac
		[ "$(uci -q get "network.$interface.modem_config")" = "$modem_config" ] || continue
		if [ "$action" = up ]; then
			ifup "$interface" >/dev/null 2>&1
		else
			ifdown "$interface" >/dev/null 2>&1
		fi
	done
}

zbt_qmi_child_alive() {
	[ -n "$cm_pid" ] || return 1
	# A reaped PID can be reused. Require this shell to remain its parent,
	# and reject zombies, before signalling; never signal a stale PID alone.
	awk -v parent="$$" '
		/^State:/ { zombie=($2 == "Z") }
		/^PPid:/ { owned=($2 == parent) }
		END { exit !(owned && !zombie) }
	' "/proc/$cm_pid/status" 2>/dev/null
}

zbt_qmi_cleanup() {
	local attempt=0
	# Owned live child only; never use a previous boot's PID file or killall.
	if [ -n "$cm_pid" ]; then
		zbt_qmi_child_alive && kill -TERM "$cm_pid" 2>/dev/null
		while zbt_qmi_child_alive && [ "$attempt" -lt 8 ]; do
			sleep 1
			attempt=$((attempt + 1))
		done
		zbt_qmi_child_alive && kill -KILL "$cm_pid" 2>/dev/null
		wait "$cm_pid" 2>/dev/null
		cm_pid=''
	fi
	rm -f "${MODEM_RUNDIR}/${modem_config}_dir/$modem_config.pid"
	zbt_qmi_notify down
	zbt_qmi_flush
}

zbt_qmi_failed() {
	local interface family state started stamp pid now="$1" seen=0
	# With no address in either requested family, the data call did not form.
	# A working IPv6-only session must not be killed for lacking IPv4.
	if ! ip -o -4 addr show dev "$modem_netcard" scope global 2>/dev/null | grep -q ' inet ' &&
	   ! ip -o -6 addr show dev "$modem_netcard" scope global 2>/dev/null | grep -q ' inet6 '; then
		return 0
	fi
	# Consume fresh results of the owner's configured interface-bound probes.
	# Missing/paused/stale trackers are unknown, not evidence of a bad modem.
	for family in 4 6; do
		ip -o -"$family" addr show dev "$modem_netcard" scope global 2>/dev/null | grep -q ' inet' || continue
		interface=$interface_name
		[ "$family" != 6 ] || interface=$interface6_name
		[ "$(uci -q get "mwan3.$interface.enabled")" = 1 ] || continue
		[ -n "$(uci -q get "mwan3.$interface.track_ip")" ] || continue
		state=$(cat "/var/run/mwan3track/$interface/STATUS" 2>/dev/null)
		started=$(cat "/var/run/mwan3track/$interface/STARTED" 2>/dev/null)
		stamp=$(cat "/var/run/mwan3track/$interface/TIME" 2>/dev/null)
		pid=$(cat "/var/run/mwan3track/$interface/PID" 2>/dev/null)
		case "$stamp:$pid" in *[!0-9:]*|:*|*:|*:0|*:1) return 1 ;; esac
		[ "$started" = 1 ] && [ "$state" = offline ] || return 1
		[ "$stamp" -le "$now" ] && [ $((now - stamp)) -le 60 ] || return 1
		kill -0 "$pid" 2>/dev/null || return 1
		seen=1
	done
	[ "$seen" = 1 ]
}

zbt_qmi_session() {
	local qmi_ifindex cm_pid='' failed_since='' now
	. /usr/lib/zbt/mwan-runtime.sh
	case "$modem_config" in 4_1|2_1) ;; *) return 1 ;; esac
	qmi_ifindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)
	# Bridge passthrough does not assign the router a WAN address. Do not
	# supervise its reachability or flush an enslaved device.
	if [ "$bridge_enabled" != 1 ]; then zbt_qmi_owned || return 1; fi
	trap 'trap "" INT TERM; zbt_qmi_cleanup; exit 0' INT TERM
	zbt_qmi_flush
	# set_if may be a no-op on redial; re-arm the logical interfaces that the
	# preceding child cleanup took down, even when UCI already matches.
	zbt_qmi_notify up
	"$@" &
	cm_pid=$!
	printf '%s\n' "$cm_pid" > "${MODEM_RUNDIR}/${modem_config}_dir/$modem_config.pid"
	while zbt_qmi_child_alive; do
		if [ "$bridge_enabled" != 1 ]; then
			zbt_qmi_owned || break
			zbt_mwan_refresh "$modem_config" "$modem_netcard" "$(ip -o -4 addr show dev "$modem_netcard" scope global 2>/dev/null | awk '/ inet / {print $4; exit}')" "$$-$cm_pid"
			now=$(zbt_qmi_now)
			if zbt_qmi_failed "$now"; then
				[ -n "$failed_since" ] || failed_since=$now
				if [ $((now - failed_since)) -ge 120 ]; then
					logger -t qmodem_network "$modem_config data session failed for 120 seconds; cleaning up before supervised retry"
					break
				fi
			else
				failed_since=''
			fi
		fi
		sleep 5
	done
	zbt_qmi_cleanup
	trap - INT TERM
	# procd owns the delayed retry. Never loop here and instantly re-add the
	# stale address/default route just removed after a failed attempt.
	return 1
}
