// Magnetic Field - Magnet-style window snapping for GNOME Shell
//
// Two ways to snap a window:
//  * keyboard shortcuts (see schemas/*.gschema.xml for the defaults)
//  * dragging the window to a screen edge or corner
//
// All geometry is expressed as fractions of the monitor work area so the same
// code serves the shortcuts and the drag zones.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ACTION_NAMES, ZONES} from './actions.js';
import {MagneticFieldIndicator} from './indicator.js';

const PREVIEW_SHOW_MS = 150;
const PREVIEW_HIDE_MS = 100;
const DRAG_POLL_MS = 33;
const SIZE_WAIT_FALLBACK_MS = 500;

const SNAPPABLE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

const MOVE_OPS = [
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
].filter(op => op !== undefined);

// Property notifications that accompany a change of the maximized state
// (Mutter 49+ has a single `maximized` property, older versions two).
const MAXIMIZE_NOTIFY_SIGNALS = ['maximized', 'maximized-horizontally', 'maximized-vertically']
    .filter(name => Meta.Window.find_property(name) !== null)
    .map(name => `notify::${name}`);

// Mutter 49 dropped the horizontal/vertical maximize flags. Older versions
// still expose get_maximized() and expect the flags argument.
function isMaximized(window) {
    if (window.get_maximized)
        return window.get_maximized() !== 0;
    return window.is_maximized();
}

function maximize(window) {
    if (window.get_maximized)
        window.maximize(Meta.MaximizeFlags.BOTH);
    else
        window.maximize();
}

function unmaximize(window) {
    if (window.get_maximized)
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    else
        window.unmaximize();
}

