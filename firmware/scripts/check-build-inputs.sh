#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

bash -n firmware/docker/build-openwrt.sh
python3 firmware/tests/mega-release.test.py
for script in \
  firmware/files/etc/init.d/speedify-installer \
  firmware/files/etc/init.d/zbt-luci-backend \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery \
  firmware/files/etc/uci-defaults/53-zbt-modem-display-labels-v2 \
  firmware/files/etc/uci-defaults/40-zbt-usb-tether-defaults \
  firmware/files/etc/uci-defaults/73-zbt-us-wifi-defaults \
  firmware/files/etc/uci-defaults/95-mwan3-defaults \
  firmware/files/etc/uci-defaults/99-zbt-route-priority-repair \
  firmware/files/etc/uci-defaults/99-speedify-bootstrap \
  firmware/files/etc/uci-defaults/99-cellular-multiwan-defaults \
  firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v2 \
  firmware/files/etc/hotplug.d/net/15-zbt-rndis-auto \
  firmware/files/etc/hotplug.d/usb/40-zbt-qmodem-autoenable \
  firmware/files/usr/lib/zbt/qmodem-start.sh \
  firmware/files/usr/sbin/speedify-installer-loop \
  firmware/files/usr/sbin/zbt-luci-backend-check \
  firmware/files/usr/sbin/zbt-mwan-preset \
  firmware/files/usr/sbin/zbt-qmodem-watchdog-loop \
  firmware/scripts/apply-router-defaults.sh \
  firmware/scripts/verify-router-runtime.sh; do
  sh -n "${script}"
done

test -x firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v2
grep -Fq 'redial_attempts=1' firmware/files/etc/uci-defaults/99-zbt-modem-recovery-v2
grep -Fq 'action=dialer-exited' firmware/files/usr/lib/zbt/qmodem-start.sh
grep -Fq 'zbt-qmodem-session-start.lock' firmware/files/usr/lib/zbt/qmodem-start.sh

# Cover every new overlay/feed shell entry point, including rpcd backends
# whose filenames do not end in .sh. Libraries are parsed but never run.
while IFS= read -r script; do
  case "$(head -n 1 "$script")" in
    '#!/bin/sh'*) sh -n "$script" ;;
  esac
done < <(rg --files firmware/files firmware/feeds)

test -s firmware/patches/luci-app-mlo-shared-iface.patch
grep -Fq 'writeCommon(mldIface, selectedDevices);' firmware/patches/luci-app-mlo-shared-iface.patch
hostapd_mlo_patch=firmware/patches/hostapd-mlo-interoperability.patch
test -s "$hostapd_mlo_patch"
grep -Fq 'AP MLD: Clear reserved fields in EML capability for AP MLD' "$hostapd_mlo_patch"
grep -Fq 'nl80211: Avoid bogus ENFILE with use_existing' "$hostapd_mlo_patch"
grep -Fq 'hostapd_remove_hapd_iface' "$hostapd_mlo_patch"
grep -Fq 'ap_sta_free_sta_profile(info);' "$hostapd_mlo_patch"
grep -Fq 'hostapd_mlo_patch_target=package/network/services/hostapd/patches/804-zbt-mlo-interoperability.patch' \
  firmware/docker/build-openwrt.sh
test -s firmware/patches/luci-app-mwan3-route-metric.patch
grep -Fq "uci.set('network', section_id, 'metric', value);" \
  firmware/patches/luci-app-mwan3-route-metric.patch
grep -Fq '"network"' firmware/patches/luci-app-mwan3-route-metric.patch
grep -Fq "uci -q add_list \"wireless.\${first}.device=\${device}\"" \
  firmware/files/etc/uci-defaults/74-zbt-mlo-shared-iface-repair

# The default Argon theme loads a Mega-only responsive layer for ordinary CBI
# pages. Keep it mobile-scoped and preserve the independently scoped About UI.
test -s firmware/patches/luci-theme-argon-mega-mobile.patch
test -s firmware/files/www/luci-static/resources/zbt-mega-mobile.css
grep -Fq 'zbt-mega-mobile.css?v={{ pkgs_update_time }}' \
  firmware/patches/luci-theme-argon-mega-mobile.patch
