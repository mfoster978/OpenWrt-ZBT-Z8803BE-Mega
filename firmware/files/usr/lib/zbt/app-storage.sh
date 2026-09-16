#!/bin/sh

MEGA_APPS_MOUNT="${MEGA_APPS_MOUNT:-/mnt/mega-apps}"
MEGA_APPS_CONFIG="${MEGA_APPS_CONFIG:-zbt_apps}"
MEGA_APPS_TOKENS="${MEGA_APPS_TOKENS:-/tmp/zbt-app-storage/tokens}"
MEGA_APPS_JOBS="${MEGA_APPS_JOBS:-/tmp/zbt-app-storage/jobs}"
MEGA_SYS_BLOCK="${MEGA_SYS_BLOCK:-/sys/class/block}"
MEGA_MOUNTINFO="${MEGA_MOUNTINFO:-/proc/self/mountinfo}"
MEGA_SWAPS="${MEGA_SWAPS:-/proc/swaps}"
MEGA_DEV_ROOT="${MEGA_DEV_ROOT:-/dev}"
MEGA_BLOCK="${MEGA_BLOCK:-/sbin/block}"
MEGA_PARTED="${MEGA_PARTED:-/sbin/parted}"
MEGA_PARTPROBE="${MEGA_PARTPROBE:-/sbin/partprobe}"
MEGA_MKFS_EXT4="${MEGA_MKFS_EXT4:-/usr/sbin/mkfs.ext4}"
MEGA_MIN_BYTES="${MEGA_MIN_BYTES:-268435456}"
MEGA_TOKEN_TTL="${MEGA_TOKEN_TTL:-300}"

mega_json_init() {
	. /usr/share/libubox/jshn.sh
	json_init
}

mega_random_id() {
	hexdump -n 16 -e '16/1 "%02x"' /dev/urandom 2>/dev/null
}

mega_safe_text() {
	printf '%s' "$1" | tr -cd 'A-Za-z0-9 ._:+/@()-' | cut -c 1-96
}

mega_valid_id() {
	case "$1" in ''|*[!0-9a-f]*) return 1 ;; esac
	case "$1" in
		????????????????????????????????) return 0 ;;
		*) return 1 ;;
	esac
}

mega_block_name_allowed() {
	case "$1" in
		sd[a-z]|sd[a-z][0-9]*) return 0 ;;
		*) return 1 ;;
	esac
}

mega_sys_realpath() {
	readlink -f "$MEGA_SYS_BLOCK/$1" 2>/dev/null
}

mega_is_usb_block() {
	mega_block_name_allowed "$1" || return 1
	path="$(mega_sys_realpath "$1")"
	case "$path" in
		*/usb[0-9]*/*) return 0 ;;
		*) return 1 ;;
	esac
}

mega_is_partition() {
	[ -f "$MEGA_SYS_BLOCK/$1/partition" ]
}

mega_parent_name() {
	path="$(mega_sys_realpath "$1")" || return 1
	basename "$(dirname "$path")"
}

mega_major_minor() {
	cat "$MEGA_SYS_BLOCK/$1/dev" 2>/dev/null
}

mega_size_bytes() {
	sectors="$(cat "$MEGA_SYS_BLOCK/$1/size" 2>/dev/null)"
	case "$sectors" in
		''|*[!0-9]*) printf '0\n' ;;
		*) printf '%s\n' "$((sectors * 512))" ;;
	esac
}

mega_disk_model() {
	name="$1"
	mega_is_partition "$name" && name="$(mega_parent_name "$name")"
	value="$(cat "$MEGA_SYS_BLOCK/$name/device/model" 2>/dev/null)"
	[ -n "$value" ] || value="USB storage"
	mega_safe_text "$value"
}

mega_disk_serial() {
	name="$1"
	mega_is_partition "$name" && name="$(mega_parent_name "$name")"
	mega_safe_text "$(cat "$MEGA_SYS_BLOCK/$name/device/serial" 2>/dev/null)"
}

mega_is_readonly() {
	[ "$(cat "$MEGA_SYS_BLOCK/$1/ro" 2>/dev/null)" = 1 ]
}

mega_has_holders() {
	for holder in "$MEGA_SYS_BLOCK/$1/holders/"*; do
		[ ! -e "$holder" ] || return 0
	done
	return 1
}

mega_is_swap_major() {
	major_minor="$1"
	[ -r "$MEGA_SWAPS" ] || return 1
	while read -r dev _; do
		[ "$dev" = Filename ] && continue
		[ -b "$dev" ] || continue
		name="$(basename "$(readlink -f "$dev")")"
		[ "$(mega_major_minor "$name")" != "$major_minor" ] || return 0
	done < "$MEGA_SWAPS"
	return 1
}

mega_mount_for_major() {
	major_minor="$1"
	awk -v mm="$major_minor" '$3 == mm { print $5; exit }' "$MEGA_MOUNTINFO" 2>/dev/null
}

mega_is_system_major() {
	major_minor="$1"
	awk -v mm="$major_minor" '$3 == mm && ($5 == "/" || $5 == "/rom" || $5 == "/overlay") { found=1 } END { exit !found }' "$MEGA_MOUNTINFO" 2>/dev/null
}

mega_device_busy() {
	name="$1"
	major_minor="$(mega_major_minor "$name")"
	[ -n "$major_minor" ] || return 0
	[ -z "$(mega_mount_for_major "$major_minor")" ] || return 0
	mega_is_swap_major "$major_minor" && return 0
	mega_is_system_major "$major_minor" && return 0
	mega_has_holders "$name" && return 0
	return 1
}

mega_disk_busy() {
	disk="$1"
	mega_device_busy "$disk" && return 0
	for entry in "$MEGA_SYS_BLOCK/$disk/"$disk*; do
		[ -e "$entry/partition" ] || continue
		mega_device_busy "$(basename "$entry")" && return 0
	done
	return 1
}

mega_block_value() {
	dev="$1"
	key="$2"
	"$MEGA_BLOCK" info "$dev" 2>/dev/null |
		sed -n "s/.*[[:space:]]$key=\"\([^\"]*\)\".*/\1/p" |
		sed -n '1p'
}

