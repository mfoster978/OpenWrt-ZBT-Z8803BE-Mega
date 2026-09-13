#!/bin/sh
# QModem/CM owns the data call; this protocol only publishes its observed IPs.
. /lib/functions.sh
. ../netifd-proto.sh
init_proto "$@"
proto_zbtqmi_init_config() {
	no_proto_task=1
	available=1
	proto_config_add_defaults
	proto_config_add_string modem_config
}
proto_zbtqmi_setup() {
	# No fake ifup before the CM has an address and route. The supervised CM
	# sends notify_proto after observing the actual physical data interface.
	return 0
}
proto_zbtqmi_teardown() { return 0; }
add_protocol zbtqmi
