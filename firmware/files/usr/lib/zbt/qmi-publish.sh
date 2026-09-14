#!/bin/sh
# Runtime only: no learned IP, gateway, device or DNS is written into UCI.

zbt_qmi_route_cache_file() {
	printf '%s/%s_dir/ipv4-main-route\n' "${MODEM_RUNDIR:-/var/run/qmodem}" "$1"
}

zbt_qmi_cache_ipv4_route() {
	local modem_config="$1" modem_netcard="$2" qmi_ifindex="$3" route address gateway metric file tmp pid
	[ -n "$qmi_ifindex" ] || return 1
	read -r pid 2>/dev/null < "${MODEM_RUNDIR:-/var/run/qmodem}/${modem_config}_dir/$modem_config.pid" || return 1
	case "$pid" in ''|*[!0-9]*|0|1) return 1 ;; esac
	kill -0 "$pid" 2>/dev/null || return 1
	address=$(ip -o -4 addr show dev "$modem_netcard" scope global 2>/dev/null |
		awk '/ inet/ && !/ tentative| dadfailed/ {print $4; exit}')
	[ -n "$address" ] || return 1
	route=$(ip -4 route show table main default dev "$modem_netcard" 2>/dev/null | sed -n '1p')
	[ -n "$route" ] || return 1
	gateway=$(printf '%s\n' "$route" | awk '{for(i=1;i<=NF;i++) if($i=="via") {print $(i+1); exit}}')
	metric=$(printf '%s\n' "$route" | awk '{for(i=1;i<=NF;i++) if($i=="metric") {print $(i+1); exit}}')
	[ -n "$gateway" ] || return 1
	case "$metric" in ''|*[!0-9]*) metric=$(uci -q get "network.$modem_config.metric") ;; esac
	case "$metric" in ''|*[!0-9]*) metric=200; [ "$modem_config" != 2_1 ] || metric=210 ;; esac
	file=$(zbt_qmi_route_cache_file "$modem_config")
	mkdir -p "${file%/*}" || return 1
	tmp="$file.$$"
	printf '%s %s %s %s %s\n' "$pid" "$qmi_ifindex" "$address" "$gateway" "$metric" > "$tmp" || { rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$file"
}

# Repair only a route observed on this exact supervised CM process. PID,
# ifindex and address must all still match. Add, never replace, so recovery
# cannot overwrite a healthy backup WAN default route.
zbt_qmi_restore_ipv4_route() {
	local modem_config="$1" modem_netcard="$2" qmi_ifindex="$3" file cached_pid cached_index cached_address gateway metric current current_pid
	[ -z "$(ip -4 route show table main default dev "$modem_netcard" 2>/dev/null)" ] || return 0
	file=$(zbt_qmi_route_cache_file "$modem_config")
	read -r cached_pid cached_index cached_address gateway metric 2>/dev/null < "$file" || return 1
	case "$cached_pid:$cached_index:$metric" in *[!0-9:]*|:*|*:) return 1 ;; esac
	read -r current_pid 2>/dev/null < "${MODEM_RUNDIR:-/var/run/qmodem}/${modem_config}_dir/$modem_config.pid" || return 1
	[ "$current_pid" = "$cached_pid" ] || return 1
	kill -0 "$current_pid" 2>/dev/null || return 1
	[ "$cached_index" = "$qmi_ifindex" ] || return 1
	current=$(ip -o -4 addr show dev "$modem_netcard" scope global 2>/dev/null |
		awk '/ inet/ && !/ tentative| dadfailed/ {print $4; exit}')
	[ -n "$current" ] && [ "$current" = "$cached_address" ] || return 1
	ip -4 route add default via "$gateway" dev "$modem_netcard" metric "$metric" || return 1
	[ -n "$(ip -4 route show table main default dev "$modem_netcard" 2>/dev/null)" ] || return 1
	logger -t zbt-mwan-reconcile "iface=$modem_config family=4 device=$modem_netcard action=restore_cm_main_route gateway=$gateway metric=$metric result=verified"
}