grep -Fq 'luci-theme-argon-mega-mobile.patch' firmware/docker/build-openwrt.sh
grep -Fq '@media screen and (max-width:768px)' \
  firmware/files/www/luci-static/resources/zbt-mega-mobile.css
grep -Fq '.td[data-title]' firmware/files/www/luci-static/resources/zbt-mega-mobile.css
grep -Fq 'grid-template-columns:repeat(2,minmax(0,1fr))' \
  firmware/files/www/luci-static/resources/zbt-mega-mobile.css

# Every LuCI resource uses the release identity from the immutable image as
# its cache version. Reproducible package database timestamps are only a
# fallback for non-Mega installations.
test -s firmware/patches/luci-mega-resource-version.patch
grep -Fq "readfile('/rom/etc/zbt-mega-build.json')" \
  firmware/patches/luci-mega-resource-version.patch
grep -Fq 'luci-mega-resource-version.patch' firmware/docker/build-openwrt.sh
grep -Fq 'make package/feeds/luci/luci-base/clean' firmware/docker/build-openwrt.sh

# US is the factory regulatory domain on every MT7996 radio. Numeric UCI
# txpower overrides are forbidden: the driver must retain its regulatory and
# EEPROM minimum. The mobile-safe 6 GHz profile is VLP at 14 dBm EIRP.
us_wifi_defaults=firmware/files/etc/uci-defaults/73-zbt-us-wifi-defaults
grep -Fq 'wireless.${radio}.country=US' "$us_wifi_defaults"
grep -Fq 'wireless.${radio}.reg_power_type=2' "$us_wifi_defaults"
grep -Fq 'wireless.${radio}.country3=20' "$us_wifi_defaults"
if grep -Eq '(^|/)(sbin/)?wifi[[:space:]]+reload|zbt-wifi-reload-deferred' \
  "$us_wifi_defaults" firmware/files/etc/uci-defaults/74-zbt-mlo-shared-iface-repair; then
  echo 'Wi-Fi UCI defaults must not reload wireless during first network bring-up' >&2
  exit 1
fi
grep -F 'wireless.${radio}.txpower' "$us_wifi_defaults" | grep -Fq 'delete'
if grep -Eq 'txpower=[0-9]|\.txpower=[0-9]' "$us_wifi_defaults"; then
  echo 'US Wi-Fi defaults must not bypass the regulatory/EEPROM power minimum' >&2
  exit 1
fi
regdb_patch=firmware/patches/wireless-regdb-us-6ghz-vlp.patch
test -s "$regdb_patch"
grep -Fq -- $'+\t(5925 - 7125 @ 320), (14)' "$regdb_patch"
grep -Fq -- $'-\t(5925 - 7125 @ 320), (12), NO-OUTDOOR, NO-IR' "$regdb_patch"
grep -Fq 'regdb_patch_target=package/firmware/wireless-regdb/patches/610-us-6ghz-vlp.patch' \
  firmware/docker/build-openwrt.sh
grep -Fq 'make package/firmware/wireless-regdb/clean' firmware/docker/build-openwrt.sh
grep -Fq 'make package/feeds/custom_local/zbt-speedtest/clean' firmware/docker/build-openwrt.sh
grep -Fq 'make package/feeds/custom_local/luci-app-speedtest-lite/clean' firmware/docker/build-openwrt.sh

# LuCI must remain reachable over warning-free LAN HTTP while preserving the
# optional HTTPS listener. This is a one-time migration so operator changes
# made after first boot are not overwritten on every upgrade.
grep -Fq "uci -q delete nginx._redirect2ssl" \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
grep -Fq "uci -q add_list nginx._lan.listen='80 default_server'" \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
grep -Fq "uci -q add_list nginx._lan.listen='[::]:80 default_server'" \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
grep -Fq "system.zbt_luci_http.nginx_migrated" \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
grep -Fq "nginx._lan.include='conf.d/*.locations'" \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
grep -Fq '/etc/init.d/uwsgi status' \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
grep -Fq '/etc/init.d/nginx status' \
  firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery
