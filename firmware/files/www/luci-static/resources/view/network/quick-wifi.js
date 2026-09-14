'use strict';
'require view';
'require uci';
'require ui';
'require rpc';

var BAND_ORDER = [ '2g', '5g', '6g' ];
var BAND_LABEL = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz' };

function asList(value) {
	if (Array.isArray(value))
		return value.filter(Boolean);
	return value ? [ value ] : [];
}

function radiosByBand() {
	var radios = {};
	uci.sections('wireless', 'wifi-device').forEach(function(section) {
		if (BAND_ORDER.indexOf(section.band) !== -1 && !radios[section.band])
			radios[section.band] = section['.name'];
	});
	return radios;
}

function isLanAp(section) {
	var mode = section.mode || 'ap';
	var networks = asList(section.network);
	return mode === 'ap' && networks.indexOf('lan') !== -1 && networks.indexOf('guest') === -1;
}

function isMlo(section) {
	return section.mlo === '1' || section.mlo === 1 || section.mlo === true;
}

function isDisabled(section) {
	return section.disabled === '1' || section.disabled === 1 || section.disabled === true;
}

function targetScore(section, band) {
	var name = section['.name'] || '';
	var networks = asList(section.network);
	var score = 0;
	if (networks.indexOf('lan') !== -1)
		score += 100;
	if (/^default_radio/.test(name))
		score += 80;
	if (/^WIFI7-/i.test(section.ssid || ''))
		score += 30;
	// Active APs outrank retained, disabled factory defaults. On 5/6 GHz,
	// the active shared MLD is the primary network; keep a separate 2.4 GHz
	// AP preferred for legacy clients. Never change its security to match MLO.
	if ((band === '2g' && !isMlo(section) && asList(section.device).length === 1) ||
		(band !== '2g' && isMlo(section)))
		score += 300;
	if (!isDisabled(section))
		score += 10000;
	if (/guest/i.test(name))
		score -= 1000;
	return score;
}

function quickWifiTargets() {
	var radios = radiosByBand();
	var accessPoints = uci.sections('wireless', 'wifi-iface').filter(isLanAp);
	var byBand = {};
	var missing = [];

	BAND_ORDER.forEach(function(band) {
		var radio = radios[band];
		if (!radio) {
			missing.push(band);
			return;
		}

		var candidates = accessPoints.filter(function(section) {
			return asList(section.device).indexOf(radio) !== -1;
		}).sort(function(a, b) {
			var difference = targetScore(b, band) - targetScore(a, band);
			return difference || String(a['.name']).localeCompare(String(b['.name']));
		});

		if (!candidates.length)
			missing.push(band);
		else
			byBand[band] = candidates[0]['.name'];
	});

	var sections = [];
	BAND_ORDER.forEach(function(band) {
		var section = byBand[band];
		if (section && sections.indexOf(section) === -1)
			sections.push(section);
	});

	return { radios: radios, byBand: byBand, sections: sections, missing: missing };
}

function utf8Length(value) {
	return new TextEncoder().encode(value).length;
}

function validateQuickWifi(ssid, password) {
	if (!ssid || !ssid.trim())
		return 'ssid_empty';
	if (utf8Length(ssid) > 32)
		return 'ssid_long';
	if (password.length < 8 || password.length > 63)
		return 'password_length';
	if (!/^[\x20-\x7e]+$/.test(password))
		return 'password_ascii';
	return null;
}

function applyQuickWifi(targets, ssid, password) {
	targets.sections.forEach(function(section) {
		uci.set('wireless', section, 'ssid', ssid);
		uci.set('wireless', section, 'key', password);
	});
	return uci.save().then(function() { return ui.changes.apply(); });
}

