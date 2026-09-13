#!/bin/sh
# Read-only post-flash checks. No AT writes, resets, reloads, UCI commits,
# full modem/SIM config dumps or account tokens.
. /usr/lib/zbt/dual-modem.sh
printf '%s\n' 'Runtime diagnostics (review/redact before sharing)'
printf 'kernel=%s\n' "$(uname -r)"
printf 'board=%s\n' "$(cat /tmp/sysinfo/board_name 2>/dev/null)"
printf 'qmodem_firstboot_rpc_matches='
cmp -s /usr/lib/zbt/qmodem-rpcd /usr/libexec/rpcd/qmodem && echo yes || echo no
printf '%s\n' 'Registered 5G backend methods (read-only)'
ubus -v list qmodem 2>/dev/null | grep '5g_deployment' || true
for section in 4_1 2_1; do
	zbt_slot "$section"
	device=$(zbt_netdev "$section") || device=''
	port=$(uci -q get "qmodem.$section.at_port")
	printf '\nmodem=%s usb=%s device=%s power=%s led=%s\n' "$section" "$ZBT_USB" "${device:-absent}" "$ZBT_POWER" "$ZBT_LED"
	printf 'power_value=%s at_port=%s port_matches=%s\n' "$(cat "/sys/class/gpio/$ZBT_POWER/value" 2>/dev/null)" "$port" "$(zbt_port_matches "$section" "$port" && echo yes || echo no)"
	for key in display_name alias state enable_dial pdp_type metric monitor_enabled; do
		printf '%s=%s\n' "$key" "$(uci -q get "qmodem.$section.$key")"
	done
	printf 'apn_mode=%s secondary_apn_mode=%s\n' "$(zbt_apn_mode "$(uci -q get "qmodem.$section.apn")")" "$(zbt_apn_mode "$(uci -q get "qmodem.$section.apn2")")"
	printf 'proto=%s network_metric=%s\n' \
		"$(uci -q get "network.$section.proto")" \
		"$(uci -q get "network.$section.metric")"
	/etc/init.d/qmodem_network modem_status "$section" 2>/dev/null
	if [ -n "$device" ]; then
		ip addr show dev "$device" scope global 2>/dev/null
		ip -4 route show default dev "$device" 2>/dev/null
	fi
	# These queries are read-only; no setting/apply method is invoked.
	ubus -t 25 call qmodem get_5g_deployment "{\"config_section\":\"$section\"}" 2>/dev/null || true
done
printf '\n%s\n' 'Independent modem TTL policy (read-only; auto uses a passive 64/65 heuristic)'
for section in 4_1 2_1; do
	printf 'modem=%s ttl_enabled=%s ttl_mode=%s custom_ttl=%s\n' "$section" \
		"$(uci -q get "qmodem_ttl.$section.enable")" \
		"$(uci -q get "qmodem_ttl.$section.mode")" \
		"$(uci -q get "qmodem_ttl.$section.ttl")"
done
nft list chain inet fw4 zbt_qmodem_ttl_postrouting 2>/dev/null || true
printf '\n%s\n' 'Physical modem LED status (read-only)'
/usr/sbin/zbt-modem-led-poller status
/etc/init.d/zbt-modem-leds status 2>/dev/null || true
printf '%s\n' 'Factory status LED owner and channels'
/etc/init.d/zbt-leds status 2>/dev/null || true
for lamp in red:status green:wan blue:power; do
	printf 'led=%s trigger=%s brightness=%s\n' "$lamp" \
		"$(sed -n 's/.*\[\([^]]*\)\].*/\1/p' "/sys/class/leds/$lamp/trigger" 2>/dev/null)" \
		"$(cat "/sys/class/leds/$lamp/brightness" 2>/dev/null)"
done
printf '\n%s\n' 'Ethernet jack LED controls (read-only; amber/green metadata may mean orange)'
for lamp in mt7530-0:00:green:lan mt7530-0:02:green:lan mt7530-0:03:green:lan mdio-bus:0f:amber:wan; do
	printf 'led=%s' "$lamp"
	if [ ! -d "/sys/class/leds/$lamp" ]; then
		printf ' missing\n'
		continue
	fi
	for attribute in trigger brightness device_name link rx tx offloaded; do
		[ -r "/sys/class/leds/$lamp/$attribute" ] || continue
		printf ' %s=%s' "$attribute" "$(cat "/sys/class/leds/$lamp/$attribute")"
	done
	printf '\n'
done
printf '\n%s\n' 'Routing and measurement configuration'
for interface in wan_sfp wan_sfp6 wan wan6 usb_tether 4_1 2_1; do
	uci -q get "network.$interface" >/dev/null 2>&1 || continue
	printf 'network.%s metric=%s proto=%s device=%s\n' "$interface" \
		"$(uci -q get "network.$interface.metric")" \
		"$(uci -q get "network.$interface.proto")" \
		"$(uci -q get "network.$interface.device")"
done
/usr/sbin/zbt-mwan-preset status 2>/dev/null || true
for member in failover_wan_sfp failover_wan failover_usb_tether failover_4_1 failover_2_1; do
	printf '%s=%s:%s\n' "$member" "$(uci -q get "mwan3.$member.interface")" "$(uci -q get "mwan3.$member.metric")"
