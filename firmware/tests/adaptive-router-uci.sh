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
[ "$(uci get qmodem.4_1.zbt_5g_policy)" = auto_adaptive ]
[ "$(uci get qmodem.2_1.zbt_5g_policy)" = nsa ]
uci set qmodem.4_1.zbt_5g_policy=sa
uci set qmodem.2_1.zbt_5g_policy=auto
uci commit qmodem
eval "$(sed '/^\/etc\/init.d\/zbt-5g-adaptive enable$/d; /^exit 0$/d' "$MEGA_TEST_REPO/firmware/files/etc/uci-defaults/99-zbt-5g-adaptive-v1")"
[ "$(uci get qmodem.4_1.zbt_5g_policy)" = sa ]
[ "$(uci get qmodem.2_1.zbt_5g_policy)" = auto ]
echo 'PASS: actual ARM64 UCI repairs scalar failover into five ordered list entries; dynamic devices, APNs and explicit radio policies preserved'

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
[ "$(uci get mwan3.default_rule6.use_policy)" = failover6 ]
[ "$(uci get mwan3.4_1v6.family)" = ipv6 ]
echo 'PASS: actual ARM64 UCI enables guarded recovery once, preserves later opt-out across presets/upgrades, and builds separate IPv6 policy'
