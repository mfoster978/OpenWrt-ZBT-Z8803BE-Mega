#!/bin/sh
# QMI child lifecycle and netifd publication. Watchdog owns Internet recovery;
# this supervisor owns loss of the local address/default-route data path.
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
	exec 1002>/var/lock/zbt-qmi-netifd.lock
	flock 1002
	for interface in "$interface_name" "$interface6_name"; do
		# An edited alias must never make a stale dialer stop LAN/another WAN.
		case "$interface" in "$modem_config"|"${modem_config}v6") ;; *) continue ;; esac
		[ "$(uci -q get "network.$interface.modem_config")" = "$modem_config" ] || continue
		# /sbin/ifup reloads every network interface before its target. Two
		# simultaneous modem sessions can therefore leave the first slot down.
		# The UCI configuration was loaded by set_if; change only this interface.
		ubus -t 5 call network.interface "$action" "{\"interface\":\"$interface\"}" >/dev/null 2>&1
	done
	flock -u 1002
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

zbt_qmi_kernel_path() {
	local family="$1"
	ip -o -"$family" addr show dev "$modem_netcard" scope global 2>/dev/null | grep -q ' inet' || return 1
	ip -"$family" route show table main default dev "$modem_netcard" 2>/dev/null | grep -q .
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

zbt_qmi_session() {
	local qmi_ifindex cm_pid='' qmi_published4='' qmi_published6='' family interface
	local qmi_had_kernel_path=0 qmi_kernel_path=0 qmi_kernel_misses=0
	. /usr/lib/zbt/mwan-runtime.sh
	. /usr/lib/zbt/qmi-publish.sh
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
			# Never destroy a live CM just because mwan3 has a stale offline
			# result. Direct end-to-end recovery is owned by modem-watchdog.
			qmi_kernel_path=0
			for family in 4 6; do
				interface=$interface_name
				[ "$family" != 6 ] || interface=$interface6_name
				zbt_qmi_kernel_path "$family" && qmi_kernel_path=1
				if zbt_qmi_publish "$family" "$interface"; then
					zbt_mwan_refresh "$modem_config" "$modem_netcard" "$(ip -o -"$family" addr show dev "$modem_netcard" scope global | awk '/ inet/ {print $4; exit}')" "$$-$cm_pid" "$family"
				fi
			done
			if [ "$qmi_kernel_path" = 1 ]; then
				qmi_had_kernel_path=1
				qmi_kernel_misses=0
			elif [ "$qmi_had_kernel_path" = 1 ]; then
				qmi_kernel_misses=$((qmi_kernel_misses + 1))
				if [ "$qmi_kernel_misses" -ge 3 ]; then
					logger -t qmodem "slot=$modem_config device=$modem_netcard action=session-restart reason=kernel-data-path-lost misses=$qmi_kernel_misses"
					break
				fi
			fi
		fi
		sleep 5
	done
	mkdir -p /tmp/modem-watchdog
	zbt_qmi_now > "/tmp/modem-watchdog/$modem_config.qmi-lost"
	zbt_qmi_cleanup
	trap - INT TERM
	# The per-slot dial supervisor owns the delayed retry. Never loop here and
	# instantly re-add the stale address/default route removed after failure.
	return 1
}
