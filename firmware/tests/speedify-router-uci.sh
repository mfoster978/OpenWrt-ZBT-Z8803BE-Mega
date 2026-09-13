#!/bin/sh
# Exercise the actual ARM64 UCI from a built image against temporary configs.
# No router access, real account, host firewall or modem is used.
set -eu
: "${MEGA_TEST_ROOTFS:?extracted image required}"
: "${MEGA_TEST_REPO:?repository required}"
sf_fixture=$(mktemp -d)
trap 'rm -rf "$sf_fixture"' EXIT
mkdir "$sf_fixture/config" "$sf_fixture/delta"
uci() { qemu-aarch64 -L "$MEGA_TEST_ROOTFS" "$MEGA_TEST_ROOTFS/sbin/uci" -c "$sf_fixture/config" -t "$sf_fixture/delta" "$@"; }
uci import network <<'CONF'
config interface 'speedify'
	option proto 'none'
	option device 'connectify0'
config interface '4_1'
	option metric '200'
config interface '2_1'
	option metric '210'
CONF
uci import firewall <<'CONF'
config defaults
	option flow_offloading '1'
	option flow_offloading_hw '1'
config zone 'local'
	option name 'lan'
	list network 'lan'
	list device 'br-lan'
	list device 'connectify0'
config zone
	option name 'wan'
	list network '4_1'
	list network '2_1'
	list network 'speedify'
	list device 'connectify0'
config zone
	option name 'speedify'
	list network 'speedify'
	list device 'connectify0'
config zone
	option name 'speedify'
	list network 'speedify'
	list device 'connectify0'
config forwarding
	option src 'lan'
	option dest 'speedify'
config forwarding
	option src 'lan'
	option dest 'speedify'
config forwarding
	option src 'speedify'
	option dest 'lan'
config forwarding
	option src 'lan'
	option dest 'wan'
CONF
uci commit network
uci commit firewall
. "$MEGA_TEST_REPO/firmware/files/usr/lib/zbt/speedify-routing.sh"
sf_log() { :; }
sf_reloads=0
sf_firewall_reload() { sf_reloads=$((sf_reloads + 1)); }
sf_repair_firewall
first=$(uci export firewall)
[ "$sf_reloads" = 1 ]
sf_repair_firewall
[ "$sf_reloads" = 1 ]
[ "$first" = "$(uci export firewall)" ]
[ "$(uci get network.4_1.metric)" = 200 ]
[ "$(uci get network.2_1.metric)" = 210 ]
[ "$(uci get firewall.local.device)" = br-lan ]
zones=0; forwards=0
for section in $(sf_sections firewall zone); do
	case "$(sf_get "firewall.$section.name")" in
		speedify)
			zones=$((zones+1))
			[ "$(sf_get "firewall.$section.network")" = speedify ]
			[ "$(sf_get "firewall.$section.masq")" = 1 ]
			[ "$(sf_get "firewall.$section.mtu_fix")" = 1 ]
			[ "$(sf_get "firewall.$section.input")" = REJECT ] ;;
		wan) [ "$(sf_get "firewall.$section.network")" = '4_1 2_1' ] ;;
	esac
done
for section in $(sf_sections firewall forwarding); do
	case "$(sf_get "firewall.$section.src"):$(sf_get "firewall.$section.dest")" in
		lan:speedify) forwards=$((forwards+1)) ;;
		speedify:lan) exit 1 ;;
	esac
done
[ "$zones:$forwards" = 1:1 ]
sf_disable_offload
[ "$(uci get 'firewall.@defaults[0].flow_offloading')" = 0 ]
[ "$(uci get 'firewall.@defaults[0].flow_offloading_hw')" = 0 ]
uci set firewall.local.input=DROP
if sf_repair_firewall; then echo 'committed a pending administrator edit' >&2; exit 1; fi
[ -n "$(uci changes firewall)" ]
printf 'PASS: actual router UCI: anonymous/named zone repair, idempotency, NAT, forwarding, preserved metrics and pending-edit protection\n'
