'use strict';
'require view';
'require rpc';

/*
 * This small ROM-resident screen keeps Speedify in LuCI across sysupgrades.
 * The checksum-verified vendor APK replaces this file with the full management
 * UI after Internet access is available; no proprietary payload is bundled.
 */
var readStatus = rpc.declare({ object: 'zbt.speedify', method: 'status', expect: {} });
var setEnabled = rpc.declare({ object: 'zbt.speedify', method: 'set_enabled', params: [ 'enabled' ], expect: {} });

function enableControl(enabled) {
	var input = E('input', { type: 'checkbox' });
	var result = E('span', { 'class': 'cbi-value-description' });
	input.checked = enabled;
	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Speedify service')),
		E('label', { 'class': 'cbi-value' }, [
			input,
			' ',
			_('Enable Speedify')
		]),
		E('p', {}, _('Speedify is optional and disabled by default. Disabling stops its installer, guard, VPN daemon, web helper, tunnel forwarding, and interception rules.')),
		E('button', {
			'class': 'btn cbi-button cbi-button-apply',
			type: 'button',
			click: function() {
				input.disabled = true;
				result.textContent = _('Applying…');
				return setEnabled(input.checked).then(function(reply) {
					if (!reply || !reply.ok) throw new Error('apply failed');
					window.location.reload();
				}).catch(function() {
					input.disabled = false;
					result.textContent = _('Unable to apply the Speedify setting. Check the system log.');
				});
			}
		}, _('Apply')),
		' ',
		result
	]);
}

return view.extend({
	load: function() {
		return readStatus();
	},
	render: function(status) {
		var enabled = !!(status && status.enabled);
		var content = [
			E('h2', {}, _('Speedify')),
			enableControl(enabled)
		];
		if (enabled) {
			content.push(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Finishing Speedify setup')),
				E('p', {}, _('This firmware keeps the Speedify menu available while the official Speedify packages are downloaded and installed. The full management screen will replace this message automatically after the router has working HTTPS Internet access.')),
				E('p', {}, _('Installation retries in the background. It can take several minutes after a firmware upgrade or first boot. Your modem and normal routing do not depend on Speedify finishing.')),
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'type': 'button',
					'click': function() { window.location.reload(); }
				}, _('Reload Speedify')),
				E('p', { 'class': 'cbi-value-description' }, [
					_('For diagnostics over SSH, run '),
					E('code', {}, 'logread -e speedify-installer')
				])
			]));
		} else {
			content.push(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Speedify is off')),
				E('p', {}, _('Normal WAN and modem routing continue without Speedify. Enable it above only if you want the optional VPN bonding service.'))
			]));
		}
		return E('div', { 'class': 'cbi-map' }, content);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
