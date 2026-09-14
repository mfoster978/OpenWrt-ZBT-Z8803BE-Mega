# Mega Edition firmware build guide

**ZBTLink ZBT-Z8803BE Mega Edition** is developed and maintained by **Michael Foster / @mfoster978**. This directory builds the edition's fixes, features and interface on the pinned [Far5eer upstream foundation](https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE). Mega development and releases live in [the Mega Edition repository](https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega).

Use the exact release notes, checksums and build provenance for your download. Compilation and automated checks do not replace hardware acceptance testing. Build 17 predates the current repairs; see the [repair notes and hardware validation checklist](docs/runtime-repair-2026-09.md) before flashing.

## What is included

- Docker builder definition: `firmware/docker/Dockerfile.remote-builder`
- Build entrypoint: `firmware/docker/build-openwrt.sh`
- Default package profile: `firmware/profiles/packages-default.txt`
- Kernel config fragment with TUN support: `firmware/profiles/kconfig-fragment.conf`
- First-boot baked defaults overlay: `firmware/files/etc/uci-defaults/99-cellular-multiwan-defaults`
- Speedify bootstrap and service: `firmware/files/etc/uci-defaults/99-speedify-bootstrap`, `firmware/files/etc/init.d/speedify-installer`, `firmware/files/usr/sbin/speedify-installer-loop`
- Reviewed Speedify LuCI login-return wrapper: `firmware/files/usr/share/zbt/speedify-luci-wrapper.js`
- Clean-install first-login password enforcement: `firmware/patches/luci-first-login-password.patch`
- Optional Speedify package-name profile: `firmware/profiles/packages-optional-speedify.txt`
- Custom LuCI watchdog app feed: `firmware/feeds/luci-app-modem-watchdog`
- Custom LuCI speed test app feed: `firmware/feeds/luci-app-speedtest-lite`
- Local Tailscale LuCI status/login app: `firmware/feeds/luci-app-tailscale`
- Mega-only Android/iPhone tethering, USB storage, KSMBD and USB-over-IP package selections: `firmware/profiles/packages-default.txt`
- Disabled-by-default KSMBD service/UI patches and USB/IP configuration: `firmware/patches/ksmbd-server-disabled.patch`, `firmware/patches/luci-app-ksmbd-enable-toggle.patch`, `firmware/files/etc/config/usbipd`
- Version-pinned, zero-fuzz runtime patches: `firmware/patches`
- Automated shell/runtime regression tests: `firmware/tests`
- Read-only router diagnostic script: `firmware/scripts/verify-router-runtime.sh`. The old live defaults application script is retired; it must not be used to overwrite a running router's configuration.

## Remote Docker usage (example)

```bash
docker build -f firmware/docker/Dockerfile.remote-builder -t owrt-remote-builder .
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
  -e BACKUP_IMAGES_DIR=/workspace/artifacts/router-backups \
  -v "$PWD":/workspace \
  owrt-remote-builder \
  bash /workspace/firmware/docker/build-openwrt.sh
```
## Notes

