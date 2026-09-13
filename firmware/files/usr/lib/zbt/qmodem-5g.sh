#!/bin/sh
# Shared by the Mega RPC and boot policy. Never changes a band mask, APN,
# SIM, cell lock or routing metric. All writes require valid prior readback.
zbt_5g_value() {
	case "$1" in auto_adaptive|auto_preferred|auto) echo 0 ;; nsa) echo 1 ;; sa) echo 2 ;; *) return 1 ;; esac
}

zbt_5g_deployment_name() {
	case "$1" in 0) echo auto ;; 1) echo nsa ;; 2) echo sa ;; *) return 1 ;; esac
}

zbt_5g_policy() {
	local policy
	policy=$(uci -q get "qmodem.$config_section.zbt_5g_policy")
	case "$policy" in auto|nsa|sa) ;; *) policy=auto_adaptive ;; esac
	printf '%s\n' "$policy"
}

zbt_remember_5g_policy() {
	uci -q set "qmodem.$config_section.zbt_5g_policy=$1" && uci -q commit qmodem
}

zbt_5g_parse() {
	printf '%s\n' "$1" | tr -d '\r' | awk -v key="$2" '
		/^[[:space:]]*OK[[:space:]]*$/ { ok=1 }
		/^[[:space:]]*(ERROR|\+CM[ES] ERROR:|NO CARRIER)/ { bad=1 }
		/^[[:space:]]*\+QNWPREFCFG:/ {
			line=$0; sub(/^[[:space:]]*\+QNWPREFCFG:[[:space:]]*/, "", line)
			n=split(line, fields, ",")
			gsub(/[[:space:]"]/, "", fields[1]); gsub(/[[:space:]"]/, "", fields[2])
			if (tolower(fields[1]) == key) { count++; value=fields[2]; if (n!=2) bad=1 }
		}
		END {
			if (!ok || bad || count!=1) exit 1
			if (key=="nr5g_disable_mode" && value !~ /^[012]$/) exit 1
			if (key=="mode_pref" && value !~ /^(AUTO|LTE|NR5G|WCDMA|LTE:NR5G|NR5G:LTE|WCDMA:LTE|WCDMA:NR5G|WCDMA:LTE:NR5G)$/) exit 1
			print value
		}'
}

zbt_5g_read() {
	local key="$1" attempt options='-t 5'
	zbt_5g_reply=''; zbt_5g_read_value=''
	# Query failures are not capability detection. Retrying is read-only and
	# uses QModem's configured AT transport, including its serialized ubus path.
	for attempt in 1 2; do
		zbt_5g_reply=$(at "$at_port" "AT+QNWPREFCFG=\"$key\"" 2>/dev/null)
		if zbt_5g_read_value=$(zbt_5g_parse "$zbt_5g_reply" "$key"); then return 0; fi
	done
	return 1
}

zbt_5g_write() {
	local key="$1" value="$2" response options='-t 5'
	response=$(at "$at_port" "AT+QNWPREFCFG=\"$key\",$value" 2>/dev/null) || return 1
	printf '%s\n' "$response" | grep -Eq '^[[:space:]]*(ERROR|\+CM[ES] ERROR:|NO CARRIER)' && return 1
	printf '%s\n' "$response" | grep -q '^[[:space:]]*OK[[:space:]]*$' || return 1
	zbt_5g_read "$key" && [ "$zbt_5g_read_value" = "$value" ]
}

zbt_5g_vendor() {
	# The pinned router BusyBox omits tr character classes. In that build,
	# tr '[:upper:]' '[:lower:]' turns Quectel into qlectel and blocks reads.
	case "$manufacturer" in
		*[Qq][Uu][Ee][Cc][Tt][Ee][Ll]*) return 0 ;;
		*) return 1 ;;
	esac
}

zbt_5g_target() {
	. /usr/lib/zbt/dual-modem.sh
	case "$config_section" in 4_1|2_1) ;; *) return 1 ;; esac
	zbt_5g_vendor && [ -c "$at_port" ] && zbt_port_matches "$config_section" "$at_port"
}

