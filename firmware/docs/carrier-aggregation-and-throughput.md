# RM551E-GL carrier aggregation and throughput

The router does not configure a two-carrier ceiling. Carrier aggregation is negotiated inside each RM551E-GL between its baseband firmware and the mobile network; QMI transports the resulting IP session and does not choose the PCC/SCC set. The number of component carriers can change with radio mode, tower configuration, load, signal quality, carrier policy, modem firmware and current traffic.

QModem now runs the read-only Quectel `AT+QCAINFO` query in LTE, 5G NSA and 5G SA modes. **Cell Information** shows:

- the number of active and reported component carriers;
- every reported PCC and SCC, including band, channel, bandwidth, PCI and state;
- `configured, idle` for an SCC state of 1 and `active` for state 2.

Newer NR PCC replies that place PCI in the fifth field are identified defensively instead of being displayed as values such as `state 436`.

An idle radio may report fewer active SCCs. Check during a sustained download: the network commonly activates secondary carriers only when traffic needs them. A four-carrier report means one PCC plus three SCCs, not four SCCs. `AT+QCAINFO` observes carrier aggregation; it does not enable or force it.

## Throughput-safe defaults

Both per-modem TTL policies now default off. TTL rewriting remains available for plans that need it, but enabling either policy must disable software and hardware flow offload so packets reach the rewrite rule. That can reduce routed throughput. A settings-preserving upgrade keeps an explicitly enabled TTL policy; a fresh installation and an old implicit `wwan0` include do not silently opt the router into that tradeoff.

QoSmate, recovery actions and Speedify are also off until enabled in Mega. Minimal omits those optional components. No build forces a cell, PCC, band set, carrier MBN profile or undocumented EFS setting. A cell lock can prevent additional cells from attaching on this modem family, so public defaults stay unlocked and carrier-neutral.

Advanced opens on **5G & Network Mode**. **Automatic adaptive** is now the default and compares verified per-modem SA/NSA samples, with idle/backup guards, rollback and a data cap. **Modem automatic — no performance tests** delegates selection entirely to the modem/network. Manual **NSA only** and **SA only** are preserved. No choice guesses from the SIM operator or rewrites band masks. Opening the page is read-only. See [adaptive behavior and validation](adaptive-5g-and-failback.md).

For the reported 30–32 Mbps cases, the screenshots show SA while the faster router shows LTE/NSA aggregation. This supports comparing deployments, but does not prove SA caused the difference or establish that Modem 1 had a working data session. Adaptive therefore checks real IPv4 reachability and samples the actual selected modem, not the router default route. Manual comparisons should still use the same SIM, location, wired client, server and time window. Keep the other modem as failover; don’t treat radio registration as proof of Internet access.

## Reproducible comparison

Compare the router and another modem host under the same conditions:

1. Test one modem at a time with the other modem dial disabled. Keep Speedify, QoSmate, custom TTL and recovery actions off.
2. Confirm software and hardware flow offload are enabled under **Network → Firewall** when no feature requiring packet mangling is active.
3. Test first from a wired client. This separates cellular throughput from Wi-Fi channel width, interference, client capability and MLO behavior. Then repeat on 5 GHz and 6 GHz near the router.
4. Start a sustained download or an explicitly confirmed speed test and refresh QModem **Cell Information** while traffic is running. Record the PCC/SCC rows, network mode, bandwidth, RSRP, RSRQ and SINR.
5. Record the read-only modem identity and profile information with `ATI`, `AT+QGMR` and `AT+QMBNCFG="list"`. The same RM551E-GL model can run materially different engineering/carrier firmware revisions.
6. Verify all four cellular antenna leads are firmly attached to the intended modem ports and compare signal quality, tower, time of day, SIM/plan, APN and carrier provisioning.

Do not install a modem firmware, MBN, QCN/EFS file or IMEI change from an unrelated router. Those changes can remove service, violate carrier requirements or make recovery require Quectel tooling. Firmware updates for the RM551E-GL should come from the module supplier/Quectel and match the exact hardware revision and carrier certification.

Host tests verify the complete QCAINFO parser with a PCC, active SCCs and a configured-but-idle SCC. They cannot create a radio combination, validate antennas or certify carrier throughput; final confirmation requires the physical router under sustained traffic.