if grep -Fq '( sleep 5;' firmware/files/etc/uci-defaults/50-zbt-luci-web-recovery; then
  echo 'LuCI first-boot recovery must not race normal service startup' >&2
  exit 1
fi
grep -Fq "http://127.0.0.1/luci-app-speedify/view/index.html" \
  firmware/files/usr/sbin/speedify-installer-loop
grep -Fq "https://127.0.0.1/luci-app-speedify/view/index.html" \
  firmware/files/usr/sbin/speedify-installer-loop
grep -Fq '[ "$http_status" = 307 ]' firmware/files/usr/sbin/speedify-installer-loop
grep -Fq 'return 307 https://$host$request_uri;' \
  firmware/files/etc/nginx/conf.d/zbt-speedify-https.locations
grep -Fq 'if ($scheme = http)' \
  firmware/files/etc/nginx/conf.d/zbt-speedify-https.locations
grep -Fq '/cgi-bin/luci/(?:[^/?]+/)*speedify' \
  firmware/files/etc/nginx/conf.d/zbt-speedify-https.locations

# MWAN3 owns route selection; QModem preserves stable interfaces and consumes
# their network metrics instead of deleting or overwriting them on redial.
grep -Fq 'network_metric=$(uci -q get network.${interface_name}.metric)' \
  firmware/patches/qmodem-dual-runtime.patch
grep -Fq 'Keep the stable 4_1/2_1 record that MWAN3 tracks' \
  firmware/patches/qmodem-dual-runtime.patch
grep -Fq "form.DummyValue, '_route_metric'" firmware/patches/qmodem-dual-runtime.patch
grep -Fq "uci.load('network')" firmware/patches/qmodem-dual-runtime.patch
grep -Fq "Phone Number (MSISDN)" firmware/patches/qmodem-dual-runtime.patch
grep -Fq "Not provided by SIM or carrier" firmware/patches/qmodem-dual-runtime.patch
test -s firmware/patches/qmodem-cell-discovery.patch
test -s firmware/patches/qmodem-5g-deployment.patch
test -s firmware/patches/qmodem-performance-ui.patch
test -s firmware/patches/qmodem-mega-policy-ui.patch
test -s firmware/files/usr/lib/zbt/qmodem-cell-discovery.sh
grep -Fq 'qmodem-cell-discovery.patch' firmware/docker/build-openwrt.sh
grep -Fq 'qmodem-5g-deployment.patch' firmware/docker/build-openwrt.sh
grep -Fq 'qmodem-performance-ui.patch' firmware/docker/build-openwrt.sh
grep -Fq 'qmodem-mega-policy-ui.patch' firmware/docker/build-openwrt.sh
grep -Fq 'Unrelated QModem changes remain; refusing to overwrite them' firmware/docker/build-openwrt.sh
grep -Fq 'qmodem-connectivity-v5.patch' firmware/docker/build-openwrt.sh
qmodem_monitor_patch=firmware/patches/zbt-qmodem-monitor-hardening.patch
test -s "$qmodem_monitor_patch"
grep -Fq 'zbt-qmodem-monitor-hardening.patch' firmware/docker/build-openwrt.sh
grep -Fq -- "--write-out '%{http_code}'" "$qmodem_monitor_patch"
grep -Fq '*generate_204*)' "$qmodem_monitor_patch"
grep -Fq 'MONITOR_RECOVERY_STREAK_DEFAULT=3' "$qmodem_monitor_patch"
grep -Fq 'config_get MONITOR_RECOVERY_STREAK main zbt_monitor_recovery_streak' "$qmodem_monitor_patch"
grep -Fq 'if [ "$status" -ne 0 ] && [ "$failed_count" -ge "$Threshold" ]; then' "$qmodem_monitor_patch"
run_actions_line="$(grep -nE '^[+ ]+[[:space:]]*run_actions$' "$qmodem_monitor_patch" | tail -n 1 | cut -d: -f1)"
mark_action_line="$(grep -nE '^[+ ]+[[:space:]]*mark_monitor_action$' "$qmodem_monitor_patch" | tail -n 1 | cut -d: -f1)"
if [[ -z "$run_actions_line" || -z "$mark_action_line" || "$run_actions_line" -ge "$mark_action_line" ]]; then
  echo 'QModem monitor patch must dispatch actions before marking the cooldown' >&2
  exit 1
