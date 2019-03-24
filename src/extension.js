// Soft-brightness - Control the display's brightness via an alpha channel.
// Copyright (C) 2019 Philippe Troin (F-i-f on Github)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const Lang = imports.lang;
const St = imports.gi.St;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Shell = imports.gi.Shell;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Convenience = Me.imports.convenience;
const Utils = Me.imports.utils;
const Logger = Me.imports.logger;
const Indicator = imports.ui.status.brightness.Indicator;
const AggregateMenu = imports.ui.main.panel.statusArea.aggregateMenu;


const ModifiedBrightnessIndicator = new Lang.Class({
    Name: 'ModifiedBrightnessIndicator',
    Extends: Indicator,

    _init(softBrightnessExtension) {
	this._softBrightnessExtension = softBrightnessExtension;
	this.parent();
    },

    _sliderChanged(slider, value) {
	this._softBrightnessExtension._logger.log_debug("_sliderChanged(slide, "+value+")");
	this._softBrightnessExtension._storeBrightnessLevel(value);
    },

    _sync() {
	this._softBrightnessExtension._logger.log_debug("_sync()");
	this._softBrightnessExtension._on_brightness_change(false);
	this._slider.setValue(this._softBrightnessExtension._getBrightnessLevel());
    }

});

const SoftBrightnessExtension = new Lang.Class({
    Name: 'SoftBrightnessExtension',

    _init: function() {
	this.parent();

	this._enabled = false;
	this._logger = null;
	this._settings = null;
	this._brightnessIndicator = null;
	this._debugSettingChangedConnection = null;

	this._unredirectPrevented = false;
	this._monitorManager = null;
	this._displayConfigProxy = null;
	this._monitorNames = null;
	this._overlays = null;

	this._monitorsChangedConnection = null;
	this._minBrightnessSettingChangedConnection = null;
	this._currentBrightnessSettingChangedConnection = null;
	this._monitorsSettingChangedConnection = null;
	this._builtinMonitorSettingChangedConnection = null;
	this._useBacklightSettingChangedConnection = null;
	this._preventUnredirectChangedConnection = null;
    },

    enable: function() {
	if (this._enabled) {
	    this._logger.log_debug('enable(), session mode = '+Main.sessionMode.currentMode+", skipping as already enabled");
	} else {
	    this._logger = new Logger.Logger('Soft-Brightness');
	    this._settings = Convenience.getSettings();
	    this._debugSettingChangedConnection = this._settings.connect('changed::debug', this.on_debug_change.bind(this));
	    this._logger.set_debug(this._settings.get_boolean('debug'));
	    this._logger.log_debug('enable(), session mode = '+Main.sessionMode.currentMode);
	    this._enable();
	    this._enabled = true;
	    this._logger.log_debug('Extension enabled');
	}
    },

    disable: function() {
	if (Main.sessionMode.currentMode == 'unlock-dialog') {
	    this._logger.log_debug('disable() skipped as session-mode = unlock-dialog');
	} else if (this._enabled) {
	    this._logger.log_debug('disable(), session mode = '+Main.sessionMode.currentMode);
	    this._settings.disconnect(this._debugSettingChangedConnection);
	    this._disable();
	    this._settings.run_dispose();
	    this._settings = null;
	    this._enabled = false;
	    this._logger.log_debug('Extension disabled');
	    this._logger = null;
	} else {
	    this._logger.log('disabled() called when not enabled');
	}
    },

    _swapMenu(oldIndicator, newIndicator) {
	let menuItems = AggregateMenu.menu._getMenuItems();
	let menuIndex = null;
	for (let i = 0; i < menuItems.length; i++) {
	    if (oldIndicator.menu == menuItems[i]) {
		menuIndex = i;
		break;
	    }
	}
	if (menuIndex == null) {
	    this._logger.log('_swapMenu(): Cannot find brightness indicator');
	    return false;
	}
	this._logger.log_debug('_swapMenu(): Replacing brightness menu item at index '+menuIndex);
	menuItems.splice(menuIndex, 1);
	oldIndicator._proxy.run_dispose();
	oldIndicator.menu.destroy();
	AggregateMenu.menu.addMenuItem(newIndicator.menu, menuIndex);
	AggregateMenu._brightness = newIndicator;
	return true;
    },

    _enable() {
	this._logger.log_debug('_enable()');

	this._brightnessIndicator = new ModifiedBrightnessIndicator(this);
	if (! this._swapMenu(AggregateMenu._brightness, this._brightnessIndicator)) {
	    return;
	}

	this._monitorManager = Meta.MonitorManager.get();
	Utils.newDisplayConfig(Lang.bind(this, function(proxy, error) {
	    if (error) {
		this._logger.log("newDisplayConfig() callback: Cannot get Display Config: " + error);
		return;
	    }
	    this._logger.log_debug('newDisplayConfig() callback');
	    this._displayConfigProxy = proxy;
	    this._on_monitors_change();
	}));

	this._monitorsChangedConnection = Main.layoutManager.connect('monitors-changed', this._on_monitors_change.bind(this));
	this._minBrightnessSettingChangedConnection = this._settings.connect('changed::min-brightness', Lang.bind(this, function() { this._on_brightness_change(false); }));
	this._currentBrightnessSettingChangedConnection = this._settings.connect('changed::current-brightness', Lang.bind(this, function() { this._on_brightness_change(false); }));
	this._monitorsSettingChangedConnection = this._settings.connect('changed::monitors', Lang.bind(this, function() { this._on_brightness_change(true); }));
	this._builtinMonitorSettingChangedConnection = this._settings.connect('changed::builtin-monitor', Lang.bind(this, function() { this._on_brightness_change(true); }));
	this._useBacklightSettingChangedConnection = this._settings.connect('changed::use-backlight', this._on_use_backlight_change.bind(this));
	this._preventUnredirectChangedConnection = this._settings.connect('changed::prevent-unredirect', Lang.bind(this, function() { this._on_brightness_change(true); }));

	// If we use the backlight and the Brightness proxy is null, it's still connecting and we'll get a _sync later.
	if (! this._settings.get_boolean('use-backlight') || this._brightnessIndicator._proxy.Brightness != null) {
	    let curBrightness = this._getBrightnessLevel();
	    this._brightnessIndicator._sliderChanged(this._brightnessIndicator._slider, curBrightness);
	    this._brightnessIndicator._slider.setValue(curBrightness);
	}
    },

    _disable() {
	this._logger.log_debug('_disable()');

	let standardIndicator = new imports.ui.status.brightness.Indicator();
	this._swapMenu(this._brightnessIndicator, standardIndicator);
	this._brightnessIndicator = null;

	Main.layoutManager.disconnect(this._monitorsChangedConnection);
	this._settings.disconnect(this._minBrightnessSettingChangedConnection);
	this._settings.disconnect(this._currentBrightnessSettingChangedConnection);
	this._settings.disconnect(this._monitorsSettingChangedConnection);
	this._settings.disconnect(this._builtinMonitorSettingChangedConnection);
	this._settings.disconnect(this._useBacklightSettingChangedConnection);
	this._settings.disconnect(this._preventUnredirectChangedConnection);
	this._hideOverlays(true);
    },

    _preventUnredirect() {
	if (! this._unredirectPrevented) {
	    this._logger.log_debug('_preventUnredirect(): disabling unredirects, prevent-unredirect='+this._settings.get_string('prevent-unredirect'));
	    Meta.disable_unredirect_for_display(global.display);
	    this._unredirectPrevented = true;
	}
    },

    _allowUnredirect() {
	if (this._unredirectPrevented) {
	    this._logger.log_debug('_allowUnredirect(): enabling unredirects, prevent-unredirect='+this._settings.get_string('prevent-unredirect'));
	    Meta.enable_unredirect_for_display(global.display);
	    this._unredirectPrevented = false;
	}
    },

    _hideOverlays(forceUnpreventUnredirect) {
	if (this._overlays != null) {
	    this._logger.log_debug("_hideOverlays(): drop overlays, count="+this._overlays.length);
	    for (let i=0; i < this._overlays.length; ++i) {
		global.stage.remove_actor(this._overlays[i]);
	    }
	    this._overlays = null;
	}
	let preventUnredirect = this._settings.get_string('prevent-unredirect');
	if (forceUnpreventUnredirect) {
	    preventUnredirect = 'never';
	}
	switch(preventUnredirect) {
	case "always":
	    this._preventUnredirect();
	    break;
	case "when-correcting":
	case "never":
	    this._allowUnredirect();
	    break;
	default:
	    this._logger.log('_hideOverlays(): Unexpected prevent-unredirect="'+preventUnredirect+'"');
	    break;
	}
    },

    _showOverlays(opacity, force) {
	this._logger.log_debug('_showOverlays('+opacity+', '+force+')');
	if (this._overlays == null || force) {
	    let enabledMonitors = this._settings.get_string('monitors');
	    let monitors;
	    this._logger.log_debug('_showOverlays(): enabledMonitors="'+enabledMonitors+'"');
	    if (enabledMonitors == "all") {
		monitors = Main.layoutManager.monitors;
	    } else if (enabledMonitors == "built-in" || enabledMonitors == "external") {
		if (this._monitorNames == null) {
		    this._logger.log_debug("_showOverlays(): skipping run as _monitorNames hasn't been set yet.");
		    return;
		}
		let builtinMonitorName = this._settings.get_string('builtin-monitor');
		this._logger.log_debug('_showOverlays(): builtinMonitorName="'+builtinMonitorName+'"');
		if (builtinMonitorName == "" || builtinMonitorName == null) {
		    builtinMonitorName = this._monitorNames[Main.layoutManager.primaryIndex];
		    this._logger.log_debug('_showOverlays(): no builtin monitor, setting to "'+builtinMonitorName+'" and skipping run');
		    this._settings.set_string('builtin-monitor', builtinMonitorName);
		    return;
		}
		monitors = [];
		for (let i=0; i < Main.layoutManager.monitors.length; ++i) {
		    if (    (enabledMonitors == "built-in" && this._monitorNames[i] == builtinMonitorName )
			 || (enabledMonitors == "external" && this._monitorNames[i] != builtinMonitorName ) ) {
			monitors.push(Main.layoutManager.monitors[i]);
		    }
		}
	    } else {
		this._logger.log("_showOverlays(): Unhandled \"monitors\" setting = "+enabledMonitors);
		return;
	    }
	    if (force) {
		this._hideOverlays(false);
	    }
	    let preventUnredirect = this._settings.get_string('prevent-unredirect');
	    switch(preventUnredirect) {
	    case "always":
	    case "when-correcting":
		this._preventUnredirect();
		break;
	    case "never":
		this._allowUnredirect();
		break;
	    default:
		this._logger.log('_showOverlays(): Unexpected prevent-unredirect="'+preventUnredirect+'"');
		break;
	    }

	    this._overlays = [];
	    for (let i=0; i < monitors.length; ++i) {
		let monitor = monitors[i];
		this._logger.log_debug('Create overlay #'+i+': '+monitor.width+'x'+monitor.height+'@'+monitor.x+','+monitor.y);
		let overlay = new St.Label({
		    style_class: 'brightness-overlay',
		    text: "",
		});
		overlay.set_position(monitor.x, monitor.y);
		overlay.set_width(monitor.width);
		overlay.set_height(monitor.height);

		global.stage.add_actor(overlay);
		Shell.util_set_hidden_from_pick(overlay, true);

		this._overlays.push(overlay);
	    }
	}

	for (let i=0; i < this._overlays.length; ++i) {
	    this._logger.log_debug('_showOverlay(): set opacity '+opacity+' on overlay #'+i);
	    this._overlays[i].opacity = opacity;
	}
    },

    _storeBrightnessLevel(value) {
	if (this._settings.get_boolean('use-backlight') && this._brightnessIndicator._proxy.Brightness >= 0) {
	    let convertedBrightness = Math.min(100, Math.round(value * 100.0)+1);
	    this._logger.log_debug('_storeBrightnessLevel('+value+') by proxy -> '+convertedBrightness);
	    this._brightnessIndicator._proxy.Brightness = convertedBrightness;
	} else {
	    this._logger.log_debug('_storeBrightnessLevel('+value+') by setting');
	    this._settings.set_double('current-brightness', value);
	}
    },

    _getBrightnessLevel() {
	let brightness = this._brightnessIndicator._proxy.Brightness;
	if (this._settings.get_boolean('use-backlight') && brightness != brightness >= 0) {
	    let convertedBrightness = brightness / 100.0;
	    this._logger.log_debug('_getBrightnessLevel() by proxy = '+convertedBrightness+' <- '+brightness);
	    return convertedBrightness;
	} else {
	    brightness = this._settings.get_double('current-brightness');
	    this._logger.log_debug('_getBrightnessLevel() by setting = '+brightness);
	    return brightness;
	}
    },

    _on_brightness_change(force) {
	let curBrightness = this._getBrightnessLevel();
	let minBrightness = this._settings.get_double('min-brightness');

	this._logger.log_debug("_on_brightness_change: current-brightness="+curBrightness+", min-brightness="+minBrightness);
	if (curBrightness < minBrightness) {
	    curBrightness = minBrightness;
	    if (! this._settings.get_boolean('use-backlight')) {
		this._brightnessIndicator._slider.setValue(curBrightness);
	    }
	    this._storeBrightnessLevel(minBrightness);
	    return;
	}
	if (curBrightness >= 1) {
	    this._hideOverlays(false);
	} else {
	    let opacity = (1-curBrightness)*255;
	    this._logger.log_debug("_on_brightness_change: opacity="+opacity);
	    this._showOverlays(opacity, force);
	}
    },

    on_debug_change: function() {
	this._logger.set_debug(this._settings.get_boolean('debug'));
	this._logger.log('debug = '+this._logger.get_debug());
    },

    _on_monitors_change() {
	if (this._displayConfigProxy == null) {
	    this._logger.log_debug("_on_monitors_change(): skipping run as the proxy hasn't been set up yet.");
	    return;
	}
	this._logger.log_debug("_on_monitors_change()");
	Utils.getMonitorConfig(this._displayConfigProxy, Lang.bind(this, function(result, error) {
	    if (error) {
		this._logger.log("_on_monitors_change(): cannot get Monitor Config: "+error);
		return;
	    }
	    let monitorNames = [];
	    for (let i=0; i < result.length; ++i) {
		let [monitorName, connectorName] = result[i];
		let monitorIndex = this._monitorManager.get_monitor_for_connector(connectorName);
		this._logger.log_debug('_on_monitors_change(): monitor="'+monitorName+'", connector="'+connectorName+'", index='+monitorIndex);
		if (monitorIndex >= 0) {
		    monitorNames[monitorIndex] = monitorName;
		}
	    }
	    this._monitorNames = monitorNames;
	    this._on_brightness_change(true);
	}));
    },

    _on_use_backlight_change() {
	this._logger.log_debug('_on_use_backlight_change()');
	if (this._settings.get_boolean('use-backlight')) {
	    this._storeBrightnessLevel(this._settings.get_double('current-brightness'));
	} else if (this._brightnessIndicator._proxy.Brightness != null && this._brightnessIndicator._proxy.Brightness >= 0) {
	    this._storeBrightnessLevel(this._brightnessIndicator._proxy.Brightness / 100.0);
	}
    }

});

function init() {
    return new SoftBrightnessExtension();
}
