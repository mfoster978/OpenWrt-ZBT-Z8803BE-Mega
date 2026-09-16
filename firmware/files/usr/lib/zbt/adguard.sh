#!/bin/sh
. /usr/lib/zbt/app-storage.sh

AGH_RELEASE='v0.107.79'
AGH_ARCHIVE='AdGuardHome_linux_arm64.tar.gz'
AGH_SHA256='3f7893c18e8aaadc456d0452839190561c306ca95175a2254958be80a769c1ae'
AGH_SIZE='11332212'
AGH_URL="https://github.com/AdguardTeam/AdGuardHome/releases/download/$AGH_RELEASE/$AGH_ARCHIVE"
AGH_ROOT="$MEGA_APPS_MOUNT/adguardhome"
AGH_CURRENT="$AGH_ROOT/current"
AGH_BINARY="$AGH_CURRENT/AdGuardHome"
AGH_CONFIG_DIR="$AGH_ROOT/config"
AGH_CONFIG="$AGH_CONFIG_DIR/AdGuardHome.yaml"
AGH_WORK="$AGH_ROOT/work"
AGH_STAGING="$AGH_ROOT/.staging"
AGH_JOBS="${AGH_JOBS:-/tmp/zbt-adguard/jobs}"
AGH_TOKEN_FILE="${AGH_TOKEN_FILE:-/tmp/zbt-adguard/install-token.json}"
AGH_CONFIG_NAME="${AGH_CONFIG_NAME:-zbt_adguard}"
AGH_WEB_PORT='3000'
AGH_SETUP_PORT='3001'
AGH_DNSMASQ_PORT='54'

agh_reply_error() {
	mega_json_init
	json_add_boolean ok false
	json_add_string error "$1"
	json_dump
}
agh_valid_uci_section() {
	case "$1" in
		@dnsmasq\[[0-9]*\]|[A-Za-z0-9_]*)
			[ -n "$1" ]
			;;
		*) return 1 ;;
	esac
}

agh_storage_ready() {
	uuid="$(uci -q get "$MEGA_APPS_CONFIG.storage.uuid")"
	[ -n "$uuid" ] && mega_mount_verified "$uuid"
}

agh_installed() {
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.installed")" = 1 ] &&
		agh_storage_ready &&
		[ -f "$AGH_BINARY" ] &&
		[ ! -L "$AGH_BINARY" ] &&
		[ -x "$AGH_BINARY" ]
}

agh_dnsmasq_section() {
	uci -q show dhcp 2>/dev/null |
		sed -n 's/^dhcp\.\([^=]*\)=dnsmasq$/\1/p' |
		sed -n '1p'
}

agh_dns_save_original() {
	section="$1"
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.dns_owned")" != 1 ] || return 0
	port="$(uci -q get "dhcp.$section.port")"
	if uci -q get "dhcp.$section.port" >/dev/null; then
		port_present=1
	else
		port_present=0
		port=53
	fi
	uci -q batch <<-EOF &&
		set $AGH_CONFIG_NAME.main.dnsmasq_section='$section'
		set $AGH_CONFIG_NAME.main.original_port_present='$port_present'
		set $AGH_CONFIG_NAME.main.original_port='$port'
		set $AGH_CONFIG_NAME.main.dns_owned='1'
		delete $AGH_CONFIG_NAME.main.owned_dhcp_option
	EOF
		uci commit "$AGH_CONFIG_NAME"
}

agh_add_dhcp_announcements() {
	for row in $(uci -q show dhcp | sed -n 's/^dhcp\.\([^=]*\)=dhcp$/\1/p'); do
		[ "$(uci -q get "dhcp.$row.ignore")" != 1 ] || continue
		iface="$(uci -q get "dhcp.$row.interface")"
		[ -n "$iface" ] || continue
		ipaddr="$(ubus call "network.interface.$iface" status 2>/dev/null |
			jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null)"
		case "$ipaddr" in
			''|*[!0-9.]*) continue ;;
		esac
		value="6,$ipaddr"
		if ! uci -q show "dhcp.$row.dhcp_option" | grep -Fqx "dhcp.$row.dhcp_option='$value'"; then
			uci -q add_list "dhcp.$row.dhcp_option=$value" || return 1
			uci -q add_list "$AGH_CONFIG_NAME.main.owned_dhcp_option=$row|$value" || return 1
		fi
	done
}

