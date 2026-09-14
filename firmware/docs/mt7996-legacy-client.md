# MT7996 legacy-client compatibility

Mega keeps its board kernel and MT7996 firmware pinned. Its mt76 source is the
OpenWrt `2026-03-19` snapshot at commit
`39c960c3ada558b4c2e7915772483d3731573d09`.

The factory defaults enable 802.11b rates only on the 2.4 GHz radio, use
WPA2-CCMP, disable PMF there, and use HT20. Settings-preserving upgrades enable
legacy rates but **do not** replace an owner's saved security or radio mode.
The board default exits when an existing SSID is present; the previous wording
incorrectly implied that the entire compatibility profile also migrated.

Network → Quick Wi-Fi Setup now has an explicit **Apply 2.4 GHz Camera
Compatibility** action. It applies that profile to the primary, separate 2.4 GHz
LAN AP without changing its SSID or password, and clears inherited minimum-rate
and fast-roaming restrictions. It refuses shared MLO sections and invalid keys.
Other bands keep their settings. Other guest APs or station uplinks keep their
own security and credentials, but if they share the same 2.4 GHz radio they
also inherit its 20 MHz mode and rates. The confirmation explains this. WMM stays
enabled because disabling it also disables 802.11n and was reported to make the
same upstream MT7996 legacy-client failure worse.

The [upstream MT7996 legacy-client report](https://github.com/openwrt/mt76/issues/1101)
uses the same `39c960c3` driver snapshot and records successful association but
an unreliable data plane. It is **not evidence that a DVR failing to join has
the same defect**: that report completed the WPA2 handshake and DHCP, while
the DVR's failure stage has not been established. The pinned driver predates MT7996 hardware power-save
buffering support. Mega
backports the following focused upstream mt76 work in
`patches/mt76-mt7996-ps-buffering.patch`:

- [`9a46d8d21d2a`](https://github.com/openwrt/mt76/commit/9a46d8d21d2acf89ab5f5df693cd3d76273bb15c) — hardware-managed TIM/PS buffering support
- [`b0af99f238f7`](https://github.com/openwrt/mt76/commit/b0af99f238f77f497a5b97a2110136f209922d6b) — MT7996 firmware PS-sync event handling
- [`f8b59ca3be7b`](https://github.com/openwrt/mt76/commit/f8b59ca3be7b17703df55ef9bbe3f6398d5c094c) — prevent an undrainable sleeping station starving all bands
- [`06b69763f2aa`](https://github.com/openwrt/mt76/commit/06b69763f2aa9f5e0a9c5cd334813612bd4a2f9c) — validate PS-sync TLVs
- [`2b7be52496ac`](https://github.com/openwrt/mt76/commit/2b7be52496ac0a418dd80bcb921adf963ccbffe3) — preserve the more-data flag for buffered frames
- [`cf8a369f`](https://github.com/openwrt/mt76/commit/cf8a369f) — set the on-air EOSP bit on the final U-APSD frame
- [`c488b587`](https://github.com/openwrt/mt76/commit/c488b587) — send disassociation through the power-save queue
- [`0898393e`](https://github.com/openwrt/mt76/commit/0898393e) — clear stale MT7996 station queue state during disconnect

The buffered-frame changes are mechanically adapted to the pinned function
signature; their behavior is unchanged. Together with the disconnect cleanup,
they cover clients that otherwise keep a U-APSD service period open or reconnect
into a stale firmware queue. The matching upstream report also records that
WPA2/PMF/HT20/legacy-rate configuration changes alone did not cure its data-plane
failure, so Mega does not weaken all radios or enable WPA1 as a workaround. Its paired
[`ieee80211_txq_aql_pending()` helper](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=9a197e71eb7b45860e37a9f3bdf61a843781ae12)
postdates the pinned backports archive, so Mega backports that exact helper too,
using the archive's existing broadcast-AQL field name. The build applies both
as OpenWrt package patches, forces mac80211 and mt76 clean, and verifies the
prepared mt76 source contains the capability before accepting an image.

The Quick Wi-Fi **Refresh Wi-Fi Connection Report** action is read-only and
on-demand. It reports the 2.4 GHz hostapd association and authorization flags,
matching unexpired DHCP leases, and a limited set of connection events. It
never returns passwords, hostapd configuration or arbitrary log lines. An
authorized station with no lease may use a static IP; a lease alone does not
prove a current connection or Internet access. Use the DVR's Wi-Fi MAC to find
the relevant station while retrying its connection. No further driver change
is justified from the phrase "cannot connect" alone.