mega_token_write() {
	token="$1"
	name="$2"
	kind="$3"
	confirmation="$4"
	mkdir -p "$MEGA_APPS_TOKENS" || return 1
	chmod 0700 "$(dirname "$MEGA_APPS_TOKENS")" "$MEGA_APPS_TOKENS" 2>/dev/null
	tmp="$MEGA_APPS_TOKENS/.$token"
	mega_json_init
	json_add_string name "$name"
	json_add_string kind "$kind"
	json_add_string realpath "$(mega_sys_realpath "$name")"
	json_add_string major_minor "$(mega_major_minor "$name")"
	json_add_string confirmation "$confirmation"
	json_add_int created "$(date +%s)"
	json_dump > "$tmp" &&
		chmod 0600 "$tmp" &&
		mv "$tmp" "$MEGA_APPS_TOKENS/$token"
}

mega_token_read() {
	token="$1"
	mega_valid_id "$token" || return 1
	token_file="$MEGA_APPS_TOKENS/$token"
	[ -f "$token_file" ] || return 1
	created="$(jsonfilter -i "$token_file" -e '@.created' 2>/dev/null)"
	case "$created" in ''|*[!0-9]*) return 1 ;; esac
	now="$(date +%s)"
	[ "$((now - created))" -ge 0 ] && [ "$((now - created))" -le "$MEGA_TOKEN_TTL" ] || return 1
	TOKEN_NAME="$(jsonfilter -i "$token_file" -e '@.name' 2>/dev/null)"
	TOKEN_KIND="$(jsonfilter -i "$token_file" -e '@.kind' 2>/dev/null)"
	TOKEN_REALPATH="$(jsonfilter -i "$token_file" -e '@.realpath' 2>/dev/null)"
	TOKEN_MAJOR_MINOR="$(jsonfilter -i "$token_file" -e '@.major_minor' 2>/dev/null)"
	TOKEN_CONFIRMATION="$(jsonfilter -i "$token_file" -e '@.confirmation' 2>/dev/null)"
	mega_block_name_allowed "$TOKEN_NAME" &&
		[ "$(mega_sys_realpath "$TOKEN_NAME")" = "$TOKEN_REALPATH" ] &&
		[ "$(mega_major_minor "$TOKEN_NAME")" = "$TOKEN_MAJOR_MINOR" ] &&
		mega_is_usb_block "$TOKEN_NAME"
}

mega_token_consume() {
	rm -f "$MEGA_APPS_TOKENS/$1"
}