agh_dns_takeover() {
	agh_storage_ready || return 1
	section="$(agh_dnsmasq_section)"
	[ -n "$section" ] || return 1
	agh_dns_save_original "$section" || return 1
	agh_add_dhcp_announcements || {
		agh_dns_restore
		return 1
	}
	uci -q set "dhcp.$section.port=$AGH_DNSMASQ_PORT" &&
		uci commit dhcp &&
		uci commit "$AGH_CONFIG_NAME" &&
		/etc/init.d/dnsmasq restart || {
			agh_dns_restore
			return 1
		}
	return 0
}

agh_dns_restore() {
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.dns_owned")" = 1 ] || return 0
	section="$(uci -q get "$AGH_CONFIG_NAME.main.dnsmasq_section")"
	agh_valid_uci_section "$section" || return 1
	for owned in $(uci -q get "$AGH_CONFIG_NAME.main.owned_dhcp_option"); do
		row="${owned%%|*}"
		value="${owned#*|}"
		agh_valid_uci_section "$row" || continue
		[ "$value" != "$owned" ] || continue
		uci -q del_list "dhcp.$row.dhcp_option=$value"
	done
	current="$(uci -q get "dhcp.$section.port")"
	if [ "$current" = "$AGH_DNSMASQ_PORT" ]; then
		if [ "$(uci -q get "$AGH_CONFIG_NAME.main.original_port_present")" = 1 ]; then
			uci -q set "dhcp.$section.port=$(uci -q get "$AGH_CONFIG_NAME.main.original_port")"
		else
			uci -q delete "dhcp.$section.port"
		fi
	else
		logger -t zbt-adguard "dnsmasq port changed by another owner; preserving port=$current"
	fi
	uci commit dhcp || return 1
	uci -q delete "$AGH_CONFIG_NAME.main.owned_dhcp_option"
	uci -q set "$AGH_CONFIG_NAME.main.dns_owned=0"
	uci commit "$AGH_CONFIG_NAME" || return 1
	/etc/init.d/dnsmasq restart
}

agh_job_write() {
	job="$1"
	phase="$2"
	error="${3:-}"
	mkdir -p "$AGH_JOBS" || return 1
	tmp="$AGH_JOBS/$job.json.tmp"
	mega_json_init
	json_add_boolean ok true
	json_add_string id "$job"
	json_add_string phase "$phase"
	json_add_string error "$error"
	json_dump > "$tmp" &&
		chmod 0600 "$tmp" &&
		mv "$tmp" "$AGH_JOBS/$job.json"
}

agh_install_offer() {
	agh_storage_ready || {
		agh_reply_error "Prepare and mount verified USB application storage first."
		return 1
	}
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.installed")" != 1 ] || {
		agh_reply_error "AdGuard Home is already installed."
		return 1
	}
	token="$(mega_random_id)"
	mkdir -p "$(dirname "$AGH_TOKEN_FILE")"
	chmod 0700 "$(dirname "$AGH_TOKEN_FILE")"
	mega_json_init
	json_add_string token "$token"
	json_add_int created "$(date +%s)"
	json_add_string uuid "$(uci -q get "$MEGA_APPS_CONFIG.storage.uuid")"
	json_dump > "$AGH_TOKEN_FILE"
	chmod 0600 "$AGH_TOKEN_FILE"
	mega_json_init
	json_add_boolean ok true
	json_add_string token "$token"
	json_add_string release "$AGH_RELEASE"
	json_add_int download_size "$AGH_SIZE"
	json_dump
}

