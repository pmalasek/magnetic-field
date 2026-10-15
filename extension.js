// Magnetic Field - Magnet-style window snapping for GNOME Shell
//
// Two ways to snap a window:
//  * keyboard shortcuts (see schemas/*.gschema.xml for the defaults)
//  * dragging the window to a screen edge or corner
//
// On top of that, tiling: Arrange divides a monitor between all windows of
// the workspace, the windows then share their dividers (see tilingManager.js),
// and the arrangement can be saved as a named layout and restored later,
// launching the apps that are not running.
//
// All geometry is expressed as fractions of the monitor work area so the same
// code serves the shortcuts and the drag zones.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ACTION_NAMES, SWAP_DIRECTIONS, WINDOWLESS_ACTIONS, ZONES} from './actions.js';
import {MagneticFieldIndicator} from './indicator.js';
import {LayoutNameDialog} from './layoutDialog.js';
import {
    findLayout, fractionToRect, parseLayouts, rectToFraction, removeLayout,
    serializeLayouts, upsertLayout,
} from './layouts.js';
import {
    cloneTree, columnsTree, leafRects, mapLeaves, removeLeaf, treeFromRects,
} from './tiling.js';
import {TilingManager} from './tilingManager.js';
import {EdgeLinker} from './edgeLinker.js';
import {dropRegion, splitRect} from './edges.js';
import {
    MAXIMIZE_NOTIFY_SIGNALS, SNAPPABLE_TYPES, isMaximized, maximize, unmaximize,
} from './windowUtils.js';

const PREVIEW_SHOW_MS = 150;
const PREVIEW_HIDE_MS = 100;
const DRAG_POLL_MS = 33;
const SIZE_WAIT_FALLBACK_MS = 500;
// How long a restored layout waits for the windows of launched apps.
const RESTORE_TIMEOUT_MS = 30000;

const MOVE_OPS = [
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
].filter(op => op !== undefined);