- `patches/hostapd-mlo-interoperability.patch` is applied after OpenWrt's hostapd patch queue and backports a bounded set of upstream AP-MLD advertisement, reassociation, interface-reuse, and reload fixes. It keeps the pinned hostapd source version and adds no key-material logging.
- The central modem watchdog and its recovery actions default on for both slots. After three failed direct checks it tries one targeted redial, verifies for 60 seconds, then uses only that slot's GPIO if Internet remains unavailable. The separate QModem monitor stays off.
- Normal priority failover is enabled by default. Modem 1 is invariantly ahead of Modem 2 in every firmware-managed policy; the old prefer-fastest promotion is retired.
- Both modem slots are default-on at first boot. QModem and mwan3 use stable internal names `4_1` and `2_1`; the UI displays editable **Modem 1** / **Modem 2** labels independently. Physical USB paths, not enumeration-dependent `wwan` or `ttyUSB` numbers, determine modem identity. The Far5eer `5g2` power setting is enabled once; later operator changes and SIM selections are preserved.
- All three Wi-Fi radios default to the US regulatory domain. The 2.4 GHz compatibility radio advertises legacy 802.11b rates in addition to HT20, and the exact pinned MT7996 source receives focused upstream power-save/TIM buffering fixes; see [MT7996 legacy-client compatibility](docs/mt7996-legacy-client.md). The 2.4 and 5 GHz radios have no fixed UCI transmit-power override, so mt7996 uses the lower of the current US regulatory limit and each radio's calibrated EEPROM target. The 6 GHz radio uses hostapd's very-low-power class with a 14 dBm EIRP software ceiling; indoor 30 dBm and standard-power/AFC operation are not enabled. The VLP class still requires compliant, permanently attached antennas and does not replace FCC equipment authorization.
- The late Wi-Fi worker runs on clean flashes and kept-configuration upgrades even after its UCI defaults are gone. It waits for the MT7996 PHY/netifd, preserves all owner settings, requests `wifi up` only when an enabled AP is configured but absent, and escalates to a radio-only reload after repeated runtime misses. It never resets wireless UCI or restarts LAN/networking.
- The custom `zbtqmi` netifd protocol is used for QMI/MBIM/MHI paths managed by `quectel-CM-M -d`, which owns their addresses and routes and publishes them to netifd. Other protocol paths retain their appropriate setup. There is no competing DHCP client for the direct-address QMI path.
- Per-modem procd instances replace the global restart/auto-enable repair loops. Each `enable_dial`-enabled instance waits for its physical slot's exact USB net device and AT port, serializes the two initial setup phases, and explicitly relaunches an exited dialer. Both its readiness checks and the dialer's final dispatch ignore QModem's discovery-only disabled marker for the two fixed slots, so a valid retry cannot silently become a hang. Recovery can act only on the selected modem. Automatic post-flash modem factory resets are retired.
- The default `mwan3` failover order is SFP WAN, copper WAN, an attached `usb_tether`, modem 1, then modem 2. The failover preset uses faster health recovery by default; unavailable paths are skipped and a recovered preferred path is selected for new flows. The legacy balanced policy retains separate cellular tiers, so it cannot make Modem 2 primary while Modem 1 is healthy.
- LuCI controls are under `Network -> MultiWAN Manager -> Priority & Recovery`: normal or fast health-failover timing plus per-modem actions (`none`, `disconnect`, `redial`, `power_cycle`). QModem only establishes each session; persistent route metrics and MWAN member tiers keep Modem 1 primary and Modem 2 on standby.
- `Services -> Speed Test Utility` uses the pinned open-source speedtest-go engine against real Speedtest.net servers, with live measured throughput, a gauge/graph, ping/jitter, USB-tether selection and automatic upload-capability fallback. First-time GO asks for terms/data-use confirmation and then selects a compatible server automatically. It is an authenticated action page with no Save/Apply controls. Interactive tests can consume substantial data and are not a fixed 30 MB sample. Optional background policy samples remain bounded HTTPS transfers and are disabled by default; see [live speed testing](docs/live-speedtest.md) for the distinction and data-use considerations.
- `mwan3` is included for user-friendly failover/load-balance policy. True bandwidth bonding (single-flow aggregation) requires a separate architecture such as Speedify or a complete OpenMPTCProuter firmware/server deployment.
- Speedify's matching OpenWrt dependencies are baked into the image. The proprietary Speedify 17.1.0-r12947 core and LuCI APKs are downloaded over HTTPS on the first online boot, verified against pinned SHA256 values, and installed without fetching kernel packages at runtime. Credentials are never baked into the firmware.
- `speedtest-netperf` and `speedtest-go` remain available as separate command-line tools. The live LuCI engine and optional background sampler bind to the selected physical network interface; the background sampler uses curl, while the live dashboard uses `zbt-speedtest`. Neither relies only on a source IP that could be identical on both cellular links.
- Failover and load-balancing support is baked in via `mwan3`, `luci-app-mwan3`, and first-boot defaults in `firmware/files/etc/uci-defaults/95-mwan3-defaults`.
- VPN support is baked in via `tailscale`, `luci-app-tailscale`, `openvpn-openssl`, and `luci-app-openvpn`.
- Android RNDIS/CDC Ethernet and Apple `ipheth`/`usbmuxd` support are baked in. Supported phone netdevs bind to stable `usb_tether` with metric 100 and an MWAN tier between wired WAN and modem 1; QMI/MHI modem devices are explicitly excluded.
- USB storage/UAS, ext4 formatting and repair (`e2fsprogs`), partitioning (`parted`), extroot, exFAT, FAT, KSMBD, and USB-over-IP client/server support are baked in. Mount Points is linked under `Services -> USB Storage`; KSMBD is under `Services -> Network Shares`. No disk is formatted automatically, KSMBD and USB/IP servers are disabled by default, and the pinned feeds provide no USB/IP LuCI application. User setup, security boundaries and rollback are documented in [`docs/usb-tethering-storage-sharing.md`](docs/usb-tethering-storage-sharing.md).
- Required tunnel/kernel support is baked in via OpenWrt's `CONFIG_PACKAGE_kmod-tun=y` selector (`firmware/profiles/kconfig-fragment.conf`).
- Speedify LuCI support defaults on and uses its required `luci-nginx` and `python3-light` packages. Set `speedify_bootstrap.main.install_luci=0` before installation to skip the proprietary UI and install Speedify core only. Ordinary LuCI remains available over LAN HTTP; Mega redirects only Speedify pages/endpoints to HTTPS to protect their admin connection (not because upstream requires HTTPS). A thin iframe wrapper preserves the LuCI menu and leaves sign-in to the official vendor UI. Non-secret transport parameters use the document query; authentication uses the official proxy's scoped cookie. There is no custom activation-link parser or focus-triggered reload. The installer retains nginx and the authenticated Speedify proxy when a service health check fails; it does not fall back to a web server that cannot serve the vendor UI. Existing packages are not repeatedly reinstalled, avoiding repeated vendor network setup. Completion still requires service and web health checks; a visible menu is not proof the VPN daemon is healthy.
- OpenMPTCProuter is intentionally not offered as a package toggle here. It is a separate firmware distribution with a companion server stack; adding a subset of its feed packages would not turn Mega Edition into a supported OpenMPTCProuter build.
- To produce a remote Docker environment, run the same container on a remote Docker host (or CI runner) and mount both your OpenWrt source tree and this repository into `/workspace`.
## Changes in this build stream