agh_install_token_valid() {
	token="$1"
	mega_valid_id "$token" || return 1
	[ -f "$AGH_TOKEN_FILE" ] || return 1
	[ "$(jsonfilter -i "$AGH_TOKEN_FILE" -e '@.token' 2>/dev/null)" = "$token" ] || return 1
	[ "$(jsonfilter -i "$AGH_TOKEN_FILE" -e '@.uuid' 2>/dev/null)" = "$(uci -q get "$MEGA_APPS_CONFIG.storage.uuid")" ] || return 1
	created="$(jsonfilter -i "$AGH_TOKEN_FILE" -e '@.created' 2>/dev/null)"
	case "$created" in ''|*[!0-9]*) return 1 ;; esac
	now="$(date +%s)"
	[ "$((now - created))" -ge 0 ] && [ "$((now - created))" -le 300 ]
}

agh_install_start() {
	input="$(cat)"
	token="$(printf '%s' "$input" | jsonfilter -e '@.token' 2>/dev/null)"
	agh_install_token_valid "$token" || {
		agh_reply_error "The installation confirmation expired. Review it again."
		return 1
	}
	agh_storage_ready || {
		agh_reply_error "The verified USB storage is no longer mounted."
		return 1
	}
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.installed")" != 1 ] || {
		agh_reply_error "AdGuard Home is already installed."
		return 1
	}
	rm -f "$AGH_TOKEN_FILE"
	job="$(mega_random_id)"
	agh_job_write "$job" queued || {
		agh_reply_error "Unable to create the installation job."
		return 1
	}
	nohup /usr/sbin/zbt-adguard-install "$job" </dev/null >/dev/null 2>&1 &
	mega_json_init
	json_add_boolean ok true
	json_add_string id "$job"
	json_dump
}

agh_install_status() {
	input="$(cat)"
	job="$(printf '%s' "$input" | jsonfilter -e '@.id' 2>/dev/null)"
	mega_valid_id "$job" || { agh_reply_error "Invalid installation job."; return 1; }
	file="$AGH_JOBS/$job.json"
	[ -f "$file" ] || { agh_reply_error "Installation job not found."; return 1; }
	jq -ce --arg id "$job" '
		if type == "object" and .ok == true and .id == $id and
			(.phase == "queued" or .phase == "downloading" or .phase == "verifying" or
			 .phase == "extracting" or .phase == "credentials" or .phase == "ready" or .phase == "error") and
			(.error | type) == "string"
		then . else error("invalid job") end' "$file" 2>/dev/null ||
		agh_reply_error "Installation state is unreadable."
}

agh_patch_local_dns() {
	domain="$(uci -q get "dhcp.$(agh_dnsmasq_section).domain")"
	case "$domain" in
		''|*[!A-Za-z0-9.-]*) domain=lan ;;
	esac
	tmp="$AGH_CONFIG.tmp"
	awk -v domain="$domain" '
		$0 == "  upstream_dns:" {
			print
			print "    - \"[/" domain "/]127.0.0.1:54\""
			next
		}
		$0 ~ /^  local_ptr_upstreams:/ {
			print "  local_ptr_upstreams:"
			print "    - 127.0.0.1:54"
			skip=1
			next
		}
		skip && $0 ~ /^    - / { next }
		{ skip=0; print }
	' "$AGH_CONFIG" > "$tmp" && mv "$tmp" "$AGH_CONFIG"
	chmod 0600 "$AGH_CONFIG"
}

agh_configure() {
	input="$(cat)"
	username="$(printf '%s' "$input" | jsonfilter -e '@.username' 2>/dev/null)"
	password="$(printf '%s' "$input" | jsonfilter -e '@.password' 2>/dev/null)"
	case "$username" in ''|*[!A-Za-z0-9._-]*) agh_reply_error "Use 1–32 letters, numbers, dots, dashes, or underscores for the administrator name."; return 1 ;; esac
	[ "${#username}" -le 32 ] || { agh_reply_error "Administrator name is too long."; return 1; }
	[ "${#password}" -ge 12 ] && [ "${#password}" -le 128 ] || {
		agh_reply_error "Use an AdGuard password between 12 and 128 characters."
		return 1
	}
	case "$password" in *'