export default class MagneticFieldExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        // window id -> {window, rect, maximized, zone, unmanagedId}
        this._originals = new Map();
        this._pendingWaits = new Map();

        this._preview = null;
        this._dragWindow = null;
        this._dragZone = null;
        this._dragMonitor = -1;
        this._pollId = 0;

        this._addKeybindings();

        this._grabBeginId = global.display.connect('grab-op-begin',
            (display, window, op) => this._onGrabBegin(window, op));
        this._grabEndId = global.display.connect('grab-op-end',
            (display, window, op) => this._onGrabEnd(window, op));

        this._dragSettingId = this._settings.connect('changed::drag-snapping',
            () => this._syncEdgeTiling());
        this._syncEdgeTiling();

        this._indicator = null;
        this._indicatorSettingId = this._settings.connect('changed::show-indicator',
            () => this._syncIndicator());
        this._syncIndicator();
    }

    disable() {
        this._removeKeybindings();

        global.display.disconnect(this._grabBeginId);
        global.display.disconnect(this._grabEndId);
        this._grabBeginId = 0;
        this._grabEndId = 0;

        this._settings.disconnect(this._dragSettingId);
        this._dragSettingId = 0;

        this._settings.disconnect(this._indicatorSettingId);
        this._indicatorSettingId = 0;
        this._indicator?.destroy();
        this._indicator = null;

        this._stopDrag();
        this._destroyPreview();

        for (const [window, wait] of this._pendingWaits)
            this._cancelWait(window, wait);
        this._pendingWaits.clear();

        for (const entry of this._originals.values())
            entry.window.disconnect(entry.unmanagedId);
        this._originals.clear();

        this._restoreEdgeTiling();

        this._originals = null;
        this._pendingWaits = null;
        this._mutterSettings = null;
        this._settings = null;
    }

    // ---------------------------------------------------------------- keys

    _addKeybindings() {
        this._keybindings = [...ACTION_NAMES];
        for (const name of this._keybindings) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                () => this._onAction(name));
        }
    }

    _removeKeybindings() {
        for (const name of this._keybindings ?? [])
            Main.wm.removeKeybinding(name);
        this._keybindings = null;
    }

    // Whether action `name` can be applied to `window` right now.
    canPerform(name, window) {
        if (!window || !this._isSnappable(window))
            return false;

        if (name in ZONES)
            return window.resizeable;

        switch (name) {
        case 'restore-window':
            return this._originals.has(window.get_id());
        case 'move-to-next-display':
        case 'move-to-previous-display':
            return window.allows_move() && global.display.get_n_monitors() > 1;
        default:
            return window.allows_move();
        }
    }

    // Shortcuts act on the focused window, the panel menu passes the window
    // that was focused when the menu opened.
    _onAction(name, window = global.display.focus_window) {
        if (!this.canPerform(name, window))
            return;

        if (name in ZONES) {
            this._applyZone(window, name, window.get_monitor());
            return;
        }

        switch (name) {
        case 'center-window':
            this._centerWindow(window);
            break;
        case 'restore-window':
            this._restoreWindow(window);
            break;
        case 'move-to-next-display':
            this._moveToDisplay(window, +1);
            break;
        case 'move-to-previous-display':
            this._moveToDisplay(window, -1);
            break;
        }
    }

    // ------------------------------------------------------------ actions

    // Note: allows_resize() is false while a window is maximized or
    // fullscreen, so callers check the `resizeable` property instead.
    _isSnappable(window) {
        return SNAPPABLE_TYPES.includes(window.get_window_type()) &&
            !window.is_override_redirect();
    }

    _applyZone(window, zoneName, monitorIndex) {
        const gap = this._settings.get_int('window-gap');
        const entry = this._rememberOriginal(window);
        entry.zone = zoneName;

        if (window.is_fullscreen())
            window.unmake_fullscreen();

        if (zoneName === 'snap-maximize' && gap === 0) {
            if (window.get_monitor() !== monitorIndex)
                window.move_to_monitor(monitorIndex);
            maximize(window);
            return;
        }

        this._moveResize(window, this._zoneRect(zoneName, monitorIndex));
    }

    _moveResize(window, rect) {
        const request = () => {
            window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
            // A client may refuse the size (minimum size hints). Mutter then
            // keeps the old position too, so put the window where it belongs
            // once the client has answered.
            this._whenReady(window, null, () => {
                const frame = window.get_frame_rect();
                if (frame.x !== rect.x || frame.y !== rect.y)
                    window.move_frame(true, rect.x, rect.y);
            });
        };

        if (isMaximized(window)) {
            // On Wayland the window stays maximized until the client has
            // acknowledged the change, and a resize issued before that is
            // constrained back to the maximized size. Wait for the ack.
            unmaximize(window);
            this._whenReady(window, () => !isMaximized(window), request);
        } else {
            request();
        }
    }

    _centerWindow(window) {
        if (!window.allows_move())
            return;

        const entry = this._rememberOriginal(window);
        entry.zone = null;

        if (window.is_fullscreen())
            window.unmake_fullscreen();

        const place = () => {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
            const frame = window.get_frame_rect();
            const x = workArea.x + Math.round((workArea.width - frame.width) / 2);
            const y = workArea.y + Math.round((workArea.height - frame.height) / 2);
            window.move_frame(true, x, y);
        };

        if (isMaximized(window)) {
            unmaximize(window);
            // The frame rect only shrinks once the client has acknowledged
            // the new size, so wait for it before measuring.
            this._whenReady(window, () => !isMaximized(window), place);
        } else {
            place();
        }
    }

    _restoreWindow(window) {
        const entry = this._originals.get(window.get_id());
        if (!entry)
            return;
        this._forget(window);

        if (window.is_fullscreen())
            window.unmake_fullscreen();

        if (entry.maximized) {
            maximize(window);
            return;
        }

        this._moveResize(window, entry.rect);
    }

    _moveToDisplay(window, delta) {
        if (!window.allows_move())
            return;

        const count = global.display.get_n_monitors();
        if (count < 2)
            return;

        const target = (window.get_monitor() + delta + count) % count;
        const entry = this._originals.get(window.get_id());

        window.move_to_monitor(target);

        // Keep the window in the same zone on the new display, like Magnet.
        if (entry?.zone && window.resizeable)
            this._applyZone(window, entry.zone, target);
    }

    // ----------------------------------------------------------- geometry

    _zoneRect(zoneName, monitorIndex) {
        const zone = ZONES[zoneName];
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const gap = this._settings.get_int('window-gap');

        // Outer gap towards the screen edges, half a gap on inner edges so two
        // neighbouring tiles end up exactly one gap apart.
        const innerX = workArea.x + gap;
        const innerY = workArea.y + gap;
        const innerW = workArea.width - 2 * gap;
        const innerH = workArea.height - 2 * gap;

        const EPS = 0.001;
        const left = innerX + zone.x * innerW + (zone.x > EPS ? gap / 2 : 0);
        const right = innerX + (zone.x + zone.w) * innerW - (zone.x + zone.w < 1 - EPS ? gap / 2 : 0);
        const top = innerY + zone.y * innerH + (zone.y > EPS ? gap / 2 : 0);
        const bottom = innerY + (zone.y + zone.h) * innerH - (zone.y + zone.h < 1 - EPS ? gap / 2 : 0);

        const x = Math.round(left);
        const y = Math.round(top);
        return {
            x,
            y,
            width: Math.round(right) - x,
            height: Math.round(bottom) - y,
        };
    }

    // Which zone (if any) the pointer at (x, y) activates.
    _zoneAtPointer(x, y) {
        const monitors = Main.layoutManager.monitors;
        const monitorIndex = monitors.findIndex(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        if (monitorIndex < 0)
            return null;

        const wa = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const threshold = this._settings.get_int('edge-threshold');
        const corner = this._settings.get_int('corner-size');

        const nearLeft = x < wa.x + threshold;
        const nearRight = x >= wa.x + wa.width - threshold;
        const nearTop = y < wa.y + threshold;
        const nearBottom = y >= wa.y + wa.height - threshold;

        const inTopCorner = y < wa.y + corner;
        const inBottomCorner = y >= wa.y + wa.height - corner;
        const inLeftCorner = x < wa.x + corner;
        const inRightCorner = x >= wa.x + wa.width - corner;

        let zone = null;
        if (nearLeft) {
            if (inTopCorner)
                zone = 'snap-top-left-quarter';
            else if (inBottomCorner)
                zone = 'snap-bottom-left-quarter';
            else
                zone = 'snap-left-half';
        } else if (nearRight) {
            if (inTopCorner)
                zone = 'snap-top-right-quarter';
            else if (inBottomCorner)
                zone = 'snap-bottom-right-quarter';
            else
                zone = 'snap-right-half';
        } else if (nearTop) {
            if (inLeftCorner)
                zone = 'snap-top-left-quarter';
            else if (inRightCorner)
                zone = 'snap-top-right-quarter';
            else
                zone = 'snap-maximize';
        } else if (nearBottom) {
            if (inLeftCorner) {
                zone = 'snap-bottom-left-quarter';
            } else if (inRightCorner) {
                zone = 'snap-bottom-right-quarter';
            } else {
                const fraction = (x - wa.x) / wa.width;
                if (fraction < 1 / 3)
                    zone = 'snap-left-third';
                else if (fraction < 2 / 3)
                    zone = 'snap-center-third';
                else
                    zone = 'snap-right-third';
            }
        }

        return zone ? {zone, monitorIndex} : null;
    }

    // --------------------------------------------------------------- drag

    _onGrabBegin(window, op) {
        if (!this._settings.get_boolean('drag-snapping'))
            return;
        if (!window || !MOVE_OPS.includes(op))
            return;
        if (!this._isSnappable(window) || !window.resizeable)
            return;

        this._stopDrag();
        this._dragWindow = window;
        this._dragZone = null;
        this._dragMonitor = -1;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_POLL_MS, () => {
            this._updateDrag();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateDrag() {
        const [x, y] = global.get_pointer();
        const hit = this._zoneAtPointer(x, y);

        if (!hit) {
            if (this._dragZone) {
                this._dragZone = null;
                this._dragMonitor = -1;
                this._hidePreview();
            }
            return;
        }

        if (hit.zone === this._dragZone && hit.monitorIndex === this._dragMonitor)
            return;

        this._dragZone = hit.zone;
        this._dragMonitor = hit.monitorIndex;
        if (this._settings.get_boolean('show-preview'))
            this._showPreview(this._zoneRect(hit.zone, hit.monitorIndex));
    }

    _onGrabEnd(window, _op) {
        const dragWindow = this._dragWindow;
        const zone = this._dragZone;
        const monitorIndex = this._dragMonitor;
        this._stopDrag();

        if (!window)
            return;

        if (window === dragWindow && zone) {
            this._applyZone(window, zone, monitorIndex);
        } else {
            // The user moved or resized the window by hand; the remembered
            // geometry no longer describes anything worth restoring.
            this._forget(window);
        }
    }

    _stopDrag() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._dragWindow = null;
        this._dragZone = null;
        this._dragMonitor = -1;
        this._hidePreview();
    }

    // ------------------------------------------------------------ preview

    _showPreview(rect) {
        if (!this._preview) {
            this._preview = new St.Widget({
                style_class: 'magnetic-field-preview',
                opacity: 0,
                reactive: false,
            });
            global.window_group.add_child(this._preview);
        }

        // Keep the preview right below the window being dragged.
        const actor = this._dragWindow?.get_compositor_private();
        if (actor && actor.get_parent() === global.window_group)
            global.window_group.set_child_below_sibling(this._preview, actor);

        this._preview.remove_all_transitions();
        if (!this._preview.visible || this._preview.opacity === 0) {
            this._preview.set_position(rect.x, rect.y);
            this._preview.set_size(rect.width, rect.height);
        }
        this._preview.show();
        this._preview.ease({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            opacity: 255,
            duration: PREVIEW_SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hidePreview() {
        if (!this._preview || !this._preview.visible)
            return;
        this._preview.remove_all_transitions();
        this._preview.ease({
            opacity: 0,
            duration: PREVIEW_HIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._preview?.hide(),
        });
    }

    _destroyPreview() {
        this._preview?.destroy();
        this._preview = null;
    }

    // ------------------------------------------------------ bookkeeping

    _rememberOriginal(window) {
        const id = window.get_id();
        let entry = this._originals.get(id);
        if (entry)
            return entry;

        entry = {
            window,
            rect: window.get_frame_rect(),
            maximized: isMaximized(window),
            zone: null,
            unmanagedId: window.connect('unmanaged', () => this._forget(window)),
        };
        this._originals.set(id, entry);
        return entry;
    }

    _forget(window) {
        const entry = this._originals?.get(window.get_id());
        if (!entry)
            return;
        window.disconnect(entry.unmanagedId);
        this._originals.delete(window.get_id());
    }

    // Run callback as soon as `ready()` holds, re-checking on each of the
    // window's geometry notifications, or after a fallback timeout if the
    // client never answers. With `ready` null the callback runs on the next
    // notification. Only one wait per window: a new one replaces the old.
    _whenReady(window, ready, callback) {
        const existing = this._pendingWaits.get(window);
        if (existing)
            this._cancelWait(window, existing);

        if (ready?.()) {
            callback();
            return;
        }

        const wait = {signalIds: [], timeoutId: 0};
        const finish = () => {
            this._cancelWait(window, wait);
            // A window that went away in the meantime has no actor any more.
            if (window.get_compositor_private())
                callback();
        };
        const check = () => {
            if (!ready || ready())
                finish();
        };

        for (const name of ['size-changed', 'position-changed', ...MAXIMIZE_NOTIFY_SIGNALS])
            wait.signalIds.push(window.connect(name, check));
        wait.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SIZE_WAIT_FALLBACK_MS, () => {
            wait.timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingWaits.set(window, wait);
    }

    _cancelWait(window, wait) {
        for (const id of wait.signalIds)
            window.disconnect(id);
        wait.signalIds = [];
        if (wait.timeoutId) {
            GLib.source_remove(wait.timeoutId);
            wait.timeoutId = 0;
        }
        if (this._pendingWaits?.get(window) === wait)
            this._pendingWaits.delete(window);
    }

    // ---------------------------------------------------------- indicator

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new MagneticFieldIndicator(this, this._settings);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ------------------------------------------------------- edge tiling

    // Mutter's own drag-to-edge tiling would fight with ours, so it is
    // switched off while drag snapping is on. The previous value is kept in
    // our own settings so it survives a Shell crash and is restored later.
    _syncEdgeTiling() {
        if (this._settings.get_boolean('drag-snapping'))
            this._overrideEdgeTiling();
        else
            this._restoreEdgeTiling();
    }

    _overrideEdgeTiling() {
        if (this._settings.get_boolean('edge-tiling-overridden'))
            return;
        this._settings.set_boolean('edge-tiling-previous',
            this._mutterSettings.get_boolean('edge-tiling'));
        this._settings.set_boolean('edge-tiling-overridden', true);
        this._mutterSettings.set_boolean('edge-tiling', false);
    }

    _restoreEdgeTiling() {
        if (!this._settings.get_boolean('edge-tiling-overridden'))
            return;
        this._mutterSettings.set_boolean('edge-tiling',
            this._settings.get_boolean('edge-tiling-previous'));
        this._settings.set_boolean('edge-tiling-overridden', false);
    }
}
