# Per-modem raw-IP QMI MTU

The recommended default remains **1500 bytes** for both fixed modem slots.
This feature does not change radio mode, APN, modem firmware, USB drivers,
watchdog thresholds, recovery actions, or WAN routing policy.

## Configuration

Open **QModem Configuration → Dial Configuration → Edit** for the desired
modem. Under its advanced settings, **Cellular MTU** accepts an integer from
**1280 through 1500**. Each physical modem has its own setting:

- Modem 1: `qmodem.4_1.mtu`
- Modem 2: `qmodem.2_1.mtu`

The modem profile seeds 1500 only for a missing option and preserves existing
owner settings. An absent or malformed UCI value falls back to 1500 at runtime. The fallback
never rewrites the saved configuration. Opening the UI does not write defaults;
Save & Apply uses the existing QModem/UCI apply path. Valid existing values are
retained. Bridge mode hides the field without deleting its saved value, and the
supervisor does not enforce MTU on bridge passthrough, non-raw-IP interfaces,
or unrelated QModem devices.

The existing supervisor re-reads the selected slot's setting on every check
(normally every five seconds while its CM child is alive). It writes only when
the live MTU differs, verifies the result, and protects the physical USB mapping
and interface generation. Redial and USB re-enumeration start a new supervisor
which reads the same saved setting. Changing only this setting is deliberately
not added to the dial fingerprint: it does not itself require a modem restart.

To restore the recommended policy for a slot, set its Cellular MTU to 1500.
Settings persist over reboots and upgrades which retain the QModem configuration;
a clean/reset installation returns to the 1500 default.

## Caution

A custom value is an advanced override, not a new stability recommendation.
On affected RM551E/driver combinations, lowering the host-interface MTU may
reintroduce the RX-error failure that the 1500 workaround addressed. Keep 1500
unless there is a specific reason to test another value. This setting is the
local host-interface MTU, not a guarantee of the end-to-end carrier path MTU.

## Build and regression checks

The UI addition is the separate `qmodem-mtu-v17.patch`, applied after v16 and
unwound before v16 for cached builds. The original pre-MTU v16 patch is restored;
a reverse-only compatibility patch recognizes the brief PR #7 variant that
embedded MTU in v16. Tests execute the actual builder cleanup on clean, original
v16, PR #7 v16, and v17 caches, and preserve unrecognized local edits. Firmware
input checks run `node --test firmware/tests/qmi-mtu*.test.cjs`; the pinned-patch
suite checks the complete forward/reverse stack and JavaScript syntax. These
software tests cover policy and isolation, not long-duration modem hardware or
carrier testing of custom values.
