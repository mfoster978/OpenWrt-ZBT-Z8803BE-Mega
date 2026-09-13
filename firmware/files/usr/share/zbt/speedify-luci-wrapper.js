'use strict';
'require view';
'require rpc';
'require poll';

var readStatus = rpc.declare({ object: 'zbt.speedify', method: 'status', expect: {} });

// Speedify owns account sign-in, activation and account-state updates.
// This wrapper only embeds its official UI and supplies router-session auth.
return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
	load: function() {},
	render: function() {
		var status = E('p', { 'aria-live': 'polite' }, _('Reading Speedify daemon status…'));
		var diagnostics = E('div', { 'class': 'cbi-section', id: 'mega-speedify-status' }, [status]);
		var refresh = function() {
			return readStatus().then(function(result) {
				var message;
				if (!result || !result.ok) {
					message = _('Speedify daemon status is unavailable. Use the native dashboard below; sign-in has not been confirmed.');
				} else if (result.signed_in) {
					message = result.state === 'CONNECTED' && result.tunnel_present
						? _('Speedify account signed in; VPN connected.')
						: _('Speedify account signed in; VPN is not connected yet.');
				} else if (result.recent_error === 'ERROR_NO_ROUTER_LICENSE') {
					message = _('Speedify recently rejected activation: ERROR_NO_ROUTER_LICENSE. A router license may still be assigned to an earlier router identity. Check Manage Routers in your Speedify account, then retry the native Sign In below.');
				} else if (result.recent_error === 'NETWORK_ERROR' || result.needs_internet) {
					message = _('Speedify could not complete sign-in because of a network error. Check the router’s Internet connection and retry the native Sign In below.');
				} else if (result.recent_error === 'AUTHENTICATION_FAILED') {
					message = _('Speedify recently reported an authentication failure. Retry the native Sign In below or contact Speedify support.');
				} else {
					message = _('Speedify has not confirmed router sign-in. Complete Sign In in the native dashboard below. Signing into the account website alone does not confirm router activation.');
				}
				status.textContent = message;
			}).catch(function() {
				status.textContent = _('Unable to read Speedify daemon status. The native dashboard remains available below.');
			});
		};
		// Read-only status polling never reloads the iframe or generates a
		// second activation link when returning from the account website.
		poll.add(refresh, 10);
		refresh();
		var sessionId = (L.env && L.env.sessionid) || '';
		if (sessionId) {
			document.cookie = 'sfy-session=' + encodeURIComponent(sessionId) +
				'; path=/luci-app-speedify/; SameSite=Strict' +
				(window.location.protocol === 'https:' ? '; Secure' : '');
		}
		var app = new URL('/luci-app-speedify/view/index.html', window.location.origin);
		// Angular owns the fragment and can replace it on navigation. Keep the
		// non-secret transport parameters in the document query so reconnects
		// cannot fall back to port 9330 after an account/login route change.
		// The official sfy-ws-auth proxy accepts the scoped session cookie;
		// never put the router's session token in query strings or server logs.
		app.search = 'wsPort=match&wsEndpoint=/luci-app-speedify/api/ws&updateEndpoint=/luci-app-speedify/cgi/perform-update.sh&restartEndpoint=/luci-app-speedify/cgi/perform-restart.sh&resetEndpoint=/luci-app-speedify/cgi/perform-reset.sh';
		app.hash = '/';
		return E('div', { 'class': 'cbi-map', id: 'mega-speedify' }, [
			diagnostics,
			E('iframe', {
				id: 'mega-speedify-dashboard', title: _('Speedify dashboard'),
				src: app.href, style: 'display:block;width:100%;min-height:720px;height:80vh;border:0;',
				referrerpolicy: 'no-referrer', allowfullscreen: true
			})
		]);
	}
});
