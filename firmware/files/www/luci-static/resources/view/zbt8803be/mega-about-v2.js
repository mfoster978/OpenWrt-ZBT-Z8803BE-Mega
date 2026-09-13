'use strict';
'require view';
'require rpc';

/* Mega edition only. The versioned asset path prevents an upgraded router from
 * reusing the legacy About view from a browser cache. This replaces the pinned
 * luci-app-zbt-about view while keeping
 * its route and read-only ACL. The sole remote image is the user-requested
 * Speedify video poster; it is lazy-loaded without a referrer. Runtime values
 * are always inserted as text. */
const MEGA_REPO = 'https://github.com/mfoster978/OpenWrt-ZBT-Z8803BE-Mega';
const MINIMAL_REPO = 'https://github.com/mfoster978/openwrt-zbtlink-zbt-z8803be-speedify-minimal-build';
const BASE_REPO = 'https://github.com/0xFar5eer/openwrt25.12_ZBT_Z8803BE';
const SPEEDIFY_VIDEO = 'https://speedify.com/enterprise/pair-and-share-cellular-connection-pooling/?wvideo=lrxei2q3dw';
const SPEEDIFY_POSTER = 'https://embed-ssl.wistia.com/deliveries/d5c4ddf469f498a4e17ed4cb75d9abb8.jpg?image_play_button_size=2x&image_crop_resized=960x540&image_play_button_rounded=1&image_play_button_color=00A1DEe0';
const callBoard = rpc.declare({ object: 'system', method: 'board', expect: {} });
const callInfo = rpc.declare({ object: 'system', method: 'info', expect: {} });
const callBuild = rpc.declare({ object: 'zbt.firmware', method: 'info', expect: {} });

function external(url, label, className) {
	return E('a', { href: url, target: '_blank', rel: 'noopener noreferrer', 'class': className || '' }, label);
}

function local(path, label) {
	return E('a', { href: L.url.apply(L, path), 'class': 'zma-button zma-button-secondary' }, label);
}

function svgNode(tag, attrs, children) {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	Object.keys(attrs || {}).forEach(function(key) { node.setAttribute(key, attrs[key]); });
	(children || []).forEach(function(child) {
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	});
	return node;
}

