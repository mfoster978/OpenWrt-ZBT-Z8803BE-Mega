#!/bin/sh
# Mega extensions for Quectel subscriber-number and nearby-cell discovery.
# This file is sourced by the narrowly patched, pinned QModem vendor script.

zbt_quectel_extract_number()
{
	# Both +CNUM and +CPBR place the subscriber number in the second
	# comma-separated field. Do not depend on command echo or line position.
	printf '%s\n' "$1" | awk -F',' '
		/^[[:space:]]*\+(CNUM|CPBR):/ {
			number = $2
			gsub(/^[[:space:]\"]+|[[:space:]\"\r]+$/, "", number)
			if (number != "") { print number; exit }
		}'
}

zbt_quectel_normalize_number()
{
	local number
	# Match POSIX whitespace in awk: the router's reduced tr has no classes.
	number=$(printf '%s' "$1" | awk '{ gsub(/[[:space:]().-]/, ""); printf "%s", $0 }')
	case "$number" in
		''|*[!+0-9*#]*) return 1 ;;
	esac
	printf '%s\n' "$number"
}

zbt_quectel_sim_number()
{
	local port="$1" response number old_storage select_response range first last

	response=$(at "$port" 'AT+CNUM')
	number=$(zbt_quectel_extract_number "$response")
	if number=$(zbt_quectel_normalize_number "$number"); then
		printf '%s\n' "$number"
		return 0
	fi

	# Some SIMs expose EF-MSISDN through the standard Own Numbers phonebook
	# even when AT+CNUM is empty. Restore the prior phonebook after the read.
	response=$(at "$port" 'AT+CPBS?')
	old_storage=$(printf '%s\n' "$response" | sed -n 's/^[[:space:]]*+CPBS:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p')
	select_response=$(at "$port" 'AT+CPBS="ON"')
	if printf '%s\n' "$select_response" | grep -q '^[[:space:]]*OK[[:space:]]*$'; then
		range=$(at "$port" 'AT+CPBR=?')
		first=$(printf '%s\n' "$range" | sed -n 's/.*(\([0-9][0-9]*\)-[0-9][0-9]*).*/\1/p' | sed -n '1p')
		last=$(printf '%s\n' "$range" | sed -n 's/.*([0-9][0-9]*-\([0-9][0-9]*\)).*/\1/p' | sed -n '1p')
		case "$first:$last" in
			*[!0-9:]*) first=1; last=5 ;;
			:|:*|*:) first=1; last=5 ;;
		esac
		[ "$last" -gt $((first + 4)) ] && last=$((first + 4))
		response=$(at "$port" "AT+CPBR=$first,$last")
		number=$(zbt_quectel_extract_number "$response")
	fi

	if [ -n "$old_storage" ] && [ "$old_storage" != 'ON' ]; then
		at "$port" "AT+CPBS=\"$old_storage\"" >/dev/null 2>&1
	fi

	zbt_quectel_normalize_number "$number"
}

zbt_quectel_long_at()
{
	local port="$1" command="$2"
	# Quectel documents a network-dependent maximum of 180 seconds for QSCAN.
	# tom_modem otherwise defaults to three seconds, which guarantees false
	# empty scans. Greedy mode continues while the modem returns cell records.
	if [ "$(uci -q get qmodem.main.at_tool 2>/dev/null)" = 1 ]; then
		sms_tool_q -t 185 -d "$port" at "$command"
	else
		tom_modem ${use_ubus_flag:-} -d "$port" -o a -c "$command" -t 185 -g
	fi
}

zbt_quectel_add_cell()
{
	local rat="$1" source="$2" arfcn="$3" pci="$4" band="$5" scs="$6" rsrp="$7" rsrq="$8"
	case "$rat" in LTE|NR) ;; *) return 1 ;; esac
	case "$arfcn:$pci" in ''|:*|*:|*[!0-9:]*) return 1 ;; esac

	json_select "$rat"
	json_add_object ""
	json_add_string source "$source"
	json_add_string arfcn "$arfcn"
	json_add_string pci "$pci"
	[ -n "$band" ] && [ "$band" != '-' ] && json_add_string band "$band"
	[ -n "$scs" ] && [ "$scs" != '-' ] && json_add_string scs "$scs"
	[ -n "$rsrp" ] && [ "$rsrp" != '-' ] && json_add_string rsrp "$rsrp"
	[ -n "$rsrq" ] && [ "$rsrq" != '-' ] && json_add_string rsrq "$rsrq"
	json_close_object
	json_select '..'
	zbt_quectel_cell_count=$((zbt_quectel_cell_count + 1))
}

zbt_quectel_parse_qscan()
{
	local response="$1" line parsed rat source arfcn pci band scs rsrp rsrq
	while IFS= read -r line; do
		case "$line" in *'+QSCAN:'*) ;; *) continue ;; esac
		parsed=$(printf '%s\n' "$line" | awk -F',' '
			function clean(value) {
				gsub(/^[[:space:]]+/, "", value); gsub(/[[:space:]\r]+$/, "", value)
				gsub(/^"|"$/, "", value); return value
			}
			{
				sub(/^[[:space:]]*\+QSCAN:[[:space:]]*/, "", $1)
				rat = clean($1)
				if (rat == "LTE")
					printf "LTE|Nearby scan|%s|%s|||%s|%s", clean($4), clean($5), clean($6), clean($7)
				else if (rat == "NR5G")
					printf "NR|Nearby scan|%s|%s|%s|%s|%s|%s", clean($4), clean($5), clean($13), clean($9), clean($6), clean($7)
			}')
		[ -n "$parsed" ] || continue
		IFS='|' read -r rat source arfcn pci band scs rsrp rsrq <<EOF
$parsed
EOF
		zbt_quectel_add_cell "$rat" "$source" "$arfcn" "$pci" "$band" "$scs" "$rsrp" "$rsrq"
	done <<EOF
$response
EOF
}

