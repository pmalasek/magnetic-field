// Help dialog opened from the top bar menu: a map of the drag zones and a
// short explanation of the menu and the shortcuts.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// Diagram size and zone proportions in logical pixels. The zones are drawn
// wider than the real defaults so they can hold a label.
const MAP_WIDTH = 400;
const MAP_HEIGHT = 250;
const MAP_BAND = 36;
const MAP_CORNER = 84;

// Same colour as the drag preview in stylesheet.css.
const ACCENT = [53 / 255, 132 / 255, 228 / 255];

function zoneShapes() {
    const W = MAP_WIDTH, H = MAP_HEIGHT, b = MAP_BAND, c = MAP_CORNER;
    const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return [
        // corners are L-shaped: they run `c` along both edges
        {points: [[0, 0], [c, 0], [c, b], [b, b], [b, c], [0, c]], corner: true},
        {points: [[W, 0], [W - c, 0], [W - c, b], [W - b, b], [W - b, c], [W, c]], corner: true},
        {points: [[0, H], [c, H], [c, H - b], [b, H - b], [b, H - c], [0, H - c]], corner: true},
        {points: [[W, H], [W - c, H], [W - c, H - b], [W - b, H - b], [W - b, H - c], [W, H - c]], corner: true},
        {points: rect(c, 0, W - 2 * c, b)},
        {points: rect(0, c, b, H - 2 * c)},
        {points: rect(W - b, c, b, H - 2 * c)},
        {points: rect(c, H - b, W / 3 - c, b)},
        {points: rect(W / 3, H - b, W / 3, b)},
        {points: rect(2 * W / 3, H - b, W / 3 - c, b)},
    ];
}

function zoneLabels() {
    const W = MAP_WIDTH, H = MAP_HEIGHT, b = MAP_BAND, c = MAP_CORNER;
    const quarter = '¼';
    const half = '½';
    const third = '⅓';
    return [
        [quarter, 0, 0, b, b],
        [quarter, W - b, 0, b, b],
        [quarter, 0, H - b, b, b],
        [quarter, W - b, H - b, b, b],
        [_('Maximize'), c, 0, W - 2 * c, b],
        [half, 0, c, b, H - 2 * c],
        [half, W - b, c, b, H - 2 * c],
        [third, c, H - b, W / 3 - c, b],
        [third, W / 3, H - b, W / 3, b],
        [third, 2 * W / 3, H - b, W / 3 - c, b],
    ];
}

const ZoneMap = GObject.registerClass(
class ZoneMap extends St.Widget {
    _init() {
        super._init({
            style_class: 'magnetic-field-zone-map',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.set_size(MAP_WIDTH * scale, MAP_HEIGHT * scale);

        this._canvas = new St.DrawingArea({
            width: MAP_WIDTH * scale,
            height: MAP_HEIGHT * scale,
        });
        this._canvas.connect('repaint', area => this._repaint(area));
        this.add_child(this._canvas);

        for (const [text, x, y, w, h] of zoneLabels())
            this._addLabel(text, x, y, w, h, scale);

        const b = MAP_BAND + 12;
        this._addLabel(_('Drag a window by its title bar into one of the zones ' +
            'and release it there.'),
        b, b, MAP_WIDTH - 2 * b, MAP_HEIGHT - 2 * b, scale, 'magnetic-field-zone-map-hint');
    }

    _addLabel(text, x, y, w, h, scale, styleClass = 'magnetic-field-zone-map-label') {
        const label = new St.Label({
            text,
            style_class: styleClass,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;

        const bin = new St.Bin({
            child: label,
            x: Math.round(x * scale),
            y: Math.round(y * scale),
            width: Math.round(w * scale),
            height: Math.round(h * scale),
        });
        this.add_child(bin);
    }

    _repaint(area) {
        const cr = area.get_context();
        const [width] = area.get_surface_size();
        const k = width / MAP_WIDTH;
        const [r, g, b] = ACCENT;

        // the screen
        const fg = area.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.08);
        cr.rectangle(0, 0, MAP_WIDTH * k, MAP_HEIGHT * k);
        cr.fill();

        cr.setLineWidth(1);
        for (const shape of zoneShapes()) {
            const [first, ...rest] = shape.points;
            cr.moveTo(first[0] * k, first[1] * k);
            for (const [x, y] of rest)
                cr.lineTo(x * k, y * k);
            cr.closePath();

            cr.setSourceRGBA(r, g, b, shape.corner ? 0.45 : 0.25);
            cr.fillPreserve();
            cr.setSourceRGBA(r, g, b, 0.9);
            cr.stroke();
        }

        cr.$dispose();
    }
});

export const HelpDialog = GObject.registerClass(
class HelpDialog extends ModalDialog.ModalDialog {
    _init(openPreferences) {
        super._init({styleClass: 'magnetic-field-help-dialog'});

        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Magnetic Field'),
            description: _('Snap windows into halves, quarters and thirds of the ' +
                'screen with keyboard shortcuts, from the top bar menu, or by ' +
                'dragging them to a screen edge or corner.'),
        }));

        this.contentLayout.add_child(this._heading(_('Drag to snap')));
        this.contentLayout.add_child(new ZoneMap());

        this.contentLayout.add_child(this._heading(_('Menu and shortcuts')));
        this.contentLayout.add_child(this._paragraph(
            _('The top bar menu lists every action with its shortcut. A menu ' +
            'item moves the window that was focused when the menu was opened, ' +
            'a shortcut moves the focused window.')));
        this.contentLayout.add_child(this._paragraph(
            _('Restore puts a window back to the size and position it had ' +
            'before it was first snapped. Shortcuts, the gap between windows ' +
            'and the size of the drag zones can be changed in Settings.')));

        this.contentLayout.add_child(this._heading(_('Layouts')));
        this.contentLayout.add_child(this._paragraph(
            _('Arrange windows tiles the windows of the workspace: the focused ' +
            'window gets the left column, the others are stacked next to it. ' +
            'Tiled windows share their edges, so dragging one edge resizes the ' +
            'neighbours too. Drag a window onto another one, or press ' +
            'Super+Ctrl+Shift+arrow, to swap them. Snapping a window to a zone ' +
            'or maximizing it takes it out of the tiling.')));
        this.contentLayout.add_child(this._paragraph(
            _('Save layout stores the apps and their proportions under a name, ' +
            'tiling windows placed by hand where they are. Picking the layout ' +
            'under Saved layouts tiles the windows again and launches the apps ' +
            'that are not running.')));

        this.addButton({
            label: _('Settings'),
            action: () => {
                this.close();
                openPreferences();
            },
        });
        this.addButton({
            label: _('Close'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
            default: true,
        });
    }

    _heading(text) {
        return new St.Label({text, style_class: 'magnetic-field-help-heading'});
    }

    _paragraph(text) {
        const label = new St.Label({text, style_class: 'magnetic-field-help-text'});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;
        return label;
    }
});