zbt_5g_apply() {
	local requested="$1" desired old_mode old_rat target_rat rat_changed=0
	zbt_5g_changed=0
	zbt_5g_message='Unable to read the modem settings; no change was made. Retry after the modem has finished connecting.'
	desired=$(zbt_5g_value "$requested") || return 1
	zbt_5g_target && zbt_5g_read nr5g_disable_mode || return 1
	old_mode=$zbt_5g_read_value
	zbt_5g_read mode_pref || return 1
	old_rat=$zbt_5g_read_value; target_rat=$old_rat
	case "$requested" in
		nsa) target_rat=LTE:NR5G ;;
		*) target_rat=AUTO ;;
	esac
	# Enable a compatible RAT before selecting NSA: disabling SA on a modem
	# restricted to NR5G alone otherwise leaves no LTE anchor for data service.
	if [ "$old_rat" != "$target_rat" ]; then
		rat_changed=1
		zbt_5g_write mode_pref "$target_rat" || {
			zbt_5g_message='Network-mode change was not verified.'
			if zbt_5g_write mode_pref "$old_rat"; then
				zbt_5g_message="$zbt_5g_message Previous network mode restored."
			else
				zbt_5g_message="$zbt_5g_message Restore was not verified; read the modem settings again before retrying."
			fi
			return 1
		}
	fi
	if [ "$old_mode" != "$desired" ] && ! zbt_5g_write nr5g_disable_mode "$desired"; then
		zbt_5g_message='5G mode change was not verified.'
		if zbt_5g_write nr5g_disable_mode "$old_mode" &&
		   { [ "$rat_changed" = 0 ] || zbt_5g_write mode_pref "$old_rat"; }; then
			zbt_5g_message="$zbt_5g_message Previous settings restored."
		else
			zbt_5g_message="$zbt_5g_message Restore was not verified; read the modem settings again before retrying."
		fi
		return 1
	fi
	[ "$old_mode:$old_rat" = "$desired:$target_rat" ] || zbt_5g_changed=1
	zbt_5g_message='Settings verified. Band masks unchanged. Allow the data connection to reconnect.'
	[ "$zbt_5g_changed" != 0 ] || zbt_5g_message='Settings already active; no modem write was needed.'
	return 0
}

zbt_get_5g_deployment() {
	local mode rat='Unknown' diagnostic='' status=0 device data_state='Modem data interface not found.'
	. /usr/lib/zbt/dual-modem.sh
	if device=$(zbt_netdev "$config_section"); then
		if ip -o -4 addr show dev "$device" scope global 2>/dev/null | grep -q ' inet '; then
			data_state='IPv4 data address assigned. MultiWAN reachability checks determine whether this connection is online.'
		else
			data_state='No IPv4 data address on this modem. Radio signal alone does not mean Internet access; a per-modem IPv4 speed test cannot run yet. Check Network Configuration and the dial log.'
		fi
	fi
	if zbt_5g_target && zbt_5g_read nr5g_disable_mode; then
		mode=$(zbt_5g_deployment_name "$zbt_5g_read_value"); status=1
		if zbt_5g_read mode_pref; then rat=$zbt_5g_read_value; fi
	else
		diagnostic=$(printf '%s' "$zbt_5g_reply" | tr -d '\r' | head -c 512)
	fi
	json_init; json_add_object deployment
	json_add_string supported "$status"
	json_add_string policy "$(zbt_5g_policy)"
	json_add_string mode "$mode"
	json_add_string network_mode "$rat"
	json_add_string data_state "$data_state"
	case "$config_section" in
		4_1|2_1) json_add_string adaptive_status "$(head -c 1024 "/tmp/zbt-5g/$config_section/status" 2>/dev/null)" ;;
	esac
	json_add_string read_response "$diagnostic"
	json_add_string message 'Could not read the 5G setting. This is not proof that the modem lacks support. Check its AT connection and retry.'
	json_close_object; json_dump
}

zbt_set_5g_deployment() {
	local requested="$1" status=0
	. /usr/lib/zbt/5g-state.sh
	[ "$requested" != auto_preferred ] || requested=auto_adaptive
	zbt_5g_message='Automatic comparison is in progress. Retry after it finishes; no setting was changed.'
	if zbt_5g_lock; then
	if zbt_5g_apply "$requested"; then
		if zbt_remember_5g_policy "$requested"; then status=1
			rm -f "$zbt_5g_dir/verified" "$zbt_5g_dir/rollback" "$zbt_5g_dir/maintenance"
			printf '%s\n' 'Policy saved; waiting for a stable, idle Internet connection.' > "$zbt_5g_dir/status"
		else zbt_5g_message='Modem settings verified, but the policy could not be saved. Read the current settings before retrying.'; fi
	fi
	zbt_5g_unlock
	fi
	json_init; json_add_object result
	json_add_string status "$status"
	json_add_string mode "$requested"
	json_add_string changed "$zbt_5g_changed"
	json_add_string message "$zbt_5g_message"
	json_close_object; json_dump
}
