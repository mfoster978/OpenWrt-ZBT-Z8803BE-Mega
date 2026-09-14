# MT7996 legacy-client compatibility

Mega keeps its board kernel and MT7996 firmware pinned. Its mt76 source is the
OpenWrt `2026-03-19` snapshot at commit
`39c960c3ada558b4c2e7915772483d3731573d09`.

The factory and settings-preserving defaults enable 802.11b rates only on the
2.4 GHz radio, retain WPA2-CCMP, disable PMF there, and use HT20. WMM stays
enabled because disabling it also disables 802.11n and was reported to make the
same upstream MT7996 legacy-client failure worse.

The [matching upstream MT7996 legacy-client report](https://github.com/openwrt/mt76/issues/1101)
uses the same `39c960c3` driver snapshot and records successful association but
an unreliable data plane. The pinned driver predates MT7996 hardware power-save
buffering support. Mega
backports the following focused upstream mt76 work in
`patches/mt76-mt7996-ps-buffering.patch`:

- [`9a46d8d21d2a`](https://github.com/openwrt/mt76/commit/9a46d8d21d2acf89ab5f5df693cd3d76273bb15c) — hardware-managed TIM/PS buffering support
- [`b0af99f238f7`](https://github.com/openwrt/mt76/commit/b0af99f238f77f497a5b97a2110136f209922d6b) — MT7996 firmware PS-sync event handling
- [`f8b59ca3be7b`](https://github.com/openwrt/mt76/commit/f8b59ca3be7b17703df55ef9bbe3f6398d5c094c) — prevent an undrainable sleeping station starving all bands
- [`06b69763f2aa`](https://github.com/openwrt/mt76/commit/06b69763f2aa9f5e0a9c5cd334813612bd4a2f9c) — validate PS-sync TLVs
- [`2b7be52496ac`](https://github.com/openwrt/mt76/commit/2b7be52496ac0a418dd80bcb921adf963ccbffe3) — preserve the more-data flag for buffered frames

The last change is mechanically adapted to the pinned function signature; its
behavior is unchanged. Its paired
[`ieee80211_txq_aql_pending()` helper](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=9a197e71eb7b45860e37a9f3bdf61a843781ae12)
postdates the pinned backports archive, so Mega backports that exact helper too,
using the archive's existing broadcast-AQL field name. The build applies both
as OpenWrt package patches, forces mac80211 and mt76 clean, and verifies the
prepared mt76 source contains the capability before accepting an image.