fi
if rg -n 'zbt_monitor_recovery_streak' firmware/files/etc/config firmware/files/etc/uci-defaults; then
  echo 'QModem recovery-streak default must not be seeded into UCI' >&2
  exit 1
fi
grep -Fq 'monitor_enabled=0' firmware/files/usr/sbin/zbt-qmodem-profile
grep -Fq 'zbt_quectel_sim_number "$at_port"' firmware/patches/qmodem-cell-discovery.patch
grep -Fq 'zbt_quectel_get_cells "$at_port"' firmware/patches/qmodem-cell-discovery.patch
grep -Fq "'AT+QSCAN=3,1'" firmware/files/usr/lib/zbt/qmodem-cell-discovery.sh
grep -Fq ' -t 185 -g' firmware/files/usr/lib/zbt/qmodem-cell-discovery.sh
grep -Fq "'AT+CPBS=\"ON\"'" firmware/files/usr/lib/zbt/qmodem-cell-discovery.sh
grep -Fq 'AT+QNWPREFCFG="nr5g_disable_mode"' firmware/patches/qmodem-5g-deployment.patch
grep -Fq 'Automatic (recommended)' firmware/patches/qmodem-5g-deployment.patch
grep -Fq "[ \"\$current\" = \"\$desired\" ]" firmware/patches/qmodem-5g-deployment.patch
grep -Fq 'auto_preferred)' firmware/patches/qmodem-mega-policy-ui.patch
grep -Fq "return uci.load('qmodem').then" firmware/patches/qmodem-mega-policy-ui.patch
grep -Fq 'NSA only — LTE-anchored 5G speed comparison' firmware/patches/qmodem-performance-ui.patch
grep -Fq "name: _('Preferred Bands')" firmware/patches/qmodem-performance-ui.patch
grep -Fq "''|4_1|2_1|modem1|modem2)" firmware/files/usr/sbin/zbt-qmodem-profile
grep -Fq 'zbt_5g_policy=auto_adaptive' firmware/files/usr/sbin/zbt-qmodem-profile
test -x firmware/files/usr/sbin/zbt-qmodem-performance-policy
grep -Fq '. /usr/lib/zbt/qmodem-5g.sh' firmware/files/usr/sbin/zbt-qmodem-performance-policy
test -x firmware/files/usr/libexec/rpcd/zbt.speedify
test -x firmware/files/etc/uci-defaults/99-zbt-modem-route-v5
test -x firmware/files/etc/uci-defaults/55-zbt-modem-labels-policy-v3
test -s firmware/files/etc/uci-defaults/53-zbt-modem-display-labels-v2
grep -Fq 'add_quectel_ca_report "$ca_response"' firmware/patches/qmodem-dual-runtime.patch
grep -Fq '"Carrier Aggregation" "$active active / $total reported"' firmware/patches/qmodem-dual-runtime.patch
if grep -Fq '[ "$section" != 4_1 ] || enable=1' firmware/files/usr/lib/zbt/ttl.sh; then
  echo 'Per-modem TTL must remain opt-in so fresh installs retain flow offload' >&2
  exit 1
fi
grep -Fq 'ensure_route_metric wan_sfp 9' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'ensure_route_metric wan 10' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'ensure_route_metric usb_tether 100' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'ensure_route_metric 4_1 200' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'ensure_route_metric 2_1 210' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'DEFAULTS_VERSION=4' firmware/files/etc/uci-defaults/99-zbt-route-priority-repair
grep -Fq "''|priority|fastest) preset=failover" firmware/files/etc/uci-defaults/99-zbt-route-priority-repair
grep -Fq 'rndis_host|cdc_ether|cdc_ncm|ipheth' firmware/files/etc/hotplug.d/net/15-zbt-rndis-auto
grep -Fq 'network.usb_tether.metric=100' firmware/files/etc/uci-defaults/40-zbt-usb-tether-defaults
grep -Fq 'ZBT_MWAN_NO_RELOAD=1 /usr/sbin/zbt-mwan-preset "$preset"' \
  firmware/files/etc/uci-defaults/99-zbt-route-priority-repair