function icon(kind) {
	const paths = {
		signal: ['M4 20v-4m5 4v-8m5 8V8m5 12V4'],
		route: ['M5 5h14M5 19h14M5 5v14m14-14v14M5 12h14'],
		shield: ['M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z', 'm8 12 3 3 5-6'],
		gauge: ['M4 18a9 9 0 1 1 16 0', 'm12 13 4-5M5 13h2m10 0h2M12 4v2'],
		light: ['M8 15a6 6 0 1 1 8 0l-1 3H9Z', 'M9 21h6M12 1v1M2 8h2m16 0h2'],
		chip: ['M6 6h12v12H6Z', 'M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5'],
		box: ['m3 7 9-4 9 4v10l-9 4-9-4Z', 'm3 7 9 4 9-4M12 11v10'],
		layers: ['m3 7 9-4 9 4-9 4Z', 'm3 12 9 4 9-4', 'm3 17 9 4 9-4'],
		heart: ['M12 21 3 12C-2 4 8 0 12 7c4-7 14-3 9 5Z'],
		arrow: ['M5 12h14m-6-6 6 6-6 6']
	};
	return svgNode('svg', { viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
		(paths[kind] || paths.chip).map(function(d) { return svgNode('path', { d: d }); }));
}

function networkArtwork() {
	const nodes = [];
	[65, 135, 205, 275].forEach(function(y, n) {
		nodes.push(svgNode('path', { d: 'M94 ' + y + 'H140Q165 ' + y + ' 165 170H220', 'class': 'zma-wire zma-wire-' + n }));
		nodes.push(svgNode('rect', { x: 20, y: y - 22, width: 94, height: 44, rx: 12, 'class': 'zma-node' }));
		nodes.push(svgNode('circle', { cx: 36, cy: y, r: 3, 'class': 'zma-dot' }));
		nodes.push(svgNode('text', { x: 48, y: y + 4, 'class': 'zma-node-label' }, [['SFP WAN', 'WAN', 'MODEM 1', 'MODEM 2'][n]]));
	});
	nodes.push(svgNode('rect', { x: 220, y: 108, width: 174, height: 124, rx: 22, 'class': 'zma-router' }));
	nodes.push(svgNode('path', { d: 'M248 106V81m118 25V81M251 92q55-43 112 0M273 99q34-25 68 0', 'class': 'zma-aerial' }));
	nodes.push(svgNode('text', { x: 307, y: 151, 'text-anchor': 'middle', 'class': 'zma-router-brand' }, ['MEGA']));
	nodes.push(svgNode('text', { x: 307, y: 174, 'text-anchor': 'middle', 'class': 'zma-router-model' }, ['ZBT-Z8803BE']));
	[249, 266, 283].forEach(function(x) { nodes.push(svgNode('circle', { cx: x, cy: 205, r: 3, 'class': 'zma-dot' })); });
	nodes.push(svgNode('path', { d: 'M342 201h26m-26 7h26', 'class': 'zma-vents' }));
	nodes.push(svgNode('path', { d: 'M394 170h57', 'class': 'zma-wire zma-wire-out' }));
	nodes.push(svgNode('rect', { x: 451, y: 141, width: 61, height: 43, rx: 6, 'class': 'zma-node' }));
	nodes.push(svgNode('path', { d: 'M481 185v11m-16 0h32', 'class': 'zma-aerial' }));
	nodes.push(svgNode('text', { x: 481, y: 219, 'text-anchor': 'middle', 'class': 'zma-node-label' }, ['YOUR LAN']));
	return E('figure', { 'class': 'zma-art' }, [
		svgNode('svg', { viewBox: '0 0 540 330', role: 'img', 'aria-label': _('Illustration: SFP WAN, copper WAN and two independent modems connect through the Mega router to your LAN. This is a topology illustration, not live status.') }, nodes),
		E('figcaption', {}, _('More ways online. One place to manage them.'))
	]);
}

function bullets(items) {
	return E('ul', { 'class': 'zma-list' }, items.map(function(text) { return E('li', {}, _(text)); }));
}

function sectionHeading(number, title, description) {
	return E('div', { 'class': 'zma-section-heading' }, [
		E('span', { 'class': 'zma-section-number', 'aria-hidden': 'true' }, number),
		E('div', {}, [E('h2', {}, _(title)), E('p', {}, _(description))])
	]);
}

function feature(kind, title, label, summary, details) {
	return E('article', { 'class': 'zma-card' }, [
		E('div', { 'class': 'zma-card-top' }, [E('span', { 'class': 'zma-icon' }, [icon(kind)]), E('span', { 'class': 'zma-tag' }, _(label))]),
		E('h3', {}, _(title)), E('p', {}, _(summary)),
		E('details', { 'class': 'zma-feature-details' }, [E('summary', {}, _('Explore this feature')), bullets(details)])
	]);
}

function usbCard(kind, title, label, summary, details, path, action) {
	const children = [
		E('div', { 'class': 'zma-card-top' }, [E('span', { 'class': 'zma-icon' }, [icon(kind)]), E('span', { 'class': 'zma-tag' }, _(label))]),
		E('h3', {}, _(title)), E('p', {}, _(summary)), bullets(details)
	];
	if (path && action) children.push(E('div', { 'class': 'zma-card-action' }, [local(path, _(action))]));
	return E('article', { 'class': 'zma-card zma-usb-card' }, children);
}

function packageGroup(title, description, packages) {
	return E('details', { 'class': 'zma-package-group' }, [
		E('summary', {}, [E('span', {}, _(title)), E('span', { 'class': 'zma-package-count' }, packages.length + ' ' + _('highlights'))]),
		E('p', {}, _(description)), E('div', { 'class': 'zma-package-list' }, packages.map(function(pkg) { return E('code', {}, pkg); }))
	]);
}

function speedifyVideo() {
	return E('figure', { 'class': 'zma-speedify-video' }, [
		E('a', { href: SPEEDIFY_VIDEO, target: '_blank', rel: 'noopener noreferrer', 'aria-label': _('Play the Pair & Share cellular bonding video on Speedify.com') }, [
			E('img', {
				src: SPEEDIFY_POSTER,
				width: '400',
				height: '225',
				loading: 'lazy',
				decoding: 'async',
				referrerpolicy: 'no-referrer',
				alt: _('Pair & Share — peer-to-peer cellular bonding by Speedify')
			})
		]),
		E('figcaption', {}, [external(SPEEDIFY_VIDEO, _('Pair & Share | Peer-to-Peer Cellular Bonding | Speedify'))])
	]);
}

function definition(label, value) {
	return E('div', {}, [E('dt', {}, _(label)), E('dd', {}, String(value == null || value === '' ? _('Not available') : value))]);
}

function uptime(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return _('Not available');
	return Math.floor(seconds / 86400) + 'd ' + Math.floor(seconds % 86400 / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm';
}

function safeScalar(value) {
	return typeof value === 'string' || typeof value === 'number' ? value : '';
}

function tabbedAbout(content) {
	const strip = content.querySelector('.zma-build-strip');
	const footer = content.querySelector('.zma-footer');
	const definitions = [
		['overview', _('Overview'), [content.querySelector('.zma-hero'), content.querySelector('#zma-build')]],
		['features', _('Features'), [content.querySelector('#zma-features')]],
		['speedify', 'Speedify', [content.querySelector('#zma-speedify')]],
		['usb', _('USB & Sharing'), [content.querySelector('#zma-usb')]],
		['packages', _('Packages'), [content.querySelector('#zma-packages')]],
		['community', _('Project & Credits'), [content.querySelector('#zma-community')]]
	];
	const tabs = [];
	const panels = [];
	const navigation = E('div', { 'class': 'zma-tabs', role: 'tablist', 'aria-label': _('About Mega Edition'), 'aria-orientation': 'horizontal' });
	function select(index, focus) {
		tabs.forEach(function(tab, i) {
			tab.setAttribute('aria-selected', i === index ? 'true' : 'false');
			tab.tabIndex = i === index ? 0 : -1;
			panels[i].hidden = i !== index;
		});
		if (focus) tabs[index].focus();
	}
	definitions.forEach(function(item, index) {
		const tab = E('button', { type: 'button', id: 'zma-tab-' + item[0], role: 'tab', 'aria-controls': 'zma-panel-' + item[0], 'class': 'zma-tab' }, item[1]);
		const panel = E('div', { id: 'zma-panel-' + item[0], role: 'tabpanel', 'aria-labelledby': tab.id, tabindex: '0', 'class': 'zma-tab-panel' }, item[2]);
		tab.addEventListener('click', function() { select(index, false); });
		tab.addEventListener('keydown', function(event) {
			let next;
			if (event.key === 'ArrowRight') next = (index + 1) % definitions.length;
			else if (event.key === 'ArrowLeft') next = (index + definitions.length - 1) % definitions.length;
			else if (event.key === 'Home') next = 0;
			else if (event.key === 'End') next = definitions.length - 1;
			else return;
			event.preventDefault();
			select(next, true);
		});
		tabs.push(tab); panels.push(panel); navigation.appendChild(tab);
	});
	const root = E('div', { 'class': 'zma-page' }, [
		E('div', { 'class': 'zma-masthead' }, [E('span', { 'class': 'zma-masthead-mark', 'aria-hidden': 'true' }, [icon('chip')]), E('div', {}, [E('span', {}, 'ZBT-Z8803BE'), E('h1', {}, _('About Mega Edition'))])]),
		strip, navigation
	].concat(panels, [footer]));
	select(0, false);
	return root;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		if (!document.getElementById('zbt-mega-about-style-v2')) document.head.appendChild(E('link', {
			id: 'zbt-mega-about-style-v2', rel: 'stylesheet', href: L.resource('view/zbt8803be/mega-about-v2.css')
		}));
		return Promise.all([callBoard().catch(function() { return {}; }), callInfo().catch(function() { return {}; }), callBuild().catch(function() { return {}; })]);
	},

	render: function(data) {
		data = data || [];
		const board = data[0] || {};
		const info = data[1] || {};
		const metadata = data[2] || {};
		const installed = metadata.installed || {};
		const version = safeScalar(installed.version || installed.tag) || _('Build metadata unavailable');
		const release = board.release || {};
		const memory = info.memory && Number.isFinite(info.memory.total) ? Math.round(info.memory.total / 1048576) + ' MiB' : '';
		const root = E('div', { 'class': 'zma-page' }, [
			E('header', { 'class': 'zma-hero' }, [
				E('div', { 'class': 'zma-hero-copy' }, [
					E('div', { 'class': 'zma-eyebrow' }, [E('span', { 'class': 'zma-spark', 'aria-hidden': 'true' }), _('BY MFOSTER978 · OPENWRT POWERED')]),
					E('h2', { 'class': 'zma-hero-title' }, [E('span', { 'class': 'zma-model' }, 'ZBT-Z8803BE'), E('span', { 'class': 'zma-edition' }, 'Mega Edition')]),
					E('p', { 'class': 'zma-hero-description' }, _('Turn your router into a versatile networking workhorse. Mega Edition brings together practical add-ons, custom-built features and easy-to-set-up tools for dual cellular, failover, speed testing, USB connectivity and optional bonding. Use what you need; keep unused optional features off.')),
					E('div', { 'class': 'zma-hero-badges' }, [E('span', {}, 'Wi-Fi 7'), E('span', {}, _('Dual modem')), E('span', {}, _('USB tools')), E('span', {}, 'MediaTek Filogic')]),
					E('div', { 'class': 'zma-actions' }, [
						external(MEGA_REPO, _('Explore the source ↗'), 'zma-button zma-button-primary')
					])
				]), networkArtwork()
			]),
			E('div', { 'class': 'zma-build-strip', 'aria-label': _('Installed firmware summary') }, [
				E('div', {}, [E('span', {}, _('THIS ROUTER')), E('strong', {}, safeScalar(board.model) || 'ZBT-Z8803BE')]),
				E('div', {}, [E('span', {}, _('INSTALLED BUILD')), E('strong', { 'class': 'zma-installed-version' }, version)]),
				E('div', {}, [E('span', {}, _('RUNNING KERNEL')), E('strong', {}, safeScalar(board.kernel) || _('Not available'))]),
				E('div', {}, [E('span', {}, _('DEVELOPER & MAINTAINER')), E('strong', {}, 'Michael Foster · mfoster978')])
			]),
			E('section', { id: 'zma-features', 'class': 'zma-section' }, [
				sectionHeading('01', 'Built for your whole connection setup', 'Mega Edition is developed and maintained by Michael Foster, with independent modem controls and practical everyday tools built on the credited OpenWrt and Far5eer foundation.'),
				E('div', { 'class': 'zma-grid zma-features' }, [
					feature('signal', 'Two modems. Independent control.', 'QModem', 'Manage Modem 1 and Modem 2 by physical slot—not by whichever wwan number Linux happens to assign at boot.', [
						'QModem Next brings modem status, signal/cell information, SMS, AT Debug, SIM information and dial controls into LuCI. Friendly aliases remain separate from stable routing identities.',
						'QMI, MBIM, NCM, USB serial and compatible PCIe MHI support are included. Quectel connection-manager paths own their own addresses and routes without a competing DHCP client.',
						'Each slot has its own opt-in IPv4 TTL / IPv6 Hop Limit switch and automatic or custom value. Both start off so flow offload remains available. Band controls verify AT-command results and show readback diagnostics instead of pretending an unknown band mask is empty.',
						'SIM information checks the full AT+CNUM response and the SIM own-numbers phonebook. Nearby-cell discovery uses Quectel QSCAN for LTE/5G with QENG and the serving cell as fallbacks. Carrier Aggregation lists every PCC/SCC, PCI, state and bandwidth reported by AT+QCAINFO without mislabelling newer NR fields.',
						'Advanced 5G & Network Mode offers Automatic adaptive, Modem automatic without tests, NSA only, or SA only. Adaptive compares three downloads per mode when idle with a healthy backup, requires a stable 15% improvement, and restores a verified selection if a trial fails. Tests reserve 150 MB per comparison, capped at 300 MB per modem per 24 hours plus overhead. Learned choices last only for this boot. Band lists and APNs remain unchanged. MultiWAN alone selects SFP, WAN, USB tether, Modem 1, then Modem 2; verified failback expires lower-priority NATed LAN connections without clearing router/VPN flows.',
						'Blank/auto APN keeps modem/network profile negotiation; manual APNs and SIM choices are preserved. Carrier coverage, activation, device support and plan requirements still apply—automatic connection is not guaranteed on every carrier.'
					]),
					feature('route', 'Wired first. Cellular when needed.', 'Multi-WAN', 'mwan3 handles connection monitoring and failover. Modem 1 remains ahead of Modem 2 in every Mega-managed policy.', [
						'Default priority is available SFP WAN, copper WAN, a connected USB phone tether, Modem 1, then Modem 2. Modem 2 is standby-only while Modem 1 is healthy; recovered preferred paths carry new connections again.',
						'Network → MultiWAN Manager → Priority & Recovery controls health-check timing and optional per-modem recovery actions. QModem only establishes the sessions; it cannot promote Modem 2 or rewrite the MWAN-owned route order.',
						'Both modems default to guarded GPIO power-cycle recovery after confirmed Internet failure, with cooldowns and a three-attempt hourly limit. 5G LEDs show verified IPv4 or IPv6 Internet access.',
						'Failover and load balancing are not bonding: ordinary mwan3 does not merge links into a faster single download, and established sessions may need to reconnect.'
					]),
					feature('gauge', 'Real tests. Live feedback.', 'Speed Test Utility', 'A live gauge, download/upload graph, ping and jitter make it easier to see what a connection is actually doing.', [
						'Uses real Speedtest.net servers through the pinned open-source speedtest-go client. It is not the official Ookla application and results can differ between test clients.',
						'Choose the default route, a wired WAN, USB phone tether or either physical modem. Automatic mode skips directory servers that cannot accept upload traffic; you can still choose a listed server or enter its ID.',
						'First-time GO asks you to accept the terms/data-use warning, then runs automatic server selection. A run can consume hundreds of MB or more than 1 GB. Router recovery uses lightweight connectivity checks and never launches this throughput test.'
					]),
					feature('shield', 'Your remote-access toolkit.', 'VPN ready', 'Use the right tunnel for the job: private device access, a conventional VPN or a bonding service.', [
						'Tailscale includes a local status/sign-in page. Connect your own account; advanced subnet-route and exit-node settings are CLI-managed.',
						'OpenVPN with OpenSSL and its LuCI application are included. WireGuard tools and the kernel module are inherited from the board baseline.',
						'TUN and supporting networking dependencies are built for this image. No account credentials, VPN provider subscription or preconfigured remote endpoint are included.'
					]),
					feature('light', 'A router you can read.', 'LEDs & health', 'Device-specific indicators and health pages help explain the router without relying on a single “online” label.', [
						'System → LED Configuration exposes supported lights. Custom rules for a 5G indicator or a SYS color take precedence over the automatic modem controller.',
						'5G1 and 5G2 are green physical LEDs, despite historical blue: kernel names. Ethernet jack LEDs are orange, with solid link and RX/TX activity configuration.',
						'The multicolor SYS policy uses blue for no Internet, green for Internet access and red for a degraded dual-modem state while another path remains online. Cellular traffic can blink green.',
						'Health, temperature/fan information and modem-event history help track storage, memory, thermal behavior and reconnects. Physical LED behavior and modem registration still require testing on your board.'
					]),
					feature('chip', 'A device-specific foundation.', 'Far5eer baseline', 'This is an OpenWrt build for the ZBTLink ZBT-Z8803BE—not a universal image for other routers.', [
						'MediaTek MT7988A / Filogic 880, MT7996-family tri-band Wi-Fi 7, SFP+ and copper Ethernet board support come from the pinned upstream platform.',
						'2.4 GHz, 5 GHz and 6 GHz default to the US domain. Power stays automatic on 2.4/5 GHz so regulatory and EEPROM limits remain authoritative; mobile 6 GHz uses the 14 dBm VLP class. Other countries must select their own domain, and 6 GHz still requires compliant hardware, antennas and clients.',
						'USB storage, block mounting, ext4/FAT/exFAT, optional extroot expansion, Android and iPhone tethering, opt-in SMB sharing and opt-in USB-over-IP support are included. A clean installation requires root to choose a new password on its first local LuCI login.',
						'Source and package selections are pinned and checked during the build. Successful compilation is not a substitute for real hardware validation.'
					])
				])
			]),
			E('section', { id: 'zma-speedify', 'class': 'zma-section zma-speedify' }, [
				E('div', { 'class': 'zma-speedify-intro' }, [
					E('span', { 'class': 'zma-eyebrow' }, _('OPTIONAL CONNECTION BONDING')),
					E('h2', {}, _('What does Speedify do?')),
					E('p', { 'class': 'zma-lead' }, _('Speedify sends traffic through an encrypted tunnel to a remote Speedify server. That shared endpoint lets it use multiple Internet connections together, rather than simply assigning each connection to a different WAN.')),
					E('p', {}, _('Depending on your links and selected mode, it can combine usable capacity, keep traffic moving when a link drops, or favor redundancy. It cannot create cellular coverage, activate a SIM, remove a carrier restriction or guarantee the sum of your advertised link speeds.')),
					external('https://speedify.com/', _('About Speedify and its plans ↗'), 'zma-text-link'),
					speedifyVideo()
				]),
				E('div', { 'class': 'zma-speedify-steps' }, [
					E('article', {}, [E('span', {}, '1'), E('div', {}, [E('h3', {}, _('Dependencies baked in')), E('p', {}, _('Matching TUN, crypto/network support, TLS certificates, C++/atomic/keyutils runtime libraries, nginx and the Python support needed by the LuCI integration are built with the firmware.'))])]),
					E('article', {}, [E('span', {}, '2'), E('div', {}, [E('h3', {}, _('Installed after Internet is ready')), E('p', {}, _('A guarded first-boot installer fetches the pinned Speedify core and optional LuCI APKs over HTTPS, checks their SHA256 and installs them without fetching replacement kernel modules. It waits and retries if connectivity or service health is not ready.'))])]),
					E('article', {}, [E('span', {}, '3'), E('div', {}, [E('h3', {}, _('You choose the account and policy')), E('p', {}, _('Use Sign in this router on the HTTPS Speedify page, complete activation in a new tab, and return. Mega checks the router daemon before confirming sign-in and keeps the LuCI menu visible. The dashboard refreshes once after confirmed sign-in, not whenever you return to the tab. The proprietary service remains separately licensed; account sign-in alone does not prove a working VPN data path.'))])])
				])
			]),
			E('section', { id: 'zma-usb', 'class': 'zma-section zma-usb' }, [
				sectionHeading('02', 'USB tethering, storage and sharing', 'Connect a phone as an additional WAN, mount local storage, or deliberately share a device. Drivers and tools are ready, while network exposure remains under the router owner’s control.'),
				E('div', { 'class': 'zma-callout' }, [
					E('strong', {}, _('Safe starting point: nothing is silently shared.')),
					E('p', {}, _('Phone interfaces are not automatically added to routing, storage is not automatically published, and both the SMB and USB-over-IP servers start disabled. Configure only the feature you intend to use.'))
				]),
				E('div', { 'class': 'zma-grid zma-usb-grid' }, [
					usbCard('signal', 'Android & iPhone tethering', 'EXTRA INTERNET', 'Use a supported phone’s USB data connection as an owner-configured OpenWrt interface.', [
						'Android RNDIS and CDC Ethernet drivers are included. Enable USB tethering on the phone after connecting it with a data-capable cable.',
						'For iPhone or iPad, enable Personal Hotspot, accept the Trust prompt and complete pairing when required. ipheth, usbmuxd and libimobiledevice utilities are included.',
						'Supported phone devices bind to stable usb_tether automatically. It uses DHCP and sits after SFP/copper WAN but before Modem 1 and Modem 2 in the default MultiWAN failover order.'
					], ['admin', 'network', 'network'], 'Open Network Interfaces'),
					usbCard('box', 'USB storage & network drives', 'LOCAL STORAGE', 'Mount USB mass-storage and UAS devices with ext4, exFAT or FAT filesystems, then optionally publish selected folders as network drives.', [
						'Use a powered hub or enclosure when a disk needs more current than the router USB port can safely provide.',
						'Create a stable mount point and verify it after a reboot before using it for backups, applications or a network share.',
						'Mounting a filesystem does not make it accessible to LAN clients; KSMBD sharing is a separate, explicit step and remains off until you enable it.'
					], ['admin', 'services', 'usb-storage'], 'Open USB Storage'),
					usbCard('layers', 'Expand OpenWrt with extroot', 'MORE PACKAGE SPACE', 'Move the writable OpenWrt overlay to an ext4 USB drive so larger optional applications have room to install.', [
						'Mega includes block-mount, ext4 tools and a partition editor, so the external overlay can be prepared on the router. Setup is intentionally manual because selecting or formatting the wrong device destroys data.',
						'Extroot expands writable package space; it does not increase RAM, CPU performance or the physical internal NAND. Larger applications such as AdGuard Home must still be compatible with this OpenWrt release and available memory.',
						'Use a reliable powered SSD or high-quality drive, back up first, copy the existing overlay, reboot, then verify /overlay and free space. Never unplug an active extroot drive.'
					], ['admin', 'services', 'usb-storage'], 'Open Mount Points'),
					usbCard('shield', 'KSMBD network shares', 'SMB · DEFAULT OFF', 'Share an already-mounted directory with computers on trusted networks.', [
						'The in-kernel KSMBD server and its LuCI page are installed, but the new Enable server switch defaults off.',
						'Configure the share path, users or guest policy, and listening interface before enabling the server.',
						'Keep SMB on trusted LAN interfaces. Do not expose file sharing directly to cellular, WAN or public-hotspot networks.'
					], ['admin', 'services', 'ksmbd'], 'Open Network Shares'),
					usbCard('route', 'USB over IP', 'ADVANCED · DEFAULT OFF', 'Attach or export a USB device across a trusted IP network using the included client and server tools.', [
						'The usbip, usbipd and matching kernel components are included; the server defaults off in /etc/config/usbipd.',
						'The pinned OpenWrt feeds do not provide a USB/IP LuCI application, so binding, export and remote attachment are command-line operations.',
						'USB/IP is not an Internet-safe file-sharing protocol. Restrict it with firewall rules and never publish it directly to an untrusted WAN.'
					])
				]),
				E('p', { 'class': 'zma-disclaimer' }, _('USB support depends on the phone, cable, USB power, filesystem health and device compatibility. Back up important storage before changing mounts. A phone or exported USB device is not added to failover, firewall or sharing policy until the owner configures it.'))
			]),
			E('section', { id: 'zma-packages', 'class': 'zma-section' }, [
				sectionHeading('03', 'Inside the Mega edition', 'Package highlights from this project’s build profile. Expand a category to see the components behind the features.'),
				E('div', { 'class': 'zma-package-grid' }, [
					packageGroup('Cellular control & protocols', 'The two modems share the same control stack, while dial state and settings remain per-slot.', ['qmodem', 'luci-app-qmodem-next', 'luci-app-qmodem-monitor', 'luci-app-qmodem-ttlfw4', 'quectel-CM-5G-M', 'uqmi', 'umbim', 'luci-proto-qmi', 'luci-proto-mbim', 'sms-tool_q', 'sms-forwarder-next']),
					packageGroup('Modem kernel support', 'Built-in USB and PCIe MHI families support compatible modem modes; listing a driver does not certify every modem model or carrier.', ['kmod-usb-net-qmi-wwan', 'kmod-usb-net-cdc-mbim', 'kmod-usb-wdm', 'kmod-usb-serial-option', 'kmod-usb-net-cdc-ncm', 'kmod-mhi-bus', 'kmod-mhi-pci-generic', 'kmod-mhi-net', 'kmod-mhi-wwan-ctrl', 'kmod-mhi-wwan-mbim']),
					packageGroup('Routing, recovery & diagnostics', 'Normal mwan3 connectivity failover is enabled with Modem 1 ahead of Modem 2. Guarded GPIO recovery is enabled by default and can be disabled per modem.', ['mwan3', 'luci-app-mwan3', 'luci-app-modem-watchdog', 'luci-app-speedtest-lite', 'zbt-speedtest', 'speedtest-go', 'speedtest-netperf', 'ethtool', 'jq', 'curl']),
					packageGroup('VPN & Speedify support', 'Speedify itself is a separately downloaded, checksum-verified runtime package. These supporting components are selected in the image.', ['tailscale', 'luci-app-tailscale', 'openvpn-openssl', 'luci-app-openvpn', 'wireguard-tools', 'kmod-wireguard', 'kmod-tun', 'libstdcpp', 'libkeyutils', 'libatomic', 'kmod-tcp-bbr', 'kmod-nft-tproxy', 'iptables-nft', 'iptables-mod-tproxy', 'iptables-mod-extra', 'iptables-mod-conntrack-extra']),
					packageGroup('USB tethering, storage & sharing', 'Android and Apple USB networking drivers are ready for owner setup. Storage, ext4 formatting and extroot are supported; KSMBD and USB/IP servers remain disabled until explicitly enabled.', ['kmod-usb-net-cdc-ether', 'kmod-usb-net-rndis', 'kmod-usb-net-ipheth', 'usbmuxd', 'libimobiledevice-utils', 'usbutils', 'block-mount', 'e2fsprogs', 'parted', 'kmod-usb-storage', 'kmod-usb-storage-uas', 'kmod-fs-ext4', 'kmod-fs-exfat', 'kmod-fs-vfat', 'kmod-nls-utf8', 'luci-app-ksmbd', 'ksmbd-server', 'usbip', 'usbip-client', 'usbip-server', 'kmod-usbip', 'kmod-usbip-client', 'kmod-usbip-server']),
					packageGroup('LuCI & device dashboards', 'The board baseline and project overlays provide the local web interface, dashboards and customization controls.', ['luci', 'luci-ssl', 'luci-nginx', 'luci-app-firewall', 'luci-app-package-manager', 'luci-app-mlo', 'luci-app-zbt-about', 'luci-app-zbt-health', 'luci-app-zbt-temperature', 'luci-app-zbt-modem-events', 'python3-light', 'ca-bundle']),
					E('div', { 'class': 'zma-package-note' }, [icon('box'), E('h3', {}, _('Need the exact package inventory?')), E('p', {}, _('These are feature highlights, not a live installed-package scan or every transitive dependency. Each release includes its package manifest and build information. Packages can differ after local changes. OpenMPTCProuter is not included: it is a separate firmware platform, not a Mega package toggle.')), external(MEGA_REPO + '/releases', _('Open release manifests ↗'), 'zma-text-link')])
				])
			]),
			E('section', { id: 'zma-build', 'class': 'zma-section zma-build-section' }, [
					E('article', { 'class': 'zma-card' }, [E('h3', {}, _('Installed router details')), E('dl', { 'class': 'zma-details' }, [
						definition('Mega release', version), definition('Build commit', safeScalar(installed.source_sha)), definition('Built at', safeScalar(installed.built_at)),
						definition('OpenWrt', safeScalar(release.description) || [safeScalar(release.distribution), safeScalar(release.version), safeScalar(release.revision)].filter(Boolean).join(' ')),
						definition('Board ID', safeScalar(board.board_name)), definition('Kernel', safeScalar(board.kernel)), definition('Hostname', safeScalar(board.hostname)), definition('Memory', memory), definition('Uptime', uptime(info.uptime))
					]), E('p', { 'class': 'zma-small' }, _('Values above come from this router when the page opens. Missing build metadata is shown as unavailable, never guessed from the latest GitHub release.'))])
			]),
			E('section', { id: 'zma-community', 'class': 'zma-section' }, [
				sectionHeading('05', 'Made by people. Better together.', 'Report what you observe, share reproducible fixes and give the upstream work the credit it deserves.'),
				E('div', { 'class': 'zma-community-grid' }, [
					E('article', { 'class': 'zma-card zma-maintainer' }, [
						E('span', { 'class': 'zma-avatar', 'aria-hidden': 'true' }, 'MF'), E('div', { 'class': 'zma-eyebrow' }, _('MEGA EDITION DEVELOPER & MAINTAINER')), E('h3', {}, 'Michael Foster'), E('p', {}, _('Developer and maintainer of Mega Edition: this firmware variant’s features, fixes, integration, interface, builds, releases and ongoing maintenance. Find me as mfoster978 on GitHub and Discord.')),
						E('dl', { 'class': 'zma-contact' }, [
							E('div', {}, [E('dt', {}, 'GitHub'), E('dd', {}, [external('https://github.com/mfoster978', '@mfoster978 ↗')])]),
							E('div', {}, [E('dt', {}, _('Email')), E('dd', {}, [E('a', { href: 'mailto:mfoster978@gmail.com' }, 'mfoster978@gmail.com')])]),
							E('div', {}, [E('dt', {}, 'Discord'), E('dd', {}, [E('code', { 'class': 'zma-discord', tabindex: '0', 'aria-label': _('Discord username: mfoster978') }, 'mfoster978'), E('small', {}, _('Username · copy to find me on Discord'))])])
						]),
						E('div', { 'class': 'zma-project-links' }, [external(MEGA_REPO, _('Mega firmware repository ↗')), external(MINIMAL_REPO, _('Minimal firmware repository ↗')), external(MEGA_REPO + '/issues', _('Report an issue / request a feature ↗'))]),
						E('p', { 'class': 'zma-small' }, _('For useful bug reports, include your build, board, modem firmware and redacted logs. Remove passwords, API keys, IMEI, IMSI, ICCID and public addresses before posting.'))
					]),
					E('article', { 'class': 'zma-thanks' }, [
						E('span', { 'class': 'zma-icon' }, [icon('heart')]), E('div', { 'class': 'zma-eyebrow' }, _('SPECIAL THANKS')), E('h3', {}, [external('https://github.com/0xFar5eer', '0xFar5eer ↗')]),
						E('p', { 'class': 'zma-thanks-lead' }, _('Thank you for putting the pieces together and creating a working OpenWrt version for this router.')),
						E('p', {}, _('Far5eer’s board support, modem integration, device tools and release baseline provide the upstream foundation. Michael Foster develops and maintains Mega Edition independently. OpenWrt, Linux, QModem and other included packages retain their original authorship and licenses.')),
						external(BASE_REPO, _('Explore Far5eer’s ZBT-Z8803BE project ↗'), 'zma-text-link')
					])
				]),
				E('div', { 'class': 'zma-credit-grid' }, [
					['https://openwrt.org/', 'OpenWrt & Linux contributors', _('The distribution, kernel, LuCI and the wider open-source networking ecosystem.')],
					['https://github.com/FUjr/QModem', 'FUjr / QModem contributors', _('The QModem control stack, modern interface and modem integration tools.')],
					['https://github.com/pttuan', 'pttuan', _('Upstream board-port work credited by Far5eer, including device-tree fan, thermal and LED integration.')],
					['https://github.com/sjanulonoks', 'sjanulonoks', _('Fan-control suggestions and release testing credited by the upstream project.')],
					['https://github.com/OneB1t/Z8803BE-research', 'OneB1t / Z8803BE research', _('Device and vendor-firmware research credited by the upstream project.')],
					['https://github.com/immortalwrt/packages', 'ImmortalWrt contributors', _('Additional package and LuCI overlay work credited by the baseline.')],
					['https://github.com/showwin/speedtest-go', 'showwin / speedtest-go contributors', _('The MIT-licensed client behind the interactive Speedtest.net measurements.')],
					['https://speedify.com/', 'Speedify / Connectify', _('The separately licensed connection-bonding service and its integration packages.')],
					['https://tailscale.com/', 'Tailscale, VPN & package authors', _('Remote-access software and the many individual packages that complete this build.')]
				].map(function(credit) { return E('article', {}, [E('h3', {}, [external(credit[0], credit[1] + ' ↗')]), E('p', {}, credit[2])]); })),
				E('p', { 'class': 'zma-disclaimer' }, _('Independent community firmware. Not an official ZBT, OpenWrt, Speedify, Tailscale or Ookla product. Credits are acknowledgments, not sponsorships or endorsements. Individual packages retain their own licenses; proprietary services may require separate accounts or payment.'))
			]),
			E('footer', { 'class': 'zma-footer' }, [E('span', {}, 'ZBT-Z8803BE · Mega Edition'), E('span', {}, _('Developed and maintained by Michael Foster · mfoster978'))])
		]);
		return tabbedAbout(root);
	}
});
