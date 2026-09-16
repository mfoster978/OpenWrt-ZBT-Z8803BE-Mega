'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callStatus = rpc.declare({ object: 'zbt.adguard', method: 'status', expect: {} });
var callOffer = rpc.declare({ object: 'zbt.adguard', method: 'offer', expect: {} });
var callInstall = rpc.declare({ object: 'zbt.adguard', method: 'install', params: ['token'], expect: {} });
var callJob = rpc.declare({ object: 'zbt.adguard', method: 'job', params: ['id'], expect: {} });
var callConfigure = rpc.declare({ object: 'zbt.adguard', method: 'configure', params: ['username', 'password'], expect: {} });
var callEnabled = rpc.declare({ object: 'zbt.adguard', method: 'set_enabled', params: ['enabled'], expect: {} });
var callUninstall = rpc.declare({ object: 'zbt.adguard', method: 'uninstall', params: ['confirmation'], expect: {} });

function size(value) {
	var n = Number(value);
	return Number.isFinite(n) ? (n / 1048576).toFixed(1) + ' MiB' : '—';
}

return view.extend({
	load: function() {
		return callStatus();
	},

	render: function(status) {
		var self = this;
		this.status = status || {};
		this.writable = typeof L.hasViewPermission === 'function' && L.hasViewPermission();
		this.busy = false;
		this.job = null;
		this.notice = E('div', { 'class': 'zapp-notice', role: 'status', 'aria-live': 'polite', hidden: '' });
		this.stateBox = E('section', { 'class': 'zapp-card' });
		this.actionBox = E('section', { 'class': 'zapp-card' });
		this.renderState();
		this.renderActions();
		poll.add(function() { return self.refresh(); }, 3);
		return E('div', { 'class': 'zapp' }, [
			E('link', { rel: 'stylesheet', href: L.resource('view/system/mega-apps.css') }),
			E('section', { 'class': 'zapp-hero zapp-agh' }, [
				E('div', {}, [
					E('span', { 'class': 'zapp-eyebrow' }, _('FULL ADGUARD HOME · USB REQUIRED')),
					E('h2', {}, _('Network-wide DNS protection without filling router flash')),
					E('p', {}, _('The application, configuration, filters, statistics, query logs, backups, and staging files remain on verified USB storage.'))
				]),
				E('div', { 'class': 'zapp-shield', 'aria-hidden': 'true' }, 'A')
			]),
			this.notice,
			!this.writable ? E('p', { 'class': 'zapp-warning' }, _('Read-only access: installation and lifecycle controls require AdGuard write permission.')) : null,
			this.stateBox,
			this.actionBox,
			E('section', { 'class': 'zapp-card zapp-caution' }, [
				E('h3', {}, _('Automatic safety behavior')),
				E('p', {}, _('If the configured USB drive is removed, the router stops AdGuard and restores dnsmasq on port 53. Reconnecting the exact USB filesystem allows an enabled installation to start again.')),
				E('p', {}, _('Sudden removal can still corrupt the USB filesystem. Unmount it before planned removal.'))
			])
		].filter(function(x) { return x != null; }));
	},

	message: function(text, error) {
		this.notice.hidden = !text;
		this.notice.classList.toggle('zapp-error', !!error);
		this.notice.textContent = text || '';
	},

	renderState: function() {
		var s = this.status;
		var state = s.running ? _('Running and protecting DNS') :
			s.enabled && !s.storage_ready ? _('Enabled, but USB storage is missing') :
			s.installed ? _('Installed but disabled') : _('Not installed');
		this.stateBox.replaceChildren(
			E('span', { 'class': 'zapp-eyebrow' }, _('CURRENT STATUS')),
			E('h3', {}, state),
			E('dl', { 'class': 'zapp-facts' }, [
				E('dt', {}, _('USB storage')), E('dd', {}, s.storage_ready ? _('Mounted and verified') : _('Not available')),
				E('dt', {}, _('Installed version')), E('dd', {}, s.version || '—'),
				E('dt', {}, _('Enabled')), E('dd', {}, s.enabled ? _('Yes') : _('No')),
				E('dt', {}, _('Service')), E('dd', {}, s.running ? _('Running') : _('Stopped')),
				E('dt', {}, _('Router DNS handoff')), E('dd', {}, s.dns_owned ? _('AdGuard owns port 53') : _('dnsmasq fallback owns port 53'))
			])
		);
	},

	renderActions: function() {
		var self = this;
		var s = this.status;
		var actions = [];
		if (!s.installed) {
			var install = E('button', { 'class': 'btn cbi-button-action', type: 'button', click: function() { self.confirmInstall(); } }, _('Install full AdGuard Home to USB…'));
			install.disabled = !this.writable || !s.storage_ready || this.busy;
			actions.push(install);
			if (!s.storage_ready) actions.push(E('a', { href: L.url('admin', 'system', 'mega-storage'), 'class': 'btn' }, _('Prepare USB storage')));
		} else if (!s.configured) {
			var setup = E('button', { 'class': 'btn cbi-button-action', type: 'button', click: function() { self.showCredentials(); } }, _('Create AdGuard administrator…'));
			setup.disabled = !this.writable || !s.storage_ready || this.busy;
			actions.push(setup);
		} else {
			var toggle = E('button', { 'class': s.enabled ? 'btn cbi-button-negative' : 'btn cbi-button-action', type: 'button', click: function() { self.setEnabled(!s.enabled); } }, s.enabled ? _('Disable AdGuard Home') : _('Enable AdGuard Home'));
			toggle.disabled = !this.writable || (!s.enabled && !s.storage_ready) || this.busy;
			actions.push(toggle);
			if (s.running) actions.push(E('a', { href: this.adguardUrl(), target: '_blank', rel: 'noopener noreferrer', 'class': 'btn cbi-button-action' }, _('Open AdGuard Home ↗')));
			var uninstall = E('button', { 'class': 'btn cbi-button-negative', type: 'button', click: function() { self.confirmUninstall(); } }, _('Uninstall from USB…'));
			uninstall.disabled = !this.writable || !s.storage_ready || this.busy;
			actions.push(uninstall);
		}
		this.actionBox.replaceChildren(
			E('h3', {}, _('Manage AdGuard Home')),
			E('p', { 'class': 'zapp-muted' }, s.installed ? _('Disable keeps all USB data. Uninstall removes only the AdGuard Home directory from the verified USB filesystem.') : _('Installation is refused unless /mnt/mega-apps is the configured, mounted USB filesystem.')),
			E('div', { 'class': 'zapp-actions' }, actions)
		);
	},

	adguardUrl: function() {
		var target = new URL(window.location.href);
		target.protocol = 'http:';
		target.port = String(this.status.web_port || 3000);
		target.pathname = '/';
		target.search = '';
		target.hash = '';
		return target.href;
	},

	confirmInstall: function() {
		var self = this;
		if (!this.writable || !this.status.storage_ready || this.busy) return;
		this.busy = true;
		return callOffer().then(function(offer) {
			if (!offer.ok || typeof offer.token !== 'string') throw new Error(offer.error || _('Installation could not be prepared.'));
			var ack = E('input', { type: 'checkbox' });
			var submit = E('button', { 'class': 'btn cbi-button-action', type: 'button' }, _('Download and install to USB'));
			submit.disabled = true;
			ack.addEventListener('change', function() { submit.disabled = !ack.checked; });
			submit.addEventListener('click', function() {
				if (submit.disabled) return;
				ui.hideModal();
				self.startInstall(offer.token);
			});
			ui.showModal(_('Install full AdGuard Home'), [
				E('p', {}, _('Install official AdGuard Home ') + offer.release + _(' exclusively to the verified USB drive?')),
				E('p', {}, _('Download size: ') + size(offer.download_size) + _('. Router flash will not be used for the archive, binary, configuration, or data.')),
				E('label', { 'class': 'zapp-check' }, [ack, E('span', {}, _('I understand this requires the USB drive and that removing it disables AdGuard.'))]),
				E('div', { 'class': 'zapp-actions' }, [E('button', { 'class': 'btn', click: function() { self.busy = false; ui.hideModal(); } }, _('Cancel')), submit])
			]);
		}).catch(function(error) {
			self.busy = false;
			self.message(error.message, true);
		});
	},

	startInstall: function(token) {
		var self = this;
		this.message(_('Starting the verified USB download…'));
		return callInstall(token).then(function(result) {
			if (!result.ok || typeof result.id !== 'string') throw new Error(result.error || _('Installation was rejected.'));
			self.job = result.id;
			self.actionBox.replaceChildren(E('h3', {}, _('Installing on USB')), E('progress'), E('p', {}, _('Downloading and verifying the official ARM64 release. Keep the USB drive connected.')));
		}).catch(function(error) {
			self.busy = false;
			self.message(error.message, true);
			self.renderActions();
		});
	},

	showCredentials: function() {
		var self = this;
		if (!this.writable || !this.status.storage_ready || this.busy) return;
		var username = E('input', { type: 'text', maxlength: '32', autocomplete: 'username', value: 'admin' });
		var password = E('input', { type: 'password', minlength: '12', maxlength: '128', autocomplete: 'new-password' });
		var repeat = E('input', { type: 'password', minlength: '12', maxlength: '128', autocomplete: 'new-password' });
		var submit = E('button', { 'class': 'btn cbi-button-action', type: 'button' }, _('Finish setup and enable'));
		function valid() {
			submit.disabled = !/^[A-Za-z0-9._-]{1,32}$/.test(username.value) || password.value.length < 12 || password.value !== repeat.value;
		}
		[username, password, repeat].forEach(function(input) { input.addEventListener('input', valid); });
		valid();
		submit.addEventListener('click', function() {
			if (submit.disabled) return;
			self.busy = true;
			submit.disabled = true;
			var user = username.value;
			var pass = password.value;
			password.value = '';
			repeat.value = '';
			ui.hideModal();
			callConfigure(user, pass).then(function(result) {
				pass = '';
				if (!result.ok) throw new Error(result.error || _('AdGuard setup failed.'));
				self.message(_('AdGuard Home is installed and DNS protection is active.'));
				return self.refresh();
			}).catch(function(error) {
				pass = '';
				self.message(error.message, true);
			}).finally(function() { self.busy = false; self.renderActions(); });
		});
		ui.showModal(_('Create the AdGuard Home administrator'), [
			E('p', {}, _('These credentials are for the separate AdGuard Home web interface. The plaintext password is not saved by Mega.')),
			E('label', {}, [_('Administrator name'), username]),
			E('label', {}, [_('Password (12 characters minimum)'), password]),
			E('label', {}, [_('Repeat password'), repeat]),
			E('div', { 'class': 'zapp-actions' }, [E('button', { 'class': 'btn', click: function() { ui.hideModal(); } }, _('Cancel')), submit])
		]);
	},

	setEnabled: function(enabled) {
		var self = this;
		if (!this.writable || this.busy) return;
		function apply() {
			self.busy = true;
			ui.hideModal();
			callEnabled(enabled).then(function(result) {
				if (!result.ok) throw new Error(result.error || _('The lifecycle change failed.'));
				self.message(enabled ? _('AdGuard Home enabled.') : _('AdGuard Home disabled; dnsmasq is serving DNS.'));
				return self.refresh();
			}).catch(function(error) { self.message(error.message, true); })
				.finally(function() { self.busy = false; self.renderActions(); });
		}
		if (enabled) return apply();
		ui.showModal(_('Disable AdGuard Home'), [
			E('p', {}, _('AdGuard will stop and dnsmasq will immediately resume normal router DNS. USB data and settings will be kept.')),
			E('div', { 'class': 'zapp-actions' }, [E('button', { 'class': 'btn', click: function() { ui.hideModal(); } }, _('Cancel')), E('button', { 'class': 'btn cbi-button-negative', click: apply }, _('Disable'))])
		]);
	},

	confirmUninstall: function() {
		var self = this;
		if (!this.writable || !this.status.storage_ready || this.busy) return;
		var typed = E('input', { type: 'text', autocomplete: 'off', placeholder: 'UNINSTALL ADGUARD' });
		var submit = E('button', { 'class': 'btn cbi-button-negative' }, _('Uninstall from USB'));
		submit.disabled = true;
		typed.addEventListener('input', function() { submit.disabled = typed.value !== 'UNINSTALL ADGUARD'; });
		submit.addEventListener('click', function() {
			if (submit.disabled) return;
			self.busy = true;
			ui.hideModal();
			callUninstall(typed.value).then(function(result) {
				if (!result.ok) throw new Error(result.error || _('Uninstall failed.'));
				self.message(_('AdGuard Home was removed from USB. dnsmasq is serving DNS.'));
				return self.refresh();
			}).catch(function(error) { self.message(error.message, true); })
				.finally(function() { self.busy = false; self.renderActions(); });
		});
		ui.showModal(_('Uninstall AdGuard Home'), [
			E('p', {}, _('This disables AdGuard, restores dnsmasq, and deletes only /mnt/mega-apps/adguardhome. The rest of the USB drive is not erased.')),
			E('label', {}, [_('Type '), E('code', {}, 'UNINSTALL ADGUARD'), typed]),
			E('div', { 'class': 'zapp-actions' }, [E('button', { 'class': 'btn', click: function() { ui.hideModal(); } }, _('Cancel')), submit])
		]);
	},

	refresh: function() {
		var self = this;
		if (this.job) {
			return callJob(this.job).then(function(result) {
				if (!result.ok) throw new Error(result.error || _('Unable to read installation progress.'));
				if (result.phase === 'credentials') {
					self.job = null;
					self.busy = false;
					self.message(_('AdGuard Home is verified on USB. Create its administrator to activate DNS.'));
					return callStatus().then(function(status) {
						self.status = status;
						self.renderState();
						self.renderActions();
						self.showCredentials();
					});
				}
				if (result.phase === 'error') {
					self.job = null;
					self.busy = false;
					self.message(result.error || _('Installation failed.'), true);
					self.renderActions();
				}
			}).catch(function(error) { self.message(error.message, true); });
		}
		return callStatus().then(function(status) {
			self.status = status || {};
			self.renderState();
			if (!self.busy) self.renderActions();
		}).catch(function(error) { self.message(error.message, true); });
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