function cameraCompatibilityTarget(targets) {
	var radio = targets.radios['2g'];
	var section = targets.byBand['2g'];
	if (!radio || !section)
		return null;
	var devices = asList(uci.get('wireless', section, 'device'));
	var networks = asList(uci.get('wireless', section, 'network'));
	var mlo = uci.get('wireless', section, 'mlo');
	var key = uci.get('wireless', section, 'key') || '';
	var encryption = uci.get('wireless', section, 'encryption') || '';
	if (devices.length !== 1 || networks.indexOf('lan') === -1 || mlo === '1' || mlo === 1 || mlo === true ||
		!/^(psk|psk2|psk-mixed|sae|sae-mixed)(\+.*)?$/.test(encryption) ||
		!((utf8Length(key) >= 8 && utf8Length(key) <= 63 && !/[\r\n\0]/.test(key)) || /^[a-fA-F0-9]{64}$/.test(key)))
		return null;
	return { radio: radio, section: section };
}

function keepMloOffLegacyRadio(legacyRadio) {
	uci.sections('wireless', 'wifi-iface').forEach(function(section) {
		var mlo = section.mlo === '1' || section.mlo === 1 || section.mlo === true;
		if (!mlo)
			return;
		var devices = asList(section.device);
		if (devices.indexOf(legacyRadio) === -1)
			return;
		var remaining = devices.filter(function(device) { return device !== legacyRadio; });
		if (remaining.length >= 2)
			uci.set('wireless', section['.name'], 'device', remaining);
		else
			uci.set('wireless', section['.name'], 'disabled', '1');
	});
}

function applyCameraCompatibility(targets) {
	var target = cameraCompatibilityTarget(targets);
	if (!target)
		return Promise.reject(new Error('A separate 2.4 GHz access point with a valid password is required.'));
	uci.set('wireless', target.radio, 'channel', '1');
	uci.set('wireless', target.radio, 'htmode', 'HT20');
	uci.set('wireless', target.radio, 'legacy_rates', '1');
	uci.set('wireless', target.radio, 'cell_density', '0');
	uci.unset('wireless', target.radio, 'basic_rate');
	uci.unset('wireless', target.radio, 'supported_rates');
	uci.unset('wireless', target.radio, 'require_mode');
	uci.unset('wireless', target.section, 'basic_rate');
	uci.unset('wireless', target.section, 'supported_rates');
	uci.set('wireless', target.section, 'encryption', 'psk2+ccmp');
	uci.set('wireless', target.section, 'ieee80211w', '0');
	uci.set('wireless', target.section, 'ieee80211r', '0');
	uci.set('wireless', target.section, 'ocv', '0');
	uci.set('wireless', target.section, 'beacon_prot', '0');
	uci.set('wireless', target.section, 'wmm', '1');
	keepMloOffLegacyRadio(target.radio);
	return uci.save().then(function() { return ui.changes.apply(); });
}

function cameraClientStage(client) {
	if (client.authorized === true)
		return client.addresses && client.addresses.length ? _('Wi-Fi connected; DHCP address assigned') : _('Wi-Fi connected; no DHCP lease found');
	if (client.associated === true)
		return _('Associated; authentication not complete');
	return _('Authentication not complete');
}