zbt_qmi_published() {
	# A successful ubus call is not proof that netifd consumed the update.
	# Check the same logical device and source-address data used by MWAN3.
	ubus -t 3 call "network.interface.$interface" status 2>/dev/null |
		jq -e --arg d "$modem_netcard" --arg f "$family" --argjson a "$addresses" '
			.up == true and .l3_device == $d and
			((if $f == "4" then .["ipv4-address"] else .["ipv6-address"] end) // [] |
			map(.address) | . as $published | all($a[]; .ipaddr as $ip | $published | index($ip) != null))' >/dev/null
}
zbt_qmi_publish() {
	local family="$1" interface="$2" addresses routes payload snapshot current qmi_ifindex
	case "$interface:$family" in "$modem_config:4"|"${modem_config}v6:6") ;; *) return 1 ;; esac
	[ "$(uci -q get "network.$interface.modem_config")" = "$modem_config" ] || return 1
	[ "$(uci -q get "network.$interface.proto")" = zbtqmi ] || return 1
	zbt_qmi_owned || return 1
	addresses=$(ip -j -"$family" addr show dev "$modem_netcard" scope global 2>/dev/null | jq -ce '[.[].addr_info[] | select(.scope == "global" and (.tentative // false | not) and (.dadfailed // false | not)) | {ipaddr:.local, mask:(.prefixlen|tostring)}]') || return 1
	[ "$addresses" != '[]' ] || return 1
	routes=$(ip -j -"$family" route show dev "$modem_netcard" table main 2>/dev/null | jq -ce --arg f "$family" '[.[] | select(.dst == "default") | {target:(if $f == "4" then "0.0.0.0" else "::" end), netmask:"0", metric:(.metric // 0)} + (if .gateway then {gateway:.gateway} else {} end)]') || return 1
	[ "$routes" != '[]' ] || return 1
	if [ "$family" = 4 ]; then
		qmi_ifindex=$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)
		zbt_qmi_cache_ipv4_route "$modem_config" "$modem_netcard" "$qmi_ifindex" || true
	fi
	payload=$(jq -cn --arg d "$modem_netcard" --arg f "$family" --argjson a "$addresses" --argjson r "$routes" '{action:0,ifname:$d,"link-up":true,"address-external":true} + (if $f=="4" then {"ipaddr":$a,routes:$r} else {"ip6addr":$a,routes6:$r} end)') || return 1
	snapshot=$(printf '%s' "$payload" | sha256sum | cut -d' ' -f1)
	eval "current=\${qmi_published$family:-}"
	# A netifd reload needs a new update even if the modem retained its IP.
	# The independent health reconciler repairs missing publication only. It
	# has no session-local snapshot and must not emit an ifupdate every poll.
	if [ "${3:-}" = repair ] && zbt_qmi_published; then return 0; fi
	if [ "$snapshot" != "$current" ] || ! zbt_qmi_published; then
		zbt_qmi_owned || return 1
		ubus -t 5 call "network.interface.$interface" notify_proto "$payload" >/dev/null 2>&1 || return 1
		zbt_qmi_published || return 1
		eval "qmi_published$family=\$snapshot"
		[ "${3:-}" != repair ] || logger -t zbt-mwan-reconcile "iface=$interface family=$family device=$modem_netcard action=publish_existing_cm_address result=verified"
	fi
	return 0
}