const RESIZE_OPS = [
    Meta.GrabOp.RESIZING_NW,
    Meta.GrabOp.RESIZING_N,
    Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E,
    Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SE,
    Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
].filter(op => op !== undefined);

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

        this._layoutRestore = null;
        this._layoutDialog = null;
        this._tiling = new TilingManager(this, this._settings);
        this._links = new EdgeLinker(this, this._settings);
        this._dropTarget = null;
        this._dragStartRect = null;
        this._dragStartLinked = false;

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

        // Tiling first, so cancelling a restore does not move windows.
        this._tiling.destroy();
        this._tiling = null;
        this._links.destroy();
        this._links = null;
        this._cancelRestore();
        this._layoutDialog?.destroy();
        this._layoutDialog = null;

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
        if (WINDOWLESS_ACTIONS.has(name)) {
            return name !== 'restore-last-layout' ||
                findLayout(this._loadLayouts(), this._settings.get_string('last-layout')) !== null;
        }

        if (!window || !this._isSnappable(window))
            return false;

        if (name in SWAP_DIRECTIONS)
            return this._tiling.neighbour(window, SWAP_DIRECTIONS[name]) !== null;
        if (name === 'untile-window')
            return this._tiling.isTiled(window);

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

        if (WINDOWLESS_ACTIONS.has(name)) {
            this._onLayoutAction(name);
            return;
        }

        if (name in SWAP_DIRECTIONS) {
            this._tiling.swapInDirection(window, SWAP_DIRECTIONS[name]);
            return;
        }

        // Every other action takes the window out of its tiling group, and
        // its neighbours take its space.
        this._tiling.release(window);
        if (name === 'untile-window')
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
        // A window snapped to a zone shares its edges with the snapped
        // windows next to it (a maximized one has no neighbours).
        entry.linked = zoneName !== 'snap-maximize';

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
        entry.linked = false;

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

    // Pixel rect of a fraction {x, y, w, h} of the monitor's work area,
    // with the window gap applied.
    _fractionRect(frac, monitorIndex) {
        return fractionToRect(frac,
            Main.layoutManager.getWorkAreaForMonitor(monitorIndex),
            this._settings.get_int('window-gap'));
    }

    _zoneRect(zoneName, monitorIndex) {
        return this._fractionRect(ZONES[zoneName], monitorIndex);
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
        if (!window || !this._isSnappable(window))
            return;

        if (RESIZE_OPS.includes(op)) {
            if (!this._tiling.beginResize(window) && this._isLinked(window))
                this._links.beginResize(window, this._linkNeighbours(window));
            return;
        }
        if (!MOVE_OPS.includes(op))
            return;

        // A tiled window can be dragged onto another one to swap them, even
        // with drag snapping off.
        const tiled = this._tiling.isTiled(window);
        if (!tiled && (!this._settings.get_boolean('drag-snapping') || !window.resizeable))
            return;

        this._stopDrag();
        this._dragWindow = window;
        this._dragZone = null;
        this._dragMonitor = -1;
        this._dropTarget = null;
        this._dragStartRect = window.get_frame_rect();
        this._dragStartLinked = this._isLinked(window);
        this._tiling.setDragging(window);
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_POLL_MS, () => {
            this._updateDrag();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateDrag() {
        const [x, y] = global.get_pointer();
        // The zones along the screen edges win over dropping onto a window,
        // which needs the pointer inside another snapped or tiled window.
        const hit = this._settings.get_boolean('drag-snapping') ? this._zoneAtPointer(x, y) : null;

        if (!hit) {
            const target = this._dropTargetAt(x, y);
            if (target) {
                if (this._dropTarget?.window !== target.window ||
                    this._dropTarget.region !== target.region) {
                    this._dragZone = null;
                    this._dragMonitor = -1;
                    this._dropTarget = target;
                    if (this._settings.get_boolean('show-preview'))
                        this._showPreview(target.preview);
                }
                return;
            }
            if (this._dragZone || this._dropTarget) {
                this._dragZone = null;
                this._dragMonitor = -1;
                this._dropTarget = null;
                this._hidePreview();
            }
            return;
        }

        this._dropTarget = null;

        if (hit.zone === this._dragZone && hit.monitorIndex === this._dragMonitor)
            return;

        this._dragZone = hit.zone;
        this._dragMonitor = hit.monitorIndex;
        if (this._settings.get_boolean('show-preview'))
            this._showPreview(this._zoneRect(hit.zone, hit.monitorIndex));
    }

    // Whether a window shares its edges with its snapped neighbours.
    _isLinked(window) {
        return this._originals.get(window.get_id())?.linked === true &&
            !this._tiling.isTiled(window);
    }

    // The other linked windows on the monitor and workspace of `window`.
    _linkNeighbours(window) {
        const workspace = window.get_workspace() ?? global.workspace_manager.get_active_workspace();
        return this._layoutWindows(workspace).filter(w =>
            w !== window && this._isLinked(w) && w.get_monitor() === window.get_monitor() &&
            !isMaximized(w) && !w.is_fullscreen());
    }

    // The window under the pointer the dragged window can be dropped onto:
    // the topmost window there, if it is snapped or tiled. Its region tells
    // what a drop does: an edge splits the window, the center swaps.
    _dropTargetAt(x, y) {
        const workspace = global.workspace_manager.get_active_workspace();
        const actors = global.get_window_actors();
        for (let i = actors.length - 1; i >= 0; i--) {
            const window = actors[i].meta_window;
            if (window === this._dragWindow || !actors[i].visible || window.minimized ||
                !this._isSnappable(window) || window.is_skip_taskbar() ||
                !window.located_on_workspace(workspace))
                continue;
            const frame = window.get_frame_rect();
            if (x < frame.x || x >= frame.x + frame.width || y < frame.y || y >= frame.y + frame.height)
                continue;

            // The topmost window under the pointer decides.
            const tiled = this._tiling.isTiled(window);
            if ((!tiled && !this._isLinked(window)) || isMaximized(window) || window.is_fullscreen())
                return null;
            const rect = tiled ? this._tiling.cellRect(window) : frame;
            const region = dropRegion(rect, x, y);
            const preview = region === 'center'
                ? rect
                : splitRect(rect, region, this._settings.get_int('window-gap')).inserted;
            return {window, region, rect, preview};
        }
        return null;
    }

    // Put a window at `rect` as a snapped window that shares its edges.
    _placeLinked(window, rect, original = undefined) {
        const entry = this._rememberOriginal(window, original);
        entry.zone = null;
        entry.linked = true;
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        this._moveResize(window, rect);
    }

    // `window` was dragged from `startRect` and dropped onto `target`.
    _dropOnWindow(window, target, startRect, startLinked) {
        const other = target.window;
        const targetTiled = this._tiling.isTiled(other);

        if (target.region !== 'center') {
            // An edge: the dragged window takes that half of the target.
            if (targetTiled) {
                this._tiling.insertBeside(other, window, target.region);
                return;
            }
            this._tiling.release(window);
            const halves = splitRect(other.get_frame_rect(), target.region,
                this._settings.get_int('window-gap'));
            this._placeLinked(other, halves.remaining);
            this._placeLinked(window, halves.inserted, startRect);
            return;
        }

        // The center: the two windows swap places.
        const draggedTiled = this._tiling.isTiled(window);
        const otherRect = other.get_frame_rect();
        if (draggedTiled || targetTiled)
            this._tiling.exchange(window, other);
        if (!targetTiled)
            this._placeLinked(window, otherRect, startRect);
        if (!draggedTiled) {
            if (startLinked) {
                this._placeLinked(other, startRect);
            } else {
                // The dragged window was free, so is the one taking its place.
                this._forget(other);
                this._moveResize(other, startRect);
            }
        }
    }

    _onGrabEnd(window, op) {
        const dragWindow = this._dragWindow;
        const zone = this._dragZone;
        const monitorIndex = this._dragMonitor;
        const dropTarget = this._dropTarget;
        const startRect = this._dragStartRect;
        const startLinked = this._dragStartLinked;
        this._stopDrag();
        this._tiling.setDragging(null);

        if (!window)
            return;

        if (this._tiling.resizingWindow === window) {
            this._tiling.endResize();
            return;
        }
        if (this._links.resizingWindow === window) {
            this._links.endResize();
            return;
        }

        if (window === dragWindow && zone) {
            this._tiling.release(window);
            this._applyZone(window, zone, monitorIndex);
            return;
        }

        if (window === dragWindow && dropTarget?.window.get_compositor_private()) {
            this._dropOnWindow(window, dropTarget, startRect, startLinked);
            return;
        }

        const group = this._tiling.groupOf(window);
        if (group) {
            if (RESIZE_OPS.includes(op) || window.get_monitor() !== group.monitor ||
                window.get_workspace() !== group.workspace) {
                // Resized with linked resizing off, or moved to another
                // monitor or workspace: the window is on its own now.
                this._tiling.release(window);
            } else {
                // Dropped somewhere else: back into its cell.
                this._tiling.apply(group, {final: true});
                return;
            }
        }

        // The user moved or resized the window by hand; the remembered
        // geometry no longer describes anything worth restoring.
        this._forget(window);
    }

    _stopDrag() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._dragWindow = null;
        this._dragZone = null;
        this._dragMonitor = -1;
        this._dropTarget = null;
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

    // ------------------------------------------------------------ layouts

    _onLayoutAction(name) {
        switch (name) {
        case 'arrange-windows':
            this._arrangeWindows();
            break;
        case 'save-layout':
            this._openSaveLayoutDialog();
            break;
        case 'restore-last-layout':
            this._restoreLayout(this._settings.get_string('last-layout'));
            break;
        }
    }

    _loadLayouts() {
        return parseLayouts(this._settings.get_string('layouts'));
    }

    _storeLayouts(data) {
        this._settings.set_string('layouts', serializeLayouts(data));
    }

    _getLayouts() {
        return this._loadLayouts().layouts;
    }

    // Top-level windows of `workspace` that belong in a layout, most
    // recently used first (the focused window comes first).
    _layoutWindows(workspace, {includeMinimized = false} = {}) {
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace).filter(w =>
            this._isSnappable(w) &&
            !w.is_skip_taskbar() &&
            !w.get_transient_for() &&
            !w.is_attached_dialog() &&
            (includeMinimized || !w.minimized));
    }

    // {app, wmClass} of a window; app is the desktop id or null when the
    // window does not belong to an installed app.
    _windowKey(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return {
            app: app && !app.is_window_backed() ? app.get_id() : null,
            wmClass: window.get_wm_class() ?? '',
        };
    }

    _entryMatches(entry, key) {
        if (entry.app && key.app)
            return entry.app === key.app;
        return entry.wmClass !== '' && entry.wmClass === key.wmClass;
    }

    // Tile the windows of the active workspace, one group per monitor: the
    // focused window gets the first column, the others follow in the order
    // they have on screen (left to right, then top to bottom).
    _arrangeWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        for (const [monitor, windows] of this._tileableWindows(workspace)) {
            const map = new Map(this._arrangeOrder(windows).map(w => [w.get_id(), w]));
            this._tiling.tile(workspace, monitor, columnsTree([...map.keys()]), map);
        }
    }

    // Map monitor -> windows of the workspace that can be tiled.
    _tileableWindows(workspace) {
        const byMonitor = new Map();
        for (const window of this._layoutWindows(workspace)) {
            if (!window.resizeable || !window.allows_move())
                continue;
            const monitor = window.get_monitor();
            if (!byMonitor.has(monitor))
                byMonitor.set(monitor, []);
            byMonitor.get(monitor).push(window);
        }
        return byMonitor;
    }

    // The focused window first, the others in the order they have on screen.
    _arrangeOrder(windows) {
        const focus = global.display.focus_window;
        const others = windows.filter(w => w !== focus).sort((a, b) => {
            const ra = a.get_frame_rect();
            const rb = b.get_frame_rect();
            return ra.x - rb.x || ra.y - rb.y;
        });
        return windows.includes(focus) ? [focus, ...others] : others;
    }

    // Tile the windows of every monitor that has windows outside a tiling,
    // keeping them where they are: the split tree is worked out from their
    // positions (tiled windows count with their cells). Windows that overlap
    // too much for that are arranged instead.
    _tileFromScreen(workspace) {
        const gap = this._settings.get_int('window-gap');
        for (const [monitor, windows] of this._tileableWindows(workspace)) {
            const group = this._tiling.group(workspace, monitor);
            if (group && windows.every(w => group.windows.get(w.get_id()) === w))
                continue;

            const cells = group ? leafRects(group.tree) : new Map();
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor);
            const items = windows.map(window => {
                const id = window.get_id();
                const rect = group?.windows.get(id) === window
                    ? cells.get(id)
                    : rectToFraction(isMaximized(window)
                        ? workArea
                        : window.get_frame_rect(), workArea, gap);
                return {id, rect};
            });
            const tree = treeFromRects(items) ??
                columnsTree(this._arrangeOrder(windows).map(w => w.get_id()));
            this._tiling.tile(workspace, monitor, tree,
                new Map(windows.map(w => [w.get_id(), w])));
        }
    }

    // Called by the tiling manager for every window it takes over; the
    // geometry follows from the group's tree.
    _prepareTiledWindow(window, monitor) {
        // Keep Restore working: it puts the window back where it was before.
        const entry = this._rememberOriginal(window);
        entry.zone = null;
        entry.linked = false;
        if (window.minimized)
            window.unminimize();
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.get_monitor() !== monitor)
            window.move_to_monitor(monitor);
    }

    // The tiling groups of the active workspace as saved monitors.
    _captureLayout() {
        const workspace = global.workspace_manager.get_active_workspace();
        return this._tiling.groupsOn(workspace)
            .map(group => ({
                monitor: group.monitor,
                tree: this._tiling.capture(group, window => this._windowKey(window)),
            }))
            .filter(m => m.tree);
    }

    // Save the windows of the active workspace under `name`, replacing a
    // layout of the same name. Windows that are not tiled yet are tiled
    // where they are first. Returns the layout, or null if there are no
    // windows.
    _saveLayout(name) {
        this._tileFromScreen(global.workspace_manager.get_active_workspace());
        const monitors = this._captureLayout();
        if (monitors.length === 0)
            return null;

        const layout = {name, monitors};
        this._storeLayouts(upsertLayout(this._loadLayouts(), layout));
        this._settings.set_string('last-layout', name);
        return layout;
    }

    _deleteLayout(name) {
        const data = this._loadLayouts();
        if (!findLayout(data, name))
            return false;
        this._storeLayouts(removeLayout(data, name));
        return true;
    }

    _openSaveLayoutDialog() {
        if (this._layoutDialog)
            return;
        if (this._tileableWindows(global.workspace_manager.get_active_workspace()).size === 0) {
            Main.notify(_('Nothing to save'), _('There are no windows on this workspace.'));
            return;
        }
        this._layoutDialog = new LayoutNameDialog(this._settings.get_string('last-layout'),
            name => {
                if (!this._saveLayout(name))
                    Main.notify(_('Nothing to save'), _('There are no windows on this workspace.'));
            });
        this._layoutDialog.connect('destroy', () => {
            this._layoutDialog = null;
        });
        this._layoutDialog.open();
    }

    // Tile the windows of the workspace as layout `name` has them. Windows
    // of the same app are reused; apps without a window are launched and
    // their windows fill their cells once they appear. Returns false if
    // there is no such layout.
    _restoreLayout(name) {
        const layout = findLayout(this._loadLayouts(), name);
        if (!layout)
            return false;

        this._cancelRestore();
        this._settings.set_string('last-layout', name);

        // A monitor that is gone hands its windows to the primary monitor;
        // two trees on one monitor share it side by side.
        const monitorCount = global.display.get_n_monitors();
        const trees = new Map();
        for (const {monitor, tree} of layout.monitors) {
            const target = monitor < monitorCount ? monitor : Main.layoutManager.primaryIndex;
            const existing = trees.get(target);
            trees.set(target, existing
                ? {split: 'v', ratio: 0.5, a: existing, b: cloneTree(tree)}
                : cloneTree(tree));
        }

        const workspace = global.workspace_manager.get_active_workspace();
        const appSystem = Shell.AppSystem.get_default();
        const candidates = this._layoutWindows(workspace, {includeMinimized: true})
            .filter(window => window.resizeable && window.allows_move())
            .map(window => ({window, key: this._windowKey(window)}));
        const used = new Set();
        const missing = [];
        let placeholders = 0;

        for (const [monitor, saved] of trees) {
            const windows = new Map();
            const dropped = [];
            let tree = mapLeaves(saved, entry => {
                const match = candidates.find(c => !used.has(c) && this._entryMatches(entry, c.key));
                if (match) {
                    used.add(match);
                    const id = match.window.get_id();
                    windows.set(id, match.window);
                    return {id};
                }
                const id = `pending-${placeholders++}`;
                const app = entry.app ? appSystem.lookup_app(entry.app) : null;
                if (app) {
                    missing.push({entry, app, monitor, id});
                } else {
                    console.debug(`Layout ${name}: cannot launch ${entry.app ?? entry.wmClass}`);
                    dropped.push(id);
                }
                return {id};
            });
            for (const id of dropped)
                tree = removeLeaf(tree, id);
            if (tree)
                this._tiling.tile(workspace, monitor, tree, windows);
        }

        if (missing.length === 0)
            return true;

        const tracker = Shell.WindowTracker.get_default();
        const restore = {
            workspace,
            entries: missing,
            fresh: new Set(),
            shownIds: new Map(),
            windowCreatedId: global.display.connect('window-created',
                (display, window) => this._onRestoreWindowCreated(window)),
            trackerId: tracker.connect('tracked-windows-changed',
                () => this._matchFreshWindows()),
            timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_TIMEOUT_MS, () => {
                restore.timeoutId = 0;
                this._cancelRestore();
                return GLib.SOURCE_REMOVE;
            }),
        };
        this._layoutRestore = restore;

        const byApp = new Map();
        for (const item of missing)
            byApp.set(item.app, (byApp.get(item.app) ?? 0) + 1);
        for (const [app, total] of byApp) {
            let count = total;
            if (app.get_n_windows() === 0) {
                // Starts the app, or brings up its window if it runs without one.
                app.activate();
                count--;
            }
            if (count > 0 && !app.can_open_new_window()) {
                console.debug(`Layout ${name}: ${app.get_id()} cannot open more windows`);
                continue;
            }
            for (let i = 0; i < count; i++)
                app.open_new_window(-1);
        }
        return true;
    }

    _onRestoreWindowCreated(window) {
        if (!this._isSnappable(window) || window.get_transient_for())
            return;
        this._layoutRestore.fresh.add(window);
        // The app is often not known yet; tracked-windows-changed retries.
        this._matchFreshWindows();
    }

    // Pair windows created since the restore started with the cells still
    // waiting for one.
    _matchFreshWindows() {
        const restore = this._layoutRestore;
        if (!restore)
            return;

        for (const window of [...restore.fresh]) {
            if (!window.get_compositor_private()) {
                restore.fresh.delete(window);
                continue;
            }
            const key = this._windowKey(window);
            if (!key.app)
                continue;
            const item = restore.entries.find(e => this._entryMatches(e.entry, key));
            if (!item)
                continue;
            restore.fresh.delete(window);
            restore.entries.splice(restore.entries.indexOf(item), 1);
            this._placeNewWindow(window, item);
        }

        if (restore.entries.length === 0 && restore.shownIds.size === 0)
            this._cancelRestore();
    }

    // A new window can only be moved reliably once it is on screen.
    _placeNewWindow(window, item) {
        const restore = this._layoutRestore;
        const place = () => this._tiling.fillPending(restore.workspace, item.monitor, item.id, window);
        if (window.get_compositor_private()?.visible) {
            place();
            return;
        }

        const id = window.connect('shown', () => {
            window.disconnect(id);
            restore.shownIds.delete(window);
            place();
            if (this._layoutRestore === restore &&
                restore.entries.length === 0 && restore.shownIds.size === 0)
                this._cancelRestore();
        });
        restore.shownIds.set(window, id);
    }

    // Stop waiting for launched apps; cells still empty are given to their
    // neighbours.
    _cancelRestore() {
        const restore = this._layoutRestore;
        if (!restore)
            return;
        this._layoutRestore = null;

        global.display.disconnect(restore.windowCreatedId);
        Shell.WindowTracker.get_default().disconnect(restore.trackerId);
        for (const [window, id] of restore.shownIds)
            window.disconnect(id);
        restore.shownIds.clear();
        restore.fresh.clear();
        if (restore.timeoutId)
            GLib.source_remove(restore.timeoutId);
        this._tiling?.prunePending();
    }

    // ------------------------------------------------------ bookkeeping

    _rememberOriginal(window, rect = window.get_frame_rect()) {
        const id = window.get_id();
        let entry = this._originals.get(id);
        if (entry)
            return entry;

        entry = {
            window,
            rect,
            maximized: isMaximized(window),
            zone: null,
            // shares its edges with other snapped windows (edgeLinker.js)
            linked: false,
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

    _cancelPendingWait(window) {
        const wait = this._pendingWaits?.get(window);
        if (wait)
            this._cancelWait(window, wait);
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
