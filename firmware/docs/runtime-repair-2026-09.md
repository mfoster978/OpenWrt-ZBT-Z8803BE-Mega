# September 2026 dual-modem runtime repair

Status: build #18 compiled the initial repairs. The user reports working Speedify, speed testing, and primary-modem Internet with both SIMs inserted, but unlit modem LEDs and an unconnected secondary modem. The September 10 follow-up below requires a new build and physical-router acceptance checks. Do not label the older build #17 as containing these repairs.

## September 10 LED and label follow-up

- The profile helper had replaced friendly aliases with routing IDs. QModem's `display_name` now restores Modem 1 / Modem 2 in dropdowns, overview, settings, dial configuration and log titles, while internal interface IDs remain stable. Existing custom display names are preserved. Label-only changes do not change either dialer's fingerprint.
- The LED service now starts at S97, after generic LED initialization (S96). An upgrade migration enables that service without starting/stopping modems. Trigger, RX/TX and device bindings are checked and restored if overwritten; brightness is explicitly initialized. A missing named-GPIO read no longer extinguishes an enumerated modem, and a powered modem without a data interface is shown as waiting.
- The LED GPIOs remain 61 / 53 and the modem power GPIOs remain 17 / 52, with their pinned polarities. No SIM mux changes, new AT polling, modem reset, power cycle, Speedify changes or speed-test changes are included. Unsupported trigger/carrier reporting has a steady-lit fallback. LED state represents presence/address/link activity, not a successful Internet probe or a radio-generation color code.
- `zbt-modem-led-poller status` and the runtime verifier report physical mappings, power-read state, trigger and brightness without writing them. The precise on-device reason for the previous dark LEDs has not been independently measured; these are tested startup/state-handling repairs, not an electrical validation.
- Modem 2's supplied log still shows SIM_READY but PS Detached. No evidence yet establishes the registration cause. Collect its own `AT+CEREG?`, `AT+C5GREG?`, `AT+CGATT?`, `AT+CFUN?` and current dial log; do not reset the working primary or force an APN/band/SIM change blindly.

Host tests cover both LED-to-USB mappings, swapped network enumeration, delayed discovery, missing power reads, disabled secondary power, trigger clobber, missing attributes, read-only status and actual patched LuCI label methods. They do not prove that the secondary SIM can register with its carrier.

## September 10 WAN and Ethernet activity follow-up

The earlier LED inventory covered the three LAN ports but omitted the separate copper WAN jack. Its inherited MT7988 2.5GbE driver had link-only register defaults and no LED-class callbacks, and its device-tree LED0 node was disabled. The new board patch enables that existing LED0 pin as `mdio-bus:0f:amber:wan`; LED1 stays disabled. A narrow driver backport exposes brightness and netdev controls, enables link/RX/TX indication, and corrects the inherited TX masks. The PHY's firmware cache remains separate from the shared LED state.

All three orange LAN lamps and the one orange WAN lamp now have stock LuCI rules: solid with link, blinking on RX/TX, off without link. Existing user rules are preserved. Modem 5G1/5G2 GPIOs and power controls are untouched by the Ethernet patch. Tests compile the real C LED callbacks/shared helpers against simulated MDIO registers, check RX-only/TX-only/2.5G behavior and brightness, and apply/reverse the patches against the pinned sources. This is not a full kernel build or a physical-light test; both require the new firmware.

## What the supplied evidence establishes

