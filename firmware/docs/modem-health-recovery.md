# Mega modem health, GPIO recovery and unified LAN policy

This Mega-only follow-up reviews both September 13 Warp exports in full. The
modem transcript reports that an isolated GPIO cycle restored packet delivery
after repeated redials failed, with RX errors returning to zero. Its last message
correctly separates radio registration, actual Internet reachability, netifd
publication and routing policy. The Wi-Fi transcript contains recommendations,
not a demonstrated Wi-Fi-specific rule or applied fix. Neither export is shipped
with the firmware; credentials and subscriber identifiers are not retained.

## LEDs and recovery

5G1 and 5G2 now indicate **verified Internet**, not power or an assigned IP.
The fixed USB mapping remains Modem 1 = `4-1`/`4_1`/`5g1`, Modem 2 =
`2-1`/`2_1`/`5g2`. Successful probes on either IPv4 or IPv6 light that modem's
activity LED. Disabled, disconnected, unprobed or stale links are dark.
An explicit System → LED Configuration custom rule still takes precedence.

Health checks run even when recovery actions are disabled, so the LEDs still
work. Numeric ping targets are bound to the physical interface; a working peer
cannot satisfy a failed modem's probe. Each family has two targets. Either
working family prevents a whole-modem reset. IPv4 and IPv6 are reported separately.
If a network blocks ICMP, configure suitable reachable targets before relying on
automatic recovery. Signal strength and an assigned IP do not prove Internet.

Default recovery settings are applied on fresh installs. A corrective v4
migration also reapplies them once to affected kept configurations where the
daemon was running but recovery permission had remained off:

| Setting | Default |
| --- | --- |
| Recovery service / actions / both slots | Enabled |
| Per-modem action | One targeted redial, then GPIO power-cycle and dial if still offline |
| Redial attempts before GPIO | 1 (0 or 2 can be selected) |
| Check interval | 20 seconds, plus probe execution time |
| Failed observations before action | 3 |
| Successful observations to clear a failure streak | 3 |
| Startup grace | 60 seconds; no action occurs before this expires |
| Soft-redial verification window | 60 seconds |
| Minimum cooldown between attempts | 180 seconds after the attempt |
| Maximum recovery requests | 3 per physical modem per hour |
| Power-off pulse / restart dispatch | 8 seconds / immediate exact-slot worker registration |

The watchdog reads RX-error growth and QMI child-loss markers. A confirmed QMI
child loss receives the configured targeted redial first; growing RX errors
bypass that soft attempt and go directly to GPIO recovery. High error counters
**alone** do not reset a working connection.
Counters and cooldowns survive dialer/service restarts in RAM; reboots start a
new grace period. Long outages can still be retried in later hourly windows.
The cooldown is measured from a completed recovery request, so it cannot delay
the first confirmed boot failure when no recovery action has occurred yet.

Recovery stops and waits for only the selected procd instance and verifies fixed
GPIO readback. It then immediately registers that slot's persistent startup
worker; that worker waits for the newly enumerated USB path, netdev and owned AT
port instead of the recovery action timing out before enumeration completes.
USB hotplug cannot start a competing instance during the operation. The peer
and WAN priority are untouched. Recovery shares the adaptive 5G radio lock and
is excluded during a live mode trial. An interrupted owned power-off pulse is
restored; an unmarked manual power-off is not reversed.

Modem 1 and Modem 2 use independent procd health/recovery workers. LED and
MultiWAN reconciliation run in a third coordinator, so a slow conntrack scan,
MWAN repair or peer probe cannot stop one modem's failure counter. Every worker
logs its recovery gate values on startup and whenever they change, making an
actions-disabled state explicit in syslog.

Each enabled QModem slot also has a persistent procd startup worker. It waits
for that physical slot's exact USB path, single netdev and owned AT port before
launching the dialer. Initial session establishment is serialized only until the
selected slot holds an address for ten seconds (at most 60 seconds), preventing the backup's
first netifd/QMI setup from overlapping the primary. If enumeration finishes
after the initial service pass or the dialer later exits, the same worker retries
through its readiness gate rather than requiring a manual Dial click. It cannot
borrow the peer modem's netdev or serial port.

QModem's `state` field records discovery, while its global and per-slot
`enable_dial` fields are the user's administrative switches. A fixed-slot USB
remove/add or late-enumeration event can transiently leave discovery state as
`disabled`. That marker no longer deletes the slot's persistent dial worker,
blocks a watchdog redial, or prevents an already proven CM session from being
published to netifd. The startup worker still requires the exact physical USB
root, netdev and AT port before dialing; clearing `enable_dial` still stops the
slot and is never overridden.

The final QModem command dispatch follows the same rule. Earlier Mega images
fixed the readiness checks but left the inherited end-of-script `state=disabled`
branch in place, so a supervised `dial` retry could still execute `hang` after
readiness had succeeded. Fixed Modem 1 and Modem 2 slots now dispatch that dial;
unrelated dynamically discovered QModem sections retain the inherited behavior.

