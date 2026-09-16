# Mega Speedify repair review — September 2026

Scope: OpenWrt Mega Edition only. Reviewed all 482 lines of the newly supplied
Speedify troubleshooting export. The private transcript and its router password
are not included in the repository, image, build logs or release assets. No SSH
commands or account operations from that transcript were replayed on a router.

## What the transcript actually establishes

1. The agent reports eventual paid-account activation (`CONNECTED`) after the
   activation callback succeeded. It explicitly says it made **no on-device
   source patch** to achieve activation. Initial `ERROR_NO_ROUTER_LICENSE`
   responses therefore are not proof of a permanently unlicensed account.
2. It removed `connectify0` from LAN/WAN firewall device lists, retained a single
   Speedify zone, enabled masquerading/MSS clamping and LAN forwarding. This bug
   is independently visible in the pinned 17.1.0-r12947 vendor networking script.
   The user reported this change alone was insufficient.
3. It reports a PEP interception table and mark-to-local route without a listener
   on 127.0.0.1:9332. Turning PEP off and restarting Speedify removed that path.
   The user then explicitly confirmed Internet worked, but was slow.
4. Speed mode, zero fixed delay and PEP off were applied. The user reported
   client throughput was still about 0.5 Mbps, despite faster router-local tests.
5. Both hardware and software flow offloading were disabled. The transcript
   reports no remaining live flowtable, and working tunnel routes. It ends by
   asking the user for another LAN test: **no final client throughput confirmation
   is present**. Most underlying SSH command output is not included in this
   export; those observations are the other agent's reported findings.

## Durable implementation

- `speedify-routing.sh` implements a repeatable firewall repair. Stable section
  IDs handle anonymous/named zones and duplicate forwarding. It preserves
  unrelated interfaces, LAN-to-WAN fallback, modem metrics and MultiWAN rules,
  and defers when LuCI has pending firewall edits or a Speedify zone contains
  ambiguous custom members.
- Speedify is explicitly off by default on fresh and kept configurations that
  have no owner choice. Both the ROM setup page and installed vendor wrapper
  expose the same authenticated **Enable Speedify** control.
- When enabled, `zbt-speedify-guard` starts after the vendor daemon and detects
  committed firewall changes after APK
  reinstalls. It does not reload an unchanged firewall on every poll.
- Both flow-offloading switches are turned off when tunnel default/split routes
  or PEP interception exist. A stale live fw4 flowtable is also reloaded away.
  Automatic restoration is intentionally omitted: it must not override TTL,
  another VPN, or an administrator's offload policy.
- The transcript's throughput profile is a **one-time** read-before-write,
  read-back-verified migration, not a constant override. Native settings remain
  editable afterward. It never logs out, erases account identity, changes bands,
  changes routing metrics, or restarts the modem/network services.
- PEP recovery requires three absent-listener checks, with another immediate
  listener check before action. It uses `pep off` and narrowly scoped kernel
  cleanup instead of repeatedly restarting the whole VPN. Healthy IPv4 PEP is
  left running if the user later enables it.
- Turning Speedify off stops and disables the installer, guard, daemon and web
  helper, removes every forwarding to/from its zone and strips leaked
  `connectify0`/Speedify memberships from other zones. LAN-to-WAN fallback and
  unrelated policies remain. Cleanup defers rather than committing pending
  owner firewall edits.
- The activation-status RPC remains read-only and the separate authenticated
  enable method changes only the lifecycle setting before applying it. The
  wrapper represents pending, confirmed and failure states without rewriting
  vendor onboarding flags. The pinned native
  UI already persists completed-intro state; the transcript provides no tested
  vendor UI patch to import. The recheck button does not request an activation
  code or reload the iframe. Two-minute guidance is not a claim that a license
  request has permanently failed.

## Validation and limits

Regression tests cover firewall ownership, duplicate/alias membership, pending
edits, profile migration and failures, split IPv4/IPv6 routes, offload state,
PEP port/listener parsing, exact cleanup scope, and activation states. Tests
for real nftables/policy-routing cleanup run in a disposable network
namespace; image validation also runs the actual ARM64 UCI binary against
temporary configurations. Chromium
tests use the checksum-pinned vendor Angular UI on desktop and mobile, with
simulated daemon/account responses. They cannot certify a real subscription,
carrier capacity, radio performance or client download rate.

After installing, verify both Ethernet and Wi-Fi client Internet access and run
client speed tests alongside router-local Speedify tests. If a large discrepancy
remains, capture retransmission/MTU/path evidence; do not infer a band/priority
problem from a router-local throughput number alone.

Vendor references: [CLI](https://support.speedify.com/article/285-speedify-cli),
[PEP](https://support.speedify.com/article/997-performance-enhancing-proxy-pep),
[OpenWrt installation and acceleration troubleshooting](https://support.speedify.com/article/918-openwrt).