done
uci -q show modem_watchdog
ip -4 route show default
ip -4 rule show
mwan3 status 2>/dev/null || true
ubus -t 12 call zbt.speedify status '{}' 2>/dev/null | jq '{ok, signed_in, state, tunnel_present, recent_error, needs_internet, message}' || true
printf '\n%s\n' 'Installed UI packages and service health'
for package in luci-app-mwan3 luci-app-speedtest-lite zbt-speedtest luci-app-tailscale speedify luci-app-speedify; do
	apk info -e "$package" >/dev/null 2>&1 && printf '%s=installed\n' "$package" || printf '%s=missing\n' "$package"
done
for service in uwsgi nginx zbt-luci-backend sfy-ws-auth speedify speedify-installer tailscale qmodem_network; do
	printf '%s=' "$service"
	"/etc/init.d/$service" status 2>/dev/null || true
done
nginx -t 2>&1
printf 'luci_backend_socket=%s\n' "$([ -S /var/run/luci-webui.socket ] && echo present || echo missing)"
printf 'luci_http_status='
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1/cgi-bin/luci/
printf 'luci_https_status='
curl -ksS --max-time 5 -o /dev/null -w '%{http_code}\n' https://127.0.0.1/cgi-bin/luci/
printf 'speedify_installer_done=%s\n' "$([ -f /etc/speedify.installed ] && echo yes || echo no)"
printf 'speedify_http_redirect_status='
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1/luci-app-speedify/view/index.html
printf 'speedify_unauthenticated_https_status='
# Self-signed local health probe only. Upstream HTTPS downloads stay verified.
curl -ksS --max-time 5 -o /dev/null -w '%{http_code}\n' https://127.0.0.1/luci-app-speedify/view/index.html
printf 'tailscale_state='
tailscale status --json 2>/dev/null | jq -r '.BackendState // "Unavailable"'
printf '\n%s\n' 'Wi-Fi regulatory state (Mega defaults: US; 6 GHz power type 2/VLP)'
printf 'registered_phys='
find /sys/class/ieee80211 -mindepth 1 -maxdepth 1 -name 'phy*' 2>/dev/null | wc -l
for node in 11280000 11290000 11300000 11310000; do
	printf 'pcie@%s clocks=' "$node"
	tr '\000' ' ' < "/sys/firmware/devicetree/base/soc/pcie@$node/clock-names" 2>/dev/null
	printf '\n'
done
printf '%s\n' 'Pending guarded Wi-Fi defaults (empty means completed)'
for name in 72-zbt-z8803be-wifi 73-zbt-us-wifi-defaults; do
	[ ! -f "/etc/uci-defaults/$name" ] || printf '%s\n' "$name"
done
dmesg | grep -E 'mt7996|Failed to get clk|failed to get clocks' | tail -n 35
for radio in $(uci -q show wireless | sed -nE 's/^wireless\.([^.]+)=wifi-device$/\1/p'); do
	printf 'radio=%s band=%s country=%s country3=%s channel=%s htmode=%s txpower=%s reg_power_type=%s disabled=%s\n' \
		"$radio" "$(uci -q get "wireless.${radio}.band")" \
		"$(uci -q get "wireless.${radio}.country")" \
		"$(uci -q get "wireless.${radio}.country3")" \
		"$(uci -q get "wireless.${radio}.channel")" \
		"$(uci -q get "wireless.${radio}.htmode")" \
		"$(uci -q get "wireless.${radio}.txpower" || printf automatic)" \
		"$(uci -q get "wireless.${radio}.reg_power_type")" \
		"$(uci -q get "wireless.${radio}.disabled")"
done
iw reg get 2>/dev/null || true
printf '\n%s\n' 'MLO representation and LAN bridge state (SSID/MAC output may need redaction)'
for section in $(uci -q show wireless | sed -nE 's/^wireless\.([^.]+)=wifi-iface$/\1/p'); do
	[ "$(uci -q get "wireless.${section}.mlo")" = 1 ] || continue
	set -- $(uci -q get "wireless.${section}.device")
	printf 'section=%s radios=%s device_count=%s network=%s security=%s disabled=%s\n' \
		"$section" "$*" "$#" "$(uci -q get "wireless.${section}.network")" \
		"$(uci -q get "wireless.${section}.encryption")" "$(uci -q get "wireless.${section}.disabled")"
done
iw dev 2>/dev/null || true
bridge link show 2>/dev/null || true
ubus list 'hostapd.*' 2>/dev/null || true
logread 2>/dev/null | grep -Ei 'mld|mlo|AP-ENABLED|too many open files|not supported' | tail -n 120
printf '%s\n' 'mac80211 peer-link objects (two or more link-* entries are required for an active multi-link peer)'
find /sys/kernel/debug/ieee80211 -type d -path '*/stations/*/link-*' -print 2>/dev/null || true
printf '\n%s\n' 'Compare AT registration/band readbacks separately in the selected modem AT Debug tab; do not publish SIM identifiers.'
