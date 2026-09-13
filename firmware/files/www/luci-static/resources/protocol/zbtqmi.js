'use strict';
'require network';
return network.registerProtocol('zbtqmi', {
	getI18n: function() { return _('QModem managed data session'); }
});
