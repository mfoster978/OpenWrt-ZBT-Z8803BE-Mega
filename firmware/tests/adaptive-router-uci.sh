#!/bin/sh
# Actual built ARM64 UCI, isolated files only. No live router is accessed.
set -eu
: "${MEGA_TEST_ROOTFS:?extracted image required}"
: "${MEGA_TEST_REPO:?repository required}"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/config" "$fixture/delta"
uci() { qemu-aarch64 -L "$MEGA_TEST_ROOTFS" "$MEGA_TEST_ROOTFS/sbin/uci" -c "$fixture/config" -t "$fixture/delta" "$@"; }
logger() { :; }
for package in network qmodem firewall mwan3 modem_watchdog; do touch "$fixture/config/$package"; done
uci set modem_watchdog.global=global
for interface in wan_sfp wan usb_tether 4_1 2_1 lan; do uci set "network.$interface=interface"; done
for section in 4_1 2_1; do
	uci set "qmodem.$section=modem-device"
	uci set "qmodem.$section.zbt_5g_policy=auto_preferred"
	uci set "qmodem.$section.apn=example.invalid"
done
uci set qmodem.2_1.zbt_5g_policy=nsa
uci set mwan3.failover=policy
# Reproduce the transcript's broken scalar, not an already-correct fixture.
uci set 'mwan3.failover.use_member=failover_4_1 failover_2_1'
uci commit
ZBT_MWAN_NO_RELOAD=1
export ZBT_MWAN_NO_RELOAD
set -- failover
. "$MEGA_TEST_REPO/firmware/files/usr/sbin/zbt-mwan-preset"
expected='failover_wan_sfp failover_wan failover_usb_tether failover_4_1 failover_2_1'
[ "$(uci get mwan3.failover.use_member)" = "$expected" ]
[ "$(uci export mwan3 | grep -c 'list use_member')" = 12 ]
metric=0
for interface in wan_sfp wan usb_tether 4_1 2_1; do
	metric=$((metric+1))
	[ "$(uci get "mwan3.failover_$interface.metric")" = "$metric" ]
done
[ "$(uci get mwan3.default_rule.use_policy)" = failover ]
for section in 4_1 2_1; do
	if uci -q get "network.$section.device"; then exit 1; fi
	if uci -q get "network.$section.ifname"; then exit 1; fi
	[ "$(uci get "qmodem.$section.apn")" = example.invalid ]
done

# Reproduce the kept-config field failure: both physical CM paths can work,
# while netifd omits Modem 1 because an old disabled option survived. The v12
# migration must also restore the two trackers for a firmware-managed policy.
for interface in 4_1 4_1v6 2_1 2_1v6; do
	case "$interface" in 4_1*) section=4_1 ;; *) section=2_1 ;; esac
	uci set "network.$interface=interface"
	uci set "network.$interface.proto=zbtqmi"
	uci set "network.$interface.modem_config=$section"
	uci set "network.$interface.auto=0"
	uci set "network.$interface.disabled=1"
done
uci set qmodem.main=global
uci set qmodem.main.enable_dial=1
uci set qmodem.4_1.enable_dial=1
uci set qmodem.2_1.enable_dial=1
uci set qmodem.4_1.state=disabled
uci set qmodem.2_1.state=disabled
uci set modem_watchdog.global.routing_preset=failover
uci set mwan3.4_1.enabled=0
uci set mwan3.2_1.enabled=0
touch "$fixture/config/system"
uci set system.zbt_qmi_netifd=runtime_defaults
uci set system.zbt_qmi_netifd.version=11
uci commit
migration=$(sed \
	-e '/^\[ ! -x \/etc\/init.d\//d' \
	-e '/^exit 0$/d' \
	-e 's#ZBT_MWAN_NO_RELOAD=1 /usr/sbin/zbt-mwan-preset "$preset"#set -- "$preset"; . "$MEGA_TEST_REPO/firmware/files/usr/sbin/zbt-mwan-preset"#' \
	"$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-qmi-netifd-v12")
eval "$migration"
for interface in 4_1 4_1v6 2_1 2_1v6; do
	[ "$(uci get "network.$interface.auto")" = 1 ]
	if uci -q get "network.$interface.disabled"; then exit 1; fi
