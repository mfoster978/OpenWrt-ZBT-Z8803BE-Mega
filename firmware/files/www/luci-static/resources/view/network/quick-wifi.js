'use strict';
'require view';
'require uci';
'require ui';

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
	return mode === 'ap' && networks.indexOf('guest') === -1;
}

function targetScore(section) {
	var name = section['.name'] || '';
	var networks = asList(section.network);
	var score = 0;
	if (networks.indexOf('lan') !== -1)
		score += 100;
	if (/^default_radio/.test(name))
		score += 80;
	if (/^WIFI7-/i.test(section.ssid || ''))
		score += 30;
	if (section.mlo === '1' || section.mlo === 1 || section.mlo === true)
		score += 20;
	if (section.disabled !== '1' && section.disabled !== 1 && section.disabled !== true)
		score += 10;
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
			var difference = targetScore(b) - targetScore(a);
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

return view.extend({
	load: function() {
		return uci.load('wireless');
	},

	render: function() {
		var targets = quickWifiTargets();
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
			E('div', { 'class': 'cbi-page-actions' }, [ applyButton ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