grep -Fq 'if [ "${ZBT_MWAN_NO_RELOAD:-0}" != 1 ]; then' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'configure_member balanced_4_1 4_1 4 1' firmware/files/usr/sbin/zbt-mwan-preset
grep -Fq 'configure_member balanced_2_1 2_1 5 1' firmware/files/usr/sbin/zbt-mwan-preset
test -x firmware/files/etc/uci-defaults/99-zbt-modem1-priority-v4
grep -Fq 'ZBT_MWAN_NO_RELOAD=1 /usr/sbin/zbt-mwan-preset failover' firmware/files/etc/uci-defaults/99-zbt-modem1-priority-v4
if rg -n "applyPreset\('fastest'\)|write_preference|preferred=2" \
  firmware/feeds/luci-app-modem-watchdog; then
  echo 'Mega must never dynamically promote Modem 2 over Modem 1' >&2
  exit 1
fi
grep -Fq 'option routing_preset' firmware/feeds/luci-app-modem-watchdog/root/etc/config/modem_watchdog
grep -Fq 'ZBT-Z8803BE Mega Edition' firmware/files/etc/banner
grep -Fq 'github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega' firmware/files/etc/banner
grep -Fq 'Developer: Michael Foster / GitHub @mfoster978' firmware/files/etc/banner
grep -Fq 'Contact  : mfoster978@gmail.com - Discord: mfoster978' firmware/files/etc/banner
if rg -n -i 'donate|ERC20|BEP20|TRC20|0xfar5eer@gmail\.com|0xFar5eer#6504' \
  firmware/files/etc/banner firmware/files/etc/profile.d/10-zbt-info.sh; then
  echo 'Mega SSH identity still contains the upstream donation or contact block' >&2
  exit 1
fi

# Mega-only USB features are selected explicitly. Phone tethering drivers are
# available on attachment, while file sharing and USB/IP listen only after an
# owner opts in.
test -s firmware/patches/ksmbd-server-disabled.patch
grep -Fq "config_get_bool enabled globals enabled 0" firmware/patches/ksmbd-server-disabled.patch
grep -Fq "option 'enabled'" firmware/patches/ksmbd-server-disabled.patch
test -s firmware/patches/luci-app-ksmbd-enable-toggle.patch
grep -Fq "form.Flag, 'enabled'" firmware/patches/luci-app-ksmbd-enable-toggle.patch
grep -Fq 'KSMBD disabled-by-default patch does not match pinned packages feed' \
  firmware/docker/build-openwrt.sh
grep -Fq 'KSMBD LuCI enable-toggle patch does not match pinned LuCI feed' \
  firmware/docker/build-openwrt.sh
grep -Fq "option enable '0'" firmware/files/etc/config/usbipd
python3 -m json.tool firmware/files/usr/share/luci/menu.d/zbt-usb-services.json >/dev/null
grep -Fq 'admin/system/mounts' firmware/files/usr/share/luci/menu.d/zbt-usb-services.json
test -s firmware/docs/usb-tethering-storage-sharing.md
grep -Fq "['usb', _('USB & Sharing')" firmware/files/www/luci-static/resources/view/zbt8803be/mega-about-v2.js
grep -Fq 'Safe starting point: nothing is silently shared.' firmware/files/www/luci-static/resources/view/zbt8803be/mega-about-v2.js
grep -Fq 'Expand OpenWrt with extroot' firmware/files/www/luci-static/resources/view/zbt8803be/mega-about-v2.js
grep -Fq 'AdGuard Home' firmware/files/www/luci-static/resources/view/zbt8803be/mega-about-v2.js
grep -Fq 'Expand writable storage with extroot' README.md
grep -Fq 'KSMBD has an explicit **Enable server** switch that defaults off.' README.md

grep -qx 'CONFIG_TARGET_mediatek_filogic_DEVICE_zbtlink_zbt-z8803be=y' \
  firmware/profiles/base-config-zbt-z8803be-v25.12.021.config
