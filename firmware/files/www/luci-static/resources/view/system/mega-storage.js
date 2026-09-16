'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callStatus = rpc.declare({ object: 'zbt.storage', method: 'status', expect: {} });
var callCandidates = rpc.declare({ object: 'zbt.storage', method: 'candidates', expect: {} });
var callPrepare = rpc.declare({ object: 'zbt.storage', method: 'prepare', params: ['mode', 'id', 'confirmation'], expect: {} });
var callJob = rpc.declare({ object: 'zbt.storage', method: 'job', params: ['id'], expect: {} });
var callRelease = rpc.declare({ object: 'zbt.storage', method: 'release', expect: {} });

function bytes(value) {
	var n = Number(value);
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GiB';
	return (n / 1048576).toFixed(1) + ' MiB';
}

function safe(value, fallback) {
	return typeof value === 'string' && value ? value : (fallback || '—');
}

return view.extend({
	load: function() {
		return Promise.all([callStatus(), callCandidates()]);
	},

	render: function(data) {
		var self = this;
		this.status = data[0] || {};
		this.candidates = Array.isArray(data[1] && data[1].candidates) ? data[1].candidates : [];
		this.writable = typeof L.hasViewPermission === 'function' && L.hasViewPermission();
		this.job = null;
		this.busy = false;
		this.notice = E('div', { 'class': 'zapp-notice', role: 'status', 'aria-live': 'polite', hidden: '' });
		this.jobBox = E('section', { 'class': 'zapp-card', hidden: '' });
		this.candidateBox = E('section', { 'class': 'zapp-card' });
		this.renderCandidates();
		poll.add(function() { return self.refreshJob(); }, 2);
		return E('div', { 'class': 'zapp' }, [
			E('link', { rel: 'stylesheet', href: L.resource('view/system/mega-apps.css') }),
			E('section', { 'class': 'zapp-hero' }, [
				E('div', {}, [
					E('span', { 'class': 'zapp-eyebrow' }, _('USB-ONLY APPLICATION STORAGE')),
					E('h2', {}, _('Prepare safe storage for router applications')),
					E('p', {}, _('Use an existing ext4 partition without erasing it, or explicitly erase one whole USB drive. Internal router storage is never selectable.'))
				]),
				E('div', { 'class': 'zapp-mark', 'aria-hidden': 'true' }, 'USB')
			]),
			this.notice,
			!this.writable ? E('p', { 'class': 'zapp-warning' }, _('Read-only access: storage may be inspected, but preparation and release require write permission.')) : null,
			this.renderCurrent(),
			this.jobBox,
			this.candidateBox,
			E('section', { 'class': 'zapp-card zapp-caution' }, [
				E('h3', {}, _('Before erasing a drive')),
				E('p', {}, _('Back up its files. The erase option removes the entire partition table and every partition. A changing /dev/sdX name is never trusted; the router revalidates the physical USB identity immediately before formatting.')),
				E('p', {}, _('Always unmount storage before unplugging it. Sudden removal can corrupt the filesystem.'))
			])
		].filter(function(x) { return x != null; }));
	},

	message: function(text, error) {
		this.notice.hidden = !text;
		this.notice.classList.toggle('zapp-error', !!error);
		this.notice.textContent = text || '';
	},

	renderCurrent: function() {
		var self = this;
		var s = this.status;
		var release = E('button', { 'class': 'btn cbi-button-negative', type: 'button', click: function() { self.confirmRelease(); } }, _('Release storage'));
		release.disabled = !this.writable || !s.configured || this.busy;
		return E('section', { 'class': 'zapp-card' }, [
			E('span', { 'class': 'zapp-eyebrow' }, _('CURRENT APPLICATION STORAGE')),
			E('h3', {}, s.mounted ? _('USB storage is mounted and verified') : s.configured ? _('Configured USB storage is missing') : _('No application storage configured')),
			E('dl', { 'class': 'zapp-facts' }, [
				E('dt', {}, _('Mount point')), E('dd', {}, safe(s.mount, '/mnt/mega-apps')),
				E('dt', {}, _('Device')), E('dd', {}, safe(s.device)),
				E('dt', {}, _('UUID')), E('dd', {}, safe(s.uuid)),
				E('dt', {}, _('Free space')), E('dd', {}, s.mounted ? bytes(s.free) + ' / ' + bytes(s.total) : '—')
			]),
			s.configured ? release : null
		].filter(function(x) { return x != null; }));
	},

	renderCandidates: function() {
		var self = this;
		if (!this.candidates.length) {
			this.candidateBox.replaceChildren(
				E('h3', {}, _('Attached USB storage')),
				E('p', {}, _('No eligible USB block device was detected. Attach a flash drive, then reload this page.'))
			);
			return;
		}
		var rows = this.candidates.map(function(c) {
			var action = E('button', { 'class': c.kind === 'erase' ? 'btn cbi-button-negative' : 'btn cbi-button-action', type: 'button', click: function() { self.confirmCandidate(c); } },
				c.kind === 'erase' ? _('Erase entire drive…') : _('Use this ext4 partition'));
			action.disabled = !self.writable || !c.eligible || self.status.configured || self.busy;
			return E('article', { 'class': 'zapp-device' }, [
				E('div', {}, [
					E('strong', {}, safe(c.model, _('USB storage'))),
					E('code', {}, safe(c.device)),
					E('span', { 'class': 'zapp-muted' }, bytes(c.size) + (c.fstype ? ' · ' + c.fstype : '') + (c.mount ? ' · ' + _('mounted at ') + c.mount : ''))
				]),
				!c.eligible ? E('p', { 'class': 'zapp-warning' }, safe(c.reason, _('This device is not eligible.'))) : null,
				action
			].filter(function(x) { return x != null; }));
		});
		this.candidateBox.replaceChildren(
			E('h3', {}, _('Attached USB storage')),
			E('p', { 'class': 'zapp-muted' }, _('Adoption does not erase an existing ext4 partition. Erase always targets the whole displayed USB disk.')),
			...rows
		);
	},

	confirmCandidate: function(candidate) {
		var self = this;
		if (!this.writable || !candidate.eligible || this.status.configured || this.busy) return;
		var erase = candidate.kind === 'erase';
		var typed = E('input', { type: 'text', autocomplete: 'off', placeholder: erase ? candidate.confirmation : '' });
		var acknowledge = E('input', { type: 'checkbox' });
		var submit = E('button', { 'class': erase ? 'btn cbi-button-negative' : 'btn cbi-button-action', type: 'button' }, erase ? _('Erase and prepare USB') : _('Use partition'));
		submit.disabled = true;
		function update() {
			submit.disabled = !acknowledge.checked || (erase && typed.value !== candidate.confirmation);
		}
		acknowledge.addEventListener('change', update);
		typed.addEventListener('input', update);
		submit.addEventListener('click', function() {
			if (submit.disabled) return;
			ui.hideModal();
			self.startPrepare(candidate, erase ? typed.value : '');
		});
		ui.showModal(erase ? _('Confirm complete USB erase') : _('Confirm ext4 adoption'), [
			E('p', {}, erase ? _('Every partition and file on this physical USB drive will be destroyed:') : _('This existing ext4 partition will be mounted at /mnt/mega-apps without formatting:')),
			E('dl', { 'class': 'zapp-facts' }, [
				E('dt', {}, _('Model')), E('dd', {}, safe(candidate.model)),
				E('dt', {}, _('Device')), E('dd', {}, safe(candidate.device)),
				E('dt', {}, _('Size')), E('dd', {}, bytes(candidate.size)),
				E('dt', {}, _('Serial')), E('dd', {}, safe(candidate.serial))
			]),
			erase ? E('label', {}, [_('Type '), E('code', {}, candidate.confirmation), typed]) : null,
			E('label', { 'class': 'zapp-check' }, [acknowledge, E('span', {}, erase ? _('I have backed up this USB drive and understand it will be erased.') : _('I want this ext4 partition to become Mega application storage.'))]),
			E('div', { 'class': 'zapp-actions' }, [
				E('button', { 'class': 'btn', type: 'button', click: function() { ui.hideModal(); } }, _('Cancel')),
				submit
			])
		].filter(function(x) { return x != null; }));
	},

	startPrepare: function(candidate, confirmation) {
		var self = this;
		this.busy = true;
		this.renderCandidates();
		this.message(candidate.kind === 'erase' ? _('Preparing and formatting the selected USB drive…') : _('Mounting and verifying the selected ext4 partition…'));
		return callPrepare(candidate.kind, candidate.id, confirmation).then(function(result) {
			if (!result.ok || typeof result.id !== 'string') throw new Error(result.error || _('Storage preparation was rejected.'));
			self.job = result.id;
			self.jobBox.hidden = false;
			self.jobBox.replaceChildren(E('h3', {}, _('Storage preparation in progress')), E('progress'), E('p', {}, _('Keep the USB drive connected.')));
		}).catch(function(error) {
			self.busy = false;
			self.renderCandidates();
			self.message(error.message, true);
		});
	},

	refreshJob: function() {
		var self = this;
		if (!this.job) return Promise.resolve();
		return callJob(this.job).then(function(result) {
			if (!result.ok) throw new Error(result.error || _('Unable to read storage progress.'));
			if (result.phase === 'ready') {
				self.job = null;
				self.message(_('USB application storage is mounted and verified.'));
				window.location.reload();
			} else if (result.phase === 'error') {
				self.job = null;
				self.busy = false;
				self.jobBox.hidden = true;
				self.renderCandidates();
				self.message(result.error || _('Storage preparation failed.'), true);
			}
		}).catch(function(error) { self.message(error.message, true); });
	},

	confirmRelease: function() {
		var self = this;
		if (!this.writable || !this.status.configured || this.busy) return;
		var acknowledge = E('input', { type: 'checkbox' });
		var release = E('button', { 'class': 'btn cbi-button-negative', type: 'button' }, _('Release storage'));
		release.disabled = true;
		acknowledge.addEventListener('change', function() { release.disabled = !acknowledge.checked; });
		release.addEventListener('click', function() {
			if (release.disabled) return;
			self.busy = true;
			ui.hideModal();
			callRelease().then(function(result) {
				if (!result.ok) throw new Error(result.error || _('Storage could not be released.'));
				window.location.reload();
			}).catch(function(error) { self.busy = false; self.message(error.message, true); });
		});
		ui.showModal(_('Release application storage'), [
			E('p', {}, _('This removes the automatic mount configuration but does not erase the USB drive. AdGuard Home must be uninstalled first.')),
			E('label', { 'class': 'zapp-check' }, [acknowledge, E('span', {}, _('Unmount and release this application-storage configuration.'))]),
			E('div', { 'class': 'zapp-actions' }, [E('button', { 'class': 'btn', click: function() { ui.hideModal(); } }, _('Cancel')), release])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
