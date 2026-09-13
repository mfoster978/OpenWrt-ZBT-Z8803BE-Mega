# Mega About and firmware updates

These additions are exclusive to **ZBT-Z8803BE Mega Edition**, developed and
maintained by **Michael Foster / @mfoster978**. They
do not add an updater to Minimal or change modem configuration.

## About

The existing **About** menu opens a dark, tabbed feature guide with illustrated
cards, a connection diagram, package descriptions, build identity, project
links, developer/maintainer contacts and upstream credits. Tabs keep the detailed guide
from becoming one long page. Both new screens use dark/charcoal surfaces even
when the browser prefers light mode, matching this firmware's black LuCI theme.
Special thanks go to
[0xFar5eer](https://github.com/0xFar5eer) for assembling the working router baseline.

Firmware update controls are **not part of About**; their separate side-menu
entry is **System → Firmware Update**.

Mega Edition combines add-on packages and custom-built tools into a configurable
networking workhorse. The guarded central modem watchdog and Modem-1-first
failover are active by default; the separate QModem monitor remains off. Users choose which optional tools to enable. Speedify's
first-online installer is enabled, but account setup and bonding are separate
user choices. See the main README's default-behavior table for the distinction.

The guide distinguishes included software from account setup and optional
features. Speedify bonding is not the same as mwan3 failover/load balancing.
The About page itself does not sign in, run tests, or change modem settings.

## System → Firmware Update

This is a **user-initiated** updater, not an unattended upgrade agent. Opening
the page does not contact GitHub, download firmware, or flash it.

1. Check for updates. The router reads published releases from the fixed
   [Mega Edition repository](https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega/releases).
   No GitHub account or API key is needed for public releases.
2. Review the installed/selected versions and release notes. Each release shows
   both a relative age and its exact publication date. New/current releases and
   known older releases are separated into Update and Downgrade sections.
   Drafts, prereleases and unsupported assets are excluded.
3. Download and verify. The image is streamed into temporary `/tmp` storage,
   checked against SHA256 and validated for this router by OpenWrt. The live
   status card scrolls into view immediately and reports bytes/percentage when
   GitHub supplies a size, followed by validation progress.
4. Download a backup using **System → Backup / Flash Firmware**. Review the
   final flash confirmation and keep-settings choice before confirming.
5. Keep power connected while flashing/rebooting. Prefer wired LAN and do not
   run another flash operation concurrently. The confirmation popup changes to
   a write/reboot progress state as soon as flashing starts. Reconnect after the reboot.

Only the device-specific **SquashFS sysupgrade `.bin`** is selected, never an
initramfs kernel, source archive, package, arbitrary URL, or Minimal image.
Canonical release files end with the full `firmware-YYYYMMDDHHMM.ATTEMPT`
version before their extension. A transition release can carry byte-identical
legacy-name aliases so updater versions already installed on routers can reach
the canonical versioned image safely.

## Downgrades and settings

Older releases use the same guarded process. Keep settings is **off by default
for downgrades**: old firmware may not understand new configuration. OpenWrt's
image validator may prohibit keeping settings for a particular image.

Not keeping settings removes configuration, including network settings and
credentials. A backup does not guarantee cross-version compatibility. Extra
packages installed after flashing are not preserved as installed binaries by
normal sysupgrade. An older firmware may lack this updater; subsequent updates
then use the standard LuCI flash page. This is not automatic rollback or a
guarantee that a historical image will boot. There is no Force button.

A settings-preserving update keeps the existing root password. A clean install
or an update performed without keeping settings begins with an empty local root
password and requires the user to set a new one in LuCI before other admin pages.

## Verification and trust

- Authenticated rpcd read access allows browsing; prepare/flash/discard require
  `zbt-firmware` write access. The browser cannot supply URLs or file paths.
- Downloads require verified HTTPS from the fixed Mega repository, with
  redirects limited to GitHub release storage.
- The updater checks the local board and reads immutable build identity from
  `/rom/etc/zbt-mega-build.json`, avoiding stale restored `/etc` metadata.
- New versioned releases contain `mega-release-v2.json`: edition, repository, device,
  version, source commit, date, filename, size and SHA256. Publishing refuses
  mismatched embedded version/commit or a dirty recipe identity.
- Legacy same-repository releases can use their exact `SHA256SUMS` entry. This
  path is labeled; without either verification file, automatic flash is refused.
- Size/resource limits, streamed hashing, OpenWrt firmware validation and
  `sysupgrade --test` must pass. A ready image is rechecked before flashing.
- One updater transaction is allowed at a time; one-time confirmation is bound
  to the prepared image. Rate limits, TLS failures, bad clock, missing Internet,
  insufficient space and validation failures do not trigger a forced flash.
- Once the destructive flash command starts, it has no request timeout. If its
  outcome becomes uncertain, the image is retained and further updates/deletion
  are blocked. Keep power connected and inspect the router before recovery;
  never reboot merely to clear a warning while an upgrade could still be running.

Checksums protect against damaged or mismatched downloads. A SHA256 fetched
from the same GitHub repository is **not an independent release signature**.
This design trusts the repository maintainer, GitHub and HTTPS; it is not secure
boot or a cryptographically signed firmware distribution system.

## Build and validation

`zbt-firmware-updater` is a standard-library-only Go executable, with no new
runtime account keys or periodic daemon. Rootfs checks verify the executable,
views, styles, ACLs and embedded identity. Published builds use
`firmware-YYYYMMDDHHMM.ATTEMPT` (UTC build-start time), so server-built releases
and future Actions builds sort consistently without sharing a run counter.
Old `firmware-RUN.ATTEMPT` tags remain readable. Unversioned development builds
are labeled `local-COMMIT` and record whether the worktree is dirty.

Automated tests cover metadata, mock HTTP/fake platform operations, static
ARM64 compilation and desktop/mobile browser flows. **They do not flash real
hardware.** On-router acceptance still needs a real release download/validation,
backup, flash/reboot/reconnect, and upgrade/downgrade checks before this feature
is called hardware-validated.

References: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases),
[OpenWrt sysupgrade](https://github.com/openwrt/openwrt/blob/openwrt-25.12/package/base-files/files/sbin/sysupgrade),
[standard LuCI flashing](https://github.com/openwrt/luci/blob/master/modules/luci-mod-system/htdocs/luci-static/resources/view/system/flash.js).
