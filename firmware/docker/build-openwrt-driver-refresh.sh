#!/usr/bin/env bash
set -euo pipefail

# Experimental driver-stack build. This deliberately leaves the normal
# Mega build recipe unchanged until the refreshed Wi-Fi/QMI stack compiles and
# is tested on hardware.
OPENWRT_ROOT="${OPENWRT_ROOT:-/workspace/openwrt}"
OPENWRT_GIT_URL="${OPENWRT_GIT_URL:-https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE.git}"
OPENWRT_GIT_REF="${OPENWRT_GIT_REF:-v25.12.021}"
EXPECTED_OPENWRT_COMMIT="${EXPECTED_OPENWRT_COMMIT:-edc738504fe8fae81eb15de967456204699b1830}"
ALLOW_CLONE_OPENWRT="${ALLOW_CLONE_OPENWRT:-1}"
RECIPE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_BUILDER="${RECIPE_ROOT}/firmware/docker/build-openwrt.sh"
QMI_PATCH="${RECIPE_ROOT}/firmware/kernel-patches/762-net-usb-qmi-wwan-rx-urb-size.patch"

MT76_OLD_DATE=2026-03-19
MT76_OLD_VERSION=39c960c3ada558b4c2e7915772483d3731573d09
MT76_OLD_HASH=7a9f8ea21eee5324e6638ace627dd305b3650ae6ca86109317d9ee83702140eb
MT76_NEW_DATE=2026-09-01
MT76_NEW_VERSION=be5ce7910521492d4a2e4ce7ee3843680a46c047
MT76_NEW_HASH=d1d0f7588c5b9ceafcac341ce19dd206ed9ec106847e672ab77e48bacb57f81a

if [[ ! -d "${OPENWRT_ROOT}/.git" ]]; then
  [[ "${ALLOW_CLONE_OPENWRT}" = 1 ]] || {
    echo "Missing OPENWRT_ROOT: ${OPENWRT_ROOT}" >&2
    exit 2
  }
  git clone --depth 1 --branch "${OPENWRT_GIT_REF}" "${OPENWRT_GIT_URL}" "${OPENWRT_ROOT}"
fi

resolved_openwrt_commit="$(git -C "${OPENWRT_ROOT}" rev-parse HEAD)"
[[ -z "${EXPECTED_OPENWRT_COMMIT}" || "${resolved_openwrt_commit}" = "${EXPECTED_OPENWRT_COMMIT}" ]] || {
  echo "Driver refresh requires OpenWrt ${EXPECTED_OPENWRT_COMMIT}; found ${resolved_openwrt_commit}" >&2
  exit 2
}

mt76_makefile="${OPENWRT_ROOT}/package/kernel/mt76/Makefile"
[[ -f "$mt76_makefile" ]] || { echo 'Missing mt76 package Makefile' >&2; exit 3; }

python3 - "$mt76_makefile" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()
old = {
    'PKG_RELEASE=2': 'PKG_RELEASE=1',
    'PKG_SOURCE_DATE:=2026-03-19': 'PKG_SOURCE_DATE:=2026-09-01',
    'PKG_SOURCE_VERSION:=39c960c3ada558b4c2e7915772483d3731573d09': 'PKG_SOURCE_VERSION:=be5ce7910521492d4a2e4ce7ee3843680a46c047',
    'PKG_MIRROR_HASH:=7a9f8ea21eee5324e6638ace627dd305b3650ae6ca86109317d9ee83702140eb': 'PKG_MIRROR_HASH:=d1d0f7588c5b9ceafcac341ce19dd206ed9ec106847e672ab77e48bacb57f81a',
}
new_markers = list(old.values())
if all(marker in s for marker in new_markers):
    pass
elif all(marker in s for marker in old):
    for before, after in old.items():
        if s.count(before) != 1:
            raise SystemExit(f'mt76 pin marker is not unique: {before}')
        s = s.replace(before, after)
    p.write_text(s)
else:
    raise SystemExit('mt76 package pin is neither the reviewed March base nor the reviewed September refresh')
PY

for marker in \
  "PKG_RELEASE=1" \
  "PKG_SOURCE_DATE:=${MT76_NEW_DATE}" \
  "PKG_SOURCE_VERSION:=${MT76_NEW_VERSION}" \
  "PKG_MIRROR_HASH:=${MT76_NEW_HASH}"; do
  grep -Fqx "$marker" "$mt76_makefile" || {
    echo "Refreshed mt76 pin missing: $marker" >&2
    exit 3
  }
done

# Linux 6.12.74 predates the stable qmi_wwan FLAG_NOMAXMTU fix. Install the
# exact upstream patch into OpenWrt's generic 6.12 backport series so QMI can
# size USB receive URBs to the modem-negotiated transfer size while keeping the
# network MTU bounded normally.
qmi_target="${OPENWRT_ROOT}/target/linux/generic/backport-6.12/762-zbt-qmi-wwan-rx-urb-size.patch"
mkdir -p "$(dirname "$qmi_target")"
if [[ -e "$qmi_target" ]] && ! cmp -s "$QMI_PATCH" "$qmi_target"; then
  echo "Unexpected existing kernel patch at $qmi_target" >&2
  exit 3
fi
cp "$QMI_PATCH" "$qmi_target"

# The September mt76 snapshot already contains the PS/TIM, EOSP and stale
# station queue fixes previously backported by Mega. Generate a temporary copy
# of the normal build recipe which skips only those now-redundant mt76 patches.
# Everything else, including the mac80211 AQL helper, hostapd fixes, overlays,
# package selection and image validation, stays on the normal build path.
generated_builder="${RECIPE_ROOT}/firmware/docker/.build-openwrt-driver-refresh.generated.sh"
trap 'rm -f "$generated_builder"' EXIT
python3 - "$BASE_BUILDER" "$generated_builder" <<'PY'
from pathlib import Path
import sys

src = Path(sys.argv[1]).read_text()
start_marker = '# The pinned 2026-03-19 mt76 snapshot predates upstream MT7996 hardware power-'
end_marker = "# mt76's throttle uses the paired mac80211 AQL query"
start = src.find(start_marker)
end = src.find(end_marker)
if start < 0 or end < 0 or end <= start:
    raise SystemExit('normal build recipe mt76 backport block changed; refusing an unreviewed refresh')
replacement = '''# Driver-refresh test: the 2026-09-01 mt76 pin already contains Mega's\n# former PS/TIM and legacy-client follow-up backports. Remove stale copies\n# from reusable trees and rely on the upstream implementation.\nrm -f package/kernel/mt76/patches/999-zbt-mt7996-ps-buffering.patch \\\n      package/kernel/mt76/patches/999-zbt-mt7996-ps-zlegacy-followup.patch\n'''
out = src[:start] + replacement + src[end:]
# Keep the normal post-build marker check but describe what it now verifies.
out = out.replace(
    "Built MT7996 source does not contain the reviewed PS buffering backport",
    "Built MT7996 source does not contain upstream PS buffering support")
Path(sys.argv[2]).write_text(out)
PY
chmod 0755 "$generated_builder"

printf 'Driver refresh test: mt76=%s (%s), qmi_wwan NOMAXMTU backport enabled\n' \
  "$MT76_NEW_VERSION" "$MT76_NEW_DATE"

exec bash "$generated_builder"
