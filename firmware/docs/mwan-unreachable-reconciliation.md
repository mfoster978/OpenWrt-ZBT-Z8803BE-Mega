# Mega: online modem, unreachable client policy

## Evidence and limits

The September 13 field report shows `2_1` online with tracking active, but the
installed IPv4 `failover` policy is `unreachable`. The active IPv4 client rule
targets that policy. Modem 2's bound LuCI speed test succeeds while Ethernet and
Wi-Fi clients cannot use the Internet. This establishes an unusable installed
client policy, not a radio-band explanation. It does not establish which
startup/hotplug event originally caused the disagreement, nor that Modem 1's
missing data session has been repaired.

MWAN3 keeps tracker state and policy-selection state separately. Its normal
connected hotplug synchronizes those states and rebuilds policies. The released
Mega worker only checked fresh tracker health before session cleanup; it skipped
cleanup when the installed policy disagreed, without repairing that disagreement.

## Source change

The health worker now invokes `zbt-mwan-apply`, which takes MWAN3's existing
procd lock non-blockingly and uses `mwan-reconcile.sh` to:

- require enabled dialing/tracking and prove a live supervised CM process owns
  the exact physical USB device, global address and default route before
  re-arming netifd; MWAN reachability is not circularly required before its
  tracker can start;
- restore a missing per-interface forwarding route only from that interface's
  existing main-table route, using MWAN3's own route/rule functions;
- resynchronize an incorrectly offline runtime policy state for a verified
  modem, and detect an installed last-resort `unreachable` rule despite a
  verified member in the configured policy;
- invoke the existing MWAN3 policy builder with the existing configuration.

No UCI policies, metrics, weights, user rules, NAT zones or Wi-Fi settings are
rewritten. No modem is redialed/reset by this path. Disabled sessions, adaptive
maintenance and pending network/MWAN edits are respected. If an enabled,
supervised session's tracker remains paused after targeted ifup, the helper
releases MWAN's procd lock and performs the normal MWAN service restart that
recovered the captured router, limited to once per interface per minute. It
does not restart netifd or the network. Subsequent healthy passes are read-only.
Logs use `zbt-mwan-reconcile`; `result=dispatched` means a rebuild was requested,
not that end-user connectivity has been independently verified.

The reconciliation runs with the existing health loop (normally 30 seconds
plus probe time), including when automatic destructive recovery is disabled.
For a supervised live QMI session, it also clears a retained generated
`network.<slot>.disabled` option before retrying publication. That option makes
netifd omit the logical interface completely, so setting `auto=1` or sending a
targeted `ifup` alone cannot repair it. Explicit QModem disable/bridge state is
still authoritative and is never overridden. Firmware-managed priority and
failover presets re-enable both MWAN trackers during the v12 upgrade migration;
custom routing policies remain untouched.
The built-image guard requires the library and compares it and the entry point
byte-for-byte. The watchdog package release is incremented for its changed worker.

## Automated validation

`firmware/tests/mwan-reconcile.test.cjs` covers idempotence, an unreachable policy
with already-online hotplug state, pending configuration, paused/stale/disabled
or dead trackers, device re-enumeration, family-specific health and missing or
unrepairable forwarding routes. The production health/tracker freshness helpers
run against fixtures; no physical modem is contacted.

`firmware/tests/lan-policy-kernel.sh` uses the pinned MWAN3 policy builder and
real kernel routing, IPv4 NAT and IPv6 NAT. Two bridged veth clients represent
Ethernet and Wi-Fi, not physical radios. It reproduces a successful bound
Modem 2 probe with both clients blocked by `unreachable`, then executes the
production reconciler and verifies both clients can forward without interface
reconnection. It also tests a stale installed policy with correct runtime
hotplug state, and restoration of Modem 1 priority once verified healthy.

This does not simulate every netifd/procd startup event, certify first-boot
hardware behavior, or demonstrate survival of every existing TCP session across
a public-IP change. Consult the selected release's build identity and notes for
its published image and validation results. Physical-router acceptance remains
unverified until the affected router is flashed and retested.
