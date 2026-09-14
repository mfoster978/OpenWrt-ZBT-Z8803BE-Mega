#!/bin/sh
# Recover a poisoned cellular USB data function without removing modem power.
# Hardware testing on RM551E showed that WDS redial and qmi_wwan rebind do not
# clear the SA RX-error storm, while full USB deauthorize/reauthorize does.
zbt_usb_reenumerate() (
	local section="$1" auth tries=0 disabled=0
	zbt_slot "$section" || exit 1
	auth="${ZBT_SYSFS:-/sys}/bus/usb/devices/$ZBT_USB/authorized"
	[ -w "$auth" ] || exit 1
	cleanup() {
		[ "$disabled" != 1 ] || printf '1\n' > "$auth" 2>/dev/null || true
	}
	trap 'cleanup' EXIT
	trap 'exit 1' INT TERM
	logger -t modem-watchdog "slot=$section action=usb_reset stage=deauthorize result=starting"
	disabled=1
	if ! printf '0\n' > "$auth"; then
		logger -t modem-watchdog "slot=$section action=usb_reset stage=deauthorize result=write-failed"
		exit 1
	fi
	sleep 5
	if ! printf '1\n' > "$auth"; then
		logger -t modem-watchdog "slot=$section action=usb_reset stage=reauthorize result=write-failed"
		exit 1
	fi
	disabled=0
	while [ "$tries" -lt 20 ]; do
		if zbt_netdev "$section" >/dev/null 2>&1; then
			logger -t modem-watchdog "slot=$section action=usb_reset stage=reauthorize result=complete wait_seconds=$tries"
			exit 0
		fi
		tries=$((tries + 1))
		sleep 1
	done
	logger -t modem-watchdog "slot=$section action=usb_reset stage=reauthorize result=netdev-timeout seconds=20"
	exit 1
)
