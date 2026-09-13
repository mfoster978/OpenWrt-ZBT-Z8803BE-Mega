<p align="center">
  <img src="https://raw.githubusercontent.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE/v25.12.021/include/logo.png" alt="OpenWrt" width="420">
</p>

<h1 align="center">OpenWrt Mega Edition for ZBTLink ZBT-Z8803BE</h1>

<p align="center">
  Developed and maintained by <a href="https://github.com/mfoster978">Michael Foster · @mfoster978</a>.<br>
  A full-featured OpenWrt community firmware for the ZBTLink ZBT-Z8803BE Wi-Fi 7 router,
  with independent dual-cellular-modem controls, multi-WAN failover, live speed testing,
  integrated Speedify support, USB tethering and sharing, VPN tools, and guided firmware updates.
</p>

<p align="center">
  Practical add-ons. Custom-built features. Easy-to-set-up tools.<br>
  Turn your router into a versatile networking workhorse—and use only the features you need.
</p>

<p align="center">
  <a href="https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/actions/workflows/build-openwrt-firmware.yml"><img alt="Firmware build" src="https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/actions/workflows/build-openwrt-firmware.yml/badge.svg"></a>
  <img alt="OpenWrt 25.12.2" src="https://img.shields.io/badge/OpenWrt-25.12.2-00B5E2?logo=openwrt&logoColor=white">
  <img alt="Linux 6.12.74" src="https://img.shields.io/badge/Linux-6.12.74-FCC624?logo=linux&logoColor=black">
  <img alt="Target MediaTek Filogic" src="https://img.shields.io/badge/target-MediaTek%20Filogic-ED1C24">
  <img alt="Architecture AArch64 Cortex-A53" src="https://img.shields.io/badge/arch-AArch64%20Cortex--A53-5C4EE5">
  <img alt="Speedify integrated" src="https://img.shields.io/badge/Speedify-integrated-00A1DE">
</p>

<p align="center">
  <a href="https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/releases">Download releases</a> ·
  <a href="https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/issues">Issues &amp; feature requests</a> ·
  <a href="mailto:mfoster978@gmail.com">mfoster978@gmail.com</a> · Discord: <strong>mfoster978</strong>
</p>

> [!CAUTION]
> This firmware is only for the **ZBTLink ZBT-Z8803BE** device IDs listed below. A successful CI build proves that the source, packages, root filesystem, metadata, and images are internally consistent; it does not replace testing on physical hardware. Back up the router before flashing and keep a recovery method available.

> [!NOTE]
> **Speedify is supported and integrated in Mega Edition.** Its official packages are automatically downloaded, checksum-verified, installed, and exposed in LuCI after the router first obtains HTTPS connectivity. Users do not need to run a manual `wget | sh` installer. A Speedify account and any applicable subscription remain the user's responsibility.

## At a glance