function cameraDiagnosticsView(report) {
	if (!report || report.ok !== true)
		return E('p', {}, _('Wi-Fi diagnostics are unavailable.'));
	var rows = [];
	(report.access_points || []).forEach(function(ap) {
		rows.push(E('p', {}, '%s: %s'.format(ap.ssid || ap.iface,
			ap.available ? _('Access point running') : _('Access point status unavailable'))));
		(ap.clients || []).forEach(function(client) {
			rows.push(E('p', {}, '%s — %s%s'.format(client.mac, cameraClientStage(client),
				client.addresses && client.addresses.length ? ' (' + client.addresses.join(', ') + ')' : '')));
		});
	});
	if (!(report.access_points || []).some(function(ap) { return (ap.clients || []).length > 0; }))
		rows.push(E('p', {}, _('No 2.4 GHz clients are associated right now. Retry the legacy device connection, then refresh this report.')));
	rows.push(E('p', {}, _('Match the legacy device’s Wi-Fi MAC address with the entries above. A DHCP lease can remain after a device disconnects, and devices using a static address may have no DHCP lease. Wi-Fi authentication does not prove Internet access.')));
	if (report.events && report.events.length) {
		rows.push(E('h4', {}, _('Recent Wi-Fi connection events')));
		rows.push(E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere' }, report.events.join('\n')));
	}
	return E('div', {}, rows);
}

return view.extend({
	load: function() {
		return uci.load('wireless');
	},

	render: function() {
		var targets = quickWifiTargets();
		var cameraTarget = cameraCompatibilityTarget(targets);
		var diagnostics = E('div', { 'aria-live': 'polite' });
		var callDiagnostics = rpc.declare({ object: 'zbt.wifi', method: 'diagnostics', expect: {} });
		var cameraButton = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'disabled': cameraTarget ? null : 'disabled',
			'click': function() {
				ui.showModal(_('Apply 2.4 GHz Legacy Device Compatibility?'), [
					E('p', {}, _('The primary 2.4 GHz network will use channel 1, WPA2-AES, 20 MHz 802.11n, and legacy rates, with protected management frames and fast roaming disabled. Its network name and password stay the same. Wi-Fi will reconnect briefly.')),
					E('p', {}, _('If a Wi-Fi 7 MLO network currently includes 2.4 GHz, that link will be removed so MLO can continue on its remaining Wi-Fi 7 bands.')),
					E('p', {}, _('The channel, 20 MHz radio mode, and rates also apply to other networks sharing the 2.4 GHz radio. Their security, names, and passwords stay the same.')),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
						E('button', { 'class': 'btn cbi-button cbi-button-positive', 'click': function() {
							ui.hideModal();
							cameraButton.disabled = true;
							return applyCameraCompatibility(targets).then(function() {
								ui.addNotification(null, E('p', {}, _('Legacy device compatibility applied. Reconnect the device using its existing Wi-Fi name and password.')), 'info');
							}).catch(function(error) {
								ui.addNotification(null, E('p', {}, error.message || String(error)), 'danger');
							}).finally(function() { cameraButton.disabled = false; });
						} }, _('Apply Compatibility'))
					])
				]);
			}
		}, _('Apply 2.4 GHz Legacy Device Compatibility'));
		var diagnosticsButton = E('button', {
			'class': 'btn cbi-button',
			'click': function() {
				diagnosticsButton.disabled = true;
				return callDiagnostics().then(function(report) {
					diagnostics.replaceChildren(cameraDiagnosticsView(report));
				}).catch(function(error) {
					diagnostics.replaceChildren(E('p', {}, _('Unable to read Wi-Fi diagnostics: %s').format(error.message || String(error))));
				}).finally(function() { diagnosticsButton.disabled = false; });
			}
		}, _('Refresh Wi-Fi Connection Report'));
		var currentNames = [];
		targets.sections.forEach(function(section) {
			var name = uci.get('wireless', section, 'ssid') || '';
			if (name && currentNames.indexOf(name) === -1)
				currentNames.push(name);
		});

		var ssidInput = E('input', {
			'id': 'quick-wifi-ssid',
			'class': 'cbi-input-text',
			'type': 'text',
			'maxlength': 32,
			'value': currentNames.length === 1 ? currentNames[0] : '',
			'placeholder': currentNames.length > 1 ? _('Enter one name for all bands') : _('Wi-Fi network name'),
			'autocomplete': 'off',
			'style': 'width:100%;max-width:32em'
		});
		var passwordInput = E('input', {
			'id': 'quick-wifi-password',
			'class': 'cbi-input-password',
			'type': 'password',
			'minlength': 8,
			'maxlength': 63,
			'placeholder': _('8–63 characters'),
			'autocomplete': 'new-password',
			'style': 'width:100%;max-width:32em'
		});

		var missingText = targets.missing.map(function(band) { return BAND_LABEL[band]; }).join(', ');
		var ready = targets.missing.length === 0 && targets.sections.length > 0;
		var applyButton;
		var errorMessages = {
			ssid_empty: _('Enter a Wi-Fi network name.'),
			ssid_long: _('The Wi-Fi network name must be no more than 32 bytes.'),
			password_length: _('The Wi-Fi password must contain between 8 and 63 characters.'),
			password_ascii: _('Use only ordinary printable characters in the Wi-Fi password.')
		};

		function save() {
			var ssid = ssidInput.value.trim();
			var password = passwordInput.value;
			var error = validateQuickWifi(ssid, password);
			if (error) {
				ui.addNotification(null, E('p', {}, errorMessages[error]), 'danger');
				return;
			}

			ui.showModal(_('Apply Quick Wi-Fi Setup?'), [
				E('p', {}, _('The 2.4 GHz, 5 GHz, and 6 GHz primary networks will all use “%s” and the password you entered. Their existing security modes and other radio settings will be preserved.').format(ssid)),
				E('p', { 'class': 'alert-message warning' }, _('Connected Wi-Fi devices will disconnect briefly and must reconnect using the new name and password.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': function() {
							ui.hideModal();
							applyButton.disabled = true;
							applyButton.classList.add('spinning');
							ui.addNotification(null, E('p', {}, _('Applying the new Wi-Fi name and password. Reconnect to “%s” if this device disconnects.').format(ssid)), 'info');
							return applyQuickWifi(targets, ssid, password).then(function() {
								passwordInput.value = '';
								ui.addNotification(null, E('p', {}, _('All three primary Wi-Fi networks were updated.')), 'info');
							}).catch(function(error) {
								ui.addNotification(null, E('p', {}, _('Unable to apply Wi-Fi settings: %s').format(error.message || String(error))), 'danger');
							}).finally(function() {
								applyButton.disabled = false;
								applyButton.classList.remove('spinning');
							});
						}
					}, _('Apply to All Three Bands'))
				])
			]);
		}

		applyButton = E('button', {
			'class': 'btn cbi-button cbi-button-apply cbi-button-positive',
			'disabled': ready ? null : 'disabled',
			'click': save
		}, _('Apply to All Three Bands'));

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Quick Wi-Fi Setup')),
			E('p', { 'class': 'cbi-map-descr' }, _('Set one network name and password for the primary 2.4 GHz, 5 GHz, and 6 GHz access points. Advanced Wi-Fi and security settings are left unchanged.')),
			E('div', { 'class': 'cbi-section' }, BAND_ORDER.map(function(band) {
				var section = targets.byBand[band];
				return E('p', {}, '%s: %s%s'.format(BAND_LABEL[band], section ?
					(uci.get('wireless', section, 'ssid') || section) : _('not found'),
					section && isMlo({ mlo: uci.get('wireless', section, 'mlo') }) ? _(' (shared MLO network)') : ''));
			})),
			E('p', {}, _('Only the networks listed above are updated. Guest networks and other secondary access points are left unchanged. Matching names does not add the legacy 2.4 GHz network to MLO.')),
			!ready ? E('div', { 'class': 'alert-message warning' }, _('Setup cannot continue because these primary bands were not found: %s. Use Network → Wireless to repair or create them first.').format(missingText || _('unknown'))) : null,
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'quick-wifi-ssid' }, _('Wi-Fi Network Name')),
						E('div', { 'class': 'cbi-value-field' }, [ ssidInput ])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'quick-wifi-password' }, _('Wi-Fi Password')),
						E('div', { 'class': 'cbi-value-field' }, [ passwordInput, E('div', { 'class': 'cbi-value-description' }, _('The password is written to all three primary networks and is never displayed after saving.')) ])
					])
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [ applyButton ]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Legacy Device Connection')),
				E('p', {}, _('Keeping settings during an upgrade also keeps your previous Wi-Fi security and radio mode. Apply this profile to update the existing 2.4 GHz network for older or compatibility-sensitive devices.')),
				cameraTarget ? E('p', {}, _('Current 2.4 GHz settings: channel %s, %s, security %s, protected management frames %s.').format(
					uci.get('wireless', cameraTarget.radio, 'channel') || _('automatic'),
					uci.get('wireless', cameraTarget.radio, 'htmode') || _('default'),
					uci.get('wireless', cameraTarget.section, 'encryption') || _('default'),
					uci.get('wireless', cameraTarget.section, 'ieee80211w') || _('automatic'))) :
					E('p', {}, _('This profile requires a separate 2.4 GHz network with a valid Wi-Fi password. Shared Wi-Fi 7 MLO networks must be separated in Network → Wi-Fi 7 MLO first.')),
				cameraButton, ' ', diagnosticsButton, diagnostics
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