- Pinned the source to `0xFar5eer/openwrt25.12_ZBT_Z8803BE` `v25.12.021` (commit `edc738504fe8fae81eb15de967456204699b1830`) and retained its ZBT-Z8803BE target, kernel, board patches, modem drivers, and release config as the baseline.
- Enforced required modem stack packages and fail-fast config checks in the bake script so missing modem symbols stop the build immediately.
- Unified modem identity across QModem, mwan3 and LEDs using the board's physical USB paths; retained the upstream GPIO definitions and the operator's SIM selection.
- Added full-response `AT+CNUM` plus Own Numbers phonebook lookup, long-running LTE/NR QSCAN discovery, defensive `AT+QCAINFO` PCC/SCC/PCI reporting, and a read-backed Automatic-preferred/Automatic/NSA-only/SA-only selector that preserves band masks. Automatic preferred leaves SA/NSA selection to the modem and serving network without carrier-specific wording. Fresh TTL policies are off so flow offload remains available unless the operator opts into TTL rewriting.
- Added/kept custom integration features: LuCI Modem Watchdog app, LuCI Speed Test Utility app, mwan3 default failover/load-balance templates, and the boot-time cellular defaults overlay.
- Replaced the old one-shot Speedify bootstrap with an architecture-checked, checksum-pinned, retrying installer that never substitutes live-repository kernel modules for the ones built with this firmware.
- Baked the complete Speedify runtime dependency set, including TUN, TPROXY, BBR, iptables-nft, C++/atomic/keyutils libraries, nginx, and Python support.

When Connectify publishes a new APK, update `SPEEDIFY_VERSION`, the two URLs if they changed, and both reviewed SHA256 constants in `firmware/files/usr/sbin/speedify-installer-loop`; then rebuild the firmware. A changed APK is deliberately rejected until that review is done.

## Validation before a build

Run from the repository root with Node.js 22+, BusyBox, jq, patch, ripgrep and a C compiler (`cc` / GCC) installed:

```bash
bash firmware/scripts/check-build-inputs.sh
node firmware/tests/check-patches.cjs
```

The second command downloads the changed files from the exact pinned QModem/packages and OpenWrt commits, verifies forward and reverse patch application with zero fuzz, checks patched script syntax and runs the regression suite. It also compiles the real Ethernet LED callbacks/helpers against simulated MDIO registers. Sanity CI runs these checks on firmware changes. It does not compile complete firmware or test actual GPIO wiring, radio registration, a SIM/APN, the proprietary ARM64 Speedify daemon, or flash compatibility. Firmware compilation is a separate manually dispatched workflow.

The Ethernet LED repair is in `firmware/patches/zbt-wan-led.patch` and `firmware/kernel-patches/753-net-phy-mediatek-mt7988-led-control.patch`. The builder enables the existing WAN LED0 node and copies the driver backport into the pinned 6.12 patch series before kernel preparation. No modem/Wi-Fi driver or kernel version upgrade is included.

Automatic APN mode preserves the modem/network-provided profile, except that a directly identified AT&T US `310/410` SIM receives the `broadband` fallback at dial time. That exception is not written into unrelated modem profiles, and an explicit operator APN always wins. Automatic connection cannot be guaranteed for every SIM plan or private APN. In particular, `SIM_READY` with persistent `PS: Detached` still requires registration diagnostics on that modem, even after these integration repairs.