| Component | Selection |
|---|---|
| Edition | **Mega Edition** — developed and maintained by [Michael Foster / @mfoster978](https://github.com/mfoster978) |
| Hardware | ZBTLink ZBT-Z8803BE / compatible ZBT-Z8803BE-T variant |
| SoC and Wi-Fi | MediaTek MT7988A / Filogic 880 with MT7996-family tri-band Wi-Fi 7 |
| OpenWrt | 25.12.2, revision `r32858-16347e93b6` |
| Kernel | Linux `6.12.74` |
| Build target | `mediatek/filogic` |
| Device profile | `zbtlink_zbt-z8803be` |
| SFP+ interface | 10GBASE-R / in-band status, up to 3 W module power |
| Baseline | [0xFar5eer/openwrt25.12_ZBT_Z8803BE](https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE) tag `v25.12.021` |
| Pinned baseline commit | `edc738504fe8fae81eb15de967456204699b1830` |
| Package format | APK |
| Primary image | SquashFS sysupgrade |

**Mega Edition is Michael Foster's firmware project.** Its development, edition-specific fixes and features, build configuration, releases, and ongoing maintenance are managed here by **@mfoster978**. Far5eer's working ZBT-Z8803BE firmware is the linked upstream foundation, not the maintainer of this edition.

The board target, Linux version, Wi-Fi and modem-driver sources remain pinned to that foundation. Mega adds its own dual-modem behavior, user interface, routing tools, update workflow, reviewed Ethernet LED changes, and the upstream MT7988 external PCIe clock wiring. The underlying OpenWrt, Linux, QModem, and other packages retain their original authorship and licenses; see [Credits](#credits).

The [September live-router review](firmware/docs/warp-router-review-2026-09.md) documents the BusyBox/5G fix, QMI session cleanup, PCIe clock backport, guarded Wi-Fi initialization, and Speedify activation diagnostics. It separates source/test results from physical-router checks still needed after flashing.

> [!IMPORTANT]
> Build success and automated checks are not hardware certification. Read the selected release's notes and the [repair and verification notes](firmware/docs/runtime-repair-2026-09.md) for confirmed causes, tests, and remaining on-router checks. Old build #17 predates the current repairs and is not a current recommended download.

## Choose your path

| You are… | Start here |
|---|---|
| Upgrading an existing compatible OpenWrt installation | Read [Download and flash](#download-and-flash), back up the current configuration, verify the SHA256, and use the SquashFS sysupgrade image. |
| Recovering through U-Boot | Follow [U-Boot recovery](#u-boot-recovery) and use the SquashFS sysupgrade image accepted by the device recovery page. |
| Running two cellular modems | Review [Dual-modem layout](#dual-modem-layout) and [Default routing behavior](#default-routing-behavior) before inserting or power-cycling modules. |
| Using wired WAN with cellular backup | The default `mwan3` policy prioritizes SFP, then copper WAN, USB tethering, modem 1, and modem 2. |
| Looking for connection bonding | Read [Speedify](#speedify) and [OpenMPTCProuter](#openmptcprouter) before choosing an architecture. |
| Connecting a phone, network drive, extroot disk, SMB share, or USB/IP device | Start with [USB tethering, storage and sharing](#usb-tethering-storage-and-sharing), then use the [complete setup and safety guide](firmware/docs/usb-tethering-storage-sharing.md). |
| Developing or auditing the firmware | Use [Build it yourself](#build-it-yourself), then inspect the resolved config, package manifest, checksums, and runtime verifier. |

## Your router, your features

Mega Edition combines a wide selection of add-on packages with custom-developed controls that improve the everyday router experience. Configure cellular connections, choose failover policies, measure performance, set up remote access, or add Speedify bonding from one firmware build. The tools are included so you can build the setup you want without assembling the integration yourself.

**Optional advanced automation is off by default.** Turn it on when you need it, configure it for your connection, or leave it off. Core networking is intentionally ready to use; “optional features off” does not mean the router boots with every service disabled.

| Feature | Default behavior / your choice |
|---|---|
| Core networking and normal `mwan3` failover | Active; faster wired-first priority failover is the starting point. |
| Modem 1 and Modem 2 | Enabled initially in Mega; later per-slot power, dialing and SIM choices are preserved. |
| Extra watchdog and automated recovery actions | Off until explicitly enabled and configured. |
| Modem 1 / Modem 2 routing | Modem 1 is always primary; Modem 2 is health-checked failover only. |
| Live Speed Test Utility | Runs only when you start a test; it does not automatically consume cellular data in the background. |
| Speedify | Dependencies are baked in and its first-online installer is enabled. Bonding still requires your own account and setup; no credentials are preconfigured. |
| Tailscale and OpenVPN | Available for your own account/tunnel configuration; no user VPN connection is preconfigured. |
| Android/iPhone USB tethering | Drivers and Apple pairing tools are ready; a supported phone binds to `usb_tether` after owner-side tethering/Trust setup. |
| USB storage, extroot, SMB shares, and USB over IP | Storage, ext4 formatting, and external-overlay tools are ready. Mounts, the KSMBD server, and the USB/IP server are not activated until the owner configures/enables them. |
| Firmware updates and downgrades | Explicitly requested and confirmed by you; no unattended flashing. |
| Root administrator password | A clean install starts without a shared factory password and requires root to set one at the first local LuCI login. An upgrade keeps the existing password. |

Installed does not mean every feature is actively controlling traffic. Keep unused optional services off, enable only what suits your setup, and avoid putting multiple routing managers in charge of the same traffic without reviewing their policies.

## Feature overview

### Mega About and firmware updates

- **About** is a desktop-ready, dark six-tab guide with dedicated Features, Speedify, USB & Sharing, Packages, installed-build, and project/credits content. It includes illustrations, developer/maintainer Michael Foster's email and Discord contacts, and special thanks to upstream developer [0xFar5eer](https://github.com/0xFar5eer).
- **System → Firmware Update** offers release checks, release notes, a verified SquashFS download, and an explicitly confirmed flash from this repository. Every entry shows both how long ago it was released and its exact date. New/current builds and older downgrade choices are presented in separate sections. Live download/validation progress scrolls into view immediately, and the final flash dialog shows an indeterminate write/reboot indicator. Keeping settings is off by default for downgrades.
- HTTPS, SHA256, local device identity and OpenWrt image checks are required. There is no forced/unattended flash or automatic rollback. Back up settings first. Old firmware without this tool requires the usual LuCI flash page for subsequent updates.
- These features are **Mega-only**; Minimal retains its original About screen and does not include this updater. See [behavior, safety and verification](firmware/docs/mega-firmware-updates.md) for the remaining on-router acceptance checks.

### Hardware and Wi-Fi

- Device-specific ZBT-Z8803BE support from the pinned Far5eer release.
- MediaTek Filogic 880 platform with MT7996-family tri-band Wi-Fi 7 support.
- 2.4 GHz, 5 GHz, and 6 GHz operation, including the upstream opt-in Wi-Fi 7 MLO interface.
- The pinned hostapd receives focused upstream AP-MLD interoperability fixes: correct partner-profile length accounting, per-link BSS change counters, valid EML capability fields, clean reassociation state, and reliable MLD reload/interface reuse. It also records key-free requested/accepted link bitmaps in `logread` so single-link negotiation can be distinguished from a link lost later in the stack.
- 10 Gb/s SFP+ (`10gbase-r`, in-band status), copper Ethernet, USB 3.0, ext4, vfat, exfat, block mounting, and SFTP support inherited from the baseline.
- ZBT temperature charts, health monitoring, fan information, modem LED services, event history, and device-specific LuCI styling inherited from the baseline.
- Mainline OpenWrt base without requiring a MediaTek vendor firmware feed.

### Cellular and modem support

- The router firmware is modem-neutral. The supplied hardware evidence uses dual Quectel RM551E-GL modules, but that model is not part of the firmware filename or a requirement; other modules still depend on their own electrical compatibility, Linux driver, QModem vendor support, connection mode, and carrier certification.
- QModem Next with LuCI modem controls, SMS, monitoring, and AT debugging.
- QMI and MBIM protocol support with `uqmi`, `umbim`, and the matching LuCI protocol handlers.
- USB QMI/MBIM, USB WDM, USB serial/Option, NCM, WWAN, and Quectel connection-manager support.
- PCIe MHI bus, network, control, MBIM, and generic PCI support for compatible MHI modems.
- Both physical modem slots are represented explicitly and mapped by their actual USB paths.
- Both modem power rails are seeded on during initial setup; later operator power choices are preserved.
- QMI/MBIM paths using `quectel-CM-M -d` use `proto=none`: the connection manager owns addresses and routes, with no competing DHCP client. ECM/RNDIS retain their protocol-specific behavior.
- A failed QMI child removes only its own modem's stale addresses/routes and notifies netifd before a delayed supervised retry. Existing MultiWAN probes remain the source of health and priority; a persistent failed data session can be recycled after 120 seconds. There is no new hard-coded ping target, radio reset or MTU override, and disabled optional monitors remain disabled.
- Both USB modems use the same startup, APN, protocol, and recovery logic. The connection manager applies the MTU reported for each data connection, rather than copying one carrier's value to everyone.
- Blank/auto QMI APNs retain modem/network profile negotiation. A directly identified AT&T US `310/410` SIM gets the data-device fallback `broadband`; every manual APN still wins. Both SIM selectors also offer editable presets for AT&T, FirstNet, T-Mobile, Verizon, Google Fi, and U.S. Cellular.
- SIM information reads the subscriber number from the full `AT+CNUM` response and falls back to the SIM's standard Own Numbers (`ON` / EF-MSISDN) phonebook. It says explicitly when neither store is provisioned; the modem cannot reconstruct an unrecorded number from ICCID or IMSI.
- QModem's nearby-cell button runs Quectel's full LTE/5G `AT+QSCAN=3,1` with its documented network-dependent timeout instead of treating a three-second timeout as an empty result. It falls back to `AT+QENG="neighbourcell"` and always includes the registered serving cell when available.
- Quectel carrier aggregation is reported in LTE, 5G NSA and 5G SA modes with every PCC/SCC, bandwidth, PCI, state and active/reported count returned by `AT+QCAINFO`; newer NR PCC layouts are not mislabelled as values such as “state 436.” The router does not impose or advertise a fake two-carrier limit.
- Advanced opens directly on **5G & Network Mode**, with **Automatic preferred**, **Automatic — SA + NSA**, **NSA only**, and **SA only**. Automatic preferred is carrier-neutral: it restores automatic network selection with SA and NSA available. NSA enables its required LTE anchor if needed. Both settings are read before writing, verified afterward, and restored where possible if verification fails. Already-matching settings are not written again; opening the page is read-only. Band masks remain unchanged.
- Band changes require a successful AT response and matching readback. Unknown masks have read-only diagnostics and Retry; reported bands stay separate from pending edits. See [per-modem band readback](firmware/docs/band-readback.md).
- Carrier TTL/hop-limit handling and modem NAT detection remain available per modem, but both policies are off on a fresh install so they do not silently disable flow offload.

### Multi-WAN and recovery

- `mwan3` and `luci-app-mwan3` are installed and enabled with deterministic first-boot defaults.
- Strict SFP → copper WAN → USB tether → modem 1 → modem 2 failover order, while automatically omitting an unavailable path.
- The legacy balanced policy remains compatible for non-cellular distribution, but keeps Modem 1 and Modem 2 in separate priority tiers.
- Default traffic, including speed-test ports, follows wired-first failover; balancing is an explicit user choice.
- **Network → MultiWAN Manager → Priority & Recovery** offers one-click normal or fast health failover plus per-modem recovery controls. Both presets keep Modem 1 ahead of Modem 2.
- The MultiWAN Interfaces tab owns the persistent route metric for every tracked link. QModem displays the cellular value read-only and cannot erase or override it during redial.
- Priority failover is enabled by default with faster recovery checks: SFP, copper WAN, USB tether, modem 1, then modem 2. When a preferred path becomes healthy again, new connections return to it automatically. Existing established sessions may remain on the backup until they reconnect.
- The additional modem-reset watchdog and destructive recovery actions remain disabled by default. The former speed-based Modem 2 promotion is retired and migrated back to strict Modem 1 priority.
- Recovery choices include log-only, disconnect, redial, or GPIO power-cycle followed by redial.
- Cooldowns and failure thresholds prevent rapid recovery loops.
- QModem supervises each physical modem separately. The old configuration-rewriting watchdog, shared restart hooks, and post-flash automatic modem reset have been retired.

### Connectivity tools and VPNs

- **Services → Speed Test Utility** is a live speed-test dashboard: a responsive speedometer updated from measured 250 ms samples, download/upload graph, ping/jitter, server selection, a USB phone-tether choice, and a Stop button. It performs real multi-connection transfers against **Speedtest.net servers**, using the pinned open-source [speedtest-go v1.8.3 client](https://github.com/showwin/speedtest-go/tree/v1.8.3), not the official Ookla app. First-time GO presents the terms/data-use confirmation and then runs automatic selection; the backend skips low-latency directory servers that cannot accept upload traffic. The cellular-tuned test uses up to 16 connections and 20-second transfer windows. There are no Save/Apply buttons or simulated speed values. See [how the live test works](firmware/docs/live-speedtest.md).
- Choose the current default route, wired WAN, SFP WAN, modem 1, or modem 2. Physical-interface binding prevents substituting the other modem when their private IP addresses overlap.
- `speedtest-netperf` and `speedtest-go` remain available separately at the command line.
- **Services → Tailscale** provides a locally packaged status/sign-in page; each user authenticates their own account. Advanced Tailscale route/exit-node options remain CLI-managed.
- OpenVPN with OpenSSL and its LuCI application are included.
- TUN, nftables/iptables compatibility, TPROXY, BBR, C++ runtime, atomic, and keyutils support are built against this exact kernel and userspace.

### USB tethering, storage and sharing

These capabilities are **Mega-only**. Nothing is silently shared. A supported attached phone is assigned the stable `usb_tether` DHCP interface and participates in MultiWAN after wired WAN but before either built-in modem.

| Capability | Where to start | Safe default and important behavior |
|---|---|---|
| Android USB tethering | Enable tethering on a data-capable cable; supported RNDIS/CDC Ethernet devices bind to `usb_tether`. | DHCP/MultiWAN is prepared automatically at route metric 100; confirm the device and carrier behavior before relying on it. |
| iPhone/iPad tethering | Enable Personal Hotspot, accept Trust and pair when required; `ipheth` binds to `usb_tether`. | `usbmuxd` and `libimobiledevice` tools are present; Apple/carrier behavior still depends on the device and account. |
| USB storage | Open **Services → USB Storage**, which links to OpenWrt's Mount Points page. | Mass-storage/UAS and ext4, exFAT, and FAT support are included. Media is neither auto-mounted into an unsafe guessed path nor automatically shared. |
| Expand writable storage with extroot | Prepare a dedicated ext4 partition, copy the current writable overlay, and configure it by UUID using the documented SSH procedure. | `block-mount`, `e2fsprogs`, `parted`, USB/UAS, and ext4 support are built in. This can provide room for larger compatible applications such as AdGuard Home, but it does not add RAM/CPU or enlarge the physical NAND. |
| SMB file sharing | Mount the filesystem first, then use **Services → Network Shares**. | KSMBD has an explicit **Enable server** switch that defaults off. Configure paths, users/guest policy, and trusted listening interfaces before enabling it. |
| USB over IP | Configure `/etc/config/usbipd`, then use the `usbip`/`usbipd` command-line tools to bind, export, list, or attach devices. | The server defaults off. The pinned feeds have no USB/IP LuCI app, and the service must never be exposed directly to an untrusted WAN. |

Extroot uses the USB drive as part of the running operating system: use reliable powered media, never unplug it while active, and keep a current backup and recovery path. Storage and exported devices can contain sensitive data. Use stable UUID-based mounts and restrictive firewall rules. See the [USB tethering, storage, extroot, KSMBD and USB/IP guide](firmware/docs/usb-tethering-storage-sharing.md) for setup order, checks, limitations, and rollback steps, and compare it with the [official OpenWrt extroot guide](https://openwrt.org/docs/guide-user/additional-software/extroot_configuration) before changing a disk.

### Build integrity and safety

- OpenWrt source tag and commit are pinned; a mismatched resolution stops the build.
- The original Far5eer release configuration is preserved as the device baseline.
- Required target, modem, MHI, VPN, Speedify-support, and custom LuCI package symbols are checked after `make defconfig`.
- A successful build must contain the required packages in the final image manifest.
- Custom first-boot and service files must be present in the assembled MediaTek root filesystem.
- Both non-empty ZBT-Z8803BE initramfs and SquashFS sysupgrade images are required before firmware is uploaded.
- Failed or cancelled jobs upload diagnostics only; they cannot publish partial binaries as validated firmware.
- GitHub Actions removes unused runner SDKs and verifies at least 40 GiB is available before compiling.
- Workflow concurrency permits one firmware build at a time and cancels superseded runs.

## Dual-modem layout

| Logical modem | QModem section | Physical USB path | Power control | Default metric | Startup state |
|---|---|---|---|---:|---|
| Modem 1 | `4_1` | `4-1` | `5g1` | 200 | Enabled |
| Modem 2 | `2_1` | `2-1` | `5g2` | 210 | Enabled |

Physical SIM wiring can differ between board revisions. Preserve a working SIM selection and confirm the selected modem reads the intended card before changing any SIM-routing setting; a software slot label is not an electrical wiring test.

QModem's **SIM Slot 1** refers to the SIM input inside the selected modem. Both modules can correctly report slot 1 while reading different cards. It is not the same numbering as the board's SIM sockets. These repairs do not change SIM GPIO routing.

| Indicator/control | Modem 1 | Modem 2 |
|---|---|---|
| Power enable (active-high) | GPIO 17 / `5g1` | GPIO 52 / `5g2` |
| Status LED (active-low) | GPIO 61 / `blue:mobile-1` | GPIO 53 / `blue:mobile-2` |
| Network identity used by QModem and mwan3 | `4_1` | `2_1` |

These GPIO numbers follow the pinned device tree. Each 5G indicator is a single physical green LED even though its stable kernel name begins with `blue:`. An absent, unpowered slot is dark; a powered or enumerated modem blinks slowly while awaiting an address; an addressed modem uses link/traffic indication. If a trigger or reliable carrier indication is unavailable, it falls back to steady illumination. The multicolor SYS lens preserves blue for no Internet and green for Internet access. It shows red when Internet remains available but a powered/present modem lacks a data session, solid green while idle, and blinking green during cellular traffic. The three LAN-jack indicators and single copper WAN-jack indicator are physical orange LEDs. They are configured to stay solid with link and blink on RX/TX through MediaTek PHY hardware offload. LAN metadata retains `green:lan`; the newly exposed WAN lamp is `mdio-bus:0f:amber:wan`, bound to `eth1`. The WAN repair enables the existing board LED0 pin and backports the missing Ethernet LED callbacks; it does not change modem power/SIM pins or the kernel version. Physical behavior still needs confirmation after flashing.

All exposed LEDs appear under **System → LED Configuration**. Adding a custom rule for either 5G LED or any SYS color hands that LED to the user configuration and prevents the automatic modem controller from overwriting it.

QModem menus, dropdowns and dial-log titles show **Modem 1** / **Modem 2**. The editable Modem Alias is stored as a display name, separate from the stable internal `4_1` / `2_1` routing identities. Upgrades also repair those internal IDs if an older UI saved one as the visible name. Changing a display name does not restart either modem.

**QModem → TTL** provides an independent enable switch and automatic/custom TTL for each modem. Use different IPv4 TTL / IPv6 Hop Limit values, or enable modification on only one modem. Rules follow the physical slots, not changing `wwanN` names. Both policies are opt-in because enabling either one disables flow offloading globally. See [TTL controls, migration and tests](firmware/docs/per-modem-ttl.md).

QModem's cell information now reads Quectel `AT+QCAINFO` in LTE, 5G NSA and 5G SA modes. It lists every PCC/SCC the modem reports and distinguishes active secondary carriers from configured-but-idle carriers. This removes the misleading combined “2 CA” label; it does not force an unsupported tower/carrier combination. See [carrier aggregation and throughput diagnosis](firmware/docs/carrier-aggregation-and-throughput.md).

The Advanced nearby-cell action is a real modem search, not a refresh of the passive neighbor list. On supported Quectel modules it uses `AT+QSCAN=3,1` for LTE and NR cells and can take up to three minutes depending on the network. If full scan is unavailable or returns no records, Mega reads the network-reported `AT+QENG="neighbourcell"` list and the current serving cell instead.

The first Advanced tab, **5G & Network Mode**, shows the saved policy, actual radio setting, allowed network types, and whether this modem has an IPv4 data address. A failed AT query shows its diagnostic response and **Read settings again**, not a claim that the hardware is unsupported. **Automatic preferred** is the carrier-neutral default; it no longer forces NSA based on the SIM operator. The shared startup/UI transaction prevents an NSA choice from leaving LTE disabled and attempts rollback if a change fails verification. A modem with signal but no data address is not ready for an IPv4 speed test. MultiWAN health checks—not QModem signal strength—decide Internet availability and failover. Actual throughput still depends on the network, radio conditions and plan.

The Mega build also patches the board's **first-boot RPC overlay**, not only the feed package: the inherited soft-reboot installer previously replaced the new backend with a copy that lacked both 5G methods. Regression tests now run that installer and call both methods for both modem slots. Its existing reboot/cooldown and input-validation protections are retained. Direct AT requests now use a kernel-released, per-device lock; queued requests cannot overlap on the same port, and killing a request cannot leave a stale semaphore blocking later reads. These repairs do not change MultiWAN priorities or promise a particular cellular speed.

Every firmware version is also used as LuCI's resource cache key. After an upgrade, the browser therefore loads the matching QModem, About, updater, Speedify and utility JavaScript instead of retaining a script from the preceding image. On the first boot after an upgrade, the LuCI health check waits for the normal uWSGI and nginx startup to settle before attempting a repair.

The September 10 follow-up repairs LED startup ordering and trigger restoration without touching modem power or SIM GPIOs. Run `zbt-modem-led-poller status` for read-only LED diagnostics. See the [follow-up notes](firmware/docs/runtime-repair-2026-09.md#september-10-led-and-label-follow-up) for the remaining modem 2 registration check.

The firmware does not infer a live modem merely because a UCI section exists. Runtime recovery is tied to a physically enumerated USB path, which prevents activity on one slot from needlessly repowering or redialing the other.

## Default routing behavior

The default IPv4 policy is failover, not bonding. The first number is the persistent, unique Linux/netifd route metric shown in the MultiWAN Interfaces tab; the second is the MWAN policy tier shown in Members:

```text
SFP WAN        route 9   / MWAN tier 1
  ↓
Copper WAN     route 10  / MWAN tier 2
  ↓
USB tether     route 100 / MWAN tier 3
  ↓
Modem 1 (4_1)  route 200 / MWAN tier 4
  ↓
Modem 2 (2_1)  route 210 / MWAN tier 5
```

Each available interface is monitored with two public ping targets and `reliability=1`. The default catch-all rule uses the `failover` policy. The legacy `balanced` policy name may still exist for compatibility, but its cellular members also use distinct tiers: it cannot promote Modem 2 while Modem 1 is healthy. Route-metric changes are made inside MultiWAN Manager and persist in `/etc/config/network`; QModem is responsible only for establishing the cellular data sessions.

> [!NOTE]
> `mwan3` distributes connections and provides failover. It does not combine multiple links into a faster single TCP flow. That requires a bonding service with a remote endpoint, such as Speedify, or a separate OpenMPTCProuter deployment.

## Modem watchdog

Open **Network → MultiWAN Manager → Presets & Recovery** in LuCI to configure:

- recommended one-click wired-first priority or faster health failover, both with Modem 1 before Modem 2;
- service enablement and a separate permission switch for recovery actions;
- check interval, ping target, consecutive-failure threshold, and recovery cooldown;
- per-modem monitoring and recovery action;
- the fixed physical identity/power mapping (displayed for reference, not freely editable).

The safe defaults are:

| Setting | Default |
|---|---:|
| Watchdog service | Off |
| Recovery actions | Off |
| Check interval | 30 seconds |
| Ping failures before action | 4 |
| Recovery cooldown | 180 seconds |

Start with monitoring only. Confirm that interface names, APNs, and ping behavior are correct before enabling redial or power-cycle actions.

The separate interactive Speed Test Utility uses Speedtest.net servers and **can consume hundreds of MB or exceed 1 GB per run**; it requires an explicit data-use confirmation. It does not alter the MWAN priority policy.

Only fresh, successful samples count toward the speed threshold. DNS, TLS, timeout, and server failures are not fabricated as zero Mbps. Speed demotion changes only the project's cellular failover-member preferences in RAM, retaining both wired WAN priorities. Custom member layouts are left alone. Existing flows may remain on their original link; this is not seamless bonding. Slow throughput alone never triggers a modem power cycle.

## Speedify

Speedify is optional proprietary software and is not embedded with credentials. Version `17.1.0-r12947` is installed on the first boot that has working HTTPS connectivity.

The firmware already contains every required dependency built for its kernel and architecture:

- `ca-bundle`, `curl`, `kmod-tun`, `libstdcpp6`, `libkeyutils1`, and `libatomic1`;
- `iptables-nft`, TPROXY, BBR, extra iptables modules, and conntrack-extra;
- `luci-nginx` and `python3-light` for the optional LuCI application.

The installer:

1. confirms the router APK architecture is `aarch64_cortex-a53`;
2. waits for internet access without blocking normal router startup;
3. downloads the pinned core and LuCI APKs over HTTPS with retries;
4. rejects either file unless its reviewed SHA256 matches;
5. installs only the downloaded local APKs with `--no-network`, preventing an ABI-mismatched kernel module from being pulled later;
6. installs a thin HTTPS LuCI wrapper that keeps the router menu visible and leaves sign-in/account handling to Speedify's official dashboard;
7. starts and health-checks Speedify, its web service, nginx, and both the HTTP and HTTPS LuCI routes;
8. keeps nginx and its authenticated Speedify routes in place if a service health check fails; retries do not reinstall already-present packages or repeatedly run vendor network setup;
9. records completion only after all selected services pass.

To install the Speedify core without its LuCI application, set this before the first successful installation:

```sh
uci set speedify_bootstrap.main.install_luci='0'
uci commit speedify_bootstrap
```

Useful status checks:

```sh
logread -e speedify-installer
/etc/init.d/speedify status
apk info -e speedify
```

Speedify accounts, licensing, privacy, and service availability are governed by Speedify/Connectify. Inclusion of an installer does not imply sponsorship or endorsement.

## OpenMPTCProuter

OpenMPTCProuter is **not included** and is not offered as a package toggle. It is a separate firmware distribution with its own patches, metapackages, build process, configuration model, and companion server. Installing a few feed packages would not turn this Far5eer-based image into a supported OpenMPTCProuter system or provide working aggregation.

The generic Linux MPTCP capability inherited from the OpenWrt/Far5eer kernel remains enabled. It installs no OpenMPTCProuter service or interface and is inactive unless software explicitly configures it. Retaining that kernel capability preserves the upstream device configuration.

## Download and flash

Download from [Mega Edition releases](https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/releases). A release may be compiled on the maintainer's local server or in GitHub Actions; its `BUILD-INFO.txt` identifies the exact recipe commit and build provenance. Publication requires validated device-specific images and checksums. Gemini generates evidence-bound release notes using a GitHub repository secret; no API key is included in the firmware.

### Which file do I need?

| Release asset | Purpose |
|---|---|
| `OpenWrt-Mega-Edition-ZBT-Z8803BE-sysupgrade-firmware-YYYYMMDDHHMM.N.bin` | Normal firmware upgrade for the supported router. The filename ends with the same firmware version shown by the release and Mega updater. |
| `OpenWrt-Mega-Edition-ZBT-Z8803BE-initramfs-firmware-YYYYMMDDHHMM.N.bin` | Temporary boot / advanced recovery, not a normal persistent upgrade. |
| `OpenWrt-Mega-Edition-ZBT-Z8803BE-packages-firmware-YYYYMMDDHHMM.N.manifest` | Exact package inventory for that versioned image. |
| `SHA256SUMS`, `BUILD-INFO.txt`, `mega-release-v2.json` | Download integrity, build provenance, and machine-readable Mega identity. |
| `RELEASE_NOTES.md`, `verify-router-runtime.sh` | Changes, upgrade caveats, and a read-only diagnostic helper. |

Use the checksums attached to the **same release** as your download; hashes from an older build are not interchangeable. The publication workflows do not upload a full OpenWrt source/build tree or package archive. GitHub still displays its automatically generated “Source code” links for release tags; those are not firmware images.

A corrective transition release can also contain byte-identical unversioned sysupgrade aliases for updater compatibility. They are not different builds. Manual downloads should use the versioned `OpenWrt-Mega-Edition-...` file; the updater automatically chooses the safest compatible name for the firmware generation currently installed.

After the repository's Mega Edition rename, development images whose updater still references the former repository name may require a one-time manual upgrade through **System → Backup / Flash Firmware**. The new image's updater and embedded identity use the new repository; their safety checks are not bypassed to follow an arbitrary redirect.

The sysupgrade metadata identifies:

```json
{
  "dist": "OpenWrt",
  "version": "25.12.2",
  "revision": "r32858-16347e93b6",
  "target": "mediatek/filogic",
  "board": "zbtlink_zbt-z8803be"
}
```

Supported device IDs embedded in the image are:

- `zbtlink,zbt-z8803be`
- `zbtlink,zbt-z8803be,mt7988a-nand`

No factory image is produced by this device profile. The SquashFS sysupgrade image is the normal upgrade/recovery upload. The initramfs image is intended for temporary boot or advanced recovery workflows, not as a substitute for the sysupgrade image.

### Before flashing

1. Confirm the router model and board revision.
2. Export an OpenWrt configuration backup and separately record modem APNs, PINs, TTL settings, and custom firewall rules.
3. Download the artifact and verify the SHA256 locally.
4. Connect by Ethernet and use reliable power. Do not upgrade over a cellular or Wi-Fi link that may disappear during reboot.
5. Keep U-Boot recovery access available.

Example checksum verification:

```sh
sha256sum -c sha256sums
```

### Existing OpenWrt

Upload the SquashFS sysupgrade image through LuCI, or copy it to the router and run:

```sh
sysupgrade OpenWrt-Mega-Edition-ZBT-Z8803BE-sysupgrade-firmware-YYYYMMDDHHMM.N.bin
```

For the cleanest first installation of this customized build:

```sh
sysupgrade -n OpenWrt-Mega-Edition-ZBT-Z8803BE-sysupgrade-firmware-YYYYMMDDHHMM.N.bin
```

The `-n` option discards existing configuration. Do not use it unless the backup is complete and a clean configuration is intended.

### U-Boot recovery

1. Disconnect unnecessary USB devices and connect a computer to Ethernet.
2. Hold **Reset** while applying power until the recovery interface starts.
3. Open `http://192.168.1.1`.
4. Upload the versioned `OpenWrt-Mega-Edition-ZBT-Z8803BE-sysupgrade-firmware-YYYYMMDDHHMM.N.bin` file.
5. Do not interrupt power. Allow several minutes for writing, first boot, and overlay initialization.

A clean Mega installation has no shared `admin` password. Open `http://192.168.1.1`, sign in locally as `root` with the initially empty password, and LuCI will require a new root password before exposing the rest of administration. A settings-preserving upgrade keeps the existing root password.

## First-boot checklist

- Complete the required root-password setup on the first local LuCI login.
- Wi-Fi defaults to the US regulatory domain on 2.4, 5 and 6 GHz. Transmit power remains automatic so the driver honors the lower of the US limit and the board's calibrated EEPROM limit. The mobile-compatible 6 GHz profile is capped to the FCC very-low-power class (14 dBm EIRP), not indoor 30 dBm or standard-power/AFC operation; use only compliant hardware and antennas.
- Confirm both installed modems appear under QModem and match sections `4_1` and `2_1`.
- Configure APN, PIN, PDP, and carrier-specific settings for each modem.
- Confirm `wan`, `wan_sfp`, `4_1`, and `2_1` status in LuCI before enabling automated recovery.
- Test wired-to-cellular failover and restoration during an attended maintenance window.
- Leave Modem Watchdog recovery actions off until basic connectivity is stable.
- Check `logread -e speedify-installer` if Speedify is wanted; otherwise disable its installer service.
- Export a fresh backup after configuration is complete.

## Build it yourself

### GitHub Actions

Open **Actions → Build OpenWrt Firmware → Run workflow**. The workflow accepts:

| Input | Purpose | Default |
|---|---|---|
| `openwrt_git_ref` | Far5eer source tag/ref; it must resolve to the pinned commit accepted by the build script | `v25.12.021` |
| `include_backup_images` | Optionally copies `artifacts/router-backups` into the image | `false` |

The build currently needs at least 40 GiB free on the runner and can take several hours. Build #17 completed in approximately 3 hours 13 minutes.

### Docker

From the repository root:

```sh
docker build \
  -f firmware/docker/Dockerfile.remote-builder \
  -t z8803be-dual-modem-builder .

docker run --rm -it \
  -e OPENWRT_ROOT=/workspace/openwrt \
  -e OPENWRT_GIT_URL=https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE.git \
  -e OPENWRT_GIT_REF=v25.12.021 \
  -e ALLOW_CLONE_OPENWRT=1 \
  -e CUSTOM_FEED_DIR=/workspace/firmware/feeds \
  -e FILES_OVERLAY_DIR=/workspace/firmware/files \
  -e PROFILE_PACKAGES_FILE=/workspace/firmware/profiles/packages-default.txt \
  -e PROFILE_KCONFIG_FILE=/workspace/firmware/profiles/kconfig-fragment.conf \
  -e INCLUDE_BACKUP_IMAGES=0 \
  -e HOST_MAKE_JOBS=4 \
  -e FINAL_MAKE_JOBS=6 \
  -e TARGET=mediatek/filogic \
  -e SUBTARGET=filogic \
  -e DEVICE=zbtlink_zbt-z8803be \
  -v "$PWD:/workspace" \
  z8803be-dual-modem-builder \
  bash /workspace/firmware/docker/build-openwrt.sh
```

The same host should have roughly 40–50 GiB available for a clean build. More space is recommended when retaining source trees, download caches, or multiple build outputs.

`HOST_MAKE_JOBS` controls build-tool/toolchain parallelism; `FINAL_MAKE_JOBS` controls the final package/image build. Choose values that leave CPU and RAM for other services. Retain a separate persistent build tree for each edition to reuse compilation caches without mixing image contents. The **Publish locally built firmware** workflow verifies an uploaded draft, generates Gemini notes, and publishes it without compiling again. Its tag and `BUILD-INFO.txt` must identify the exact clean recipe commit used to build the images.

### Repository layout

| Path | Purpose |
|---|---|
| `.github/workflows/build-openwrt-firmware.yml` | Reproducible CI build, validation, diagnostics, and artifact upload |
| `firmware/docker/` | Container definition and main OpenWrt build entrypoint |
| `firmware/profiles/` | Pinned baseline config, required package list, and kernel fragment |
| `firmware/files/` | Files embedded into the router root filesystem |
| `firmware/feeds/luci-app-modem-watchdog/` | Custom modem health and recovery LuCI application |
| `firmware/feeds/luci-app-speedtest-lite/` | Live speedometer, throughput graph, server/modem selection, and authenticated test controls |
| `firmware/feeds/zbt-speedtest/` | Pinned speedtest-go measurement engine with live reporting, socket-level modem binding, and cancellation |
| `firmware/feeds/luci-app-tailscale/` | Tailscale status/sign-in UI and authenticated RPC backend |
| `firmware/patches/` | Strict patches against pinned QModem and mwan3 userspace sources |
| `firmware/docs/usb-tethering-storage-sharing.md` | Mega-only phone tethering, storage, KSMBD and USB/IP setup/safety guide |
| `firmware/tests/` | Mocked runtime regressions, pinned-source patch checks, and isolated nginx/proxy test |
| `firmware/scripts/check-build-inputs.sh` | Static source, checksum, and input validation |
| `firmware/scripts/verify-router-runtime.sh` | Post-flash runtime inspection helper |
| `firmware/README-build.md` | Lower-level implementation and builder notes |

## Validation model

A green **firmware build** confirms the following build-time checks (the separate Sanity workflow does not compile firmware):

- source URL, tag, commit, device target, and required configuration symbols;
- reviewed Speedify downloads and pinned SHA256 values;
- successful toolchain, Go bootstrap, package, kernel, and image compilation;
- required modem, QModem, MHI, mwan3, VPN, custom LuCI, Speedify dependency, phone-tethering, storage, KSMBD, and USB/IP packages in that run's final manifest;
- required first-boot defaults and services in the assembled root filesystem;
- non-empty initramfs and SquashFS sysupgrade images;
- artifact-level `sha256sums` verification.

Physical validation should still cover boot, Ethernet, SFP+, all three Wi-Fi bands, each installed modem, failover, recovery, and any carrier-specific behavior.

Run source-level regressions with Node.js 22, BusyBox, jq, patch, and ripgrep installed:

```sh
bash firmware/scripts/check-build-inputs.sh
node firmware/tests/check-patches.cjs
```

The second command downloads only the exact pinned public source files, tests forward/reverse patch application, and runs behavioral tests in temporary fixtures. It never contacts a router, sends real AT commands, or toggles GPIOs.

## Troubleshooting

### A modem is not detected

Check the physical USB paths and QModem state:

```sh
ls -l /sys/bus/usb/devices/4-1 /sys/bus/usb/devices/2-1
uci show qmodem
logread | grep -Ei 'qmodem|qmi|mbim|mhi|wwan|usb'
```

Do not remap modem 2 from `2_1` to `3_1`; the project defaults and runtime evidence use physical path `2-1`.

### The modem connects and repeatedly disconnects

Confirm QModem owns the data path:

```sh
uci get network.4_1.proto
uci get network.2_1.proto
```

For the default RM551E-GL QMI/`quectel-CM-M -d` setup, both should report `none`. Adding DHCP creates a second address manager. Do not apply this rule indiscriminately to ECM/RNDIS or another connection manager. The retired `apply-router-defaults.sh` helper intentionally refuses to modify a live router.

### Modem 2 is SIM-ready but stays detached / SA band boxes are empty

The supplied logs show a working SIM read but no packet-service attachment on modem 2. That is not evidence that the router has turned its power off, or that every SA band is disabled. The two RM551E-GL modules also report different internal modem firmware revisions. Read [the registration and band checklist](firmware/docs/runtime-repair-2026-09.md#remaining-hardware-checks); do not reset the modem, change SIM GPIOs, or force an SA-only mode based on an empty UI mask.

### Speedify does not install

```sh
logread -e speedify-installer
cat /etc/apk/arch
apk info -e kmod-tun luci-nginx python3-light
curl -I https://downloads.speedify.com/
```

The installer intentionally refuses changed APKs, missing baked dependencies, unsupported architecture, or a failed service/UI health check.

### Speedify opens a 404 or fails its health check

The vendor UI requires nginx's alias/proxy routes and `sfy-ws-auth`. Switching to uhttpd leaves the Speedify menu pointing to a URL that uhttpd cannot serve. The repaired installer keeps nginx active and separates service recovery from package installation. Check:

```sh
/etc/init.d/nginx status
/etc/init.d/sfy-ws-auth status
/etc/init.d/speedify status
nginx -t
logread -e speedify-installer
```

Clicking Speedify from an HTTP LuCI session returns a Speedify-only **307 redirect to HTTPS**; ordinary LuCI pages remain available over HTTP. Without a login session, the protected HTTPS Speedify index should return **401**, not 404 or 502. HTTPS is Mega's choice for protecting this admin connection, not an upstream requirement: Speedify's own OpenWrt instructions also support HTTP. A healthy proxy is not proof that the proprietary VPN daemon has connected; authenticate your Speedify account and test its data path separately. Do not configure two routing/bonding managers to control the same traffic without checking their policies.

For sign-in, use **Sign In inside the official Speedify dashboard**, complete its sign-in in the new browser tab, and return to LuCI, as described in [Speedify's router instructions](https://support.speedify.com/article/927-how-to-sign-in-to-my-speedify-router). The custom **Sign in this router** flow and its restrictive activation-link parser have been removed. The wrapper never requests activation codes or reloads the dashboard on focus. Its read-only status panel distinguishes daemon-confirmed account sign-in, VPN connection, recent license/authentication errors and connectivity failures. Non-secret connection parameters stay in the document query; router authentication uses a scoped session cookie accepted by the official proxy, never a token in the URL. The sidebar remains available. Moving from HTTP to HTTPS may require a second LuCI login. Desktop/mobile tests use the actual pinned vendor UI with simulated daemon/account replies; real account activation and radio throughput still require device testing.

OpenWrt requires a [Speedify Router License](https://support.speedify.com/article/918-openwrt). `ERROR_NO_ROUTER_LICENSE` does not necessarily mean you never purchased one: a license can remain assigned to an earlier router identity. Follow [Speedify's activation/transfer instructions](https://support.speedify.com/article/989-activating-moving-router-license) or contact their support. Firmware cannot grant or transfer a proprietary license, and logging into the account website alone does not establish a router VPN connection.

### HTTPS warning on the router's private IP address

Use `http://192.168.1.1` for the default warning-free LAN login. Speedify is the exception: Mega redirects that page to HTTPS to protect its admin connection. HTTPS uses a per-router self-signed certificate and will show a warning until you install a trusted local CA or a certificate for a hostname you control. HTTP is restricted to the local router interface but is not encrypted, so use HTTPS with a trusted certificate on untrusted LANs. This setting never disables certificate verification for firmware or package downloads.

## Support and sponsorship

**Michael Foster / @mfoster978 develops and maintains Mega Edition.** Report Mega-specific issues and feature requests in [this repository](https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/issues), email [mfoster978@gmail.com](mailto:mfoster978@gmail.com), or contact **mfoster978** on Discord. Pull requests, reproducible bug reports, documentation, and hardware-test results are welcome.

Credits and support links below acknowledge independent upstream projects; they do not imply sponsorship, endorsement, or responsibility for Mega Edition. Choose the project closest to the work you want to support:

| If you depend on… | Support or contribute to… |
|---|---|
| OpenWrt itself, package infrastructure, and security maintenance | [Donate to the OpenWrt Project](https://openwrt.org/donate) |
| Upstream ZBT-Z8803BE board support and hardware testing | [Far5eer's ZBT-Z8803BE project](https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE) and its own support information |
| QModem Next and modem-management UX | [FUjr/QModem](https://github.com/FUjr/QModem) through issues, testing, documentation, or code contributions |
| Mega Edition development, fixes, user interface, and ongoing releases | [@mfoster978's Mega repository](https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega), Issues and Pull Requests |

For upstream donations or sponsorship, follow the relevant project's own current support page. Mega Edition's developer/maintainer contact information is listed above; upstream funding links are not payment details for this edition.

## Credits

- [Michael Foster / @mfoster978](https://github.com/mfoster978) — **developer and maintainer of Mega Edition**: this firmware variant's features, fixes, integration, interface, builds, releases, and ongoing maintenance.
- Special thanks to [0xFar5eer](https://github.com/0xFar5eer) for putting the pieces together and producing a working OpenWrt foundation for this router. The [upstream ZBT-Z8803BE project](https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE) supplies the pinned board-support baseline, release configuration, and hardware-focused documentation.
- [@pttuan](https://github.com/pttuan) — upstream board-port work through [OpenWrt pull request #23053](https://github.com/openwrt/openwrt/pull/23053), including DT-native fan, GPIO watchdog, thermal, and LED bindings.
- [@sjanulonoks](https://github.com/sjanulonoks) — fan-control suggestions and release testing credited by the baseline project.
- [FUjr/QModem](https://github.com/FUjr/QModem) — QModem Next and its modem-management interface.
- [OneB1t/Z8803BE-research](https://github.com/OneB1t/Z8803BE-research) — research into the vendor firmware and platform behavior.
- [OpenWrt](https://openwrt.org/) — the underlying Linux router distribution and package ecosystem.
- [ImmortalWrt](https://github.com/immortalwrt) — supplemental package and LuCI overlays used by the baseline build.
- [Speedify](https://speedify.com/) / Connectify — the optional proprietary bonding service installed only after the user brings the router online.

## Contributing

When reporting a problem, include the exact build run, firmware SHA256, router revision, modem models, connection protocol, relevant interface names, and sanitized logs. Never publish APNs containing credentials, SIM PINs, account tokens, private keys, or complete configuration backups.

For code changes:

Do not commit router captures, backup archives, SIM identifiers, credentials or other personal diagnostics. The generated `artifacts/` directory is ignored; redact logs before sharing an issue. If you have a clone from before the public-release history cleanup, re-clone instead of merging its old history back into this repository.

1. keep the Far5eer source commit pinned and review any deliberate baseline upgrade separately;
2. run `bash firmware/scripts/check-build-inputs.sh`;
3. keep shell scripts compatible with BusyBox `ash` where they run on the router;
4. verify first-boot scripts are idempotent and preserve later operator choices;
5. require final manifest, root-filesystem, image, and checksum validation before describing a build as flashable.

---

<p align="center">
  <strong>Built for one router, two modems, and predictable recovery.</strong><br>
  Mega Edition · Developed and maintained by Michael Foster / @mfoster978<br>
  Independent firmware · Not an official ZBTLink, OpenWrt, Far5eer, FUjr, or Speedify release
</p>
