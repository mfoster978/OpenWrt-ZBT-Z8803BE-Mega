include $(TOPDIR)/rules.mk
PKG_NAME:=luci-app-modem-watchdog
PKG_VERSION:=1
PKG_RELEASE:=10
LUCI_TITLE:=LuCI support for MWAN3 presets, dual-stack modem health and guarded GPIO recovery
LUCI_DEPENDS:=+luci-base +rpcd +jq +curl +flock +mwan3
include $(TOPDIR)/feeds/luci/luci.mk
define Package/$(PKG_NAME)/conffiles
/etc/config/modem_watchdog
endef
define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./root/etc/config/modem_watchdog $(1)/etc/config/modem_watchdog
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/modem_watchdog $(1)/etc/init.d/modem_watchdog
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./root/usr/sbin/modem-watchdog $(1)/usr/sbin/modem-watchdog
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-modem-watchdog.json $(1)/usr/share/luci/menu.d/luci-app-modem-watchdog.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-modem-watchdog.json $(1)/usr/share/rpcd/acl.d/luci-app-modem-watchdog.json
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/modem-watchdog
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/modem-watchdog/config.js $(1)/www/luci-static/resources/view/modem-watchdog/config.js
endef
# call BuildPackage - OpenWrt buildroot signature
$(eval $(call BuildPackage,$(PKG_NAME)))