# Prove that the address belongs to the currently supervised CM process. Route
# ownership is checked separately so the reconciler can safely restore a route
# that netifd removed after a successful CM setup.
zbt_qmi_session_owned() {
	local modem_config="$1" family="$2" modem_netcard="$3" qmi_ifindex="$4"
	local pid arg previous='' seen_cm=0 seen_device=0 rundir
	case "$modem_config:$family" in 4_1:4|4_1:6|2_1:4|2_1:6) ;; *) return 1 ;; esac
	[ "$(uci -q get qmodem.main.enable_dial)" = 1 ] || return 1
	[ "$(uci -q get "qmodem.$modem_config.enable_dial")" = 1 ] || return 1
	[ "$(uci -q get "qmodem.$modem_config.en_bridge")" != 1 ] || return 1
	[ "$(zbt_netdev "$modem_config")" = "$modem_netcard" ] || return 1
	[ "$(cat "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/ifindex" 2>/dev/null)" = "$qmi_ifindex" ] || return 1
	[ ! -e "${ZBT_SYSFS:-/sys}/class/net/$modem_netcard/master" ] || return 1
	rundir=${MODEM_RUNDIR:-/var/run/qmodem}
	read -r pid 2>/dev/null < "$rundir/${modem_config}_dir/$modem_config.pid" || return 1
	case "$pid" in ''|*[!0-9]*|0|1) return 1 ;; esac
	kill -0 "$pid" 2>/dev/null || return 1
	[ -r "/proc/$pid/cmdline" ] || return 1
	while IFS= read -r arg; do
		case "$arg" in quectel-CM|*/quectel-CM|quectel-CM-M|*/quectel-CM-M) seen_cm=1 ;; esac
		[ "$previous" != -i ] || [ "$arg" != "$modem_netcard" ] || seen_device=1
		previous=$arg
	done <<EOCMD
$(tr '\000' '\n' < "/proc/$pid/cmdline")
EOCMD
	[ "$seen_cm" = 1 ] && [ "$seen_device" = 1 ] || return 1
	ip -o -"$family" addr show dev "$modem_netcard" scope global 2>/dev/null |
		awk '/ inet/ && !/ tentative| dadfailed/ {found=1} END {exit !found}'
}

zbt_qmi_session_active() {
	zbt_qmi_session_owned "$@" || return 1
	[ -n "$(ip -"$2" route show table main default dev "$3" 2>/dev/null)" ]
}

# Repair only the generated netifd identity for a proven, currently supervised
# CM session. In particular, option disabled '1' makes netifd omit the UCI
# interface object completely; requiring that object before repair is circular.
zbt_qmi_repair_netifd_config() {
	local interface="$1" family="$2" modem_config="$3" modem_netcard="$4"
	local proto changed=0 metric option
	case "$interface:$family:$modem_config" in
		4_1:4:4_1|4_1v6:6:4_1|2_1:4:2_1|2_1v6:6:2_1) ;;
		*) return 1 ;;
	esac
	proto=$(uci -q get "network.$interface.proto")
	case "$proto" in
		zbtqmi|none) ;;
		'')
			uci -q set "network.$interface=interface"
			uci -q set "network.$interface.proto=zbtqmi"
			proto=zbtqmi
			changed=1
			;;
		*) return 1 ;;
	esac
	if [ "$(uci -q get "network.$interface.modem_config")" != "$modem_config" ]; then
		uci -q set "network.$interface.modem_config=$modem_config"
		changed=1
	fi
	for option in device ifname; do
		if [ "$(uci -q get "network.$interface.$option")" != "$modem_netcard" ]; then
			uci -q set "network.$interface.$option=$modem_netcard"
			changed=1
		fi
	done
	if [ "$(uci -q get "network.$interface.auto")" != 1 ]; then
		uci -q set "network.$interface.auto=1"
		changed=1
	fi
	# Delete both retained disabled=1 and legacy disabled=0. Absence is the
	# canonical netifd representation for an enabled generated interface.
	if uci -q get "network.$interface.disabled" >/dev/null 2>&1; then
		uci -q delete "network.$interface.disabled"
		changed=1
	fi
	metric=$(uci -q get "network.$interface.metric")
	if [ -z "$metric" ]; then
		metric=200; [ "$modem_config" != 2_1 ] || metric=210
		uci -q set "network.$interface.metric=$metric"
		changed=1
	fi
	ZBT_QMI_CONFIG_REPAIRED=$changed
	[ "$changed" = 1 ] || return 0
	uci -q commit network || return 1
	ubus -t 15 call network reload >/dev/null 2>&1 || return 1
	logger -t zbt-mwan-reconcile "iface=$interface family=$family device=$modem_netcard evidence=supervised_cm_address_route action=clear_stale_netifd_disabled result=committed"
}