printf '%s  %s\n' \
  '98b960b5fcd0908453387b9a1d17efa2d7a0ea03c58eab65e752b5873362028a' \
  'firmware/profiles/base-config-zbt-z8803be-v25.12.021.config' | sha256sum -c -

required_packages=(
  ca-bundle curl kmod-tun libstdcpp libkeyutils libatomic
  iptables-nft kmod-nft-tproxy iptables-mod-tproxy kmod-tcp-bbr
  iptables-mod-extra iptables-mod-conntrack-extra luci-nginx python3-light
)
for package in "${required_packages[@]}"; do
  grep -qx "${package}" firmware/profiles/packages-default.txt || {
    echo "Missing required baked Speedify dependency: ${package}" >&2
    exit 1
  }
done
grep -qx 'zbt-firmware-updater' firmware/profiles/packages-default.txt

mega_usb_packages=(
  kmod-usb-net-cdc-ether kmod-usb-net-rndis kmod-usb-net-ipheth
  usbmuxd libimobiledevice-utils usbutils block-mount e2fsprogs parted
  kmod-usb-storage kmod-usb-storage-uas kmod-fs-ext4 kmod-fs-exfat
  kmod-fs-vfat kmod-nls-utf8 ksmbd-server luci-app-ksmbd
  usbip usbip-client usbip-server kmod-usbip kmod-usbip-client
  kmod-usbip-server
)
for package in "${mega_usb_packages[@]}"; do
  grep -qx "${package}" firmware/profiles/packages-default.txt || {
    echo "Missing Mega USB feature package: ${package}" >&2
    exit 1
  }
done

# Mega's menu must not appear without its view, permissions and backend.
for component in \
  firmware/feeds/zbt-firmware-updater/Makefile \
  firmware/feeds/zbt-firmware-updater/LICENSE \
  firmware/feeds/zbt-firmware-updater/src/go.mod \
  firmware/files/www/luci-static/resources/view/speedify/speedify.js \
  firmware/files/usr/share/zbt/speedify-luci-wrapper.js \
  firmware/files/www/luci-static/resources/view/zbt8803be/mega-about-v2.js \
  firmware/files/www/luci-static/resources/view/zbt8803be/mega-about-v2.css \
  firmware/files/www/luci-static/resources/zbt-mega-mobile.css \
  firmware/files/www/luci-static/resources/view/system/mega-update.js \
  firmware/files/www/luci-static/resources/view/system/mega-update.css; do
  test -s "$component" || { echo "Missing Mega component: $component" >&2; exit 1; }
done
test -x firmware/files/usr/libexec/rpcd/zbt.firmware
for metadata in \
  firmware/files/usr/share/luci/menu.d/luci-app-zbt-about.json \
  firmware/files/usr/share/luci/menu.d/zbt-firmware.json \
  firmware/files/usr/share/luci/menu.d/zbt-speedify-launcher.json \
  firmware/files/usr/share/rpcd/acl.d/luci-app-speedify.json \
  firmware/files/usr/share/rpcd/acl.d/zbt-firmware.json \
  firmware/files/usr/share/rpcd/acl.d/luci-app-zbt-about.json; do
  python3 -m json.tool "$metadata" >/dev/null
done
grep -Fq '"path": "zbt8803be/mega-about-v2"' firmware/files/usr/share/luci/menu.d/luci-app-zbt-about.json
grep -Fq '"path": "speedify/launcher"' firmware/files/usr/share/luci/menu.d/zbt-speedify-launcher.json
grep -Fq '"path": "speedify/speedify"' firmware/files/usr/share/luci/menu.d/zbt-speedify-launcher.json
grep -Fq "target.protocol = 'https:'" firmware/files/www/luci-static/resources/view/speedify/launcher.js
grep -Fq 'window.location.replace(target.href)' firmware/files/www/luci-static/resources/view/speedify/launcher.js
grep -Fq "install_luci_wrapper || return 1" firmware/files/usr/sbin/speedify-installer-loop
if grep -Eq "window.location.replace|syncOuterHash" \
  firmware/files/usr/share/zbt/speedify-luci-wrapper.js; then
  echo 'Speedify must preserve LuCI navigation and not mirror transient login hashes' >&2
  exit 1