Automatic adaptive SA/NSA evaluation is explicit opt-in and additionally
requires six consecutive direct-health successes and no QMI-loss/recovery
marker. It cannot test or write a radio mode during the unstable period
immediately after a modem reconnects. Automatic preferred performs no background
evaluation or periodic radio write.

The separate QModem monitor remains disabled so it cannot race the central
watchdog. The corrective v4 migration restores central recovery once on an
affected upgrade; user opt-outs made afterward survive later upgrades and
routing presets. Bridge-passthrough modems are not probed/reset for lacking a
router WAN address.

## QMI and netifd

`proto=none` cannot accept netifd `notify_proto` updates. The new `zbtqmi`
protocol leaves dialing with QModem/CM but publishes observed external addresses
and default routes to netifd. It waits for both an address and a route, then
refreshes only that family's modem tracker. No second DHCP client, permanent
`wwan0`/`wwan1` assignment, learned IP in UCI, APN change or global network restart
is introduced. IPv6 companions bind directly to the detected modem, not to an
IPv4 parent that may never come up on an IPv6-only PDP.

A living CM is no longer destroyed by a 120-second mwan3-offline timer. The
watchdog independently tests the data path. A genuinely exited CM is cleaned
up and reported to recovery, with only its own addresses/routes removed.
After a session has successfully acquired a local address and default route,
loss of every local address/route path for three consecutive five-second checks
also ends only that session. Its persistent per-slot worker then redials it.
This covers a live CM process left behind after netifd loses its route, without
using another modem's health, a global network restart, or an Internet probe as
the decision.

## IPv6 and Wi-Fi/LAN failback

IPv4 retains `failover`; IPv6 gets `failover6`, with separate IPv6 trackers and
the same SFP → WAN → USB tether → Modem 1 → Modem 2 order. Configured wired IPv6
companions are included; no nonexistent upstream IPv6 service is invented.
IPv6-capable cellular interfaces join the existing WAN firewall zone unless
already assigned to a custom zone. Default WAN NAT66 allows LAN ULA addresses
to use different providers' prefixes. Explicit `masq6=0` is preserved; advanced
native-prefix/NPT setups remain the administrator's responsibility. Existing
LAN IPv6 addressing and router advertisements are preserved, not enabled or
forced. In particular, the board's IPv4-only/no-ULA default is not silently
reversed. LAN clients need an administrator-configured IPv6 prefix and appropriate
router advertisements (or working prefix delegation) to use the IPv6 policy.
The new policy/NAT66 does not invent a LAN prefix or carrier IPv6 service.
See [OpenWrt mwan3 IPv6 guidance](https://openwrt.org/docs/guide-user/network/wan/multiwan/mwan3).

Ethernet and Wi-Fi clients attached to LAN share the same routing decision.
The source audit found no built-in Wi-Fi-to-Modem-2 steering rule, so no invented
rule is deleted and no radio tuning is applied. One concrete timing gap is fixed:
the connected hotplug may run before the tracker publishes its first timestamp.
Periodic reconciliation retries verified failback after that publication.

Only NATed LAN flows with a lower-priority WAN's exact mark are expired, now for
IPv4 and IPv6 separately. Existing connections may need to reconnect; this is
not transparent migration of a TCP session between public addresses. Router,
extra VPN-marked, non-NAT and custom-policy connections are preserved. The
installed single-WAN policy and fresh health must agree before any expiration.
Explicit per-client or per-SSID rules are not overwritten.

`zbt-mwan-diagnostics` prints the installed policies, fresh tracked winners,
Wi-Fi network membership, custom rule selectors, dual-stack direct health,
policy routing rules and recent recovery/failback events. It does not print
wireless keys, APNs, modem account credentials or SIM IDs. Custom-rule origin is
reported as unverified rather than falsely attributing it to the firmware.

## Validation and remaining physical checks

Regression tests cover slot isolation, direct IPv4/IPv6 health, LED transitions,
disabled controls, interrupted pulses, cooldowns, escalation, hourly limits,
adaptive lock exclusion, external address publication and actual ARM64 UCI
upgrade behavior. Linux network-namespace tests use the pinned mwan3 policy
builder and forwarded packets from two bridged client ports (wired and simulated
Wi-Fi) over IPv4 and NAT66. Connection-tracking tests check selective expiration.
The pinned netifd/ubus/UCI sources were also compiled natively in an isolated
container: the actual protocol handler accepted the external IPv4/IPv6 address
and route updates while retaining CM-owned addresses. QEMU's route-netlink
handling stalled the ARM64 netifd fixture, so this particular test used that
native build, not an emulated router. ARM64 UCI migration tests passed separately.

This does not reproduce the physical Wi-Fi radio, carrier or GPIO electronics.
After flashing, verify both lamps against a per-modem Internet test, observe a
controlled outage/recovery, and compare simultaneous wired/Wi-Fi tests using the
same destination. Retain a configuration backup and local Ethernet access.
Radio speed improvements and the user's exact intermittent hardware fault have
not been independently measured by this build environment.
