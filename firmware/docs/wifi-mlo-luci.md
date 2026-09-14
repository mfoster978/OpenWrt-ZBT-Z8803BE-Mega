# Legacy 2.4 GHz plus 5/6 GHz MLO

These instructions describe the corrected source, not older published images
that still contain the same-SSID MLO editor bug. Applying Wi-Fi configuration
briefly interrupts wireless clients; use Ethernet and save a configuration backup.

## Intended layout

| Radio | Mode | Access point security | MLO membership |
| --- | --- | --- | --- |
| 2.4 GHz | N / HT20, legacy rates allowed | WPA2-PSK / CCMP, PMF off | Separate AP |
| 5 GHz | BE / EHT80 initially | WPA3-SAE, PMF required | One shared 5+6 GHz MLD |
| 6 GHz | BE / EHT160 initially | WPA3-SAE, PMF required | Same shared MLD |

The separate legacy AP and MLD may have matching SSIDs and passphrases without
sharing their security or link membership. This does not guarantee that every
client will roam correctly between WPA2 and WPA3 or use both MLO links. A separate
legacy SSID remains an option for compatibility-sensitive devices.

## LuCI setup

1. In **Network → Wireless**, retain or add one separate 2.4 GHz access point on
   `lan`, with WPA2-PSK/CCMP and a valid passphrase. Do not put this radio in MLO.
2. Check that the 5 and 6 GHz radios are enabled and use **BE** mode. Start with
   80 MHz and 160 MHz respectively. Keep the appropriate country/regulatory
   settings; the MLO editor does not change channel, width or country.
3. In **Network → WiFi 7 MLO**, edit the desired group or use **+ Add MLD**.
   Select only 5 GHz and 6 GHz, choose WPA3-SAE, enter the SSID/passphrase, click
   **Save**, then **Save & Apply**. Editing a group now changes that group only,
   even when another standalone AP advertises the same SSID. Removing a link
   does not create another standalone AP or rewrite an existing AP's security.
4. In **Network → Quick Wi-Fi Setup**, review the displayed target networks,
   enter the desired common name/password and use **Apply to All Three Bands**.
   The active MLO section is selected for 5/6 GHz even if disabled factory APs
   remain. It is written once. A separate 2.4 GHz AP remains preferred for that
   band. Guest and other secondary APs are not renamed.
5. Use **Apply 2.4 GHz Legacy Device Compatibility** on that page. It selects
   channel 1, HT20, legacy rates and WPA2-CCMP; turns off PMF and fast roaming;
   and keeps WMM enabled. It does not change the SSID or passphrase. Other APs
   sharing the radio also share its channel and radio mode.
6. Reconnect clients. **Refresh Wi-Fi Connection Report** distinguishes
   association, authorization and DHCP leases; a lease alone is not proof of
   current connectivity. Use a compatible Wi-Fi 7 client to test MLO.

If an older image already deleted a legacy AP, these changes do not guess or
reconstruct its lost settings. Add it explicitly under Network → Wireless.
No upgrade migration rewrites the owner's SSIDs, passwords or radio modes.

## Source regression coverage

- Saving/renaming/deleting an MLD uses its exact configuration identity instead
  of deleting every AP with the same SSID; guest and standalone records survive.
- Linked radios must be configured for EHT and share supported security and PMF.
- Wireless enable/disable handles device lists, preserving a radio still used
  by another AP, station or MLD; enabling an MLD enables its individual radios.
- Quick setup chooses active primary LAN targets over disabled factory records,
  preserves WPA2 on the legacy AP and WPA3 on MLO, and displays its targets.
- Pinned source patch application, cached-build reversal, and minified LuCI
  behavior are checked before accepting the source changes. Physical radio and
  client interoperability still require hardware testing.
