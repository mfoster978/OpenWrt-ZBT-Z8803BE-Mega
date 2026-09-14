#!/usr/bin/env bash
set -euo pipefail
OPENWRT_ROOT="${OPENWRT_ROOT:-/workspace/openwrt}"
OPENWRT_GIT_URL="${OPENWRT_GIT_URL:-https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE.git}"
OPENWRT_GIT_REF="${OPENWRT_GIT_REF:-v25.12.021}"
EXPECTED_OPENWRT_COMMIT="${EXPECTED_OPENWRT_COMMIT:-edc738504fe8fae81eb15de967456204699b1830}"
ALLOW_CLONE_OPENWRT="${ALLOW_CLONE_OPENWRT:-1}"
PROFILE_PACKAGES_FILE="${PROFILE_PACKAGES_FILE:-/workspace/firmware/profiles/packages-default.txt}"
PROFILE_PACKAGES_EXTRA_FILES="${PROFILE_PACKAGES_EXTRA_FILES:-}"
PROFILE_KCONFIG_FILE="${PROFILE_KCONFIG_FILE:-/workspace/firmware/profiles/kconfig-fragment.conf}"
BASE_CONFIG_FILE="${BASE_CONFIG_FILE:-/workspace/firmware/profiles/base-config-zbt-z8803be-v25.12.021.config}"
CUSTOM_FEED_DIR="${CUSTOM_FEED_DIR:-/workspace/firmware/feeds}"
FILES_OVERLAY_DIR="${FILES_OVERLAY_DIR:-/workspace/firmware/files}"
BACKUP_IMAGES_DIR="${BACKUP_IMAGES_DIR:-/workspace/artifacts/router-backups}"
INCLUDE_BACKUP_IMAGES="${INCLUDE_BACKUP_IMAGES:-0}"
CUSTOM_FEED_NAME="${CUSTOM_FEED_NAME:-custom_local}"
TARGET="${TARGET:-mediatek/filogic}"
SUBTARGET="${SUBTARGET:-}"
DEVICE="${DEVICE:-zbtlink_zbt-z8803be}"
FINAL_MAKE_JOBS="${FINAL_MAKE_JOBS:-$(nproc)}"
HOST_MAKE_JOBS="${HOST_MAKE_JOBS:-1}"
[[ "$HOST_MAKE_JOBS" =~ ^[1-9][0-9]*$ && "$FINAL_MAKE_JOBS" =~ ^[1-9][0-9]*$ ]] || {
  echo 'Build job counts must be positive integers' >&2; exit 2;
}
RECIPE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEGA_RELEASE_VERSION="${MEGA_RELEASE_VERSION:-}"
if [[ ! -d "${OPENWRT_ROOT}" ]]; then
  if [[ "${ALLOW_CLONE_OPENWRT}" = "1" ]]; then
    git clone --depth 1 --branch "${OPENWRT_GIT_REF}" "${OPENWRT_GIT_URL}" "${OPENWRT_ROOT}"
  else
    echo "Missing OPENWRT_ROOT: ${OPENWRT_ROOT}" >&2
    exit 2
  fi
fi
cd "${OPENWRT_ROOT}"
export FORCE_UNSAFE_CONFIGURE=1
resolved_openwrt_commit="$(git rev-parse HEAD)"
echo "OpenWrt source: ${OPENWRT_GIT_URL} ${OPENWRT_GIT_REF} (${resolved_openwrt_commit})"
if [[ -n "${EXPECTED_OPENWRT_COMMIT}" && "${resolved_openwrt_commit}" != "${EXPECTED_OPENWRT_COMMIT}" ]]; then
  echo "OpenWrt ref resolved to ${resolved_openwrt_commit}; expected ${EXPECTED_OPENWRT_COMMIT}" >&2
  exit 2
fi
printf '%s  %s\n' \
  '9adb2d14a022727f12364ab6040d15a0d7391465e33abff03602923196e508e4' \
  'target/linux/mediatek/filogic/base-files/etc/zbt-leds.sh' | sha256sum -c -
if [[ -d "${CUSTOM_FEED_DIR}" ]]; then
  grep -q "^src-link ${CUSTOM_FEED_NAME} " feeds.conf.default || \
    echo "src-link ${CUSTOM_FEED_NAME} ${CUSTOM_FEED_DIR}" >> feeds.conf.default
fi
./scripts/feeds update -a
./scripts/feeds install -a
# The userspace fixes below are reviewed against these exact feed revisions.
[[ "$(git -C feeds/qmodem rev-parse HEAD)" = a8b8a63e5b0853c79d2ad3f1ebbb673a724872bf ]] || {
  echo 'Unexpected QModem revision; review runtime patches before building' >&2; exit 3;
}
# Feed updates preserve tracked local modifications. Since the performance UI
# patch intentionally refines lines added by the deployment patch, testing an
# earlier patch in isolation cannot recognize an already-applied full stack.
# Reverse only our exact known patches. Do not reset an entire checkout or
# discard unrelated local edits while preparing a cached build.
if ! git -C feeds/qmodem diff --quiet; then
  for patch_name in qmodem-network-apply-v16.patch qmodem-fixed-slot-dial-v15.patch qmodem-fixed-slot-state-v14.patch qmodem-adaptive-safety-v13.patch qmodem-netifd-disabled-v12.patch qmodem-netifd-arming-v11.patch qmodem-netifd-serialization-v10.patch qmodem-health-v9.patch qmodem-adaptive-v8.patch qmodem-session-lifecycle-v7.patch qmodem-radio-rpc-v6.patch qmodem-at-transport-v6.patch qmodem-connectivity-v5.patch qmodem-mega-policy-ui.patch qmodem-performance-ui.patch qmodem-5g-deployment.patch qmodem-cell-discovery.patch qmodem-dual-runtime.patch; do
    stack_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/$patch_name"
    # --force disables GNU patch's automatic reversal guessing. In batch
    # mode alone an absent patch can be applied while asking to reverse it.
    if patch --dry-run --force --fuzz=0 --reverse -p1 -d feeds/qmodem < "$stack_patch" >/dev/null; then
      patch --force --fuzz=0 --reverse -p1 -d feeds/qmodem < "$stack_patch"
    elif git -C feeds/qmodem diff --quiet; then
      break
    elif ! patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$stack_patch" >/dev/null; then
      echo "Unrecognized cached QModem changes at $patch_name; preserving checkout for inspection" >&2
      exit 3
    fi
  done
  git -C feeds/qmodem diff --quiet || {
    echo 'Unrelated QModem changes remain; refusing to overwrite them' >&2; exit 3;
  }
fi
[[ "$(git -C feeds/packages rev-parse HEAD)" = db3b315119519f9194dad8aa668aa40618df9b20 ]] || {
  echo 'Unexpected packages revision; review mwan3 patch before building' >&2; exit 3;
}
[[ "$(git -C feeds/luci rev-parse HEAD)" = a611522a2bfc24ca2625e8cd2fcc9404288532a6 ]] || {
  echo 'Unexpected LuCI revision; review mwan3 route-metric patch before building' >&2; exit 3;
}
# Load Mega's responsive form layer from the pinned Argon header. The CSS is a
# separate overlay file so this one-line integration remains easy to audit.
argon_mobile_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/luci-theme-argon-mega-mobile.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/iwrt_luci < "$argon_mobile_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/iwrt_luci < "$argon_mobile_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/iwrt_luci < "$argon_mobile_patch" >/dev/null; then
  echo 'Mega mobile theme patch does not match pinned Argon; refusing an unstyled build' >&2
  exit 3
fi
# Fresh Mega installs must replace the shared vendor-label password on their
# first local LuCI login. Keep the enforcement as a narrow patch against the
# exact pinned dispatcher instead of carrying an unreviewed LuCI fork.
first_login_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/luci-first-login-password.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/luci < "$first_login_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/luci < "$first_login_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/luci < "$first_login_patch" >/dev/null; then
  echo 'First-login password patch does not match pinned LuCI; refusing an insecure build' >&2
  exit 3
fi
# Reproducible package timestamps do not distinguish successive firmware
# images. Put the immutable Mega release identity in LuCI's resource query so
# browsers cannot retain stale QModem, About, updater, or utility JavaScript.
resource_version_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/luci-mega-resource-version.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/luci < "$resource_version_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/luci < "$resource_version_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/luci < "$resource_version_patch" >/dev/null; then
  echo 'Mega LuCI resource-version patch does not match pinned LuCI; refusing a cache-stale build' >&2
  exit 3
fi
# Handle shared MLD device lists in the standard Wireless enable/disable
# controls. Disabling a standalone AP must not shut off a peer MLO link.
wireless_mlo_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/luci-wireless-mlo-toggle.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/luci < "$wireless_mlo_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/luci < "$wireless_mlo_patch"
elif ! patch --dry-run --force --fuzz=0 --reverse -p1 -d feeds/luci < "$wireless_mlo_patch" >/dev/null; then
  echo 'Wireless MLO toggle patch does not match pinned LuCI' >&2; exit 3
