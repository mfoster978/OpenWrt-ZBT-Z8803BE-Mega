#!/bin/sh
# Files here are RAM-only. No learned SA/NSA lock survives a router reboot.
zbt_5g_state_dir() {
	case "$config_section" in 4_1|2_1) ;; *) return 1 ;; esac
	zbt_5g_dir="${ZBT_5G_STATE:-/tmp/zbt-5g}/$config_section"
	umask 077
	mkdir -p "$zbt_5g_dir"
}
zbt_5g_lock() {
	zbt_5g_state_dir || return 1
	exec 9>"$zbt_5g_dir/radio.lock"
	flock -n 9 || { exec 9>&-; return 1; }
}
zbt_5g_unlock() { flock -u 9; exec 9>&-; }
zbt_5g_hint() {
	local hint=''
	zbt_5g_state_dir || return 1
	# A crashed/terminated trial is never promoted by the next dial attempt.
	if [ -f "$zbt_5g_dir/rollback" ]; then
		read -r hint < "$zbt_5g_dir/rollback"
	else
		read -r hint 2>/dev/null < "$zbt_5g_dir/verified" || true
	fi
	case "$hint" in auto|nsa|sa) echo "$hint" ;; *) echo auto ;; esac
}