mega_candidate_json() {
	name="$1"
	kind="$2"
	eligible="$3"
	reason="$4"
	token="$5"
	confirmation="$6"
	dev="$MEGA_DEV_ROOT/$name"
	fstype="$(mega_block_value "$dev" TYPE)"
	uuid="$(mega_block_value "$dev" UUID)"
	mountpoint="$(mega_mount_for_major "$(mega_major_minor "$name")")"
	mega_json_init
	json_add_string id "$token"
	json_add_string kind "$kind"
	json_add_string device "$dev"
	json_add_string model "$(mega_disk_model "$name")"
	json_add_string serial "$(mega_disk_serial "$name")"
	json_add_int size "$(mega_size_bytes "$name")"
	json_add_string fstype "$fstype"
	json_add_string uuid "$uuid"
	json_add_string mount "$mountpoint"
	json_add_boolean eligible "$eligible"
	json_add_string reason "$reason"
	json_add_string confirmation "$confirmation"
	json_dump
}

mega_storage_candidates() {
	mkdir -p "$MEGA_APPS_TOKENS"
	find "$MEGA_APPS_TOKENS" -type f -mmin +5 -delete 2>/dev/null
	items="/tmp/zbt-app-storage-candidates.$$"
	: > "$items" || return 1
	for sys_entry in "$MEGA_SYS_BLOCK"/sd[a-z]; do
		[ -e "$sys_entry" ] || continue
		disk="$(basename "$sys_entry")"
		mega_is_usb_block "$disk" || continue
		eligible=true
		reason=""
		if mega_is_readonly "$disk"; then
			eligible=false
			reason="This USB device is read-only."
		elif mega_disk_busy "$disk"; then
			eligible=false
			reason="Unmount every partition and stop users of this USB device before erasing it."
		elif [ "$(mega_size_bytes "$disk")" -lt "$MEGA_MIN_BYTES" ]; then
			eligible=false
			reason="At least 256 MiB is required."
		fi
		token="$(mega_random_id)"
		confirmation="ERASE $disk ${token#????????????????????????}"
		mega_token_write "$token" "$disk" disk "$confirmation" || continue
		mega_candidate_json "$disk" erase "$eligible" "$reason" "$token" "$confirmation" >> "$items"
		for part_entry in "$MEGA_SYS_BLOCK/$disk/"$disk*; do
			[ -e "$part_entry/partition" ] || continue
			part="$(basename "$part_entry")"
			eligible=true
			reason=""
			fstype="$(mega_block_value "$MEGA_DEV_ROOT/$part" TYPE)"
			uuid="$(mega_block_value "$MEGA_DEV_ROOT/$part" UUID)"
			if [ "$fstype" != ext4 ] || [ -z "$uuid" ]; then
				eligible=false
				reason="Only an existing ext4 partition with a UUID can be adopted without erasing."
			elif mega_device_busy "$part"; then
				eligible=false
				reason="Unmount this partition before adopting it."
			elif [ "$(mega_size_bytes "$part")" -lt "$MEGA_MIN_BYTES" ]; then
				eligible=false
				reason="At least 256 MiB is required."
			fi
			part_token="$(mega_random_id)"
			mega_token_write "$part_token" "$part" partition "" || continue
			mega_candidate_json "$part" adopt "$eligible" "$reason" "$part_token" "" >> "$items"
		done
	done
	jq -sc '{ok:true,candidates:.}' "$items"
	rm -f "$items"
}

mega_find_uuid_device() {
	uuid="$1"
	"$MEGA_BLOCK" info 2>/dev/null |
		awk -v wanted="$uuid" '
			index($0, "UUID=\"" wanted "\"") {
				sub(/:.*/, "", $1)
				print $1
				exit
			}'
}

mega_mount_verified() {
	uuid="$1"
	dev="$(mega_find_uuid_device "$uuid")"
	[ -n "$dev" ] || return 1
	name="$(basename "$(readlink -f "$dev")")"
	mega_is_usb_block "$name" || return 1
	[ "$(mega_block_value "$dev" TYPE)" = ext4 ] || return 1
	[ "$(mega_block_value "$dev" UUID)" = "$uuid" ] || return 1
	major_minor="$(mega_major_minor "$name")"
	[ "$(mega_mount_for_major "$major_minor")" = "$MEGA_APPS_MOUNT" ] || return 1
	MEGA_VERIFIED_DEVICE="$dev"
	return 0
}