fi
# Strict userspace-only patch against the pinned QModem feed. No kernel,
# modem driver or wireless firmware revision changes.
runtime_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-dual-runtime.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$runtime_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$runtime_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/qmodem < "$runtime_patch" >/dev/null; then
  echo 'Pinned QModem runtime patch no longer matches; refusing an unpatched build' >&2
  exit 3
fi
# Use Quectel's actual long-running LTE/NR QSCAN path and robust subscriber
# number parsing while keeping the changes pinned to the reviewed QModem tree.
cell_discovery_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-cell-discovery.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$cell_discovery_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$cell_discovery_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/qmodem < "$cell_discovery_patch" >/dev/null; then
  echo 'Pinned QModem cell-discovery patch no longer matches; refusing a broken modem UI build' >&2
  exit 3
fi
# Expose Quectel's reversible SA/NSA selector without touching its band masks.
deployment_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-5g-deployment.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$deployment_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$deployment_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/qmodem < "$deployment_patch" >/dev/null; then
  echo 'Pinned QModem 5G deployment patch no longer matches; refusing an incomplete modem UI build' >&2
  exit 3
fi
# Keep performance controls first and readable on a phone after adding the
# read-backed connection-type selector above.
performance_ui_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-performance-ui.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$performance_ui_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$performance_ui_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/qmodem < "$performance_ui_patch" >/dev/null; then
  echo 'Pinned QModem performance UI patch no longer matches; refusing a hidden-control build' >&2
  exit 3
fi
# Persist Mega's read-before-write deployment policy and keep Advanced usable
# even when an already-open browser retains the previous QModem helper module.
policy_ui_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-mega-policy-ui.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$policy_ui_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$policy_ui_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/qmodem < "$policy_ui_patch" >/dev/null; then
  echo 'Mega QModem policy/UI compatibility patch no longer matches; refusing a broken Advanced page build' >&2
  exit 3
fi
connectivity_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-connectivity-v5.patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$connectivity_patch"
for patch_name in qmodem-at-transport-v6.patch qmodem-radio-rpc-v6.patch qmodem-session-lifecycle-v7.patch qmodem-adaptive-v8.patch qmodem-health-v9.patch; do
  patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/$patch_name"
