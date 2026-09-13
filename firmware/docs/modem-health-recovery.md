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

Default recovery settings, applied once on a kept-config upgrade as requested:

| Setting | Default |
| --- | --- |
| Recovery service / actions / both slots | Enabled |
| Per-modem action | GPIO power-cycle, then explicit targeted dial |
| Optional redial attempts before GPIO | 0 (1 or 2 can be selected) |
| Check interval | 30 seconds, plus probe execution time |
| Failed observations before action | 4 |
| Successful observations to clear a failure streak | 3 |
| Startup grace | 120 seconds; no action occurs before this expires |
| Minimum cooldown between attempts | 180 seconds after the attempt |
| Maximum recovery requests | 3 per physical modem per hour |
| Power-off pulse / enumeration wait | 3 seconds / up to 60 seconds |

The watchdog reads RX-error growth and QMI child-loss markers. With optional
redial-first enabled, either condition bypasses soft retries when connectivity
also fails. High error counters **alone** do not reset a working connection.
Counters and cooldowns survive dialer/service restarts in RAM; reboots start a
new grace period. Long outages can still be retried in later hourly windows.
The cooldown is measured from a completed recovery request, so it cannot delay
the first confirmed boot failure when no recovery action has occurred yet.

Recovery stops and waits for only the selected procd instance, verifies fixed
GPIO readback, waits for a newly enumerated interface, then explicitly starts
that slot. USB hotplug cannot start a competing instance during the operation.
The peer and WAN priority are untouched. Recovery shares the adaptive 5G radio
lock and is excluded during a live mode trial. An interrupted owned power-off
pulse is restored; an unmarked manual power-off is not reversed.

Each enabled QModem slot also has a persistent procd startup worker. It waits
for that physical slot's exact USB path, single netdev and owned AT port before
launching the dialer. If enumeration finishes after the initial service pass,
the worker continues retrying rather than requiring a manual Dial click. A
dialer exit respawns through the same readiness gate and cannot borrow the peer
modem's netdev or serial port.

The separate QModem monitor remains disabled so it cannot race the central
watchdog. Later user recovery opt-outs survive upgrades and routing presets.
Bridge-passthrough modems are not probed/reset for lacking a router WAN address.

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
