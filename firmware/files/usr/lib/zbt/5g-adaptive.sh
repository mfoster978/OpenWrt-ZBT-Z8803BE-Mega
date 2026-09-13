#!/bin/sh
# Guarded per-modem SA/NSA trials. Policy is persistent; a learned selection
# is a RAM hint only. The modem/network still chooses cells and enabled bands.
zbt_adaptive_status() { printf '%s\n' "$*" > "$zbt_5g_dir/status"; }
zbt_adaptive_enabled() {
	[ "$(zbt_5g_policy)" = auto_adaptive ] &&
	[ "$(uci -q get "qmodem.$config_section.zbt_5g_adaptive_opt_in")" = 1 ] &&
	[ "$(uci -q get qmodem.main.enable_dial)" = 1 ] &&
	[ "$(uci -q get "qmodem.$config_section.enable_dial")" = 1 ] &&
	[ "$(uci -q get "qmodem.$config_section.state")" = enabled ] &&
	[ "$(uci -q get "qmodem.$config_section.en_bridge")" != 1 ]
}
zbt_adaptive_capable() {
	local options='-t 5'
	# Query support, not the mutable band masks. Unreadable is deferred, never
	# proof of unsupported hardware and never permission for a speculative write.
	at "$at_port" 'AT+QNWPREFCFG=?' 2>/dev/null | tr -d '\r' | awk '
		/^[[:space:]]*OK[[:space:]]*$/ {ok=1}
		/ERROR/ {bad=1}
		/\+QNWPREFCFG:.*"nr5g_disable_mode"/ {
			gsub(/[[:space:]]/,"")
			if($0 ~ /\(0,1,2\)$/ || $0 ~ /\(0-2\)$/) modes=1
		}
		END {exit !(ok && !bad && modes)}'
}
zbt_adaptive_serving_parse() {
	# Only retain deployment and signal, never subscriber/cell identifiers.
	printf '%s\n' "$1" | tr -d '\r' | awk -F, '
		/^[[:space:]]*OK[[:space:]]*$/ {ok=1}
		/ERROR|SEARCH|LIMSRV/ {bad=1}
		/^[[:space:]]*\+QENG:/ {
			for(i=1;i<=NF;i++) gsub(/[[:space:]"]/,"",$i)
			if($1=="+QENG:servingcell" && ($2=="NOCONN" || $2=="CONNECT")) registered=1
			if($3=="NR5G-SA" && NF>=16) {mode="sa"; rsrp=$13; sinr=$15; count++}
			if($1=="+QENG:NR5G-NSA" && NF>=10) {mode="nsa"; rsrp=$5; sinr=$6; count++}
		}
		END {
			if(!ok || bad || !registered || count!=1 || rsrp !~ /^-[0-9]+$/ ||
				sinr !~ /^-?[0-9]+$/ || rsrp+0 < -150 || rsrp+0 > -30 || sinr+0 < -30 || sinr+0 > 50) exit 1
			print mode,rsrp,sinr
		}'
}
zbt_adaptive_serving() {
	local options='-t 5'
	zbt_adaptive_serving_parse "$(at "$at_port" 'AT+QENG="servingcell"' 2>/dev/null)"
}
zbt_adaptive_device() {
	local current
	current=$(zbt_netdev "$config_section") || return 1
	[ "$current" = "$adaptive_device" ] &&
	[ "$(cat "/sys/class/net/$current/ifindex" 2>/dev/null)" = "$adaptive_index" ] &&
	zbt_port_matches "$config_section" "$at_port" &&
	[ ! -e "/sys/class/net/$current/master" ]
}
zbt_adaptive_address() {
	zbt_adaptive_device || return 1
	ip -o -4 addr show dev "$adaptive_device" scope global 2>/dev/null | awk '/ inet / {print $4; exit}' | grep .
}
zbt_adaptive_probe() {
	local code
	zbt_adaptive_address >/dev/null || return 1
	code=$(zbt_adaptive_exec curl -4 -sS --noproxy '*' --interface "if!$adaptive_device" --connect-timeout 5 --max-time 10 \
		-o /dev/null -w '%{http_code}' https://www.gstatic.com/generate_204 2>/dev/null) || return 1
	[ "$code" = 204 ]
}
zbt_adaptive_recovery_stable() {
	# Never begin a radio-mode comparison immediately after a dial/QMI failure.
	# The central watchdog records consecutive direct-health successes in RAM;
	# require roughly two quiet minutes at the default interval before touching
	# SA/NSA.  Missing/corrupt recovery state fails closed and changes nothing.
	local fails good last attempts window cycles oldrx oldindex
	[ ! -f "/tmp/modem-watchdog/$config_section.qmi-lost" ] || return 1
	[ ! -f "/tmp/modem-watchdog/$config_section.recovering" ] || return 1
	read -r fails good last attempts window cycles oldrx oldindex 2>/dev/null < "/tmp/modem-watchdog/$config_section.state" || return 1
	case "$fails:$good" in *[!0-9:]*|:*|*:) return 1 ;; esac
	[ "$fails" = 0 ] && [ "$good" -ge 6 ]
}
zbt_adaptive_exec() {
	# Set MWAN3's bypass socket mark as well as binding the physical device.
	# A custom OUTPUT policy must not send a trial over the backup modem.
	/usr/sbin/mwan3 use "$config_section" "$@"
}
zbt_adaptive_backup() {
	local interface
	for interface in wan_sfp wan usb_tether 4_1 2_1; do
		[ "$interface" = "$config_section" ] && continue
		zbt_mwan_online "$interface" && /usr/sbin/zbt-mwan-standby-ready "$interface" && return 0
	done
	return 1
}
zbt_adaptive_trial_safe() {
	zbt_adaptive_backup || return 1
	# If the tested modem carries IPv6, require a verified IPv6 alternative
	# too; IPv4 backup alone cannot protect IPv6 clients during a radio reset.
	[ "${adaptive_ipv6:-0}" != 1 ] && return 0
	local interface
	for interface in wan_sfp6 wan6 usb_tether6 4_1v6 2_1v6; do
		[ "$interface" = "${config_section}v6" ] && continue
		zbt_mwan_online "$interface" && /usr/sbin/zbt-mwan-standby-ready "$interface" && return 0
	done
	return 1
}
zbt_adaptive_bytes() {
	local rx tx
	rx=$(cat "/sys/class/net/$adaptive_device/statistics/rx_bytes") || return 1
	tx=$(cat "/sys/class/net/$adaptive_device/statistics/tx_bytes") || return 1
	printf '%s\n' "$((rx + tx))"
}
zbt_adaptive_idle() {
	local before after
	zbt_adaptive_trial_safe && zbt_adaptive_device || return 1
	before=$(zbt_adaptive_bytes) || return 1
	sleep 15
	after=$(zbt_adaptive_bytes) || return 1
	# About 4 KiB/s permits tracker chatter, not a stream or speed test.
	[ "$after" -ge "$before" ] && [ $((after - before)) -le 65536 ] &&
	zbt_adaptive_trial_safe && zbt_adaptive_enabled && zbt_speed_renew
}
zbt_adaptive_wait_data() {
	local expected="$1" n=0 good=0 serving
	while [ "$n" -lt 12 ]; do
		zbt_speed_renew && zbt_adaptive_device || return 1
		[ "$expected" = any ] || { zbt_adaptive_enabled && zbt_adaptive_trial_safe; } || return 1
		# A data request can wake an idle NSA connection. Do not gate the
		# request itself on a pre-transfer NR reading. It still takes two valid
		# post-probe deployment + reachability results to verify the candidate.
		serving=''
		if zbt_adaptive_probe; then
			serving=$(zbt_adaptive_serving) || serving=''
			if [ "$expected" = any ] || [ "${serving%% *}" = "$expected" ]; then
			good=$((good + 1)); [ "$good" -lt 2 ] || return 0
			else good=0; fi
		else good=0; fi
		sleep 5; n=$((n + 1))
	done
	return 1
}
zbt_adaptive_resume() {
	local n=0
	# Resume only the selected tracker. This does not change netifd devices,
	# WAN metrics, policies or either modem's band lists.
	rm -f "$zbt_5g_dir/maintenance"
	/usr/sbin/mwan3 ifup "$config_section" >/dev/null 2>&1 || return 1
	if [ "$(uci -q get "mwan3.${config_section}v6.enabled")" = 1 ]; then
		/usr/sbin/mwan3 ifup "${config_section}v6" >/dev/null 2>&1 || true
	fi
	while [ "$n" -lt 12 ]; do
		zbt_speed_renew || return 1
		zbt_mwan_online "$config_section" && return 0
		sleep 5; n=$((n + 1))
	done
	return 1
}
zbt_adaptive_scores() {
	# Three stable samples; a fast outlier is not a performance improvement.
	jq -er 'if length == 3 and all(.[]; type == "number" and . > 0 and . < 10000) and
		(max <= min * 1.5) then [min,max,(add/3)] | @tsv else error("unstable samples") end' "$1"
}
zbt_adaptive_better() {
	# Every candidate sample must beat every baseline sample by at least 15%.
	awk -v baseline="$1" -v candidate="$2" 'BEGIN {exit !(candidate >= baseline * 1.15)}'
}
zbt_adaptive_samples() {
	local mode="$1" output="$2" n serving result speed address before after
	printf '[]\n' > "$output"
	for n in 1 2 3; do
		zbt_adaptive_enabled && zbt_speed_renew && zbt_adaptive_sample_ready || return 1
		address=$(zbt_adaptive_address) || return 1
		serving=$(zbt_adaptive_serving) || return 1
		[ "${serving%% *}" = "$mode" ] || return 1
		before=$(zbt_adaptive_bytes) || return 1
		result=$(zbt_adaptive_exec /usr/sbin/zbt-speed-sample "$config_section" download) || return 1
		after=$(zbt_adaptive_bytes) || return 1
		# Reject samples contaminated by other traffic, device/address changes,
		# a lost tracker, LTE fallback or a different deployment mid-transfer.
		[ "$after" -ge "$before" ] && [ $((after - before)) -le 28000000 ] || return 1
		[ "$(zbt_adaptive_address)" = "$address" ] && zbt_adaptive_sample_ready || return 1
		serving=$(zbt_adaptive_serving) || return 1
		[ "${serving%% *}" = "$mode" ] || return 1
		speed=$(printf '%s' "$result" | jq -er --arg d "$adaptive_device" --arg s "$config_section" \
			'select(.ok == true and .device == $d and .interface == $s) | .download_mbps | select(type == "number" and . > 0)') || return 1
		jq --argjson value "$speed" '. + [$value]' "$output" > "$output.new" && mv "$output.new" "$output" || return 1
		sleep 3
	done
	zbt_adaptive_scores "$output" >/dev/null
}
zbt_adaptive_sample_ready() {
	zbt_adaptive_trial_safe || return 1
	if [ -f "$zbt_5g_dir/maintenance" ]; then
		# The candidate must remain excluded from forwarded client traffic.
		[ "$(cat "/var/run/mwan3/iface_state/$config_section" 2>/dev/null)" = offline ]
	else
		zbt_mwan_online "$config_section"
	fi
}
zbt_adaptive_reserve() {
	local now start=0 last=0 used=0 budget usage
	now=$(date +%s)
	[ "$now" -ge 1700000000 ] || return 1
	budget=$(uci -q get "qmodem.$config_section.zbt_5g_daily_mb")
	case "$budget" in 0|150|300) ;; *) budget=300 ;; esac
	mkdir -p "${ZBT_5G_USAGE:-/etc/zbt}"
	usage="${ZBT_5G_USAGE:-/etc/zbt}/5g-adaptive-$config_section.json"
	if [ -f "$usage" ]; then
		# Corrupt accounting fails closed; never silently grant more test data.
		read -r start last used <<EOF
$(jq -er '[.window_start,.last_evaluation,.reserved_mb] | if all(.[]; type=="number" and floor==. and .>=0) then @tsv else error("bad accounting") end' "$usage")
EOF
		case "$start:$last:$used" in *[!0-9:]*|:*|*::*|*:) return 1 ;; esac
	fi
	[ "$now" -ge "$last" ] && [ $((now - last)) -ge 3600 ] || return 1
	if [ $((now - start)) -ge 86400 ]; then start=$now; used=0; fi
	[ $((used + 150)) -le "$budget" ] || return 1
	# Reserve the complete six-download round before the first byte. Failures
	# consume the reservation too. At most two rounds/four mode transitions
	# per 24h by default, and at most one round per hour, across reboots.
	jq -n --argjson start "$start" --argjson now "$now" --argjson used "$((used + 150))" \
		'{window_start:$start,last_evaluation:$now,reserved_mb:$used}' > "$usage.new" && mv "$usage.new" "$usage"
}
zbt_adaptive_restore() {
	local restore policy
	[ -f "$zbt_5g_dir/rollback" ] || return 0
	read -r restore < "$zbt_5g_dir/rollback"
	case "$restore" in auto|nsa|sa) ;; *) restore=auto ;; esac
	policy=$(zbt_5g_policy)
	case "$policy" in auto|nsa|sa) restore=$policy ;; esac
	zbt_adaptive_status 'Restoring the last verified connection after a trial.'
	if zbt_5g_apply "$restore" && zbt_adaptive_wait_data any && zbt_adaptive_resume; then
		printf '%s\n' "$restore" > "$zbt_5g_dir/verified"
		rm -f "$zbt_5g_dir/rollback" "$zbt_5g_dir/maintenance"
		return 0
	fi
	# Coverage may have changed. Fall back to modem/network automatic without
	# silently marking the connection verified. Retry recovery next iteration.
	# An explicit policy changed outside LuCI while testing takes precedence.
	if [ "$policy" = auto_adaptive ]; then
		# Retry automatic from now on, not NSA/SA -> AUTO on every loop when
		# the carrier has lost coverage. Readback still prevents redundant writes.
		printf '%s\n' auto > "$zbt_5g_dir/rollback"
		zbt_speed_renew && zbt_5g_apply auto || true
	fi
	zbt_adaptive_resume || true
	zbt_adaptive_status 'Recovery is not yet verified. Automatic network selection requested; retrying recovery, no further trials.'
	return 1
}
zbt_adaptive_round() {
	local serving baseline_mode candidate baseline_max candidate_min scores previous
	adaptive_ipv6=0
	if ip -o -6 addr show dev "$adaptive_device" scope global 2>/dev/null | grep -q ' inet6 '; then adaptive_ipv6=1; fi
	zbt_adaptive_enabled && zbt_adaptive_recovery_stable && zbt_mwan_online "$config_section" && zbt_adaptive_probe || {
		zbt_adaptive_status 'Waiting for this modem to remain stable after dialing, with verified IPv4 Internet and an online MultiWAN tracker.'; return 1;
	}
	serving=$(zbt_adaptive_serving) || {
		zbt_adaptive_status 'Waiting for a valid registered SA/NSA serving cell and signal reading; LTE-only or unknown is not a comparison.'; return 1;
	}
	baseline_mode=${serving%% *}
	zbt_adaptive_capable || {
		zbt_adaptive_status 'Could not verify SA/NSA selector capabilities. Automatic network selection remains unchanged; retrying later.'; return 1;
	}
	previous=$(zbt_5g_hint)
	# Read support and ensure the observed starting settings match the runtime
	# hint. External/manual AT changes must not become an implicit baseline.
	zbt_5g_read nr5g_disable_mode && [ "$zbt_5g_read_value" = "$(zbt_5g_value "$previous")" ] || return 1
	zbt_5g_read mode_pref || return 1
	case "$previous:$zbt_5g_read_value" in auto:AUTO|sa:AUTO|nsa:LTE:NR5G) ;; *) return 1 ;; esac
	zbt_adaptive_status 'Waiting for an idle modem and another online WAN before comparing SA/NSA.'
	zbt_adaptive_idle || return 1
	zbt_adaptive_reserve || {
		zbt_adaptive_status 'Waiting for the hourly test limit or daily data budget (default 300 MB; 150 MB reserved per comparison).'; return 1;
	}
	# Readiness is retried every service pass. Only an actual reserved trial
	# incurs the 15-minute failed-attempt cooldown (plus the hourly data cap).
	zbt_mwan_now > "$zbt_5g_dir/attempt"
	zbt_adaptive_status "Measuring three interface-bound $baseline_mode baseline downloads (25 MB each)."
	zbt_adaptive_samples "$baseline_mode" "$zbt_5g_dir/baseline.json" || {
		zbt_adaptive_status 'Baseline was unavailable, changed mode, or was unstable. No candidate was applied.'; return 1;
	}
	scores=$(zbt_adaptive_scores "$zbt_5g_dir/baseline.json") || return 1
	baseline_max=$(printf '%s' "$scores" | awk '{print $2}')
	candidate=nsa; [ "$baseline_mode" != nsa ] || candidate=sa
	zbt_adaptive_idle || { zbt_adaptive_status 'Traffic or backup availability changed; comparison deferred without a radio write.'; return 1; }
	# Journal BEFORE changing the modem. A crash cannot promote the candidate.
	printf '%s\n' "$previous" > "$zbt_5g_dir/rollback"
	printf '%s\n' "$$" > "$zbt_5g_dir/maintenance"
	zbt_adaptive_status "Testing $candidate; this modem is excluded from IPv4 and IPv6 client routing until verified."
	/usr/sbin/mwan3 ifdown "$config_section" >/dev/null 2>&1 || { zbt_adaptive_restore; return 1; }
	if [ "$(uci -q get "mwan3.${config_section}v6.enabled")" = 1 ]; then
		/usr/sbin/mwan3 ifdown "${config_section}v6" >/dev/null 2>&1 || { zbt_adaptive_restore; return 1; }
	fi
	if ! zbt_adaptive_trial_safe || ! zbt_5g_apply "$candidate" || ! zbt_adaptive_wait_data "$candidate"; then
		zbt_adaptive_restore && zbt_adaptive_status 'Candidate could not establish verified 5G Internet. Previous working selection restored.'
		return 1
	fi
	if ! zbt_adaptive_samples "$candidate" "$zbt_5g_dir/candidate.json"; then
		zbt_adaptive_restore && zbt_adaptive_status 'Candidate samples failed or were unstable. Previous working selection restored.'
		return 1
	fi
	scores=$(zbt_adaptive_scores "$zbt_5g_dir/candidate.json") || return 1
	candidate_min=$(printf '%s' "$scores" | awk '{print $1}')
	if zbt_adaptive_better "$baseline_max" "$candidate_min" && zbt_adaptive_probe && zbt_adaptive_resume; then
		printf '%s\n' "$candidate" > "$zbt_5g_dir/verified"
		rm -f "$zbt_5g_dir/rollback" "$zbt_5g_dir/maintenance"
		zbt_adaptive_status "Verified $candidate preferred for this boot: all three samples exceeded the $baseline_mode baseline by at least 15%. Baseline max $baseline_max Mbps; candidate min $candidate_min Mbps. Bands unchanged."
	else
		zbt_adaptive_restore && zbt_adaptive_status "Kept $previous: no stable 15% improvement. Baseline max $baseline_max Mbps; candidate min $candidate_min Mbps."
	fi
}
zbt_adaptive_run() {
	local config_section="$1" adaptive_device adaptive_index adaptive_ipv6=0 zbt_5g_dir now last=0 usage
	section_ready "$config_section" || return 0
	zbt_5g_lock || return 0
	adaptive_device=$(zbt_netdev "$config_section")
	adaptive_index=$(cat "/sys/class/net/$adaptive_device/ifindex" 2>/dev/null)
	if zbt_speed_lock; then
		if [ -f "$zbt_5g_dir/rollback" ]; then
			zbt_adaptive_restore
		else
			now=$(zbt_mwan_now)
			read -r last 2>/dev/null < "$zbt_5g_dir/attempt" || true
			case "$last" in ''|*[!0-9]*) last=0 ;; esac
			if [ "$last" = 0 ] || [ $((now - last)) -ge 900 ]; then
				zbt_adaptive_round
			fi
		fi
		# Persist diagnostics alongside bounded accounting, never as a setting
		# which pre-dial restores. No raw AT output or subscriber IDs are saved.
		usage="${ZBT_5G_USAGE:-/etc/zbt}/5g-adaptive-$config_section.json"
		if [ -f "$usage" ] && [ -f "$zbt_5g_dir/baseline.json" ]; then
			jq --arg mode "$(zbt_5g_hint)" --arg status "$(cat "$zbt_5g_dir/status")" \
				'. + {last_verified_mode:$mode,last_result:$status}' "$usage" > "$zbt_5g_dir/usage.new" &&
				{ cmp -s "$zbt_5g_dir/usage.new" "$usage" || {
					cp "$zbt_5g_dir/usage.new" "$usage.new" && mv "$usage.new" "$usage"
				}; }
			rm -f "$zbt_5g_dir/usage.new"
		fi
		zbt_speed_unlock
	fi
	zbt_5g_unlock
	# A completed trial can have deferred the normal hotplug failback hook.
	[ -f "$zbt_5g_dir/maintenance" ] || /usr/sbin/zbt-mwan-failback "$(zbt_mwan_winner)"
}
