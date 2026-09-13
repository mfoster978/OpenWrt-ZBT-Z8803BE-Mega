# September 2026 live-router review — Mega only

The owner supplied a Warp conversation containing live ZBT-Z8803BE checks,
attempted repairs and source edits. Its credentials, modem identifiers,
activation material and full transcript are deliberately not committed.

## Findings carried into the firmware

- **5G controls:** the released BusyBox has no `tr` character-class support.
  `tr '[:upper:]' '[:lower:]'` corrupts Quectel's name, rejecting valid ports
  before the AT read. The vendor check now uses a case-insensitive shell glob.
  SIM-number whitespace normalization also no longer depends on that `tr`
  feature. Warp verified Automatic/AUTO readback from both modems after its
  vendor fix. Existing read-before-write, verification, rollback and unchanged
  band-mask behavior are retained.
- **Wi-Fi / first boot:** the trace shows MT7996 firmware initialization timing
  out before any PHY registers. An empty wireless config is a consequence,
  not proof that SSID settings alone are wrong. Backport the four external
  PCIe clocks from [OpenWrt commit 2b25f66](https://github.com/openwrt/openwrt/commit/2b25f66d0a61edf7b9411432b6c920ad00f0f28b).
  Keep the already-present `966` Wi-Fi reset patch, GPIO7 on PCIe3 with 100 ms
  delay, board PCIe ranges and factory EEPROM mapping unchanged. Initial
  `-EPROBE_DEFER` clock messages alone do not prove this root cause: the trace
  subsequently enumerates PCIe devices. Actual cold/warm boot validation is
  still required to establish whether the clock backport resolves the timeout.
  Board defaults now wait for real PHYs, retain themselves when generation is
  incomplete, and never redirect deprecated `wifi detect` over wireless UCI.
  Remove the inherited five-second reload racing initial netifd startup.
  A bounded, non-blocking late worker retries pending defaults only after PHYs
  and netifd exist; custom SSIDs are preserved.
- **QMI data sessions:** Warp demonstrated an address/default route surviving
  failed device-bound probes and QMI disconnected/setup-error replies. Signal,
  an address, or `proto=none` metadata is not sufficient proof of Internet.
  The dialer now cleans its own child/PID/address/routes on failure and stop,
  explicitly re-arms its own logical interfaces for a new attempt, and returns
  to procd for delayed retry. Procd keeps retrying through long SIM outages.
  Physical USB ownership and ifindex are rechecked before any device flush;
  only the current child can be signalled. No blanket network restart or
  peer-modem shutdown is added.
- **Speedify:** Warp reports authentication reaching the daemon followed by
  `ERROR_NO_ROUTER_LICENSE` and later network errors, but explicitly did not
  verify activation. Keep native Speedify Sign In and activation URLs. A
  read-only panel now separates signed-in account from connected VPN, displays
  recognized recent daemon error categories, and never exports raw logs or
  tokens. A zero quota value or missing tunnel by itself is not proof of logout.
  See the official [router requirements](https://support.speedify.com/article/918-openwrt)
  and [license activation/transfer guidance](https://support.speedify.com/article/989-activating-moving-router-license).

## Deliberate differences from Warp's experiments

Warp's QMI experiments used a single `1.1.1.1` ping; an intermediate version
immediately restarted failed children. The final experiment handed retry to procd, but
the router became unreachable before verification completed. This is not
treated as a successful live acceptance test.

Mega now uses direct, physical-interface-bound IPv4/IPv6 health checks for its
central watchdog while MultiWAN independently owns routing priority. An exited
dialer is relaunched by its persistent per-slot worker. A sustained outage tries
one targeted redial and then the selected slot's GPIO; the peer is untouched.
Paused/stale trackers are not treated as proof of physical failure, and an
IPv6-only working session is not failed merely for lacking IPv4. Bridge
passthrough is excluded from router-address supervision. No band mask, carrier
MTU or routing priority is changed by recovery.

The cached build also now removes exact duplicate copies of its known mwan3
hook before applying it once, while refusing unrelated source changes.

## Required physical-router acceptance

Automated tests are not modem, licensing or RF performance certification.
After backing up configuration and flashing, use Ethernet for recovery access:

1. Test a cold boot, warm reboot and settings-preserving upgrade. Verify three
   PHYs, advertised SSIDs, hostapd startup and no MT7996 initialization timeout.
2. Read Automatic/NSA/SA on both physical modems. Apply an already-active mode
   and verify no write. Compare NSA versus automatic only where the carrier
   supports the LTE anchor; no mode guarantees higher throughput.
3. With modem1 healthy, verify a new Ethernet and Wi-Fi flow uses modem1.
   Remove its SIM, confirm failover to modem2, and check the failed child's
   address/default route disappears. Reinsert the SIM, wait for MultiWAN's
   recovery streak, and confirm new flows return to modem1. Existing tracked
   connections can stay on their original WAN until they reconnect.
4. Use Speedify's native Sign In; verify daemon account state and then VPN
   connected state. If license rejection persists, inspect the account's
   Manage Routers allocation with Speedify rather than repeating firmware
   flashes. Verify each intended bonding adapter separately.

The release's `verify-router-runtime.sh` is read-only and reports PHYs, PCIe
clock names, pending defaults, radio RPCs, route policy and redacted Speedify
status. Review diagnostic output before sharing it.
