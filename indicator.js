// Top bar icon with a menu of every action, its shortcut and a short help.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ACTION_GROUPS, ZONES} from './actions.js';

// Actions without a zone get a stock icon or a drawn glyph of their own.
const ACTION_ICONS = {
    'restore-window': 'edit-undo-symbolic',
    'move-to-next-display': 'go-next-symbolic',
    'move-to-previous-display': 'go-previous-symbolic',
};
const CENTER_GLYPH = {x: 1 / 4, y: 1 / 4, w: 1 / 2, h: 1 / 2};

const MODIFIER_LABELS = {
    super: 'Super',
    primary: 'Ctrl',
    control: 'Ctrl',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
    hyper: 'Hyper',
};
const MODIFIER_ORDER = ['Super', 'Hyper', 'Meta', 'Ctrl', 'Alt', 'Shift'];

const KEY_LABELS = {
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Return: 'Enter',
    KP_Enter: 'Enter',
    BackSpace: 'Backspace',
    Delete: 'Del',
    Escape: 'Esc',
    space: 'Space',
    Page_Up: 'PgUp',
    Page_Down: 'PgDn',
};

// '<Super><Control>Left' -> 'Super+Ctrl+←'
export function formatAccelerator(accelerator) {
    if (!accelerator)
        return '';

    const modifiers = new Set();
    let rest = accelerator;
    let match;
    while ((match = rest.match(/^<([^>]+)>/))) {
        const name = match[1].toLowerCase();
        modifiers.add(MODIFIER_LABELS[name] ?? match[1]);
        rest = rest.slice(match[0].length);
    }

    const key = KEY_LABELS[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest);
    const ordered = [...modifiers].sort((a, b) =>
        (MODIFIER_ORDER.indexOf(a) + 1 || 99) - (MODIFIER_ORDER.indexOf(b) + 1 || 99));
    return [...ordered, key].join('+');
}

// A miniature screen with the target area filled in, drawn in the text color
// so it follows the theme and the insensitive state.
const ZoneGlyph = GObject.registerClass(
class ZoneGlyph extends St.DrawingArea {
    _init(zone) {
        super._init({
            style_class: 'magnetic-field-zone-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._zone = zone;
        this.connect('style-changed', () => this.queue_repaint());
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);

        // Screen outline: a 1px line on half pixels so it stays crisp.
        const screenH = Math.round(width * 0.75);
        const top = Math.round((height - screenH) / 2);
        cr.setLineWidth(1);
        cr.rectangle(0.5, top + 0.5, width - 1, screenH - 1);
        cr.stroke();

        // Target area, inset by one pixel of padding inside the outline.
        const inner = {x: 2, y: top + 2, w: width - 4, h: screenH - 4};
        const z = this._zone;
        const x0 = Math.round(inner.x + z.x * inner.w);
        const y0 = Math.round(inner.y + z.y * inner.h);
        const x1 = Math.round(inner.x + (z.x + z.w) * inner.w);
        const y1 = Math.round(inner.y + (z.y + z.h) * inner.h);
        cr.rectangle(x0, y0, x1 - x0, y1 - y0);
        cr.fill();

        cr.$dispose();
    }
});

const ActionMenuItem = GObject.registerClass(
class ActionMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(name, title) {
        super._init();
        this.name = name;

        const zone = name === 'center-window' ? CENTER_GLYPH : ZONES[name];
        if (zone) {
            this.add_child(new ZoneGlyph(zone));
        } else {
            this.add_child(new St.Icon({
                icon_name: ACTION_ICONS[name],
                style_class: 'popup-menu-icon',
            }));
        }

        this.label = new St.Label({
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;

        this._shortcut = new St.Label({
            style_class: 'magnetic-field-shortcut',
            y_align: Clutter.ActorAlign.CENTER,
            // dimmed like secondary text, and dimmed further when insensitive
            opacity: 160,
        });
        this.add_child(this._shortcut);
    }

    set shortcut(text) {
        this._shortcut.text = text;
        this._shortcut.visible = text !== '';
    }

    get shortcut() {
        return this._shortcut.text;
    }
});

export const MagneticFieldIndicator = GObject.registerClass(
class MagneticFieldIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, _('Magnetic Field'));
        this._extension = extension;
        this._settings = settings;
        this._targetWindow = null;

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/magnetic-field-symbolic.svg`),
            style_class: 'system-status-icon',
        }));

        this._items = new Map();
        this._displaySection = null;
        for (const group of ACTION_GROUPS) {
            const section = new PopupMenu.PopupMenuSection();
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_(group.title)));
            for (const [name, title] of group.actions) {
                const item = new ActionMenuItem(name, _(title));
                item.connect('activate', () => this._activate(name));
                section.addMenuItem(item);
                this._items.set(name, item);
            }
            if (group.actions.some(([name]) => name.startsWith('move-to-')))
                this._displaySection = section;
            this.menu.addMenuItem(section);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._dragSwitch = new PopupMenu.PopupSwitchMenuItem(_('Drag to snap'),
            this._settings.get_boolean('drag-snapping'));
        this._dragSwitch.connect('toggled',
            (item, state) => this._settings.set_boolean('drag-snapping', state));
        this.menu.addMenuItem(this._dragSwitch);

        this.menu.addMenuItem(this._buildHelp());

        this.menu.addAction(_('Settings'), () => this._extension.openPreferences());

        // Runs before the menu grabs the keyboard, so the focused window is
        // still the one the user was working with.
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._sync();
            else
                this._targetWindow = null;
        });
    }

    _buildHelp() {
        const help = new PopupMenu.PopupSubMenuMenuItem(_('Help'), true);
        help.icon.icon_name = 'help-about-symbolic';

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            style_class: 'magnetic-field-help',
            x_expand: true,
        });
        // GNOME 48 replaced `vertical` with `orientation`.
        if ('orientation' in box)
            box.orientation = Clutter.Orientation.VERTICAL;
        else
            box.vertical = true;

        const paragraph = (text, styleClass = null) => {
            const label = new St.Label({text, style_class: styleClass});
            label.clutter_text.line_wrap = true;
            box.add_child(label);
        };
        paragraph(_('Pick an action above to move the window that was focused ' +
            'when you opened this menu. The same actions work on the focused ' +
            'window with the keyboard shortcuts shown next to them.'));
        paragraph(_('Drag a window to the screen edge to snap it:'), 'magnetic-field-help-heading');
        paragraph(_('• left or right edge: half\n' +
            '• corner: quarter\n' +
            '• top edge: maximize\n' +
            '• bottom edge: left, center or right third'));
        paragraph(_('Restore puts the window back to the size and position ' +
            'it had before the first snap.'));
        paragraph(_('Shortcuts, gaps and drag zones can be changed in Settings.'));

        item.add_child(box);
        help.menu.addMenuItem(item);
        return help;
    }

    _sync() {
        const window = global.display.focus_window;
        this._targetWindow = window;

        for (const [name, item] of this._items) {
            const [accelerator] = this._settings.get_strv(name);
            item.shortcut = formatAccelerator(accelerator);
            item.setSensitive(this._extension.canPerform(name, window));
        }

        this._displaySection.actor.visible = global.display.get_n_monitors() > 1;
        this._dragSwitch.setToggleState(this._settings.get_boolean('drag-snapping'));
    }

    _activate(name) {
        const window = this._targetWindow;
        // The window may have gone away while the menu was open.
        if (!window?.get_compositor_private())
            return;
        this._extension._onAction(name, window);
    }
});
