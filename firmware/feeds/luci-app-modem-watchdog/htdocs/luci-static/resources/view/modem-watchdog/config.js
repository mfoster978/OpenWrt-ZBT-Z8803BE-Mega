'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';
return view.extend({
	load: function() {
		return uci.load('modem_watchdog');
	},
	render: function() {
		var m, s, o;
		var applyPreset = function(preset) {
			ui.showModal(_('Applying routing preset'), [
				E('p', { 'class': 'spinning' }, _('Updating MWAN3 policy without restarting either modem…'))
			]);
			return fs.exec('/usr/sbin/zbt-mwan-preset', [preset]).then(function(res) {
				if (res.code !== 0)
					throw new Error((res.stderr || res.stdout || _('Preset command failed')).trim());
				window.location.reload();
			}).catch(function(err) {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, err.message), 'error');
			});
		};

		m = new form.Map('modem_watchdog', _('Multi-WAN Priority & Recovery'),
			_('MWAN3 owns router-wide priority. QModem only brings each cellular link online. Modem 1 is always the preferred cellular path; Modem 2 is used only after MWAN3 marks Modem 1 unavailable.'));

		var presets = m.section(form.NamedSection, 'global', 'modem_watchdog', _('Easy routing presets'),
			_('Applying a preset updates only the firmware-managed MWAN3 members and route metrics. It does not reboot, redial, or power-cycle a modem.'));
		o = presets.option(form.DummyValue, 'routing_preset', _('Current preset'));
		o.cfgvalue = function(section_id) {
			var value = uci.get('modem_watchdog', section_id, 'routing_preset') || 'priority';
			return ({
				priority: _('Priority failover'),
				failover: _('Fast health failover'),
				fastest: _('Retired — use Fast health failover'),
				custom: _('Custom settings')
			})[value] || value;
		};
		o = presets.option(form.Button, '_priority', _('Priority failover'),
			_('SFP → WAN → USB tether → Modem 1 → Modem 2. MWAN3 removes an unhealthy link after three failed checks and restores it after two good checks. Your recovery settings are preserved.'));
		o.inputstyle = 'apply';
		o.onclick = function() { return applyPreset('priority'); };
		o = presets.option(form.Button, '_failover', _('Fast health failover'),
			_('Uses the same safe priority order, but fails over after two failed checks and returns to the preferred link after its first successful check. Your recovery settings are preserved.'));
		o.inputstyle = 'apply';
		o.onclick = function() { return applyPreset('failover'); };
		s = m.section(form.TypedSection, 'modem_watchdog', _('Global settings'));
		s.anonymous = true;
		o = s.option(form.Flag, 'enabled', _('Enable watchdog recovery'));
		o.default = '1';
		o = s.option(form.Flag, 'actions_enabled', _('Allow recovery actions'));
		o.default = '1';
		o = s.option(form.Value, 'interval_seconds', _('Check interval (seconds)'));
		o.datatype = 'range(10,60)';
		o.default = '30';
		o = s.option(form.Value, 'ping_target', _('Ping target'));
		o.default = '1.1.1.1';
		o = s.option(form.Value, 'ping6_target', _('IPv6 ping target'));
		o.default = '2606:4700:4700::1111';
		o = s.option(form.Value, 'ping_fail_threshold', _('Failures before action'));
		o.datatype = 'uinteger';
		o.default = '4';
		o = s.option(form.Value, 'cooldown_seconds', _('Recovery cooldown (seconds)'));
		o.datatype = 'uinteger';
		o.default = '180';
		var modem = m.section(form.TypedSection, 'modem', _('Per-modem settings'));
		modem.anonymous = true;
		modem.addremove = false;
		o = modem.option(form.DummyValue, 'section', _('Physical modem identity (4_1 = 5G1; 2_1 = 5G2)'));
		o.default = '4_1';
		o = modem.option(form.Flag, 'enabled', _('Monitor this modem'));
		o.default = '1';
		o = modem.option(form.ListValue, 'action', _('Recovery action'));
		o.value('none', _('None (log only)'));
		o.value('disconnect', _('Disconnect modem interface'));
		o.value('redial', _('Redial modem'));
		o.value('power_cycle', _('Power cycle GPIO + redial'));
		o.default = 'power_cycle';
		o = modem.option(form.ListValue, 'redial_attempts', _('Redial attempts before GPIO recovery'), _('Default: go directly to GPIO recovery after confirmed failure. RX-error growth or QMI session loss skips soft retries. Each slot is limited to three recovery attempts per hour; working IPv4 or IPv6 prevents a reset.'));
		o.value('0', _('None — GPIO recovery first'));
		o.value('1', _('One attempt'));
		o.value('2', _('Two attempts'));
		o.default = '0';
		o = modem.option(form.DummyValue, 'gpio_power_name', _('Fixed slot power GPIO'));
		o.default = '5g1';
		return m.render();
	}
});