fi
grep -Fq "E('iframe'" \
  firmware/files/usr/share/zbt/speedify-luci-wrapper.js
grep -Fq "app.search = 'wsPort=match&wsEndpoint=" \
  firmware/files/usr/share/zbt/speedify-luci-wrapper.js
if grep -Eq "getRouterActivation|method: 'activation'|Sign in this router" firmware/files/usr/share/zbt/speedify-luci-wrapper.js; then
  echo 'Speedify must use its native sign-in UI' >&2; exit 1
fi
for patch_name in qmodem-at-transport-v6.patch qmodem-radio-rpc-v6.patch zbt-qmodem-rpc-firstboot.patch qmodem-session-lifecycle-v7.patch zbt-wifi-firstboot-v7.patch; do
  test -s "firmware/patches/$patch_name"
  grep -Fq "$patch_name" firmware/docker/build-openwrt.sh
done
grep -Fq 'procd_set_param respawn 3600 5 0' firmware/files/etc/init.d/zbt-wifi-firstboot
grep -Fq 'configured-ap-not-running phase=boot' firmware/files/usr/sbin/zbt-wifi-firstboot
grep -Fq 'while sleep "$ZBT_WIFI_MONITOR_INTERVAL"' firmware/files/usr/sbin/zbt-wifi-firstboot
if grep -Fq '[ -f /etc/uci-defaults/72-zbt-z8803be-wifi ]' firmware/files/etc/init.d/zbt-wifi-firstboot; then
  echo 'Kept-configuration Wi-Fi recovery must not depend on pending defaults' >&2
  exit 1
fi
test -s firmware/kernel-patches/967-arm64-dts-mt7988-pcie-external-clocks.patch
grep -Fq '967-arm64-dts-mt7988-pcie-external-clocks.patch' firmware/docker/build-openwrt.sh

grep -q "OPENWRT_GIT_REF:-v25.12.021" firmware/docker/build-openwrt.sh
grep -q "OPENWRT_GIT_URL:-https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE.git" \
  firmware/docker/build-openwrt.sh
grep -q "EXPECTED_OPENWRT_COMMIT:-edc738504fe8fae81eb15de967456204699b1830" \
  firmware/docker/build-openwrt.sh
grep -Fq 'luci-first-login-password.patch' firmware/docker/build-openwrt.sh
grep -Fq "root_password_is_unset()" firmware/patches/luci-first-login-password.patch
grep -Fq "admin/system/admin/password" firmware/patches/luci-first-login-password.patch
grep -Fq "password') + '?first=1'" firmware/patches/luci-first-login-password.patch
grep -Fq "window.location.replace(L.url('admin', 'about'))" firmware/patches/luci-first-login-password.patch
grep -Fq 'does not ship the shared vendor password "admin"' \
  firmware/files/etc/uci-defaults/80-zbt-z8803be-admin-password
if grep -Eq 'passwd[[:space:]]+root|admin\\nadmin' firmware/files/etc/uci-defaults/80-zbt-z8803be-admin-password; then
  echo 'Mega must not restore the shared vendor root password' >&2
  exit 1
fi
grep -q "EXPECTED_ARCH='aarch64_cortex-a53'" firmware/files/usr/sbin/speedify-installer-loop
grep -q "SPEEDIFY_SHA256='876ec301cee1a2bb9136ccef6c050762456525b15ac645581b44f0c16630947d'" \
  firmware/files/usr/sbin/speedify-installer-loop
grep -q "LUCI_SHA256='efaa6f7da76e4ad5c6bb407aa503886e6af828100a1263698ec26b4335e14167'" \
  firmware/files/usr/sbin/speedify-installer-loop
while IFS= read -r checksum; do
  [[ "${checksum}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Invalid Speedify SHA256 constant: ${checksum}" >&2
    exit 1
  }
done < <(sed -n "s/^\(SPEEDIFY_SHA256\|LUCI_SHA256\)='\([^']*\)'$/\2/p" \
  firmware/files/usr/sbin/speedify-installer-loop)

echo 'firmware_input_checks=passed'
