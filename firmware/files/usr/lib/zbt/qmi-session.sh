#!/bin/sh
# QMI child lifecycle and netifd publication. The device-bound watchdog owns
# Internet and kernel-path recovery; this supervisor owns only its CM child.
# No modem AT writes, SIM resets, network restart or metric edits.

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

zbt_qmi_target_mtu() {
	local target
	target=$(uci -q get "qmodem.$modem_config.mtu" 2>/dev/null)
	case "$target" in
		''|*[!0-9]*) target=1500 ;;
	esac
	if [ "$target" -lt 1280 ] || [ "$target" -gt 1500 ]; then
		target=1500
	fi
	printf '%s\n' "$target"
}

zbt_qmi_normalize_mtu() {
	local raw_ip current_mtu target_mtu verified_mtu
	case "$modem_config" in 4_1|2_1) ;; *) return 0 ;; esac
	[ "$bridge_enabled" != 1 ] || return 0
	zbt_qmi_owned || return 1
	raw_ip="${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/qmi/raw_ip"
	[ -r "$raw_ip" ] || return 0
	[ "$(cat "$raw_ip" 2>/dev/null)" = Y ] || return 0
	target_mtu=$(zbt_qmi_target_mtu) || return 1
	current_mtu=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/mtu" 2>/dev/null)
	case "$current_mtu" in ''|*[!0-9]*) return 1 ;; esac
	[ "$current_mtu" != "$target_mtu" ] || return 0
	# Keep the proven 1500 path explicit for build validation while allowing a
	# validated owner-selected QModem value when a carrier/network needs it.
	if [ "$target_mtu" = 1500 ]; then
		ip link set dev "$modem_netcard" mtu 1500 || return 1
	else
		ip link set dev "$modem_netcard" mtu "$target_mtu" || return 1
	fi
	verified_mtu=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/mtu" 2>/dev/null)
	[ "$verified_mtu" = "$target_mtu" ] || return 1
	logger -t zbt-qmi "slot=$modem_config device=$modem_netcard action=normalize-mtu old=$current_mtu new=$target_mtu result=verified"
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

zbt_qmi_report_exit() {
	local current index
	current=$(zbt_netdev "$modem_config" 2>/dev/null) || current=absent
	index=$(cat "${ZBT_SYSFS:-/sys}/class/net/$current/ifindex" 2>/dev/null) || index=absent
	# Report the cause before cleanup changes either netifd or the data device.
	# Deliberately omit command arguments, subscriber identities and addresses.
	logger -t qmodem_network "slot=$modem_config action=cm-session-ending reason=$1 cm_status=$2 cm_pid=${cm_pid:-none} device=$modem_netcard ifindex=$qmi_ifindex current_device=$current current_ifindex=$index"
}

zbt_qmi_signal() {
	trap '' INT TERM
	zbt_qmi_report_exit "signal-$1" pending
	zbt_qmi_cleanup
	exit 0
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
	local exit_reason=cm-exited exit_status=1 qmi_mtu_warned=0 target_mtu
	. /usr/lib/zbt/mwan-runtime.sh
	. /usr/lib/zbt/qmi-publish.sh
	case "$modem_config" in 4_1|2_1) ;; *) return 1 ;; esac
	qmi_ifindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)
	# Bridge passthrough does not assign the router a WAN address. Do not
	# supervise its reachability or flush an enslaved device.
	if [ "$bridge_enabled" != 1 ]; then zbt_qmi_owned || return 1; fi
	trap 'zbt_qmi_signal INT' INT
	trap 'zbt_qmi_signal TERM' TERM
	zbt_qmi_flush
	# set_if may be a no-op on redial; re-arm the logical interfaces that the
	# preceding child cleanup took down, even when UCI already matches.
	zbt_qmi_notify up
	"$@" &
	cm_pid=$!
	printf '%s\n' "$cm_pid" > "${MODEM_RUNDIR}/${modem_config}_dir/$modem_config.pid"
	while zbt_qmi_child_alive; do
		if [ "$bridge_enabled" != 1 ]; then
			zbt_qmi_owned || { exit_reason=usb-device-changed; break; }
			if zbt_qmi_normalize_mtu; then
				qmi_mtu_warned=0
			elif [ "$qmi_mtu_warned" -eq 0 ]; then
				target_mtu=$(zbt_qmi_target_mtu)
				logger -t zbt-qmi "slot=$modem_config device=$modem_netcard action=normalize-mtu new=$target_mtu result=failed"
				qmi_mtu_warned=1
			fi
			# Address/default-route publication is allowed to disappear and be
			# repaired independently. In particular, a short netifd or mwan3
			# transition must never kill a healthy CM data call. The central
			# watchdog directly probes this physical netdev and owns a targeted
			# redial/GPIO escalation if the local or Internet path really fails.
			for family in 4 6; do
				interface=$interface_name
				[ "$family" != 6 ] || interface=$interface6_name
				if zbt_qmi_publish "$family" "$interface"; then
					zbt_mwan_refresh "$modem_config" "$modem_netcard" "$(ip -o -"$family" addr show dev "$modem_netcard" scope global | awk '/ inet/ {print $4; exit}')" "$$-$cm_pid" "$family"
				fi
			done
		fi
		sleep 5
	done
	if [ "$exit_reason" = cm-exited ]; then
		# wait retains a child's real exit/signal result even after it has been
		# reaped asynchronously. Log it before cleanup can overwrite $?.
		exit_status=0
		wait "$cm_pid" 2>/dev/null || exit_status=$?
		zbt_qmi_report_exit "$exit_reason" "$exit_status"
	else
		zbt_qmi_report_exit "$exit_reason" pending
	fi
	mkdir -p /tmp/modem-watchdog
	zbt_qmi_now > "/tmp/modem-watchdog/$modem_config.qmi-lost"
	zbt_qmi_cleanup
	trap - INT TERM
	# The per-slot dial supervisor owns the delayed retry. Never loop here and
	# instantly re-add the stale address/default route removed after failure.
	# A CM exiting successfully still ended a connection that should persist.
	# Keep retries for that case; propagate other results to the dial worker.
	[ "$exit_status" -ne 0 ] || exit_status=1
	return "$exit_status"
}