| Observation | Finding and response |
|---|---|
| Modem 1 obtained IPv4/IPv6 and reported 5G SA attachment | Its USB/QMI driver and basic data path worked. Avoid replacing the working kernel or modem driver. |
| Modem 2 reported SIM_READY but remained PS Detached | The SIM is readable, but successful packet-service registration is not demonstrated. An APN change alone is not a proven fix. |
| Both dialers were hung at the same logged second | A shared restart can interrupt both. The old custom hotplug path did globally restart QModem; the log alone cannot establish which caller caused every restart. |
| A post-flash hook reset modem 1 while handling modem events | The automatic factory-reset/reboot hook is disabled. A firmware update must not silently erase module configuration or reboot the wrong modem. |
| Both USB buses were attributed to LED 1 | Broad `*-1` matching and a presumed second path `4-2` were wrong for the supplied `4-1` / `2-1` topology. One mapped LED poller now owns both indicators. |
| QModem startup submitted an empty procd service object | Nested service operations corrupted startup registration. Startup now builds one transaction; targeted commands operate on one instance. |
| `modem1` DHCP competed with a `4_1` interface on the same device | QModem and mwan3 now use one identity per slot. The patched QMI/MBIM `-d` path owns addresses without a second DHCP client. |
| Speed-test JSON parsing encountered a shell shebang | nginx served the old CGI script as a static file. The browser now calls an authenticated rpcd backend, not a web-exposed shell endpoint. |
| Speedify appeared after reboot but opened a 404 | The old installer could switch back to uhttpd after a health failure. That server cannot serve the vendor's nginx alias/proxy URL. nginx is retained, its authenticated routes repaired, and menu visibility no longer waits for the VPN daemon to be healthy. |
| Tailscale daemon was present but menu absent | The pinned feeds did not supply the requested LuCI package. A local, explicitly required status/sign-in package is now built. |
| SA band boxes were empty / setting bands appeared ineffective | Empty or failed reads are now distinguished from a valid selection. Writes must return OK and match a subsequent readback; errors are surfaced to the user. |

The pasted log's March-to-September timestamp jump is consistent with correcting the clock after gaining connectivity; it is not proof of a months-long outage. Wi-Fi emitted startup errors but subsequently reported all three APs enabled and a client connected. Those lines do not justify replacing Wi-Fi drivers or raising file limits blindly. Missing first-boot fstab/seed messages were followed by a mounted writable overlay and saved seed.

## Hardware and SIM identity

The kernel version remains **6.12.74** from Far5eer tag **v25.12.021**, commit `edc738504fe8fae81eb15de967456204699b1830`. The release config remains the baseline. Modem-driver and Wi-Fi sources are unchanged; the WAN LED follow-up adds only the documented board LED0 enablement and Ethernet PHY LED backport. It is no longer accurate to describe the entire DTS/kernel patch set as unmodified.

| Physical modem | QModem/netifd identity | USB path | Power enable | LED |
|---|---|---|---|---|
| Modem 1 / 5G1 | `4_1` | `4-1` | GPIO 17, `5g1`, active-high | GPIO 61, `blue:mobile-1`, active-low |
| Modem 2 / 5G2 | `2_1` | `2-1` | GPIO 52, `5g2`, active-high | GPIO 53, `blue:mobile-2`, active-low |

GPIO assignments match the [pinned device tree](https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE/blob/edc738504fe8fae81eb15de967456204699b1830/target/linux/mediatek/dts/mt7988a-zbtlink-zbt-z8803be.dts). USB identity comes from the supplied two-modem runtime evidence; this is not an electrical measurement of every board revision. GPIO 59/SIM switching is deliberately untouched because the user confirmed correct card identities. Each module can report its own internal SIM input **1**, even though the board connects different cards to those modules. Never remap a working SIM based solely on this display.

The modules are the same RM551E-GL model but have different **internal modem firmware**: modem 1 reports `RM551EGL00AAR01A02M8G`, modem 2 `RM551EGL00AAR02A02M8G`. This router firmware change does not upgrade or downgrade either module. Reported voltages of 4003 and 3992 mV differ by only 11 mV; these snapshots alone neither identify a power fault nor rule out transient droop under load.

## APN and carrier independence

Both modems use the same configuration helper and dialer. For QMI, blank/`auto` APN normally means retaining the connection manager's modem/network profile negotiation, not sending a literal APN named `auto` or clearing an existing profile. The one narrow fallback is a directly identified AT&T US MCC/MNC `310/410` SIM, which receives the data-device APN `broadband`. Manual APNs, authentication, PINs and SIM selections are always preserved and override that fallback. The two editable APN selectors contain matching U.S. carrier presets; no APN is inferred for carriers whose network code may also identify MVNOs.

This is not a promise of universal zero-configuration access: carrier activation, plan-specific APNs, coverage, device approval, modem firmware and carrier profiles can matter. The modem 2 log already shows a saved `nxtgenphone` profile; it does **not** prove there was no APN. The firmware therefore does not overwrite every user's profile with that value.

## Speed-based failover