mega_storage_status() {
	uuid="$(uci -q get "$MEGA_APPS_CONFIG.storage.uuid")"
	configured=false
	mounted=false
	device=""
	total=0
	free=0
	[ -z "$uuid" ] || configured=true
	if [ -n "$uuid" ] && mega_mount_verified "$uuid"; then
		mounted=true
		device="$MEGA_VERIFIED_DEVICE"
		set -- $(df -Pk "$MEGA_APPS_MOUNT" 2>/dev/null | awk 'NR == 2 { print $2 * 1024, $4 * 1024 }')
		total="${1:-0}"
		free="${2:-0}"
	fi
	mega_json_init
	json_add_boolean ok true
	json_add_boolean configured "$configured"
	json_add_boolean mounted "$mounted"
	json_add_string uuid "$uuid"
	json_add_string device "$device"
	json_add_string mount "$MEGA_APPS_MOUNT"
	json_add_int total "$total"
	json_add_int free "$free"
	json_dump
}

mega_configure_mount() {
	uuid="$1"
	uci -q batch <<-EOF || return 1
		delete fstab.mega_apps
		set fstab.mega_apps=mount
		set fstab.mega_apps.uuid='$uuid'
		set fstab.mega_apps.target='$MEGA_APPS_MOUNT'
		set fstab.mega_apps.fstype='ext4'
		set fstab.mega_apps.options='rw,noatime,nosuid,nodev'
		set fstab.mega_apps.enabled='1'
		set fstab.mega_apps.enabled_fsck='1'
		set $MEGA_APPS_CONFIG.storage=storage
		set $MEGA_APPS_CONFIG.storage.uuid='$uuid'
		set $MEGA_APPS_CONFIG.storage.target='$MEGA_APPS_MOUNT'
	EOF
	uci commit fstab &&
		uci commit "$MEGA_APPS_CONFIG" &&
		"$MEGA_BLOCK" mount &&
		mega_mount_verified "$uuid"
}

mega_adopt_partition() {
	token="$1"
	mega_token_read "$token" || return 20
	[ "$TOKEN_KIND" = partition ] || return 21
	mega_device_busy "$TOKEN_NAME" && return 22
	dev="$MEGA_DEV_ROOT/$TOKEN_NAME"
	[ "$(mega_block_value "$dev" TYPE)" = ext4 ] || return 23
	uuid="$(mega_block_value "$dev" UUID)"
	[ -n "$uuid" ] || return 24
	mega_configure_mount "$uuid"
}

mega_erase_disk() {
	token="$1"
	confirmation="$2"
	mega_token_read "$token" || return 30
	[ "$TOKEN_KIND" = disk ] || return 31
	[ "$confirmation" = "$TOKEN_CONFIRMATION" ] || return 32
	mega_is_readonly "$TOKEN_NAME" && return 33
	mega_disk_busy "$TOKEN_NAME" && return 34
	dev="$MEGA_DEV_ROOT/$TOKEN_NAME"
	"$MEGA_PARTED" -s "$dev" mklabel gpt mkpart primary ext4 1MiB 100% || return 35
	"$MEGA_PARTPROBE" "$dev" >/dev/null 2>&1 || true
	part=""
	tries=0
	while [ "$tries" -lt 20 ]; do
		for candidate in "$MEGA_SYS_BLOCK/$TOKEN_NAME/"$TOKEN_NAME*; do
			[ -e "$candidate/partition" ] || continue
			part="$(basename "$candidate")"
			break
		done
		[ -z "$part" ] || break
		tries=$((tries + 1))
		sleep 1
	done
	[ -n "$part" ] || return 36
	mega_is_usb_block "$part" || return 37
	"$MEGA_MKFS_EXT4" -F -L MEGA_APPS "$MEGA_DEV_ROOT/$part" >/dev/null || return 38
	uuid="$(mega_block_value "$MEGA_DEV_ROOT/$part" UUID)"
	[ -n "$uuid" ] || return 39
	mega_configure_mount "$uuid"
}

mega_storage_release() {
	installed="$(uci -q get zbt_adguard.main.installed)"
	[ "$installed" != 1 ] || return 40
	uuid="$(uci -q get "$MEGA_APPS_CONFIG.storage.uuid")"
	[ -n "$uuid" ] || return 0
	if mega_mount_verified "$uuid"; then
		umount "$MEGA_APPS_MOUNT" || return 41
	fi
	uci -q delete fstab.mega_apps
	uci -q delete "$MEGA_APPS_CONFIG.storage"
	uci commit fstab &&
		uci commit "$MEGA_APPS_CONFIG"
}