'*) agh_reply_error "The password cannot contain a line break."; return 1 ;; esac
	agh_installed || { agh_reply_error "The verified USB installation is unavailable."; return 1; }
	[ ! -e "$AGH_CONFIG" ] || { agh_reply_error "AdGuard Home is already configured."; return 1; }
	exec 9>/var/lock/zbt-adguard.lock
	flock -n 9 || { agh_reply_error "Another AdGuard operation is running."; return 1; }
	agh_dns_takeover || { agh_reply_error "Unable to reserve DNS safely; dnsmasq was restored."; return 1; }
	mkdir -p "$AGH_CONFIG_DIR" "$AGH_WORK/tmp"
	chmod 0700 "$AGH_ROOT" "$AGH_CONFIG_DIR" "$AGH_WORK" "$AGH_WORK/tmp"
	HOME="$AGH_WORK" TMPDIR="$AGH_WORK/tmp" "$AGH_BINARY" \
		--config "$AGH_CONFIG" --work-dir "$AGH_WORK" \
		--web-addr "127.0.0.1:$AGH_SETUP_PORT" --no-check-update \
		>/dev/null 2>&1 &
	setup_pid=$!
	ready=0
	tries=0
	while [ "$tries" -lt 30 ]; do
		if curl -fsS --max-time 2 "http://127.0.0.1:$AGH_SETUP_PORT/control/install/get_addresses" >/dev/null 2>&1; then
			ready=1
			break
		fi
		kill -0 "$setup_pid" 2>/dev/null || break
		tries=$((tries + 1))
		sleep 1
	done
	if [ "$ready" != 1 ]; then
		kill "$setup_pid" 2>/dev/null
		agh_dns_restore
		agh_reply_error "AdGuard setup did not start; dnsmasq was restored."
		return 1
	fi
	mega_json_init
	json_add_object web
	json_add_string ip "0.0.0.0"
	json_add_int port "$AGH_WEB_PORT"
	json_close_object
	json_add_object dns
	json_add_string ip "0.0.0.0"
	json_add_int port 53
	json_close_object
	json_add_string username "$username"
	json_add_string password "$password"
	payload="$(json_dump)"
	unset password
	if ! printf '%s' "$payload" | curl -fsS --max-time 15 \
		-H 'Content-Type: application/json' --data-binary @- \
		"http://127.0.0.1:$AGH_SETUP_PORT/control/install/configure" >/dev/null; then
		unset payload
		kill "$setup_pid" 2>/dev/null
		wait "$setup_pid" 2>/dev/null
		rm -f "$AGH_CONFIG"
		agh_dns_restore
		agh_reply_error "AdGuard rejected its initial configuration; dnsmasq was restored."
		return 1
	fi
	unset payload
	kill "$setup_pid" 2>/dev/null
	wait "$setup_pid" 2>/dev/null
	agh_patch_local_dns || {
		rm -f "$AGH_CONFIG"
		agh_dns_restore
		agh_reply_error "Unable to configure local DNS; dnsmasq was restored."
		return 1
	}
	uci -q set "$AGH_CONFIG_NAME.main.enabled=1"
	uci commit "$AGH_CONFIG_NAME"
	/etc/init.d/zbt-adguard restart
	sleep 3
	if pidof AdGuardHome >/dev/null 2>&1 &&
		nslookup openwrt.org 127.0.0.1 >/dev/null 2>&1; then
		echo '{"ok":true,"enabled":true}'
	else
		uci -q set "$AGH_CONFIG_NAME.main.enabled=0"
		uci commit "$AGH_CONFIG_NAME"
		/etc/init.d/zbt-adguard stop
		agh_dns_restore
		agh_reply_error "AdGuard did not pass its DNS health check; dnsmasq was restored."
		return 1
	fi
}