The controls are under **Network → MultiWAN Manager → Priority & Recovery**. Modem 1 now remains above Modem 2 in every firmware-managed policy; the former speed-sampling promotion is retired. Guarded watchdog recovery defaults on for both slots and retains separate permission controls for users who disable it later.

The background sampler is a bounded, single-stream HTTPS transfer, not a complete Ookla benchmark. It binds the physical interface, which matters when both modem NATs return the same private address. Background tests use up to 25 MB each. Two modems sampled every 15 minutes can use approximately 4.8 GB/day. The old interactive sample has since been replaced by [live tests against Speedtest.net servers](live-speedtest.md), which have substantially higher data usage and separate user confirmation. The kernel timer/traffic LED cannot establish Internet reachability or distinguish SA/NSA by color.

Speed preferences apply only to the project's cellular members, are stored in RAM, and do not rewrite UCI counters or change wired member priorities. Expired preference leases are ignored at the next policy rebuild. Custom member layouts are untouched. An active Speedify/VPN policy can affect routing and must be tested separately; established flows are not seamlessly migrated.

## Verification performed

- Static shell syntax, base-config SHA256, selected dependency and source-pin checks.
- Zero-fuzz forward and reverse patch checks against the exact pinned QModem and packages sources; patched shell and LuCI JavaScript syntax checks.
- `node firmware/tests/check-patches.cjs`: physical-path/AT-port isolation, missing/ambiguous devices, per-modem settings fingerprints, APN arguments for both modems, speed units/interface binding/download-only mode, failed samples, threshold/recovery counters, expiring preferences/measurement locks, stopped-service status, SA band read/write failures, and utility-page/RPC contracts.
- Isolated nginx + **the pinned vendor Python proxy and UI** over HTTP and self-signed HTTPS: main LuCI route fixture reachable, valid test session serves the index (200), missing/invalid sessions denied (401). The authentication service was mocked; this does not authenticate a real router session or test the ARM VPN daemon.

The web test uses `firmware/tests/nginx-speedify.conf`, `mock-speedify-ubus`, and `check-speedify-web.sh` in a disposable Alpine container with nginx/Python/curl and read-only mounts of the extracted, checksum-verified vendor UI. These fixtures are outside the router files overlay and must never replace the router's real ubus executable.

## Remaining hardware checks

1. Build the repair commit, inspect its manifest/checksums, back up configuration, and flash only a verified image for the correct board. No router was flashed or remotely reset during this source repair.
2. Run `firmware/scripts/verify-router-runtime.sh` on the router. It is read-only and avoids complete SIM/account dumps. Verify each module's physical path, own AT port, independent metrics and `proto=none` for the default QMI setup.
3. With automatic recovery and Speedify connection disabled, test one modem, then both. Redial each independently and confirm the peer stays connected. Confirm correct chassis LED behavior. Do not infer an electrically powered-off module from an LED alone.
4. On **modem 2's own AT Debug tab**, collect these read-only responses:

   ```text
   AT+CPIN?
   AT+CEREG?
   AT+C5GREG?
   AT+COPS?
   AT+QENG="servingcell"
   AT+QNWPREFCFG="mode_pref"
   AT+QNWPREFCFG="nr5g_band"
   AT+QNWPREFCFG="nsa_nr5g_band"
   AT+CGDCONT?
   ```

   Some module revisions may not support every query. An ERROR to one query is not proof that the radio feature is absent. Registration/reject information is needed before attributing the persistent `PS: Detached` state to APN, band settings, carrier provisioning or modem firmware. Do not force SA-only operation, reset all bands, or flash module firmware based on the empty checkbox display.
5. Confirm automatic/default APN behavior with each activated SIM; preserve manual plan-specific settings where needed. Do not publish IMSI, ICCID, IMEI, PINs or account tokens with diagnostics.
6. Test Speedify sign-in and traffic after the unbonded cellular links are stable. Inspect `/tmp/speedify-service.log`, `/tmp/speedify-nginx-check.log` and `logread -e speedify-installer` if the daemon remains unhealthy. The provided log did not establish why the proprietary daemon itself failed its health check.
7. Confirm all expected menus, a completed interactive speed sample, Tailscale sign-in, wired-first routing, and optional speed-threshold failover. Validate over time and across carriers before marking the public firmware stable.
