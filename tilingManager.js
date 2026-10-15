// Tiling groups: the windows placed by Arrange or by restoring a layout.
//
// Each group covers one monitor of one workspace and divides it with a split
// tree (see tiling.js). Windows in a group share their dividers: dragging
// the edge of one window moves the divider and resizes its neighbours, a
// window can be swapped with another one, and when a window leaves the group
// (closed, minimized, maximized, snapped to a zone, moved away) its
// neighbours take its space.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {rectToFraction} from './layouts.js';
import {
    cloneTree, findSplitForEdge, hasLeaf, insertBeside, leafIds, leafRects,
    mapLeaves, neighbourLeaf, removeLeaf, replaceLeafId, resizeEdge, swapLeaves,
} from './tiling.js';
import {MAXIMIZE_NOTIFY_SIGNALS, isMaximized} from './windowUtils.js';

const EDGES = ['left', 'right', 'top', 'bottom'];

function sameRect(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export class TilingManager {
    // `extension` provides _fractionRect, _moveResize, _cancelPendingWait
    // and _prepareTiledWindow.
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        // {workspace, monitor, tree, windows: Map id -> Meta.Window,
        //  signals: Map Meta.Window -> handler ids, lastRects: Map id -> rect}
        this._groups = [];
        this._resize = null;
        this._dragging = null;

        this._leftMonitorId = global.display.connect('window-left-monitor',
            (display, monitor, window) => this._onWindowLeftMonitor(monitor, window));
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this.releaseAll({reapply: false}));
    }

    destroy() {
        this._cancelResize();
        this.releaseAll({reapply: false});
        global.display.disconnect(this._leftMonitorId);
        Main.layoutManager.disconnect(this._monitorsChangedId);
        this._dragging = null;
        this._extension = null;
        this._settings = null;
    }

    // ------------------------------------------------------------ groups

    group(workspace, monitor) {
        return this._groups.find(g => g.workspace === workspace && g.monitor === monitor) ?? null;
    }

    groupOf(window) {
        if (!window)
            return null;
        const id = window.get_id();
        return this._groups.find(g => g.windows.get(id) === window) ?? null;
    }

    isTiled(window) {
        return this.groupOf(window) !== null;
    }

    groupsOn(workspace) {
        return this._groups.filter(g => g.workspace === workspace);
    }

    hasGroups(workspace) {
        return this.groupsOn(workspace).some(g => g.windows.size > 0);
    }

    // Tile `windows` (Map id -> Meta.Window) on a monitor of a workspace
    // with `tree`, replacing the group that was there. Leaves without a
    // window (apps that are still starting) keep their space empty.
    tile(workspace, monitor, tree, windows) {
        const old = this.group(workspace, monitor);
        if (old)
            this.releaseGroup(old, {reapply: false});
        for (const window of windows.values()) {
            if (this.isTiled(window))
                this.release(window);
        }

        const group = {
            workspace,
            monitor,
            tree,
            windows: new Map(),
            signals: new Map(),
            lastRects: new Map(),
        };
        this._groups.push(group);
        for (const [id, window] of windows)
            this._add(group, id, window);
        this.apply(group, {final: true});
        return group;
    }

    _add(group, id, window) {
        group.windows.set(id, window);
        const releaseIf = test => () => {
            if (test())
                this.release(window);
        };
        group.signals.set(window, [
            window.connect('unmanaged', () => this.release(window)),
            // Only on the way in: tiling a window unminimizes, unfullscreens
            // and unmaximizes it, and those notifications arrive later.
            window.connect('notify::minimized', releaseIf(() => window.minimized)),
            window.connect('notify::fullscreen', releaseIf(() => window.is_fullscreen())),
            ...MAXIMIZE_NOTIFY_SIGNALS.map(name =>
                window.connect(name, releaseIf(() => isMaximized(window)))),
            window.connect('workspace-changed', releaseIf(() =>
                window.get_workspace() !== group.workspace && !window.is_on_all_workspaces())),
        ]);
        this._extension._prepareTiledWindow(window, group.monitor);
    }

    // Take a window out of its group; its neighbours take its space.
    release(window, {reapply = true} = {}) {
        const group = this.groupOf(window);
        if (!group)
            return false;

        if (this._resize?.window === window)
            this._cancelResize();

        for (const id of group.signals.get(window) ?? [])
            window.disconnect(id);
        group.signals.delete(window);
        const id = window.get_id();
        group.windows.delete(id);
        group.lastRects.delete(id);
        group.tree = removeLeaf(group.tree, id);

        if (!group.tree)
            this._groups = this._groups.filter(g => g !== group);
        else if (reapply)
            this.apply(group, {final: true});
        return true;
    }

    releaseGroup(group, {reapply = false} = {}) {
        for (const window of [...group.windows.values()])
            this.release(window, {reapply});
        this._groups = this._groups.filter(g => g !== group);
    }

    releaseAll({reapply = false} = {}) {
        for (const group of [...this._groups])
            this.releaseGroup(group, {reapply});
    }

    // Put a window into the leaf that was kept for it while its app started.
    fillPending(workspace, monitor, placeholderId, window) {
        const group = this.group(workspace, monitor);
        if (!group || !hasLeaf(group.tree, placeholderId))
            return false;
        if (this.isTiled(window))
            this.release(window);

        this._fill(group, placeholderId, window);
        this.apply(group, {final: true});
        return true;
    }

    // Take a window out of its group but keep its leaf, under a placeholder
    // id that is returned.
    _detach(group, window) {
        if (this._resize?.window === window)
            this._cancelResize();
        for (const id of group.signals.get(window) ?? [])
            window.disconnect(id);
        group.signals.delete(window);
        const id = window.get_id();
        group.windows.delete(id);
        group.lastRects.delete(id);
        const placeholder = `swap-${id}`;
        group.tree = replaceLeafId(group.tree, id, placeholder);
        return placeholder;
    }

    _fill(group, placeholderId, window) {
        const id = window.get_id();
        group.tree = replaceLeafId(group.tree, placeholderId, id);
        this._add(group, id, window);
    }

    // Put `window` next to the tiled window `target`, sharing its cell: the
    // window gets the half at `edge`.
    insertBeside(target, window, edge) {
        if (this.isTiled(window))
            this.release(window);
        const group = this.groupOf(target);
        if (!group)
            return false;
        const id = window.get_id();
        group.tree = insertBeside(group.tree, target.get_id(), id, edge);
        this._add(group, id, window);
        this.apply(group, {final: true});
        return true;
    }

    // Each window takes the other's place in the tiling. A window that was
    // not tiled stays untiled: the other one ends up outside the tiling and
    // the caller places it.
    exchange(windowA, windowB) {
        const groupA = this.groupOf(windowA);
        const groupB = this.groupOf(windowB);
        if (groupA && groupA === groupB)
            return this.swap(windowA, windowB);

        const placeholderA = groupA ? this._detach(groupA, windowA) : null;
        const placeholderB = groupB ? this._detach(groupB, windowB) : null;
        if (groupA)
            this._fill(groupA, placeholderA, windowB);
        if (groupB)
            this._fill(groupB, placeholderB, windowA);
        for (const group of [groupA, groupB]) {
            if (group)
                this.apply(group, {final: true});
        }
        return true;
    }

    // Drop the leaves still waiting for a window; neighbours take the space.
    prunePending() {
        for (const group of [...this._groups]) {
            const pending = leafIds(group.tree).filter(id => !group.windows.has(id));
            if (pending.length === 0)
                continue;
            for (const id of pending)
                group.tree = removeLeaf(group.tree, id);
            if (!group.tree)
                this._groups = this._groups.filter(g => g !== group);
            else
                this.apply(group, {final: true});
        }
    }

    // ---------------------------------------------------------- geometry

    // Move every window of the group into its cell. Live updates (during a
    // resize) skip the dragged window and cells that did not change, and
    // do not wait for the client; the final pass does.
    apply(group, {skip = null, final = false} = {}) {
        for (const [id, frac] of leafRects(group.tree)) {
            const window = group.windows.get(id);
            if (!window || window === skip || !window.get_compositor_private())
                continue;
            const rect = this._extension._fractionRect(frac, group.monitor);
            if (!final && sameRect(group.lastRects.get(id), rect))
                continue;
            group.lastRects.set(id, rect);
            if (final) {
                this._extension._moveResize(window, rect);
            } else {
                // A client refuses a size below its minimum, and Mutter then
                // keeps the old position too; ask for what it accepts.
                const [width, height] = this._clampToMinSize(window, rect);
                this._extension._cancelPendingWait(window);
                window.move_resize_frame(true, rect.x, rect.y, width, height);
            }
        }
    }

    _clampToMinSize(window, rect) {
        if (typeof window.get_min_size !== 'function')
            return [rect.width, rect.height];
        const [ok, minWidth, minHeight] = window.get_min_size();
        if (!ok)
            return [rect.width, rect.height];
        return [Math.max(rect.width, minWidth), Math.max(rect.height, minHeight)];
    }

    // [{id, window, rect}] in pixels, for the cells that hold a window.
    cells(group) {
        const cells = [];
        for (const [id, frac] of leafRects(group.tree)) {
            const window = group.windows.get(id);
            if (window)
                cells.push({id, window, rect: this._extension._fractionRect(frac, group.monitor)});
        }
        return cells;
    }

    // Pixel rect of a tiled window's cell, or null.
    cellRect(window) {
        const group = this.groupOf(window);
        const frac = group ? leafRects(group.tree).get(window.get_id()) : null;
        return frac ? this._extension._fractionRect(frac, group.monitor) : null;
    }

    // ---------------------------------------------------------- swapping

    neighbour(window, direction) {
        const group = this.groupOf(window);
        if (!group)
            return null;
        const id = neighbourLeaf(group.tree, window.get_id(), direction);
        return id === null ? null : group.windows.get(id) ?? null;
    }

    swap(windowA, windowB) {
        const group = this.groupOf(windowA);
        if (!group || this.groupOf(windowB) !== group || windowA === windowB)
            return false;
        swapLeaves(group.tree, windowA.get_id(), windowB.get_id());
        this.apply(group, {final: true});
        return true;
    }

    swapInDirection(window, direction) {
        const other = this.neighbour(window, direction);
        return other ? this.swap(window, other) : false;
    }

    // ---------------------------------------------------------- resizing

    // Called when the user starts resizing `window`. Returns false when the
    // window is not tiled or linked resizing is off.
    beginResize(window) {
        this._cancelResize();
        const group = this.groupOf(window);
        if (!group || !this._settings.get_boolean('linked-resizing'))
            return false;

        for (const other of group.windows.values())
            this._extension._cancelPendingWait(other);

        const onChange = () => this._onResizeChanged();
        this._resize = {
            window,
            group,
            start: window.get_frame_rect(),
            edges: new Set(),
            signalIds: [
                window.connect('size-changed', onChange),
                window.connect('position-changed', onChange),
            ],
        };
        return true;
    }

    // Called when the user releases the window: move the dividers one last
    // time and put every window, the resized one too, exactly into its cell.
    endResize() {
        const resize = this._resize;
        if (!resize)
            return;
        this._onResizeChanged(true);
        this._cancelResize();
        if (this._groups.includes(resize.group))
            this.apply(resize.group, {final: true});
    }

    get resizingWindow() {
        return this._resize?.window ?? null;
    }

    _cancelResize() {
        const resize = this._resize;
        if (!resize)
            return;
        this._resize = null;
        for (const id of resize.signalIds)
            resize.window.disconnect(id);
    }

    // The window's frame changed during a resize: work out which edges the
    // user is dragging and move the matching dividers.
    _onResizeChanged(final = false) {
        const {window, group, start, edges} = this._resize;
        if (!this._groups.includes(group))
            return;

        const frame = window.get_frame_rect();
        if (frame.x !== start.x)
            edges.add('left');
        if (frame.x + frame.width !== start.x + start.width)
            edges.add('right');
        if (frame.y !== start.y)
            edges.add('top');
        if (frame.y + frame.height !== start.y + start.height)
            edges.add('bottom');
        if (edges.size === 0)
            return;

        const frac = rectToFraction(frame,
            Main.layoutManager.getWorkAreaForMonitor(group.monitor),
            this._settings.get_int('window-gap'));
        const position = {
            left: frac.x,
            right: frac.x + frac.w,
            top: frac.y,
            bottom: frac.y + frac.h,
        };

        const id = window.get_id();
        let changed = false;
        for (const edge of EDGES) {
            if (!edges.has(edge))
                continue;
            const hit = findSplitForEdge(group.tree, id, edge);
            if (!hit)
                continue;
            const before = leafRects(group.tree);
            const oldRatio = hit.node.ratio;
            if (!resizeEdge(group.tree, id, edge, position[edge]))
                continue;
            if (this._squeezesBelowMinSize(group, before, window))
                hit.node.ratio = oldRatio;
            else
                changed = true;
        }

        if (changed && !final)
            this.apply(group, {skip: window});
    }

    // Whether the current tree makes a window other than `except` smaller
    // than its minimum size, compared with the cells in `before`.
    _squeezesBelowMinSize(group, before, except) {
        for (const [id, frac] of leafRects(group.tree)) {
            const window = group.windows.get(id);
            if (!window || window === except || typeof window.get_min_size !== 'function')
                continue;
            const [ok, minWidth, minHeight] = window.get_min_size();
            if (!ok)
                continue;
            const old = before.get(id);
            const rect = this._extension._fractionRect(frac, group.monitor);
            const oldRect = this._extension._fractionRect(old, group.monitor);
            if ((rect.width < oldRect.width && rect.width < minWidth) ||
                (rect.height < oldRect.height && rect.height < minHeight))
                return true;
        }
        return false;
    }

    // ------------------------------------------------------------- misc

    // The window being moved by the user: monitor changes are ignored for
    // it until the move ends, the extension decides then.
    setDragging(window) {
        this._dragging = window;
    }

    _onWindowLeftMonitor(monitor, window) {
        if (window === this._dragging)
            return;
        if (this.groupOf(window)?.monitor === monitor)
            this.release(window);
    }

    // The group's tree with each window replaced by keyFn(window), without
    // the leaves still waiting for a window. Null when nothing is left.
    capture(group, keyFn) {
        let tree = cloneTree(group.tree);
        for (const id of leafIds(tree)) {
            if (!group.windows.has(id))
                tree = removeLeaf(tree, id);
        }
        return tree ? mapLeaves(tree, leaf => keyFn(group.windows.get(leaf.id))) : null;
    }
}