agh_set_enabled() {
	input="$(cat)"
	enabled="$(printf '%s' "$input" | jsonfilter -e '@.enabled' 2>/dev/null)"
	case "$enabled" in true|1) enabled=1 ;; false|0) enabled=0 ;; *) agh_reply_error "enabled must be a boolean"; return 1 ;; esac
	exec 9>/var/lock/zbt-adguard.lock
	flock -n 9 || { agh_reply_error "Another AdGuard operation is running."; return 1; }
	if [ "$enabled" = 1 ]; then
		agh_installed || { agh_reply_error "The USB installation is unavailable."; return 1; }
		uci -q set "$AGH_CONFIG_NAME.main.enabled=1"
		uci commit "$AGH_CONFIG_NAME"
		if /etc/init.d/zbt-adguard restart; then
			echo '{"ok":true,"enabled":true}'
		else
			uci -q set "$AGH_CONFIG_NAME.main.enabled=0"
			uci commit "$AGH_CONFIG_NAME"
			agh_dns_restore
			agh_reply_error "AdGuard could not start; dnsmasq was restored."
			return 1
		fi
	else
		uci -q set "$AGH_CONFIG_NAME.main.enabled=0"
		uci commit "$AGH_CONFIG_NAME"
		/etc/init.d/zbt-adguard stop
		agh_dns_restore || {
			agh_reply_error "AdGuard stopped, but dnsmasq restoration needs attention."
			return 1
		}
		echo '{"ok":true,"enabled":false}'
	fi
}

agh_uninstall() {
	input="$(cat)"
	confirmation="$(printf '%s' "$input" | jsonfilter -e '@.confirmation' 2>/dev/null)"
	[ "$confirmation" = "UNINSTALL ADGUARD" ] || { agh_reply_error "The uninstall confirmation does not match."; return 1; }
	agh_storage_ready || { agh_reply_error "Reconnect the configured USB storage before uninstalling."; return 1; }
	exec 9>/var/lock/zbt-adguard.lock
	flock -n 9 || { agh_reply_error "Another AdGuard operation is running."; return 1; }
	uci -q set "$AGH_CONFIG_NAME.main.enabled=0"
	uci commit "$AGH_CONFIG_NAME"
	/etc/init.d/zbt-adguard stop
	agh_dns_restore || { agh_reply_error "Unable to restore dnsmasq; uninstall was stopped."; return 1; }
	[ "$AGH_ROOT" = "$MEGA_APPS_MOUNT/adguardhome" ] || return 1
	[ ! -L "$AGH_ROOT" ] || { agh_reply_error "The USB installation path is unsafe."; return 1; }
	rm -rf -- "$AGH_ROOT" || { agh_reply_error "Unable to remove the USB installation."; return 1; }
	uci -q batch <<-EOF
		set $AGH_CONFIG_NAME.main.installed='0'
		set $AGH_CONFIG_NAME.main.enabled='0'
		delete $AGH_CONFIG_NAME.main.version
	EOF
	uci commit "$AGH_CONFIG_NAME"
	echo '{"ok":true,"installed":false}'
}

agh_status() {
	storage=false
	installed=false
	configured=false
	enabled=false
	running=false
	dns_owned=false
	agh_storage_ready && storage=true
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.installed")" = 1 ] && installed=true
	[ -s "$AGH_CONFIG" ] && configured=true
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.enabled")" = 1 ] && enabled=true
	pidof AdGuardHome >/dev/null 2>&1 && running=true
	[ "$(uci -q get "$AGH_CONFIG_NAME.main.dns_owned")" = 1 ] && dns_owned=true
	version="$(uci -q get "$AGH_CONFIG_NAME.main.version")"
	mega_json_init
	json_add_boolean ok true
	json_add_boolean storage_ready "$storage"
	json_add_boolean installed "$installed"
	json_add_boolean configured "$configured"
	json_add_boolean enabled "$enabled"
	json_add_boolean running "$running"
	json_add_boolean dns_owned "$dns_owned"
	json_add_string version "$version"
	json_add_string release "$AGH_RELEASE"
	json_add_int web_port "$AGH_WEB_PORT"
	json_dump
}