done
[ "$(uci get mwan3.4_1.enabled)" = 1 ]
[ "$(uci get mwan3.2_1.enabled)" = 1 ]
[ "$(uci get system.zbt_qmi_netifd.version)" = 12 ]
echo 'PASS: actual ARM64 UCI migrates retained disabled modem interfaces into netifd and re-enables both managed MWAN trackers'
# A later explicit QModem disable and custom MWAN selection remain authoritative.
uci set system.zbt_qmi_netifd.version=11
uci set qmodem.2_1.enable_dial=0
uci set network.2_1.auto=0
uci set network.2_1.disabled=1
uci set modem_watchdog.global.routing_preset=custom
uci set mwan3.2_1.enabled=0
uci commit
eval "$migration"
[ "$(uci get network.2_1.auto)" = 0 ]
[ "$(uci get network.2_1.disabled)" = 1 ]
[ "$(uci get mwan3.2_1.enabled)" = 0 ]
echo 'PASS: v12 migration preserves explicit QModem disable and custom MultiWAN state'
# Execute the actual migration body without enabling a host init service.
eval "$(sed '/^\/etc\/init.d\/zbt-5g-adaptive enable$/d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-5g-adaptive-v1")"
[ "$(uci get qmodem.4_1.zbt_5g_policy)" = auto ]
[ "$(uci get qmodem.2_1.zbt_5g_policy)" = nsa ]
# Firmware that briefly seeded adaptive mode did not have an explicit opt-in
# marker. The v2 migration removes only that implicit value and preserves an
# explicitly marked adaptive selection on the peer slot.
uci set qmodem.4_1.zbt_5g_policy=auto_adaptive
uci set qmodem.2_1.zbt_5g_policy=auto_adaptive
uci set qmodem.2_1.zbt_5g_adaptive_opt_in=1
uci commit qmodem
eval "$(sed '/^\/etc\/init.d\/zbt-5g-adaptive enable$/d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-5g-adaptive-v2")"
[ "$(uci get qmodem.4_1.zbt_5g_policy)" = auto ]
[ "$(uci get qmodem.2_1.zbt_5g_policy)" = auto_adaptive ]
[ "$(uci get qmodem.2_1.zbt_5g_adaptive_opt_in)" = 1 ]
[ "$(uci get system.zbt_5g_policy.version)" = 2 ]
uci set qmodem.4_1.zbt_5g_policy=sa
uci commit qmodem
# The version guard intentionally exits its calling shell. Run an idempotence
# check in a subshell so the rest of this migration suite is still exercised.
( eval "$(sed '/^\/etc\/init.d\/zbt-5g-adaptive enable$/d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-5g-adaptive-v2")" )
[ "$(uci get qmodem.4_1.zbt_5g_policy)" = sa ]
echo 'PASS: actual ARM64 UCI repairs failover and removes implicit adaptive mode while preserving explicit radio policies'

uci set modem_watchdog.modem1=modem
uci set modem_watchdog.modem2=modem
uci set modem_watchdog.global.enabled=0
uci set modem_watchdog.global.actions_enabled=0
touch "$fixture/config/system"
eval "$(sed '/^\/etc\/init.d\/modem_watchdog enable$/d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v1")"
[ "$(uci get modem_watchdog.global.enabled)" = 1 ]
[ "$(uci get modem_watchdog.global.actions_enabled)" = 1 ]
[ "$(uci get modem_watchdog.modem1.action)" = power_cycle ]
[ "$(uci get modem_watchdog.modem2.action)" = power_cycle ]
uci set modem_watchdog.global.enabled=0
uci set modem_watchdog.modem2.action=none
uci commit
eval "$(sed '/^\/etc\/init.d\/modem_watchdog enable$/d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v1")"
set -- failover
. "$MEGA_TEST_REPO/firmware/files/usr/sbin/zbt-mwan-preset"
[ "$(uci get modem_watchdog.global.enabled)" = 0 ]
[ "$(uci get modem_watchdog.modem2.action)" = none ]
# The upgrade lifecycle must re-install/restart the central worker without
# overriding a deliberate recovery opt-out.
eval "$(sed '/^\/etc\/init.d\/modem_watchdog /d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v3")"
[ "$(uci get modem_watchdog.global.recovery_v3)" = 1 ]
[ "$(uci get modem_watchdog.global.enabled)" = 0 ]
[ "$(uci get modem_watchdog.modem2.action)" = none ]
# The affected release proved that merely restarting the worker could preserve
# a historical actions-disabled state. v4 restores the requested Mega recovery
# policy exactly once; subsequent user changes survive its version marker.
recovery_v4=$(sed '/^\/etc\/init.d\/modem_watchdog /d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v4")
eval "$recovery_v4"
[ "$(uci get modem_watchdog.global.recovery_v4)" = 1 ]
[ "$(uci get modem_watchdog.global.enabled)" = 1 ]
[ "$(uci get modem_watchdog.global.actions_enabled)" = 1 ]
[ "$(uci get modem_watchdog.modem1.enabled)" = 1 ]
[ "$(uci get modem_watchdog.modem2.enabled)" = 1 ]
[ "$(uci get modem_watchdog.modem1.action)" = power_cycle ]
[ "$(uci get modem_watchdog.modem2.action)" = power_cycle ]
[ "$(uci get modem_watchdog.modem1.redial_attempts)" = 1 ]
[ "$(uci get modem_watchdog.modem2.redial_attempts)" = 1 ]
uci set modem_watchdog.global.enabled=0
uci set modem_watchdog.modem2.action=none
uci commit modem_watchdog
( eval "$recovery_v4" )
[ "$(uci get modem_watchdog.global.enabled)" = 0 ]
[ "$(uci get modem_watchdog.modem2.action)" = none ]
# v5 repairs the exact route-gap teardown / unverified-worker combination in
# the affected release and therefore re-arms both slots once on upgrade.
recovery_v5=$(sed '/^\/etc\/init.d\/modem_watchdog /d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v5")
eval "$recovery_v5"
[ "$(uci get modem_watchdog.global.recovery_v5)" = 1 ]
[ "$(uci get modem_watchdog.global.enabled)" = 1 ]
[ "$(uci get modem_watchdog.global.actions_enabled)" = 1 ]
[ "$(uci get modem_watchdog.modem1.action)" = power_cycle ]
[ "$(uci get modem_watchdog.modem2.action)" = power_cycle ]
uci set modem_watchdog.global.enabled=0
uci set modem_watchdog.modem1.action=none
uci commit modem_watchdog
( eval "$recovery_v5" )
[ "$(uci get modem_watchdog.global.enabled)" = 0 ]
[ "$(uci get modem_watchdog.modem1.action)" = none ]
[ "$(uci get mwan3.default_rule6.use_policy)" = failover6 ]
[ "$(uci get mwan3.4_1v6.family)" = ipv6 ]
echo 'PASS: actual ARM64 UCI repairs each affected watchdog generation once, then preserves later opt-out and the separate IPv6 policy'