done
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-netifd-serialization-v10.patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-netifd-arming-v11.patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-netifd-disabled-v12.patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-adaptive-safety-v13.patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-fixed-slot-state-v14.patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-fixed-slot-dial-v15.patch"
# Patch the actual packaged view before LuCI minifies it. First-boot text
# matching alone cannot repair the minified JavaScript shipped in the image.
patch --batch --fuzz=0 --forward -p1 -d feeds/qmodem < "$(dirname "${FILES_OVERLAY_DIR}")/patches/qmodem-network-apply-v16.patch"
for apn in broadband NXTGENPHONE ENHANCEDPHONE firstnet-broadband fast.t-mobile.com vzwinternet h2g2 h2g2-t usccinternet; do
  [ "$(grep -Fo "o.value('$apn'" feeds/qmodem/luci/luci-app-qmodem-next/htdocs/luci-static/resources/view/qmodem/network_config.js | wc -l)" -eq 2 ] || {
    echo "US APN preset is not present for both QModem SIM selectors: $apn" >&2; exit 3;
  }
done
led_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/zbt-wan-led.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 < "$led_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 < "$led_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 < "$led_patch" >/dev/null; then
  echo 'WAN LED device-tree patch does not match the pinned board' >&2
  exit 3
fi
# Far5eer's base files carry a pre-created S95 link. Replacing the init script
# with START=97 causes OpenWrt to generate the correct S97 link as well, so the
# legacy link must be removed before rootfs assembly or two owners race at boot.
# Validate its exact target before deleting it; an upstream layout change must
# fail closed instead of silently removing an unrelated service.
legacy_modem_led_link=target/linux/mediatek/filogic/base-files/etc/rc.d/S95zbt-modem-leds
if [[ -L "$legacy_modem_led_link" ]]; then
  [[ "$(readlink "$legacy_modem_led_link")" = ../init.d/zbt-modem-leds ]] || {
    echo 'Unexpected legacy modem LED startup link target' >&2; exit 3;
  }
  rm -f -- "$legacy_modem_led_link"
elif [[ -e "$legacy_modem_led_link" ]]; then
  echo 'Legacy modem LED startup path is not the expected symlink' >&2
  exit 3
fi
# Later patches refine the shared writer. Unwind only recognized patches in
# reverse order, covering fresh trees, previous-release caches and new caches.
# --force is essential: -R --batch otherwise guesses forward on absent patches.
for mlo_patch_name in luci-app-mlo-safe-edit.patch luci-app-mlo-shared-iface.patch; do
  mlo_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/$mlo_patch_name"
  if patch --dry-run --force --fuzz=0 --reverse -p1 -d package/luci-app-mlo < "$mlo_patch" >/dev/null; then
    patch --force --fuzz=0 --reverse -p1 -d package/luci-app-mlo < "$mlo_patch"
  fi
done
for mlo_patch_name in luci-app-mlo-shared-iface.patch luci-app-mlo-safe-edit.patch; do
  patch --batch --fuzz=0 --forward -p1 -d package/luci-app-mlo < "$(dirname "${FILES_OVERLAY_DIR}")/patches/$mlo_patch_name"
done
grep -Eq "uci.set\('wireless',[[:space:]]*mldIface,[[:space:]]*'device',[[:space:]]*selectedDevices\);" \
  package/luci-app-mlo/htdocs/luci-static/resources/view/mlo/main.js || {
  echo 'MLO page did not retain the shared multi-radio writer' >&2; exit 3;
}
# Keep the pinned hostapd release while applying the reviewed upstream AP-MLD
# interoperability and reload fixes after OpenWrt's existing package patches.
# This avoids an unbounded hostapd upgrade while correcting the actual MLE and
# reused-interface paths exercised by the three-radio Z8803BE MLD.
hostapd_mlo_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/hostapd-mlo-interoperability.patch"
hostapd_mlo_patch_target=package/network/services/hostapd/patches/804-zbt-mlo-interoperability.patch
if ! cmp -s "$hostapd_mlo_patch" "$hostapd_mlo_patch_target"; then
  cp "$hostapd_mlo_patch" "$hostapd_mlo_patch_target"
fi
# The pinned 2026-03-19 mt76 snapshot predates upstream MT7996 hardware power-
# save buffering support. Without it, some embedded clients complete WPA but
# their frames can remain stranded while the station is asleep. Backport only
# the reviewed PS/TIM fixes against the exact PKG_SOURCE_VERSION above.
mt76_ps_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/mt76-mt7996-ps-buffering.patch"
mt76_ps_patch_target=package/kernel/mt76/patches/999-zbt-mt7996-ps-buffering.patch
mkdir -p "$(dirname "$mt76_ps_patch_target")"
if ! cmp -s "$mt76_ps_patch" "$mt76_ps_patch_target"; then
  cp "$mt76_ps_patch" "$mt76_ps_patch_target"
fi
# Complete that backport with the later upstream EOSP and stale-station queue
# fixes. These are especially important for embedded clients that reconnect or
# use U-APSD on the 2.4 GHz radio.
mt76_legacy_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/mt76-mt7996-legacy-client-followup.patch"
mt76_legacy_patch_target=package/kernel/mt76/patches/999-zbt-mt7996-ps-zlegacy-followup.patch
if ! cmp -s "$mt76_legacy_patch" "$mt76_legacy_patch_target"; then
  cp "$mt76_legacy_patch" "$mt76_legacy_patch_target"
fi
# mt76's throttle uses the paired mac80211 AQL query that entered upstream
# after the pinned backports 6.18.7 archive. Backport that one exported helper
# with this archive's existing broadcast-field name.
mac80211_aql_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/mac80211-aql-pending.patch"
mac80211_aql_patch_target=package/kernel/mac80211/patches/subsys/999-zbt-aql-pending.patch
if ! cmp -s "$mac80211_aql_patch" "$mac80211_aql_patch_target"; then
  cp "$mac80211_aql_patch" "$mac80211_aql_patch_target"
fi
# Add LED callbacks to the pinned MT7988 Ethernet PHY driver before the kernel
# is prepared. The kernel version, modem drivers and power/SIM pins stay pinned.
kernel_led_patch="$(dirname "${FILES_OVERLAY_DIR}")/kernel-patches/753-net-phy-mediatek-mt7988-led-control.patch"
kernel_led_patch_target=target/linux/mediatek/patches-6.12/753-net-phy-mediatek-mt7988-led-control.patch
# OpenWrt includes patch mtimes in its kernel preparation stamp. Preserve the
# existing timestamp only when the bytes match; changed patches must rebuild.
if ! cmp -s "$kernel_led_patch" "$kernel_led_patch_target"; then
  cp "$kernel_led_patch" "$kernel_led_patch_target"
fi
# Restore the upstream external PCIe clocks without changing the pinned
# board reset ordering, driver, EEPROM or modem power/SIM wiring.
pcie_clock_patch="$(dirname "${FILES_OVERLAY_DIR}")/kernel-patches/967-arm64-dts-mt7988-pcie-external-clocks.patch"
pcie_clock_target=target/linux/mediatek/patches-6.12/967-arm64-dts-mt7988-pcie-external-clocks.patch
if ! cmp -s "$pcie_clock_patch" "$pcie_clock_target"; then
  cp "$pcie_clock_patch" "$pcie_clock_target"
fi
wifi_boot_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/zbt-wifi-firstboot-v7.patch"
if patch --dry-run --force --fuzz=0 --reverse -p1 < "$wifi_boot_patch" >/dev/null; then
  : # already present
else
  patch --batch --fuzz=0 --forward -p1 < "$wifi_boot_patch"
fi
# The upstream US 6 GHz rule is client-only (NO-IR), which makes a US AP
# impossible even when hostapd advertises the FCC VLP device class. Install a
# reviewed package patch that permits only the 14 dBm VLP ceiling; the higher
# indoor and standard-power/AFC classes remain unavailable.
regdb_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/wireless-regdb-us-6ghz-vlp.patch"
regdb_patch_target=package/firmware/wireless-regdb/patches/610-us-6ghz-vlp.patch
if ! cmp -s "$regdb_patch" "$regdb_patch_target"; then
  cp "$regdb_patch" "$regdb_patch_target"
fi
policy_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/mwan3-speed-policy.patch"
lifecycle_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/mwan3-mega-lifecycle.patch"
if patch --dry-run --force --fuzz=0 --reverse -p1 -d feeds/packages < "$lifecycle_patch" >/dev/null 2>&1; then
  patch --force --fuzz=0 --reverse -p1 -d feeds/packages < "$lifecycle_patch"
fi
# This insertion remains forward-applicable after application. Remove only
# exact known copies (including duplicates from older cached builds), check
# the target is otherwise pristine, then apply once. No checkout/reset.
while patch --dry-run --force --fuzz=0 --reverse -p1 -d feeds/packages < "$policy_patch" >/dev/null; do
  patch --force --fuzz=0 --reverse -p1 -d feeds/packages < "$policy_patch"
done
git -C feeds/packages diff --quiet -- net/mwan3/files/lib/mwan3/mwan3.sh || {
  echo 'Unrecognized mwan3 edits; preserving source for inspection' >&2; exit 3;
}
patch --batch --fuzz=0 --forward -p1 -d feeds/packages < "$policy_patch"
patch --batch --fuzz=0 --forward -p1 -d feeds/packages < "$lifecycle_patch"
mwan_luci_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/luci-app-mwan3-route-metric.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/luci < "$mwan_luci_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/luci < "$mwan_luci_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/luci < "$mwan_luci_patch" >/dev/null; then
  echo 'MWAN3 route-metric UI patch does not match pinned LuCI feed' >&2
  exit 3
fi
# Keep optional file sharing inert until the owner enables it in LuCI. The
# upstream package starts unconditionally, so both the daemon gate and its
# matching UI switch are pinned and validated here.
ksmbd_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/ksmbd-server-disabled.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/packages/net/ksmbd-tools < "$ksmbd_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/packages/net/ksmbd-tools < "$ksmbd_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/packages/net/ksmbd-tools < "$ksmbd_patch" >/dev/null; then
  echo 'KSMBD disabled-by-default patch does not match pinned packages feed' >&2
  exit 3
fi
ksmbd_luci_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/luci-app-ksmbd-enable-toggle.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 -d feeds/luci/applications/luci-app-ksmbd < "$ksmbd_luci_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 -d feeds/luci/applications/luci-app-ksmbd < "$ksmbd_luci_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 -d feeds/luci/applications/luci-app-ksmbd < "$ksmbd_luci_patch" >/dev/null; then
  echo 'KSMBD LuCI enable-toggle patch does not match pinned LuCI feed' >&2
  exit 3
fi
# Harden the board tree's QModem monitor copy that 52-zbt-qmodem-monitor-overlay
# installs over the feed worker on first boot. The patch is pinned to the exact
# OpenWrt commit checked above and is idempotent for reusable source trees.
qmodem_monitor_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/zbt-qmodem-monitor-hardening.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 < "$qmodem_monitor_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 < "$qmodem_monitor_patch"
elif ! patch --dry-run --batch --fuzz=0 --reverse -p1 < "$qmodem_monitor_patch" >/dev/null; then
  echo 'QModem monitor hardening patch does not match the pinned OpenWrt tree' >&2
  exit 3
fi
# 56-zbt-qmodem-soft-reboot-overlay replaces the feed RPC on first boot.
# Patch that authoritative copy too, retaining its security/reboot fixes.
qmodem_boot_patch="$(dirname "${FILES_OVERLAY_DIR}")/patches/zbt-qmodem-rpc-firstboot.patch"
if patch --dry-run --batch --fuzz=0 --forward -p1 < "$qmodem_boot_patch" >/dev/null; then
  patch --batch --fuzz=0 --forward -p1 < "$qmodem_boot_patch"
elif ! patch --dry-run --force --fuzz=0 --reverse -p1 < "$qmodem_boot_patch" >/dev/null; then
  echo 'QModem first-boot RPC patch does not match the pinned OpenWrt tree' >&2
  exit 3
fi
qmodem_monitor_source=target/linux/mediatek/filogic/base-files/usr/lib/zbt/qmodem-modem_monitor.sh
grep -Fq -- "--write-out '%{http_code}'" "$qmodem_monitor_source" &&
  grep -Fq '*generate_204*)' "$qmodem_monitor_source" &&
  grep -Fq 'zbt_monitor_recovery_streak' "$qmodem_monitor_source" || {
  echo 'QModem monitor source was not hardened as expected' >&2; exit 3;
}
mkdir -p files
if [[ -d "${FILES_OVERLAY_DIR}" ]]; then
  # This source tree is intentionally reusable between local builds. Mirror
  # the selected edition exactly so files removed from an overlay cannot leak
  # into a later firmware image through OpenWrt's persistent files/ directory.
  rsync -a --delete "${FILES_OVERLAY_DIR}/" files/
fi
# Read this identity from /rom at runtime: a settings-preserving upgrade must
# not misidentify its new image because an old /etc file was restored.
identity_args=(identity --repository-root "${RECIPE_ROOT}" --output files/etc/zbt-mega-build.json)
if [[ -n "${MEGA_RELEASE_VERSION}" ]]; then
  identity_args+=(--version "${MEGA_RELEASE_VERSION}")
fi
python3 "${RECIPE_ROOT}/firmware/scripts/mega-release.py" "${identity_args[@]}"
if [[ -d "files/etc/uci-defaults" ]]; then
  chmod +x files/etc/uci-defaults/* 2>/dev/null || true
fi
# Git-created overlay helpers must be executable in the image.
find files/etc/init.d files/etc/hotplug.d files/usr/sbin files/usr/libexec/rpcd -type f -exec chmod 755 {} +
if [[ "${INCLUDE_BACKUP_IMAGES}" = "1" && -d "${BACKUP_IMAGES_DIR}" ]]; then
  mkdir -p files/root/router-backups
  rsync -a "${BACKUP_IMAGES_DIR}/" files/root/router-backups/
fi
cp -f .config .config.bak 2>/dev/null || true
target_main="${TARGET%%/*}"
target_sub="${TARGET#*/}"
if [[ "${target_sub}" = "${TARGET}" ]]; then
  target_sub=""
fi
if [[ -z "${SUBTARGET}" && -n "${target_sub}" ]]; then
  SUBTARGET="${target_sub}"
fi
if [[ -f "${BASE_CONFIG_FILE}" ]]; then
  cp -f "${BASE_CONFIG_FILE}" .config
else
cat > .config <<EOF
CONFIG_TARGET_${target_main}=y
EOF
fi
if [[ -n "${SUBTARGET}" ]]; then
  echo "CONFIG_TARGET_${target_main}_${SUBTARGET}=y" >> .config
  target_device_config="CONFIG_TARGET_${target_main}_${SUBTARGET}_DEVICE_${DEVICE}"
else
  target_device_config="CONFIG_TARGET_${target_main}_DEVICE_${DEVICE}"
