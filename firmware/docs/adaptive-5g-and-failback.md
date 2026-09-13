# Mega: adaptive 5G and verified WAN failback

## Review outcome

The September 13 router transcript was reviewed in full, including its final
requirements. It reports a successful targeted Modem 1 redial and a failover /
failback test. The raw exported terminal blocks do not independently establish
all reported results. Its adaptive performance selector was a proposal, not a
working implementation on the router. This release implements that proposal
with bounded testing and recovery; it does not claim a hardware speed result.

The early hard-coded `wwan0`/`wwan1` assignments and scalar `use_member` command
were mistakes subsequently corrected in that conversation. They are NOT replayed.
The existing Mega preset already generated proper lists and the requested order;
the regression test now starts with the malformed scalar and runs the actual
router UCI binary to verify repair. No private transcript, password, account or
SIM identifiers are included in the source or release.

## Routing ownership

The default IPv4 policy remains **SFP → copper WAN → USB tether → Modem 1 →
Modem 2**, with member metrics 1–5 and a real UCI `list use_member` entry for each.
The kept-configuration upgrade re-applies the managed failover preset. QModem
owns modem dialing and the dynamically detected physical USB netdev, not WAN
priority. No static `wwanN` binding, global network restart, SIM reset, APN change
or band rewrite is introduced.

The QMI supervisor now refreshes only its own mwan3 tracker when an IPv4 address
arrives after the initial proto-none ifup, or when an addressed tracker remains
paused/disabled. Retries are throttled to once per minute. The failed-session
cleanup and supervised redial from the previous release remain in place.

After a higher-priority WAN is both fresh/online and selected by the installed
failover policy, the hotplug hook expires only lower-priority, NATed IPv4 LAN
connections carrying that WAN's exact mwan mark. This covers Wi-Fi and Ethernet
clients on LAN equally. Applications may need to reconnect; an existing TCP
session cannot be transparently moved to another public address. It does not
globally flush conntrack, kill router-originated sessions, remove VPN-marked
flows, alter IPv6 flows or touch non-NAT connections. With custom policy rules,
pending UCI edits, or an unrecognized marking scheme it defers expiration instead
of overriding deliberate routing.

## Automatic adaptive

`auto_adaptive` replaces the legacy `auto_preferred` default. That old value is
accepted as an alias; the upgrade migration changes it to the new name. Explicit
`auto` (modem automatic, no tests), `nsa`, and `sa` policies are preserved.

The read-before-write transaction uses these settings and verifies readback:

| Selection | `mode_pref` | `nr5g_disable_mode` |
| --- | --- | --- |
| Automatic | `AUTO` | `0` |
| NSA | `LTE:NR5G` | `1` |
| SA | `AUTO` | `2` |

The selector controls SA/NSA availability, not carrier/tower scheduling. SA mode
retains automatic RAT selection rather than restricting the modem to NR alone;
LTE fallback does not qualify as a successful SA performance sample. These
selector meanings and serving-cell formats are documented in the [Quectel AT
manual](https://www.quectel.com/content/uploads/2024/05/Quectel_RG50xQRM5xxQ_Series_AT_Commands_Manual_V1.2.pdf).
The actual modem must return valid support and readback; a failed query defers
the trial, it is not labeled unsupported.

The procd worker waits until five minutes after boot; it does not block startup.
For each automatic modem it requires a verified IPv4 address, fresh online
MultiWAN tracker, HTTPS 204 reachability, a registered SA/NSA serving cell with
valid signal values, and explicit selector capability readback. It then:

1. Waits for another healthy WAN and 15 seconds with at most 64 KiB traffic on
   this modem. No interruption override is enabled by default.
2. Reserves the complete test budget before downloading any test payload.
3. Collects three 25 MB HTTPS downloads bound using `SO_BINDTODEVICE` to this
   physical modem. Address/device changes, extra traffic, deployment changes,
   failed responses and samples whose maximum exceeds 1.5× their minimum are
   rejected. The existing interactive speed-test lock prevents overlapping tests.
4. Rechecks idle/backup availability, journals the last verified setting in RAM,
   withdraws/pauses only this modem in mwan3, and applies the other deployment.
   The other trackers and WAN order remain unchanged; a disconnected candidate
   is never falsely kept online.
5. Requires the requested 5G registration and two consecutive bound reachability
   successes, resumes its tracker, and waits for it to become online before
   collecting three candidate samples.
6. Keeps the candidate only when **every candidate sample** exceeds **every
   baseline sample** by at least 15%. Otherwise it restores and verifies the last
   working selection. Failed recovery retains the journal and retries recovery,
   without permitting new comparisons. Worker crashes also retain that journal.

Radio transactions are mutually exclusive with UI and pre-dial writes. A trial
does not save a manual policy. Learned preferences exist only in RAM: boot starts
automatic again, and a fresh dial after connectivity loss drops a learned lock.
Policy, test accounting and a non-identifying result summary are persistent;
the persisted summary is never used as a radio setting.

## Limits and disabling tests

Defaults: at least 15 minutes between evaluation attempts, at most one reserved
comparison per hour, and **300 MB per modem per rolling 24 hours**. Each attempt
reserves 150 MB even if it fails partway; with default limits that permits at most
two comparisons and four planned selector transitions per modem per day (an
emergency fallback to automatic can add a recovery transition). Protocol / TLS
overhead and small reachability probes are additional. Limits survive restarts
and kept-configuration upgrades; invalid accounting or a backward clock fails
closed. The existing monitor stays off by default.

Choose **Modem automatic — no performance tests** in QModem to disable the
evaluator while allowing normal SA/NSA selection. Manual SA/NSA also disables
testing. Advanced users may set `qmodem.4_1.zbt_5g_daily_mb` and/or
`qmodem.2_1.zbt_5g_daily_mb` to `0`, `150`, or `300`; the default is runtime 300,
not an extra seeded configuration value. No first-boot benchmark runs before the
guard conditions are met. The UI reports waiting, testing and result status.

## Validation and limitations

Tests exercise real BusyBox shell parsing, read/write rollback, all five WAN
priority cases, quota persistence, guarded trials, sample integrity and lock
exclusion. Tests against the extracted router's ARM64 UCI verify list repair and
manual-policy migration. A disposable Linux network namespace uses real kernel
conntrack entries to verify lower-priority LAN expiration and preservation of
primary, router, VPN-marked and non-NAT flows. Final image checks verify the
worker, libraries, UI patch and startup service are actually installed.

The physical router and carrier were not accessed during implementation. A small
bounded HTTPS comparison is not a guarantee of maximum possible throughput or a
substitute for a sustained wired test. Congestion, plan limits, antennas, modem
firmware and the test endpoint still affect results. Trials can briefly interrupt
this modem even with an idle guard; the healthy backup carries new LAN traffic.
Read [mwan3's documentation](https://openwrt.org/docs/guide-user/network/wan/multiwan/mwan3)
for policy/connection-tracking behavior. Live SA/NSA convergence and carrier
performance still need confirmation on the actual router after flashing.
