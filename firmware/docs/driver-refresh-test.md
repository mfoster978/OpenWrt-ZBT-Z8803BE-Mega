# Experimental September driver refresh

Use only `firmware/docker/build-openwrt-driver-refresh.sh` on the
`driver-refresh-test` branch. Publish test images as GitHub prereleases,
never as production Latest. Do not merge the branch merely to build it.

The base remains Far5eer `v25.12.021`, Linux **6.12.74** and wireless
backports **6.18.7**. mt76 is pinned to September 1, 2026 commit
`be5ce7910521492d4a2e4ce7ee3843680a46c047`, archive SHA256
`d1d0f7588c5b9ceafcac341ce19dd206ed9ec106847e672ab77e48bacb57f81a`.
The QMI RX URB/max-MTU backport is based on Linux commit
`55f854dd5bdd8e19b936a00ef1f8d776ac32c7b0`. Both RM551E-GL modems retain
QMI mode; this does not update modem firmware or issue mode-switch commands.

## Required wireless API backports

The first complete compile exposed APIs that the new mt76 snapshot needs
but the pinned wireless stack does not provide. The experimental wrapper
installs these additional patches; the production builder does not:

- `driver-refresh-mac80211-airtime.patch`: the unchanged OpenWrt patch from
  [92143f94b6b35e5b3602c1f9d2cfb6e2f9a63085](https://github.com/openwrt/openwrt/commit/92143f94b6b35e5b3602c1f9d2cfb6e2f9a63085)
  adds the real station-airtime callback, change notification, station-upload
  notification and tracing. The driver's callback is not removed or stubbed.
- `driver-refresh-mac80211-fils-link.patch` and
  `driver-refresh-mac80211-probe-link.patch`: Linux commits
  [0495b64132154dd04ed5d443bb35afd3769a13a6](https://github.com/torvalds/linux/commit/0495b64132154dd04ed5d443bb35afd3769a13a6)
  and [e098c26b3524b6a8087dfc8f664d7cc76d30ecc2](https://github.com/torvalds/linux/commit/e098c26b3524b6a8087dfc8f664d7cc76d30ecc2),
  with the already-present mt76 call-site changes excluded. These retrieve
  the requested MLO link's discovery template under RCU, not the default link.
  The corresponding ath call sites are retained for API consistency.
- `driver-refresh-mt76-6.18-compat.patch`: use the older named action union
  with `offsetofend()` bounds through each field actually read. Omit the
  common-connac switch cases for the NAN data-interface type that cannot
  exist in this pinned nl80211 API. Ordinary NAN and the MT7996 AP/station/
  mesh modes remain. This image selects MT7996, not the new MT7925 NAN stack.

The normal Mega hostapd/MLO, AQL and runtime fixes are retained. The old
mt76 PS/TIM and legacy-client patches are redundant with September upstream
and are removed only in the experimental build tree. Kernel and package
versions, archive hashes and source identity checks remain enforced.

The wrapper generates its adjusted builder outside the recipe checkout,
retains the correct recipe path, and removes the temporary file on both
success and failure. This avoids falsely dirtying a clean source identity.

Before a full build, run the input checks and
`node --test firmware/tests/driver-refresh.test.cjs`. These include strict
patch application/reversal against pinned sources and source-identity tests.
After compilation, verify the actual kernel/mt76/mac80211 sources and modules
in the extracted images. Compile success is not hardware-test certification.