fi
echo "${target_device_config}=y" >> .config
if [[ -f "${PROFILE_PACKAGES_FILE}" ]]; then
  while IFS= read -r pkg; do
    [[ -z "${pkg}" || "${pkg}" =~ ^# ]] && continue
    echo "CONFIG_PACKAGE_${pkg}=y" >> .config
  done < "${PROFILE_PACKAGES_FILE}"
fi
if [[ -n "${PROFILE_PACKAGES_EXTRA_FILES}" ]]; then
  IFS=',' read -r -a extra_files <<< "${PROFILE_PACKAGES_EXTRA_FILES}"
  for extra_file in "${extra_files[@]}"; do
    [[ -f "${extra_file}" ]] || continue
    while IFS= read -r pkg; do
      [[ -z "${pkg}" || "${pkg}" =~ ^# ]] && continue
      echo "CONFIG_PACKAGE_${pkg}=y" >> .config
    done < "${extra_file}"
  done
fi
if [[ -f "${PROFILE_KCONFIG_FILE}" ]]; then
  cat "${PROFILE_KCONFIG_FILE}" >> .config
fi
make defconfig
# Source patches are not guaranteed to invalidate package stamps in a reused
# OpenWrt tree. Rebuild every directly patched package so an incremental build
# cannot ship an older dialer, QModem UI, MLO writer, or MWAN metric editor.
make package/feeds/luci/luci-base/clean
make package/feeds/luci/luci-mod-network/clean
make package/base-files/clean
make package/feeds/qmodem/qmodem/clean
make package/feeds/qmodem/tom_modem/clean
make package/feeds/qmodem/luci-app-qmodem-next/clean
make package/luci-app-mlo/clean
make package/network/services/hostapd/clean
make package/kernel/mac80211/clean
make package/kernel/mt76/clean
make package/feeds/luci/luci-app-mwan3/clean
make package/feeds/packages/mwan3/clean
make package/firmware/wireless-regdb/clean
make package/feeds/packages/ksmbd-tools/clean
make package/feeds/luci/luci-app-ksmbd/clean
make package/feeds/iwrt_luci/luci-theme-argon/clean
make package/feeds/custom_local/zbt-speedtest/clean
make package/feeds/custom_local/luci-app-speedtest-lite/clean
make package/feeds/custom_local/zbt-firmware-updater/clean
if ! grep -q '^CONFIG_PACKAGE_kmod-tun=y$' .config; then
  echo "Required package missing from resolved config: CONFIG_PACKAGE_kmod-tun=y" >&2
  exit 3
fi
required_config_flags=(
  "CONFIG_PACKAGE_ip-full=y"
  "${target_device_config}=y"
  "CONFIG_PACKAGE_kmod-usb-net-qmi-wwan=y"
  "CONFIG_PACKAGE_kmod-usb-net-cdc-mbim=y"
  "CONFIG_PACKAGE_kmod-usb-wdm=y"
  "CONFIG_PACKAGE_kmod-usb-serial-option=y"
  "CONFIG_PACKAGE_uqmi=y"
  "CONFIG_PACKAGE_umbim=y"
  "CONFIG_PACKAGE_qmodem=y"
  "CONFIG_PACKAGE_luci-app-qmodem-next=y"
  "CONFIG_PACKAGE_luci-app-qmodem-monitor=y"
  "CONFIG_PACKAGE_luci-app-qmodem-ttlfw4=y"
  "CONFIG_PACKAGE_luci-app-qmodem_INCLUDE_ADD_QFIREHOSE_SUPPORT=y"
  "CONFIG_PACKAGE_luci-app-qmodem_INCLUDE_generic-qmi-wwan=y"
  "CONFIG_PACKAGE_luci-proto-qmi=y"
  "CONFIG_PACKAGE_luci-proto-mbim=y"
  "CONFIG_PACKAGE_quectel-CM-5G-M=y"
  "CONFIG_PACKAGE_ndisc6=y"
  "CONFIG_PACKAGE_kmod-mhi-bus=y"
  "CONFIG_PACKAGE_kmod-mhi-net=y"
  "CONFIG_PACKAGE_kmod-mhi-pci-generic=y"
  "CONFIG_PACKAGE_kmod-mhi-wwan-ctrl=y"
  "CONFIG_PACKAGE_kmod-mhi-wwan-mbim=y"
  "CONFIG_PACKAGE_mwan3=y"
  "CONFIG_PACKAGE_luci-app-mwan3=y"
  "CONFIG_PACKAGE_tailscale=y"
  "CONFIG_PACKAGE_luci-app-tailscale=y"
  "CONFIG_PACKAGE_luci-app-modem-watchdog=y"
  "CONFIG_PACKAGE_luci-app-speedtest-lite=y"
  "CONFIG_PACKAGE_zbt-speedtest=y"
  "CONFIG_PACKAGE_zbt-firmware-updater=y"
  "CONFIG_PACKAGE_luci-app-zbt-about=y"
  "CONFIG_PACKAGE_ca-bundle=y"
  "CONFIG_PACKAGE_curl=y"
  "CONFIG_PACKAGE_kmod-tun=y"
  "CONFIG_PACKAGE_libstdcpp=y"
  "CONFIG_PACKAGE_libkeyutils=y"
  "CONFIG_PACKAGE_libatomic=y"
  "CONFIG_PACKAGE_iptables-nft=y"
  "CONFIG_PACKAGE_kmod-nft-tproxy=y"
  "CONFIG_PACKAGE_iptables-mod-tproxy=y"
  "CONFIG_PACKAGE_kmod-tcp-bbr=y"
  "CONFIG_PACKAGE_iptables-mod-extra=y"
  "CONFIG_PACKAGE_iptables-mod-conntrack-extra=y"
  "CONFIG_PACKAGE_luci-nginx=y"
  "CONFIG_PACKAGE_python3-light=y"
  "CONFIG_PACKAGE_kmod-usb-net-cdc-ether=y"
  "CONFIG_PACKAGE_kmod-usb-net-rndis=y"
  "CONFIG_PACKAGE_kmod-usb-net-ipheth=y"
  "CONFIG_PACKAGE_usbmuxd=y"
  "CONFIG_PACKAGE_libimobiledevice-utils=y"
  "CONFIG_PACKAGE_usbutils=y"
  "CONFIG_PACKAGE_block-mount=y"
  "CONFIG_PACKAGE_e2fsprogs=y"
  "CONFIG_PACKAGE_parted=y"
  "CONFIG_PACKAGE_kmod-usb-storage=y"
  "CONFIG_PACKAGE_kmod-usb-storage-uas=y"
  "CONFIG_PACKAGE_kmod-fs-ext4=y"
  "CONFIG_PACKAGE_kmod-fs-exfat=y"
  "CONFIG_PACKAGE_kmod-fs-vfat=y"
  "CONFIG_PACKAGE_kmod-nls-utf8=y"
  "CONFIG_PACKAGE_ksmbd-server=y"
  "CONFIG_PACKAGE_luci-app-ksmbd=y"
  "CONFIG_PACKAGE_usbip=y"
  "CONFIG_PACKAGE_usbip-client=y"
  "CONFIG_PACKAGE_usbip-server=y"
  "CONFIG_PACKAGE_kmod-usbip=y"
  "CONFIG_PACKAGE_kmod-usbip-client=y"
  "CONFIG_PACKAGE_kmod-usbip-server=y"
)
for cfg in "${required_config_flags[@]}"; do
  if ! grep -q "^${cfg}$" .config; then
    echo "Required package missing from resolved config: ${cfg}" >&2
    exit 3
  fi
done
make tools/install -j"${HOST_MAKE_JOBS}" V=s
make toolchain/install -j"${HOST_MAKE_JOBS}" V=s
make package/feeds/packages/golang-bootstrap/host/compile -j1 V=s
make -j"${FINAL_MAKE_JOBS}" V=s

mt76_build_source="$(find build_dir/target-* -type f -path '*/mt76-*/mt7996/mmio.c' -print -quit)"
if [[ -z "$mt76_build_source" ]] ||
   ! grep -Fq 'MT_DRV_HW_PS_BUFFERING' "$mt76_build_source"; then
  echo 'Built MT7996 source does not contain the reviewed PS buffering backport' >&2
  exit 4
fi

manifest="$(find "bin/targets/${target_main}/${SUBTARGET}" -maxdepth 1 -type f -name "*zbt-z8803be*.manifest" -print -quit)"
if [[ -z "${manifest}" ]]; then
  echo "No ZBT-Z8803BE image manifest was produced" >&2
  exit 4
fi
required_image_packages=(
  kmod-usb-net-qmi-wwan kmod-usb-net-cdc-mbim kmod-usb-wdm
  kmod-usb-serial-option uqmi umbim luci-proto-qmi luci-proto-mbim
  qmodem luci-app-qmodem-next luci-app-qmodem-monitor
  luci-app-qmodem-ttlfw4 quectel-CM-5G-M ndisc6
  kmod-mhi-bus kmod-mhi-net kmod-mhi-pci-generic
  kmod-mhi-wwan-ctrl kmod-mhi-wwan-mbim mwan3 kmod-tun
  luci-app-modem-watchdog luci-app-speedtest-lite tailscale luci-app-tailscale
  zbt-speedtest zbt-firmware-updater luci-app-zbt-about
  ca-bundle curl libstdcpp6 libkeyutils1 libatomic1
  iptables-nft kmod-nft-tproxy
  iptables-mod-tproxy kmod-tcp-bbr iptables-mod-extra
  iptables-mod-conntrack-extra luci-nginx python3-light
  kmod-usb-net-cdc-ether kmod-usb-net-rndis kmod-usb-net-ipheth
  usbmuxd libimobiledevice-utils usbutils block-mount e2fsprogs parted
  kmod-usb-storage kmod-usb-storage-uas kmod-fs-ext4 kmod-fs-exfat
  kmod-fs-vfat kmod-nls-utf8 ksmbd-server luci-app-ksmbd
  usbip usbip-client usbip-server kmod-usbip kmod-usbip-client
  kmod-usbip-server
)
for package in "${required_image_packages[@]}"; do
  if ! grep -q "^${package} - " "${manifest}"; then
    echo "Required runtime package missing from image manifest: ${package}" >&2
    exit 4
  fi
done
echo "Validated image manifest: ${manifest}"

rootfs_dir="$(find build_dir -maxdepth 2 -type d -name 'root-mediatek' -print -quit)"
if [[ -z "${rootfs_dir}" ]]; then
  echo "Unable to locate the built MediaTek root filesystem" >&2
  exit 4
fi
cmp target/linux/mediatek/filogic/base-files/usr/lib/zbt/qmodem-rpcd "${rootfs_dir}/usr/lib/zbt/qmodem-rpcd"
for rpc_source in usr/lib/zbt/qmodem-rpcd usr/libexec/rpcd/qmodem; do
  for marker in 'get_5g_deployment)' 'set_5g_deployment)' '. /usr/lib/zbt/qmodem-5g.sh'; do
    grep -Fq "$marker" "${rootfs_dir}/$rpc_source" || {
      echo "5G RPC missing from pre/post-first-boot backend: $rpc_source" >&2; exit 4;
    }
  done
done
grep -Fq 'install_if_changed /usr/lib/zbt/qmodem-rpcd /usr/libexec/rpcd/qmodem 0755' \
  "${rootfs_dir}/etc/uci-defaults/56-zbt-qmodem-soft-reboot-overlay" || exit 4
qmodem_monitor_rootfs="${rootfs_dir}/usr/lib/zbt/qmodem-modem_monitor.sh"
test -x "$qmodem_monitor_rootfs" || {
  echo 'Hardened QModem monitor tree copy is missing from the image' >&2; exit 4;
}
grep -Fq -- "--write-out '%{http_code}'" "$qmodem_monitor_rootfs" &&
  grep -Fq '*generate_204*)' "$qmodem_monitor_rootfs" &&
  grep -Fq 'MONITOR_RECOVERY_STREAK_DEFAULT=3' "$qmodem_monitor_rootfs" &&
  grep -Fq 'config_get MONITOR_RECOVERY_STREAK main zbt_monitor_recovery_streak' "$qmodem_monitor_rootfs" || {
  echo 'QModem monitor HTTP/recovery hardening is missing from the image' >&2; exit 4;
}
run_actions_line="$(grep -nF '            run_actions' "$qmodem_monitor_rootfs" | tail -n 1 | cut -d: -f1)"
mark_action_line="$(grep -nF '            mark_monitor_action' "$qmodem_monitor_rootfs" | tail -n 1 | cut -d: -f1)"
if [[ -z "$run_actions_line" || -z "$mark_action_line" || "$run_actions_line" -ge "$mark_action_line" ]]; then
  echo 'QModem monitor must mark its cooldown only after dispatching actions' >&2
  exit 4
fi
qmodem_monitor_overlay="${rootfs_dir}/etc/uci-defaults/52-zbt-qmodem-monitor-overlay"
grep -Fq 'SRC=/usr/lib/zbt/qmodem-modem_monitor.sh' "$qmodem_monitor_overlay" &&
  grep -Fq 'DST=/usr/share/qmodem/modem_monitor.sh' "$qmodem_monitor_overlay" || {
  echo 'QModem first-boot worker overlay is missing from the image' >&2; exit 4;
}
if grep -R -Fq 'zbt_monitor_recovery_streak' "${rootfs_dir}/etc/config" "${rootfs_dir}/etc/uci-defaults"; then
  echo 'QModem recovery-streak default must remain runtime-only' >&2
  exit 4
fi
grep -Fq 'monitor_enabled=0' "${rootfs_dir}/usr/sbin/zbt-qmodem-profile" || {
  echo 'QModem monitoring is not disabled by default in the image' >&2; exit 4;
}
for runtime_file in usr/sbin/modem-watchdog etc/config/modem_watchdog etc/init.d/modem_watchdog; do
  cmp "${CUSTOM_FEED_DIR}/luci-app-modem-watchdog/root/$runtime_file" "${rootfs_dir}/$runtime_file" || exit 4
done
grep -Fq 'action=worker result=started' "${rootfs_dir}/usr/sbin/modem-watchdog" || exit 4
test -x "${rootfs_dir}/lib/netifd/proto/zbtqmi.sh" || exit 4
test -x "${rootfs_dir}/usr/libexec/ip-full" || exit 4
grep -Fq 'proto="zbtqmi"; protov6="zbtqmi"' "${rootfs_dir}/usr/share/qmodem/modem_dial.sh" || exit 4
test -x "${rootfs_dir}/usr/bin/zbt-speedtest" || {
  echo 'Live speed test engine missing from firmware' >&2; exit 4;
}
test -x "${rootfs_dir}/usr/bin/zbt-firmware-updater" || {
  echo 'Mega release updater missing from firmware' >&2; exit 4;
}
cmp files/etc/zbt-mega-build.json "${rootfs_dir}/etc/zbt-mega-build.json"
cp "${rootfs_dir}/etc/zbt-mega-build.json" "bin/targets/${target_main}/${SUBTARGET}/zbt-mega-build.json"
# Fail the build if an upstream package overwrites the Mega experience.
for overlay_file in \
  www/luci-static/resources/view/zbt8803be/mega-about-v2.js \
  www/luci-static/resources/view/zbt8803be/mega-about-v2.css \
  www/luci-static/resources/view/system/mega-update.js \
  www/luci-static/resources/view/system/mega-update.css \
  www/luci-static/resources/zbt-mega-mobile.css \
  usr/libexec/rpcd/zbt.firmware \
  usr/share/rpcd/acl.d/zbt-firmware.json \
  usr/share/rpcd/acl.d/luci-app-zbt-about.json \
  usr/share/luci/menu.d/luci-app-zbt-about.json \
  usr/share/luci/menu.d/zbt-firmware.json; do
  cmp "${FILES_OVERLAY_DIR}/${overlay_file}" "${rootfs_dir}/${overlay_file}" || {
    echo "Mega About/update component missing or overwritten: ${overlay_file}" >&2; exit 4;
  }
done
grep -Fq 'zbt-mega-mobile.css' \
  "${rootfs_dir}/usr/share/ucode/luci/template/themes/argon/header.ut" || {
  echo 'Mega mobile stylesheet is not loaded by the installed Argon header' >&2; exit 4;
}
cmp "${CUSTOM_FEED_DIR}/luci-app-speedtest-lite/htdocs/luci-static/resources/view/speedtest-lite/config.js" \
  "${rootfs_dir}/www/luci-static/resources/view/speedtest-lite/config.js"
cmp "${CUSTOM_FEED_DIR}/luci-app-speedtest-lite/htdocs/luci-static/resources/view/speedtest-lite/style.css" \
  "${rootfs_dir}/www/luci-static/resources/view/speedtest-lite/style.css"
required_overlay_files=(
  lib/netifd/proto/zbtqmi.sh
  www/luci-static/resources/protocol/zbtqmi.js
  usr/lib/zbt/modem-health.sh
  usr/lib/zbt/modem-recovery.sh
  usr/lib/zbt/qmi-publish.sh
  usr/lib/zbt/qmi-session.sh
  usr/lib/zbt/qmodem-start.sh
  usr/libexec/rpcd/zbt.wifi
  usr/lib/zbt/modem-leds.sh
  usr/sbin/zbt-modem-led-poller
  usr/sbin/zbt-mwan-diagnostics
  etc/uci-defaults/99-zbt-modem-recovery-v1
  etc/uci-defaults/99-zbt-modem-recovery-v2
  etc/uci-defaults/99-zbt-modem-recovery-v3
  etc/uci-defaults/99-zbt-modem-recovery-v4
  etc/uci-defaults/99-zbt-modem-recovery-v5
  usr/lib/zbt/5g-state.sh
  usr/lib/zbt/5g-adaptive.sh
  usr/lib/zbt/mwan-runtime.sh
  usr/lib/zbt/mwan-reconcile.sh
  usr/sbin/zbt-mwan-standby-ready
  usr/sbin/zbt-mwan-failback
  usr/sbin/zbt-5g-adaptive
  etc/init.d/zbt-5g-adaptive
  etc/hotplug.d/iface/90-zbt-mwan-failback
  etc/uci-defaults/99-zbt-5g-adaptive-v1
  etc/uci-defaults/99-zbt-5g-adaptive-v2
  etc/uci-defaults/99-zbt-modem-route-v5
  etc/uci-defaults/99-zbt-qmi-netifd-v11
  etc/uci-defaults/99-zbt-qmi-netifd-v12
  usr/lib/zbt/qmodem-5g.sh
  usr/libexec/rpcd/zbt.speedify
  usr/share/rpcd/acl.d/zbt-speedify.json
  etc/uci-defaults/95-mwan3-defaults
  etc/uci-defaults/40-zbt-usb-tether-defaults
  etc/uci-defaults/80-zbt-z8803be-admin-password
  etc/uci-defaults/99-cellular-multiwan-defaults
  etc/uci-defaults/99-speedify-bootstrap
  etc/nginx/conf.d/zbt-speedify-https.locations
  etc/init.d/speedify-installer
  etc/init.d/zbt-speedify-guard
  usr/sbin/zbt-speedify-guard
  usr/lib/zbt/speedify-routing.sh
  etc/init.d/zbt-luci-backend
  usr/sbin/speedify-installer-loop
  usr/share/zbt/speedify-luci-wrapper.js
  www/luci-static/resources/view/speedify/speedify.js
  usr/share/luci/menu.d/zbt-speedify-launcher.json
  www/luci-static/resources/view/speedify/launcher.js
  usr/share/rpcd/acl.d/luci-app-speedify.json
  usr/sbin/zbt-luci-backend-check
  usr/sbin/zbt-speed-sample
  usr/libexec/rpcd/zbt.speedtest
  usr/libexec/rpcd/zbt.tailscale
  usr/lib/zbt/dual-modem.sh
  usr/lib/zbt/qmodem-cell-discovery.sh
  usr/lib/zbt/modem-leds.sh
  etc/init.d/zbt-modem-leds
  etc/uci-defaults/48-zbt-modem-led-dark-repair
  etc/uci-defaults/49-zbt-modem-labels-leds
  etc/uci-defaults/53-zbt-modem-display-labels-v2
  etc/uci-defaults/73-zbt-us-wifi-defaults
  etc/uci-defaults/74-zbt-mlo-shared-iface-repair
  etc/uci-defaults/50-zbt-luci-web-recovery
  usr/lib/zbt/quectel-bands.sh
  usr/lib/zbt/speed-lock.sh
  usr/lib/zbt/speed-policy.sh
  usr/lib/zbt/mwan3-speed-metric.sh
  usr/sbin/zbt-qmodem-profile
  usr/sbin/zbt-modem-led-poller
  usr/sbin/zbt-mwan-apply
  usr/sbin/zbt-mwan-preset
  etc/init.d/qmodem_network
  etc/uci-defaults/99-zbt-route-priority-repair
  etc/hotplug.d/net/15-zbt-rndis-auto
  usr/share/rpcd/acl.d/zbt-speedtest.json
  usr/share/luci/menu.d/tailscale.json
  etc/config/usbipd
  usr/share/luci/menu.d/zbt-usb-services.json
)
for overlay_file in "${required_overlay_files[@]}"; do
  if [[ ! -s "${rootfs_dir}/${overlay_file}" ]]; then
    echo "Required overlay file missing from built root filesystem: ${overlay_file}" >&2
    exit 4
  fi
done
echo "Validated files overlay in root filesystem: ${rootfs_dir}"
for component in usr/sbin/zbt-mwan-apply usr/sbin/zbt-5g-adaptive usr/sbin/zbt-mwan-failback usr/lib/zbt/qmodem-start.sh usr/libexec/rpcd/zbt.wifi usr/sbin/conntrack usr/bin/util-linux-flock; do
  test -x "${rootfs_dir}/$component" || { echo "Missing adaptive/failback executable: $component" >&2; exit 4; }
done
[ "$(readlink "${rootfs_dir}/etc/rc.d/S99zbt-5g-adaptive")" = ../init.d/zbt-5g-adaptive ] || {
  echo 'Adaptive worker lacks its boot service link' >&2; exit 4;
}
[ "$(readlink "${rootfs_dir}/etc/rc.d/S99modem_watchdog")" = ../init.d/modem_watchdog ] || {
  echo 'Central modem watchdog lacks its boot service link' >&2; exit 4;
}
grep -Fq 'sleep 10' "${rootfs_dir}/usr/lib/zbt/modem-recovery.sh" || {
  echo 'RM551E ten-second GPIO recovery pulse is missing from the image' >&2; exit 4;
}
if grep -Fq 'kernel-data-path-lost' "${rootfs_dir}/usr/lib/zbt/qmi-session.sh"; then
  echo 'QMI supervisor must not tear down a live CM during route publication gaps' >&2; exit 4;
fi
grep -Fq 'result=worker-registered' "${rootfs_dir}/usr/lib/zbt/modem-recovery.sh" || {
  echo 'Watchdog recovery does not verify persistent QModem worker registration' >&2; exit 4;
}
test -s "${rootfs_dir}/lib/mwan3/libwrap_mwan3_sockopt.so.1.0" || {
  echo 'Watchdog MultiWAN probe socket binding library is missing' >&2; exit 4;
}
for overlay_file in usr/libexec/rpcd/zbt.wifi usr/lib/zbt/modem-health.sh usr/lib/zbt/modem-recovery.sh usr/sbin/zbt-mwan-diagnostics; do
  cmp "${FILES_OVERLAY_DIR}/${overlay_file}" "${rootfs_dir}/${overlay_file}" || exit 4
done
grep -Fq 'Automatic preferred — modem/network selection (recommended)' \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/config_advanced.js" || exit 4
test -x "${rootfs_dir}/usr/sbin/zbt-speedify-guard" &&
  test -x "${rootfs_dir}/etc/init.d/zbt-speedify-guard" || exit 4
for overlay_file in usr/lib/zbt/mwan-reconcile.sh usr/sbin/zbt-mwan-apply usr/lib/zbt/5g-state.sh usr/lib/zbt/5g-adaptive.sh usr/lib/zbt/mwan-runtime.sh usr/sbin/zbt-mwan-failback usr/sbin/zbt-5g-adaptive etc/init.d/zbt-5g-adaptive etc/hotplug.d/iface/90-zbt-mwan-failback etc/uci-defaults/99-zbt-5g-adaptive-v1 etc/uci-defaults/99-zbt-5g-adaptive-v2 etc/uci-defaults/99-zbt-modem-recovery-v2 etc/uci-defaults/99-zbt-modem-recovery-v3 etc/uci-defaults/99-zbt-modem-recovery-v4 etc/uci-defaults/99-zbt-modem-recovery-v5 usr/lib/zbt/qmodem-5g.sh usr/lib/zbt/qmi-session.sh usr/lib/zbt/qmodem-start.sh usr/sbin/zbt-wifi-firstboot etc/init.d/zbt-wifi-firstboot etc/uci-defaults/71-zbt-wifi-firstboot usr/lib/zbt/mwan3-speed-metric.sh usr/libexec/rpcd/zbt.speedify usr/share/rpcd/acl.d/zbt-speedify.json usr/share/zbt/speedify-luci-wrapper.js usr/lib/zbt/speedify-routing.sh usr/sbin/zbt-speedify-guard etc/init.d/zbt-speedify-guard etc/uci-defaults/99-zbt-modem-route-v5 etc/uci-defaults/99-zbt-qmi-netifd-v11 etc/uci-defaults/99-zbt-qmi-netifd-v12 www/luci-static/resources/view/network/quick-wifi.js usr/share/luci/menu.d/zbt-quick-wifi.json usr/share/rpcd/acl.d/zbt-quick-wifi.json; do
  cmp "${FILES_OVERLAY_DIR}/${overlay_file}" "${rootfs_dir}/${overlay_file}" || exit 4
done
# Check the actual installed dialer and authoritative board defaults, not
# only overlay helpers which would be inert without their pinned call sites.
grep -Fq 'zbt_qmi_session "$@"' "${rootfs_dir}/usr/share/qmodem/modem_dial.sh" || exit 4
grep -Fq '4_1|2_1) state_fullfill=1' "${rootfs_dir}/usr/share/qmodem/modem_dial.sh" || {
  echo 'QModem fixed-slot discovery-state recovery is missing from the image' >&2; exit 4;
}
grep -Fq 'case "$modem_config" in' "${rootfs_dir}/usr/share/qmodem/modem_dial.sh" &&
grep -Fq 'A stale discovery state must not turn an automatic retry into a' \
  "${rootfs_dir}/usr/share/qmodem/modem_dial.sh" || {
  echo 'QModem fixed-slot final dial dispatch is still gated by stale discovery state' >&2; exit 4;
}
grep -Fq 'fixed modem slot $slot not enumerated yet' "${rootfs_dir}/etc/init.d/qmodem_init" || {
  echo 'QModem late-enumeration guard is missing from the image' >&2; exit 4;
}
grep -Fq 'procd_set_param command /usr/lib/zbt/qmodem-start.sh "$1"' \
  "${rootfs_dir}/etc/init.d/qmodem_network" || exit 4
grep -Fq 'zbt_qmodem_ready "$section"' \
  "${rootfs_dir}/usr/lib/zbt/qmodem-start.sh" || exit 4
grep -Fq 'action=dialer-exited' \
  "${rootfs_dir}/usr/lib/zbt/qmodem-start.sh" || exit 4
grep -Fq 'procd_set_param respawn 3600 5 0' \
  "${rootfs_dir}/etc/init.d/zbt-wifi-firstboot" || exit 4
grep -Fq 'configured-ap-not-running phase=boot' \
  "${rootfs_dir}/usr/sbin/zbt-wifi-firstboot" || exit 4
grep -Fq '[ -d "$1" ] || exit 1' "${rootfs_dir}/etc/uci-defaults/72-zbt-z8803be-wifi" || exit 4
grep -Fq 'wireless.${radio}.legacy_rates=1' \
  "${rootfs_dir}/etc/uci-defaults/73-zbt-us-wifi-defaults" || {
  echo 'Kept-configuration 2.4 GHz compatibility migration is missing' >&2; exit 4;
}
if grep -q '/sbin/wifi reload' "${rootfs_dir}/etc/uci-defaults/72-zbt-z8803be-wifi"; then
  echo 'Unsafe first-boot wireless reload survived into the image' >&2; exit 4;
fi
[ "$(grep -c 'metric=$(zbt_speed_metric' "${rootfs_dir}/lib/mwan3/mwan3.sh")" = 1 ] || {
  echo 'mwan3 image has missing/duplicated metric hook' >&2; exit 4;
}
for mwan_file in lib/mwan3/common.sh lib/mwan3/mwan3.sh usr/sbin/mwan3 etc/hotplug.d/iface/15-mwan3; do
  cmp -s "feeds/packages/net/mwan3/files/$mwan_file" "${rootfs_dir}/$mwan_file" || {
    echo "MWAN lifecycle code missing from built image: $mwan_file" >&2; exit 4;
  }
done
for overlay_file in usr/lib/zbt/qmi-publish.sh usr/sbin/zbt-mwan-standby-ready; do
  cmp -s "${FILES_OVERLAY_DIR}/$overlay_file" "${rootfs_dir}/$overlay_file" || exit 4
done
# A package/base-files install must expose exactly one modem LED owner. S97
# deliberately runs after OpenWrt's generic S96 LED configuration service.
[ "$(readlink "${rootfs_dir}/etc/rc.d/S97zbt-modem-leds")" = ../init.d/zbt-modem-leds ] || {
  echo 'Modem LED boot service is not enabled at S97 in the image' >&2; exit 4;
}
mapfile -t modem_led_links < <(find "${rootfs_dir}/etc/rc.d" -maxdepth 1 -type l -name 'S??zbt-modem-leds' -print)
[ "${#modem_led_links[@]}" -eq 1 ] || {
  printf 'Expected one modem LED startup link, found %s: %s\n' "${#modem_led_links[@]}" "${modem_led_links[*]}" >&2
  exit 4
}
[ "$(readlink "${rootfs_dir}/etc/rc.d/S10zbt-leds")" = ../init.d/zbt-leds ] || {
  echo 'Far5eer status LED state machine is not enabled at S10' >&2; exit 4;
}
test -x "${rootfs_dir}/etc/zbt-leds.sh" && test -x "${rootfs_dir}/etc/hotplug.d/iface/40-zbt-status-led" || {
  echo 'Far5eer status LED runtime is missing from the image' >&2; exit 4;
}
cmp target/linux/mediatek/filogic/base-files/etc/zbt-leds.sh "${rootfs_dir}/etc/zbt-leds.sh" || {
  echo 'Far5eer modem/status LED helper was changed or overwritten in rootfs' >&2; exit 4;
}
for overlay_file in usr/lib/zbt/modem-leds.sh usr/lib/zbt/qmodem-cell-discovery.sh usr/sbin/zbt-modem-led-poller etc/init.d/zbt-modem-leds etc/hotplug.d/net/15-zbt-rndis-auto etc/hotplug.d/net/20-zbt-modem-led usr/sbin/zbt-qmodem-profile usr/sbin/zbt-qmodem-performance-policy usr/sbin/zbt-mwan-preset etc/uci-defaults/40-zbt-usb-tether-defaults etc/uci-defaults/48-zbt-modem-led-dark-repair etc/uci-defaults/49-zbt-modem-labels-leds etc/uci-defaults/53-zbt-modem-display-labels-v2 etc/uci-defaults/55-zbt-modem-labels-policy-v3 etc/uci-defaults/73-zbt-us-wifi-defaults etc/uci-defaults/74-zbt-mlo-shared-iface-repair etc/uci-defaults/95-mwan3-defaults etc/uci-defaults/99-cellular-multiwan-defaults etc/uci-defaults/99-zbt-route-priority-repair etc/uci-defaults/99-zbt-modem1-priority-v4 etc/init.d/zbt-luci-backend usr/sbin/zbt-luci-backend-check etc/uci-defaults/50-zbt-luci-web-recovery; do
  cmp -s "${FILES_OVERLAY_DIR}/${overlay_file}" "${rootfs_dir}/${overlay_file}" || {
    echo "Runtime repair was overwritten in rootfs: ${overlay_file}" >&2; exit 4;
  }
done
grep -Fq 'configure_member failover_4_1 4_1 4 1' "${rootfs_dir}/usr/sbin/zbt-mwan-preset" &&
grep -Fq 'configure_member failover_2_1 2_1 5 1' "${rootfs_dir}/usr/sbin/zbt-mwan-preset" &&
grep -Fq 'configure_member balanced_4_1 4_1 4 1' "${rootfs_dir}/usr/sbin/zbt-mwan-preset" &&
grep -Fq 'configure_member balanced_2_1 2_1 5 1' "${rootfs_dir}/usr/sbin/zbt-mwan-preset" || {
  echo 'Strict Modem 1 before Modem 2 policy is missing from the image' >&2; exit 4;
}
if grep -Eq "write_preference|preferred=2|applyPreset\('fastest'\)" \
  "${rootfs_dir}/usr/sbin/modem-watchdog" \
  "${rootfs_dir}/www/luci-static/resources/view/modem-watchdog/config.js"; then
  echo 'Built image still permits automatic Modem 2 promotion' >&2; exit 4;
fi
regdb_source="$(find build_dir/target-* -maxdepth 2 -type f -path '*/wireless-regdb-*/db.txt' -print -quit)"
if [[ -z "$regdb_source" ]]; then
  echo 'Unable to locate the prepared wireless regulatory database' >&2
  exit 4
fi
grep -Fq $'\t(5925 - 7125 @ 320), (14)' "$regdb_source" || {
  echo 'US 6 GHz VLP power rule is missing from the prepared regulatory database' >&2; exit 4;
}
if sed -n '/^country US:/,/^country /p' "$regdb_source" | grep -Fq $'\t(5925 - 7125 @ 320), (12), NO-OUTDOOR, NO-IR'; then
  echo 'Client-only US 6 GHz NO-IR rule survived package preparation' >&2
  exit 4
fi
test -s "${rootfs_dir}/lib/firmware/regulatory.db" || {
  echo 'Compiled wireless regulatory database is missing from the image' >&2; exit 4;
}
grep -Fq 'network_metric=$(uci -q get network.${interface_name}.metric)' \
  "${rootfs_dir}/usr/share/qmodem/modem_dial.sh" || {
  echo 'QModem is not consuming the persistent network route metric' >&2; exit 4;
}
grep -Eq "form\.DummyValue,[[:space:]]*'_route_metric'" \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/network_config.js" || {
  echo 'QModem read-only route-metric display is missing from the image' >&2; exit 4;
}
grep -Eq "uci\.set\('network',[[:space:]]*section_id,[[:space:]]*'metric',[[:space:]]*value\);" \
  "${rootfs_dir}/www/luci-static/resources/view/mwan3/network/interface.js" || {
  echo 'MultiWAN Manager route-metric editor is missing from the image' >&2; exit 4;
}
grep -Fq '"network"' \
  "${rootfs_dir}/usr/share/rpcd/acl.d/luci-app-mwan3.json" || {
  echo 'MultiWAN Manager lacks permission to persist network metrics' >&2; exit 4;
}
grep -Eq "option[[:space:]]+'?enabled'?[[:space:]]+'?0'?" \
  "${rootfs_dir}/etc/config/ksmbd" || {
  echo 'KSMBD is not disabled by default in the image' >&2; exit 4;
}
grep -Fq 'config_get_bool enabled globals enabled 0' \
  "${rootfs_dir}/etc/init.d/ksmbd" || {
  echo 'KSMBD service lacks its disabled-by-default runtime gate' >&2; exit 4;
}
grep -Eq "form\.Flag,[[:space:]]*'enabled'" \
  "${rootfs_dir}/www/luci-static/resources/view/ksmbd.js" || {
  echo 'KSMBD LuCI enable switch is missing from the image' >&2; exit 4;
}
grep -Eq "option[[:space:]]+enable[[:space:]]+'0'" \
  "${rootfs_dir}/etc/config/usbipd" || {
  echo 'USB/IP server is not disabled by default in the image' >&2; exit 4;
}
test -x "${rootfs_dir}/usr/sbin/usbip" && test -x "${rootfs_dir}/usr/sbin/usbipd" || {
  echo 'USB/IP client/server binaries are missing from the image' >&2; exit 4;
}
grep -Fq 'admin/system/mounts' \
  "${rootfs_dir}/usr/share/luci/menu.d/zbt-usb-services.json" || {
  echo 'Services > USB Storage menu alias is missing from the image' >&2; exit 4;
}
[ "$(readlink "${rootfs_dir}/etc/rc.d/S79uwsgi")" = ../init.d/uwsgi ] || {
  echo 'LuCI uWSGI backend is not enabled at S79' >&2; exit 4;
}
[ "$(readlink "${rootfs_dir}/etc/rc.d/S80nginx")" = ../init.d/nginx ] || {
  echo 'LuCI nginx frontend is not enabled at S80' >&2; exit 4;
}
grep -q '/etc/init.d/uhttpd disable' "${rootfs_dir}/etc/uci-defaults/50-zbt-luci-web-recovery" || {
  echo 'LuCI web-stack migration does not disable the competing uhttpd listener' >&2; exit 4;
}
grep -q 'if /usr/sbin/zbt-luci-backend-check' "${rootfs_dir}/etc/uci-defaults/50-zbt-luci-web-recovery" || {
  echo 'LuCI first-boot migration does not actively repair a failed nginx start' >&2; exit 4;
}
grep -Eq "uci.set\('wireless',[[:space:]]*mldIface,[[:space:]]*'device',[[:space:]]*selectedDevices\);" \
  "${rootfs_dir}/www/luci-static/resources/view/mlo/main.js" || {
  echo 'Corrected shared-interface MLO page is missing from the image' >&2; exit 4;
}
grep -Fq 'function validateMld(' "${rootfs_dir}/www/luci-static/resources/view/mlo/main.js" || {
  echo 'Validated non-destructive MLO editor is missing from the image' >&2; exit 4;
}
grep -Eq 'L.toArray\(wifi_iface.device\).indexOf\(radio\)' \
  "${rootfs_dir}/www/luci-static/resources/view/network/wireless.js" || {
  echo 'MLD-aware Wireless enable/disable controls are missing from the image' >&2; exit 4;
}
# Keep the upstream package from silently restoring the global-only TTL UI
# or old init/hotplug/default writers over this firmware's independent policy.
for overlay_file in \
  usr/lib/zbt/ttl.sh usr/sbin/zbt-qmodem-ttl etc/init.d/qmodem_ttl \
  etc/nftables.d/99-qmodem-ttl.nft \
  etc/hotplug.d/net/95-zbt-qmodem-ttl etc/hotplug.d/iface/60-zbt-ttl-probe \
  etc/uci-defaults/36-zbt-z8803be-wan-speed-mode etc/uci-defaults/54-zbt-qmodem-ttl-defaults \
  www/luci-static/resources/view/qmodem/ttl.js \
  usr/share/rpcd/acl.d/luci-app-qmodem-ttlfw4.json; do
  cmp -s "${FILES_OVERLAY_DIR}/${overlay_file}" "${rootfs_dir}/${overlay_file}" || {
    echo "Per-modem TTL repair missing or overwritten in rootfs: ${overlay_file}" >&2; exit 4;
  }
done
for ui_file in qmodem/qmodem.js view/qmodem/network_config.js view/qmodem/settings.js; do
  grep -q display_name "${rootfs_dir}/www/luci-static/resources/${ui_file}" || {
    echo "Friendly modem labels missing from built LuCI: ${ui_file}" >&2; exit 4;
  }
done
for apn in broadband NXTGENPHONE ENHANCEDPHONE firstnet-broadband fast.t-mobile.com vzwinternet h2g2 h2g2-t usccinternet; do
  [ "$(grep -Fo "o.value('$apn'" "${rootfs_dir}/www/luci-static/resources/view/qmodem/network_config.js" | wc -l)" -eq 2 ] || {
    echo "US APN preset missing from one or both built SIM selectors: $apn" >&2; exit 4;
  }
done
grep -Fq 'Phone Number (MSISDN)' \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/overview.js" || {
  echo 'Per-modem SIM phone-number field is missing from built LuCI' >&2; exit 4;
}
grep -Fq 'zbt_quectel_sim_number "$at_port"' \
  "${rootfs_dir}/usr/share/qmodem/vendor/quectel.sh" || {
  echo 'Robust Quectel subscriber-number lookup is missing from the image' >&2; exit 4;
}
grep -Fq 'zbt_quectel_get_cells "$at_port"' \
  "${rootfs_dir}/usr/share/qmodem/vendor/quectel.sh" || {
  echo 'Quectel nearby-cell discovery is missing from the image' >&2; exit 4;
}
grep -Fq "'AT+QSCAN=3,1'" \
  "${rootfs_dir}/usr/lib/zbt/qmodem-cell-discovery.sh" || {
  echo 'Quectel LTE/NR full-scan command is missing from the image' >&2; exit 4;
}
grep -Fq 'take up to three minutes' \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/config_advanced.js" || {
  echo 'Nearby-cell scan timing guidance is missing from LuCI' >&2; exit 4;
}
grep -Fq 'Automatic preferred — modem/network selection (recommended)' \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/config_advanced.js" || {
  echo 'Quectel SA/NSA connection-type control is missing from LuCI' >&2; exit 4;
}
grep -Fq 'Automatic adaptive — measured SA/NSA tests (optional)' \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/config_advanced.js" || {
  echo 'Optional measured SA/NSA control is missing from LuCI' >&2; exit 4;
}
grep -Fq 'NSA only — LTE-anchored 5G speed comparison' \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/config_advanced.js" || {
  echo 'Prominent NSA performance comparison is missing from LuCI' >&2; exit 4;
}
grep -Fq "readfile('/rom/etc/zbt-mega-build.json')" \
  "${rootfs_dir}/usr/share/ucode/luci/runtime.uc" || {
  echo 'Firmware-specific LuCI resource cache version is missing from the image' >&2; exit 4;
}
grep -Fq '. /usr/lib/zbt/qmodem-5g.sh' \
  "${rootfs_dir}/usr/libexec/rpcd/qmodem" || {
  echo 'Quectel SA/NSA readback backend is missing from the image' >&2; exit 4;
}
grep -Fq 'zbt_5g_policy)' \
  "${rootfs_dir}/usr/lib/zbt/qmodem-5g.sh" || {
  echo 'Saved Mega 5G deployment policy is missing from QModem RPC' >&2; exit 4;
}
grep -Fq "return uci.load('qmodem').then" \
  "${rootfs_dir}/www/luci-static/resources/view/qmodem/config_advanced.js" || {
  echo 'QModem Advanced page lacks its cache-compatible direct label loader' >&2; exit 4;
}
grep -Fq 'add_quectel_ca_report "$ca_response"' \
  "${rootfs_dir}/usr/share/qmodem/vendor/quectel.sh" || {
  echo 'Full Quectel carrier-aggregation report is missing from the image' >&2; exit 4;
}
grep -Fq 'root_password_is_unset()' \
  "${rootfs_dir}/usr/share/ucode/luci/dispatcher.uc" || {
  echo 'First-login root-password enforcement is missing from built LuCI' >&2; exit 4;
}
grep -Fq "password') + '?first=1'" \
  "${rootfs_dir}/usr/share/ucode/luci/dispatcher.uc" || {
  echo 'First-login password route is missing its completion marker' >&2; exit 4;
}
grep -Eq "window\.location\.replace\(L\.url\('admin',[[:space:]]*'about'\)\)" \
  "${rootfs_dir}/www/luci-static/resources/view/system/password.js" || {
  echo 'Successful first-login password setup does not continue to About' >&2; exit 4;
}

for image_pattern in '*zbt-z8803be-initramfs-kernel.bin' '*zbt-z8803be-squashfs-sysupgrade.bin'; do
  image="$(find "bin/targets/${target_main}/${SUBTARGET}" -maxdepth 1 -type f -size +0c -name "${image_pattern}" -print -quit)"
  if [[ -z "${image}" ]]; then
    echo "Required ZBT-Z8803BE image was not produced: ${image_pattern}" >&2
    exit 4
  fi
  echo "Validated firmware image: ${image}"
done
# A newly added kernel patch must invalidate cached preparation. Refuse a
# release if the actual kernel tree used by the image still has four clocks.
clock_tree_checked=0
for kernel_dtsi in build_dir/target-*/linux-mediatek_filogic/linux-6.12.74/arch/arm64/boot/dts/mediatek/mt7988a.dtsi; do
  [ -f "$kernel_dtsi" ] || continue
  [ "$(grep -c '"pextp_clk"' "$kernel_dtsi")" = 4 ] || {
    echo 'Kernel preparation omitted the PCIe clock backport' >&2; exit 4;
  }
  clock_tree_checked=1
done
[ "$clock_tree_checked" = 1 ] || { echo 'Cannot verify prepared kernel PCIe clocks' >&2; exit 4; }