zbt_quectel_parse_qeng_neighbors()
{
	local response="$1" line parsed rat source arfcn pci band scs rsrp rsrq
	while IFS= read -r line; do
		case "$line" in *'+QENG:'*) ;; *) continue ;; esac
		parsed=$(printf '%s\n' "$line" | awk -F',' '
			function clean(value) {
				gsub(/^[[:space:]]+/, "", value); gsub(/[[:space:]\r]+$/, "", value)
				gsub(/^"|"$/, "", value); return value
			}
			{
				sub(/^[[:space:]]*\+QENG:[[:space:]]*/, "", $1)
				source = clean($1); rat = clean($2)
				if (rat == "LTE")
					printf "LTE|Network %s|%s|%s|||%s|%s", source, clean($3), clean($4), clean($6), clean($5)
			}')
		[ -n "$parsed" ] || continue
		IFS='|' read -r rat source arfcn pci band scs rsrp rsrq <<EOF
$parsed
EOF
		zbt_quectel_add_cell "$rat" "$source" "$arfcn" "$pci" "$band" "$scs" "$rsrp" "$rsrq"
	done <<EOF
$response
EOF
}

zbt_quectel_parse_serving_cells()
{
	local response="$1" line parsed rat source arfcn pci band scs rsrp rsrq
	while IFS= read -r line; do
		case "$line" in *'+QENG:'*) ;; *) continue ;; esac
		parsed=$(printf '%s\n' "$line" | awk -F',' '
			function clean(value) {
				gsub(/^[[:space:]]+/, "", value); gsub(/[[:space:]\r]+$/, "", value)
				gsub(/^"|"$/, "", value); return value
			}
			{
				sub(/^[[:space:]]*\+QENG:[[:space:]]*/, "", $1)
				one = clean($1); three = clean($3)
				if (one == "LTE")
					printf "LTE|Serving cell|%s|%s|%s||%s|%s", clean($7), clean($6), clean($8), clean($12), clean($13)
				else if (one == "NR5G-NSA")
					printf "NR|Serving cell|%s|%s|%s|%s|%s|%s", clean($8), clean($4), clean($9), clean($11), clean($5), clean($7)
				else if (one == "servingcell" && three == "LTE")
					printf "LTE|Serving cell|%s|%s|%s||%s|%s", clean($9), clean($8), clean($10), clean($14), clean($15)
				else if (one == "servingcell" && three == "NR5G-SA")
					printf "NR|Serving cell|%s|%s|%s||%s|%s", clean($10), clean($8), clean($11), clean($13), clean($14)
			}')
		[ -n "$parsed" ] || continue
		IFS='|' read -r rat source arfcn pci band scs rsrp rsrq <<EOF
$parsed
EOF
		zbt_quectel_add_cell "$rat" "$source" "$arfcn" "$pci" "$band" "$scs" "$rsrp" "$rsrq"
	done <<EOF
$response
EOF
}

zbt_quectel_lock_status()
{
	local port="$1" lte_status nr_status lte_lock nr_lock
	lte_status=$(at "$port" 'AT+QNWLOCK="common/4g"' | grep '+QNWLOCK:' | sed -n '1p')
	nr_status=$(at "$port" 'AT+QNWLOCK="common/5g"' | grep '+QNWLOCK:' | sed -n '1p')
	lte_lock=$(printf '%s\n' "$lte_status" | awk -F',' '{gsub(/[[:space:]\r]/, "", $2); print $2}')
	nr_lock=$(printf '%s\n' "$nr_status" | awk -F',' '{gsub(/[[:space:]\r]/, "", $2); print $2}')

	json_add_object lockcell_status
	[ -n "$lte_lock" ] && [ "$lte_lock" != 0 ] && json_add_string LTE locked || json_add_string LTE unlock
	[ -n "$nr_lock" ] && [ "$nr_lock" != 0 ] && json_add_string NR locked || json_add_string NR unlock
	json_close_object
}

zbt_quectel_get_cells()
{
	local port="$1" capability scan_response neighbor_response serving_response before
	zbt_quectel_cell_count=0

	json_add_object Feature
	json_add_string Unlock 2
	json_add_string 'Lock PCI' 1
	json_add_string 'Reboot Modem' 4
	json_add_string 'Manually Search' 3
	json_close_object
	json_add_array NR
	json_close_array
	json_add_array LTE
	json_close_array

	capability=$(at "$port" 'AT+QSCAN=?')
	if printf '%s\n' "$capability" | grep -q '+QSCAN:'; then
		scan_response=$(zbt_quectel_long_at "$port" 'AT+QSCAN=3,1')
		case "$scan_response" in
			*'+QSCAN:'*) ;;
			*ERROR*) scan_response=$(zbt_quectel_long_at "$port" 'AT+QSCAN=3') ;;
		esac
		zbt_quectel_parse_qscan "$scan_response"
	fi

	# Older firmware may lack QSCAN, and a network may occasionally return an
	# empty active scan. Preserve the fast network-reported neighbor fallback.
	if [ "$zbt_quectel_cell_count" -eq 0 ]; then
		neighbor_response=$(at "$port" 'AT+QENG="neighbourcell"')
		zbt_quectel_parse_qeng_neighbors "$neighbor_response"
	fi

	# Always include the registered serving LTE/NR cell. QENG neighbour output
	# can legitimately be empty (especially in 5G SA), which must not become the
	# misleading claim that there are no cell towers at all.
	serving_response=$(at "$port" 'AT+QENG="servingcell"')
	zbt_quectel_parse_serving_cells "$serving_response"
	zbt_quectel_lock_status "$port"
}