# Re-publish an already working CM data path after a missed netifd update.
# Never start a QModem-disabled interface or touch modem/radio settings.
zbt_qmi_reconcile_publication() (
	local modem_config="$1" family="$2" modem_netcard="$3" qmi_ifindex="$4" interface status proto attempt
	interface=$modem_config
	[ "$family" != 6 ] || interface=${modem_config}v6
	# Pre-lock checks are read-only. The route repair itself is a mutation and
	# must happen only while holding the shared QMI/netifd lock.
	zbt_qmi_session_owned "$modem_config" "$family" "$modem_netcard" "$qmi_ifindex" || return 1
	exec 1002>/var/lock/zbt-qmi-netifd.lock
	flock -w 10 1002 || return 1
	# Recheck ownership after waiting for the dialer's shared lock. Only that
	# exact live session may authorize route or netifd repair.
	zbt_qmi_session_owned "$modem_config" "$family" "$modem_netcard" "$qmi_ifindex" || return 1
	if [ "$family" = 4 ]; then
		zbt_qmi_restore_ipv4_route "$modem_config" "$modem_netcard" "$qmi_ifindex" || return 1
	fi
	zbt_qmi_session_active "$modem_config" "$family" "$modem_netcard" "$qmi_ifindex" || return 1
	ZBT_QMI_CONFIG_REPAIRED=0
	zbt_qmi_repair_netifd_config "$interface" "$family" "$modem_config" "$modem_netcard" || return 1
	proto=$(uci -q get "network.$interface.proto")
	zbt_qmi_owned() {
		zbt_qmi_session_active "$modem_config" "$family" "$modem_netcard" "$qmi_ifindex"
	}
	zbt_qmi_owned || return 1
	# QModem's enabled data session, not netifd's stale autostart bit, is the
	# administrative authority for these generated logical interfaces. The
	# stock ifup helper performs a global reload before a targeted up and can
	# leave one of two concurrent modems down while its CM path keeps working.
	status=$(ubus -t 3 call "network.interface.$interface" status 2>/dev/null || true)
	if ! printf '%s' "$status" | jq -e '.available == true and .autostart == true and (.up == true or .pending == true)' >/dev/null; then
		[ "$(uci -q get qmodem.main.enable_dial)" = 1 ] || return 1
		[ "$(uci -q get "qmodem.$modem_config.enable_dial")" = 1 ] || return 1
		[ "$(uci -q get "qmodem.$modem_config.en_bridge")" != 1 ] || return 1
		# A reload that just introduced a formerly disabled section can take a
		# moment to register its ubus object. Bound the wait; periodic reconcile
		# will retry without altering WAN state if netifd remains unavailable.
		for attempt in 1 2 3 4 5; do
			ubus -t 5 call network.interface up "{\"interface\":\"$interface\"}" >/dev/null 2>&1 || true
			status=$(ubus -t 3 call "network.interface.$interface" status 2>/dev/null || true)
			printf '%s' "$status" | jq -e '.available == true and .autostart == true and (.up == true or .pending == true)' >/dev/null && break
			sleep 1
		done
		printf '%s' "$status" | jq -e '.available == true and .autostart == true and (.up == true or .pending == true)' >/dev/null || return 1
		logger -t zbt-mwan-reconcile "iface=$interface family=$family device=$modem_netcard evidence=supervised_cm_address_route action=rearm_generated_interface result=verified"
	fi
	# Older settings-preserving installs used proto=none with CM owning the
	# address. Re-arming that exact interface is sufficient for MWAN; it has no
	# protocol handler to receive external-address publication.
	if [ "$proto" = none ]; then
		if printf '%s' "$status" | jq -e --arg d "$modem_netcard" '.up == true and (.l3_device == $d or .device == $d)' >/dev/null; then
			return 2
		fi
		return 1
	fi
	zbt_qmi_publish "$family" "$interface" repair
)
