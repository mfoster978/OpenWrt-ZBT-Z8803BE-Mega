# Mega MWAN lifecycle and SA/NSA selection — September 13, 2026

## What the report establishes

The router reports `4_1` disabled/paused with status `(31)` while a Modem 1
bound Internet test works. In the pinned MWAN3 reporter, 31 is the sum of
missing source/mark/unreachable routing rules, incoming interface chain and
default forwarding route. It is not a cellular error code or a reason to
change the user's APN, Wi-Fi or priority policy. Modem 2 remains the backup.
Without a live runtime snapshot, the exact event that stranded this router
cannot be established from the status text alone.

The source audit found and addressed these concrete failure paths:

* Follow-up dump: a kernel CM default route can exist while MWAN table 3
  and its rules are absent. Reconciliation previously required netifd to
  already be up, so it could never repair a missed CM publication itself.
  The first follow-up incorrectly treated netifd `autostart=false` as an
  intentional administrative stop. The supplied live-router transcript
  establishes the affected state exactly: `proto=none`, `up=false`,
  `pending=false`, `autostart=false`, a working CM address/default route and
  an enabled QModem session. The transcript's successful repair began with a
  targeted `ifup 4_1`. Reconciliation now re-arms that generated logical
  interface when and only when the QModem global/per-slot enable settings,
  live supervised CM PID, exact `-i` device, current ifindex, global address
  and device default route agree. Internet reachability is deliberately not a
  prerequisite for starting the MWAN tracker that owns that determination. An
  explicitly disabled modem, disabled MWAN tracking, bridge mode, foreign
  device, stale CM process or pending edit remains untouched. Legacy `proto=none` uses its verified
  kernel address without writing it to UCI; `zbtqmi` additionally publishes
  and verifies external address/route readback.
* The source of the stranded state was also present in the runtime: OpenWrt's
  `/sbin/ifup` performs a global network reload before every targeted down/up.
  Both QMI dialers called it for both address families during concurrent boot.
  Their UCI/reload operations are now serialized, configuration is loaded once,
  and direct ubus operations bring up only the selected slot. QMI session
  cleanup/start also uses serialized targeted ubus down/up, without a global
  reload. Generated QMI logical interfaces for enabled supervised sessions now
  use `auto=1`; the prior `auto=0` setting recreated the reported
  `autostart=false` state after an unrelated reload. QModem also issues an
  idempotent targeted ubus up on every live-session publication. Explicitly
  disabled QModem sessions are migrated to `auto=0` and remain down.
* MWAN3's generic resolver prefers an existing `4_1_4` dynamic child even
  when it is down and the base interface is up. Mega's explicitly owned
  `zbtqmi` interfaces now resolve to the exact parent where CM publishes.
  Ordinary non-Mega/dynamic interfaces retain upstream behavior.
* `mwan3 ifup` could return success without dispatching hotplug when netifd
  had no up/device result. The function and CLI now propagate failure.
* The captured paused tracker did not recover from a targeted MWAN ifup alone;
  the live router recovered after `ifup 4_1` followed by a normal MWAN service
  restart. Reconciliation performs that same restart after re-arming a proven
  live session, with a per-interface 60-second cooldown and after releasing
  MWAN's procd lock. It reads existing policies and does not edit them.
* CM passes an address with prefix and a session generation; the health
  worker passes a bare address without generation. Their different retry
  fingerprints defeated the shared cooldown. Both now use device + bare IP;
  paused retries remain bounded to once a minute.
* CM publication now verifies netifd's up state, physical device and all
  published source addresses before recording success or refreshing MWAN.
* MWAN package cleaning and byte comparisons of built lifecycle scripts
  prevent cached packages from silently omitting these changes.

UCI policies, weights, priorities and intentionally disabled interfaces are
preserved. No global network restart or radio reset is part of reconciliation;
a bounded normal MWAN service restart is used only for an enabled supervised
session whose tracker remains paused after targeted recovery.
`zbt-mwan-diagnostics` includes publication and configuration state plus the
reconciliation log. A dispatcher success is not proof of client connectivity.

## Research and design decision

