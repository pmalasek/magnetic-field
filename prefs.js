// Preferences window for Magnetic Field.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ACTION_GROUPS} from './actions.js';

// Keys that make no sense as a bare shortcut (they are needed for navigation).
const FORBIDDEN_KEYVALS = [
    Gdk.KEY_Home, Gdk.KEY_Left, Gdk.KEY_Up, Gdk.KEY_Right, Gdk.KEY_Down,
    Gdk.KEY_Page_Up, Gdk.KEY_Page_Down, Gdk.KEY_End, Gdk.KEY_Tab,
    Gdk.KEY_KP_Enter, Gdk.KEY_Return, Gdk.KEY_Mode_switch,
];

function isValidBinding(mask, keyval) {
    if (!Gtk.accelerator_valid(keyval, mask))
        return false;

    // Without a real modifier (or with only Shift) refuse plain characters and
    // navigation keys, otherwise typing would trigger window snapping.
    if (mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK) {
        if (Gdk.keyval_to_unicode(keyval) !== 0)
            return false;
        if (FORBIDDEN_KEYVALS.includes(keyval))
            return false;
    }
    return true;
}

const ShortcutDialog = GObject.registerClass({
    Signals: {'shortcut-chosen': {param_types: [GObject.TYPE_STRING]}},
}, class ShortcutDialog extends Adw.Window {
    _init(parent, title) {
        super._init({
            title,
            modal: true,
            transient_for: parent,
            default_width: 420,
            default_height: 260,
            resizable: false,
        });

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar({show_title: false}));

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            margin_top: 12,
            margin_bottom: 36,
            margin_start: 24,
            margin_end: 24,
        });
        box.append(new Gtk.Image({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            pixel_size: 48,
        }));
        box.append(new Gtk.Label({
            label: title,
            css_classes: ['title-2'],
        }));
        box.append(new Gtk.Label({
            label: _('Press the new shortcut'),
        }));
        box.append(new Gtk.Label({
            label: _('Esc cancels, Backspace disables the shortcut'),
            css_classes: ['dim-label'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
        }));
        toolbar.set_content(box);
        this.set_content(toolbar);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed',
            (c, keyval, keycode, state) => this._onKeyPressed(keyval, keycode, state));
        this.add_controller(controller);
    }

    _onKeyPressed(keyval, keycode, state) {
        let mask = state & Gtk.accelerator_get_default_mod_mask();
        mask &= ~Gdk.ModifierType.LOCK_MASK;

        if (mask === 0) {
            if (keyval === Gdk.KEY_Escape) {
                this.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                this.emit('shortcut-chosen', '');
                this.close();
                return Gdk.EVENT_STOP;
            }
        }

        if (!isValidBinding(mask, keyval))
            return Gdk.EVENT_STOP;

        const accelerator = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
        this.emit('shortcut-chosen', accelerator);
        this.close();
        return Gdk.EVENT_STOP;
    }
});

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title) {
        super._init({title, activatable: true});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);
        this.add_suffix(new Gtk.Image({
            icon_name: 'document-edit-symbolic',
            css_classes: ['dim-label'],
        }));

        this._changedId = settings.connect(`changed::${key}`, () => this._sync());
        this._sync();

        this.connect('activated', () => this._edit());
        this.connect('unrealize', () => {
            if (this._changedId) {
                this._settings.disconnect(this._changedId);
                this._changedId = 0;
            }
        });
    }

    _sync() {
        const [binding] = this._settings.get_strv(this._key);
        this._label.accelerator = binding ?? '';
    }

    _edit() {
        const dialog = new ShortcutDialog(this.get_root(), this.title);
        dialog.connect('shortcut-chosen', (d, accelerator) => {
            this._settings.set_strv(this._key, accelerator ? [accelerator] : []);
        });
        dialog.present();
    }
});

export default class MagneticFieldPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(this._buildGeneralPage(settings));
        window.add(this._buildShortcutsPage(settings));
    }

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const topBar = new Adw.PreferencesGroup({title: _('Top bar')});
        const indicator = new Adw.SwitchRow({
            title: _('Show icon in the top bar'),
            subtitle: _('A menu with all actions, their shortcuts and a short help'),
        });
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        topBar.add(indicator);
        page.add(topBar);

        const layout = new Adw.PreferencesGroup({title: _('Layout')});
        const gap = new Adw.SpinRow({
            title: _('Window gap'),
            subtitle: _('Space in pixels between snapped windows and the screen edges'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 64, step_increment: 1, page_increment: 8}),
        });
        settings.bind('window-gap', gap, 'value', Gio.SettingsBindFlags.DEFAULT);
        layout.add(gap);
        page.add(layout);

        const drag = new Adw.PreferencesGroup({
            title: _('Drag to snap'),
            description: _('Drag a window to a screen edge or corner to snap it there. ' +
                'The built-in edge tiling of GNOME is switched off while this is enabled.'),
        });

        const enabled = new Adw.SwitchRow({
            title: _('Snap windows by dragging'),
        });
        settings.bind('drag-snapping', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        drag.add(enabled);

        const preview = new Adw.SwitchRow({
            title: _('Show preview'),
            subtitle: _('Highlight the target area while dragging'),
        });
        settings.bind('show-preview', preview, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('drag-snapping', preview, 'sensitive', Gio.SettingsBindFlags.GET);
        drag.add(preview);

        const threshold = new Adw.SpinRow({
            title: _('Edge threshold'),
            subtitle: _('How close to the edge the pointer has to be, in pixels'),
            adjustment: new Gtk.Adjustment({lower: 4, upper: 100, step_increment: 1, page_increment: 10}),
        });
        settings.bind('edge-threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('drag-snapping', threshold, 'sensitive', Gio.SettingsBindFlags.GET);
        drag.add(threshold);

        const corner = new Adw.SpinRow({
            title: _('Corner size'),
            subtitle: _('Length of the corner zones along each edge, in pixels'),
            adjustment: new Gtk.Adjustment({lower: 20, upper: 600, step_increment: 10, page_increment: 50}),
        });
        settings.bind('corner-size', corner, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('drag-snapping', corner, 'sensitive', Gio.SettingsBindFlags.GET);
        drag.add(corner);

        page.add(drag);
        return page;
    }

    _buildShortcutsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            icon_name: 'input-keyboard-symbolic',
        });

        ACTION_GROUPS.forEach((groupDef, index) => {
            const group = new Adw.PreferencesGroup({title: _(groupDef.title)});

            if (index === 0) {
                const reset = new Gtk.Button({
                    label: _('Reset all'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: _('Restore the default shortcuts'),
                });
                reset.connect('clicked', () => {
                    for (const def of ACTION_GROUPS) {
                        for (const [key] of def.actions)
                            settings.reset(key);
                    }
                });
                group.set_header_suffix(reset);
            }

            for (const [key, title] of groupDef.actions)
                group.add(new ShortcutRow(settings, key, _(title)));

            page.add(group);
        });

        return page;
    }
}