[Teltonika RUTM50 Mobile](https://wiki.teltonika-networks.com/view/RUTM50_Mobile)
documents Auto/NSA/SA with Auto as the default. It does not document a router
download-test algorithm for choosing between them.

[Ericsson's NSA band-selection explanation](https://www.ericsson.com/en/blog/2024/7/data-driven-prioritization-of-5g-nsa-bands)
describes LTE anchor selection of NR secondary cells using configuration or
UE measurements. Network priorities and hysteresis affect that process.
[Ericsson's SA traffic-steering description](https://www.ericsson.com/en/blog/2023/5/advanced-traffic-steering-in-5g-standalone)
accounts for radio conditions, carrier aggregation and load. These are
network-side mechanisms, not evidence that consumer routers all run speed
tests or that the most bands/strongest signal always wins.

Consequently Mega keeps two distinct choices: **Modem automatic** delegates
selection without test downloads; **Automatic adaptive** is Mega's own
bounded end-to-end comparison, not an imitation of a published vendor
algorithm. Signal/serving mode validates a sample; throughput compares it.
It cannot guarantee globally optimal performance or predict a different
mode's throughput without connecting in that mode.

Quectel's public [Q-series AT manual](https://www.quectel.com/content/uploads/2024/05/Quectel_RG50xQRM5xxQ_Series_AT_Commands_Manual_V1.2.pdf)
documents the SA/NSA disable selector and immediate, automatically saved
changes. That manual is not specific to RM551E. Quectel's
[RM551E documentation reply](https://forumschinese.quectel.com/t/topic/6990)
names a separate E/V-series manual, but provides no accessible manual text
in the public reply. Therefore Mega still requires each modem's actual
capability query and readback; unreadable support never authorizes a write.

## Adaptive safety changes

Readiness is reconsidered each service pass (normally 60 seconds after the
five-minute startup grace), not stalled for 15 minutes after an early missing
IP/tracker. Actual trials retain the hourly and 300 MB/day per-modem caps.
Redial starts with modem automatic after loss of a verified connection;
there is no speed test on every redial and no permanent learned band lock.

A backup now needs fresh tracking, online policy state, forwarding table and
mark rule. IPv6 on the tested modem requires an IPv6 backup too. Both families
are withdrawn for a trial; live maintenance suppresses spontaneous hotplug
promotion. A dead worker's marker cannot indefinitely suppress hotplug.
Candidate transfers use MWAN's socket-mark bypass plus physical-device binding
and run before the modem is readmitted to client policy. Backup loss aborts
the trial and initiates rollback. An improvement requires three stable samples,
each at least 15% faster than the slow mode's fastest baseline sample.

These guards reduce disruption but do not guarantee uninterrupted existing
TCP/VPN sessions when public IP or mode changes. They defer comparisons when
safe prerequisites are absent. No physical-router test is claimed by the
automated suite; the release needs field verification on the affected router.

## Tests

`mwan-lifecycle.test.cjs` executes the pinned resolver/ifup and maintenance
guard with controlled netifd/procd inputs, including both slots and families.
`adaptive.test.cjs` covers candidate withdrawal, sampling-before-resume,
backup loss, IPv6 requirements, cooldowns, rollback and command binding.
`modem-health.test.cjs` exercises publication readback, idempotence and strict
device-bound HTTPS 204 fallback when a cellular path drops ICMP.
`netifd-publish-image.sh` runs the pinned native netifd/ubus/UCI builds with
the image's protocol libraries: backup first, primary pending with live CM
addresses, IPv4/IPv6 publication recovery, no repeated notifications,
unrelated network reload survival, explicit-QModem-disable preservation, and
the reported retained `network.4_1.disabled=1` state (where direct modem tests
work but netifd omits Modem 1), plus legacy `proto=none` and `autostart=false`
recovery while backup stays publishable. `mwan-apply.test.cjs` verifies lock-safe, rate-limited restart of
a tracker that remains paused after targeted recovery.
The separate isolated `lan-policy-kernel.sh` test sends real IPv4/IPv6 packets
from bridged veth clients through the pinned policy builder and reconciler;
veth clients model Ethernet/Wi-Fi forwarding, not physical radio hardware.
