// Linked edges of snapped windows: windows snapped to zones (or placed by
// dropping one window onto another) that touch each other share their
// dividers. Dragging the edge of one of them moves the touching edges of the
// others with it, live; windows never shrink below their minimum size.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {lineOf, lineRange, linkedLine, moveLine} from './edges.js';

const EDGES = ['left', 'right', 'top', 'bottom'];

// Frame rects are Mtk.Rectangle boxes; object spread does not copy them.
function plainRect(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

function sameRect(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function minSize(window) {
    if (typeof window.get_min_size !== 'function')
        return [1, 1];
    const [ok, width, height] = window.get_min_size();
    return ok ? [width, height] : [1, 1];
}

export class EdgeLinker {
    // `extension` provides _moveResize, _cancelPendingWait and _originals.
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._resize = null;
    }

    destroy() {
        this._cancel();
        this._extension = null;
        this._settings = null;
    }

    get resizingWindow() {
        return this._resize?.window ?? null;
    }

    // The user starts resizing `window`; `neighbours` are the other snapped
    // windows of its monitor. Returns false when linked resizing is off.
    beginResize(window, neighbours) {
        this._cancel();
        if (!this._settings.get_boolean('linked-resizing'))
            return false;

        const gap = this._settings.get_int('window-gap');
        const windows = new Map([window, ...neighbours].map(w => [w.get_id(), w]));
        const rects = new Map([...windows].map(([id, w]) => [id, plainRect(w.get_frame_rect())]));
        const minSizes = new Map([...windows].map(([id, w]) => [id, minSize(w)]));
        const id = window.get_id();
        const links = {};
        for (const edge of EDGES) {
            const link = linkedLine(rects, id, edge, gap);
            if (link) {
                link.range = lineRange(rects, link, minSizes, gap, id);
                links[edge] = link;
            }
        }

        for (const other of neighbours)
            this._extension._cancelPendingWait(other);

        const onChange = () => this._onChanged();
        this._resize = {
            window,
            id,
            windows,
            rects,
            links,
            gap,
            start: plainRect(window.get_frame_rect()),
            moved: new Set(),
            lastRects: new Map(),
            signalIds: [
                window.connect('size-changed', onChange),
                window.connect('position-changed', onChange),
            ],
        };
        return true;
    }

    // The user released the window: put the neighbours exactly in place,
    // and pull the resized window back if it went past a neighbour's
    // minimum size.
    endResize() {
        if (!this._resize)
            return;
        this._onChanged(true);
        this._cancel();
    }

    _cancel() {
        const resize = this._resize;
        if (!resize)
            return;
        this._resize = null;
        for (const id of resize.signalIds)
            resize.window.disconnect(id);
    }

    _onChanged(final = false) {
        const r = this._resize;
        const frame = plainRect(r.window.get_frame_rect());
        const {start} = r;
        if (frame.x !== start.x)
            r.moved.add('left');
        if (frame.x + frame.width !== start.x + start.width)
            r.moved.add('right');
        if (frame.y !== start.y)
            r.moved.add('top');
        if (frame.y + frame.height !== start.y + start.height)
            r.moved.add('bottom');

        const targets = new Map();
        let fixed = null;
        for (const edge of r.moved) {
            const link = r.links[edge];
            if (!link)
                continue;
            const wanted = lineOf(frame, edge, r.gap);
            const [low, high] = link.range;
            const line = Math.min(high, Math.max(low, wanted));
            for (const id of [...link.before, ...link.after]) {
                if (id === r.id)
                    continue;
                targets.set(id, moveLine(targets.get(id) ?? r.rects.get(id), link, id, line, r.gap));
            }
            if (line !== wanted)
                fixed = moveLine(fixed ?? {...frame}, link, r.id, line, r.gap);
        }

        for (const [id, rect] of targets) {
            const window = r.windows.get(id);
            if (!window.get_compositor_private())
                continue;
            if (final) {
                this._extension._moveResize(window, rect);
            } else if (!sameRect(r.lastRects.get(id), rect)) {
                r.lastRects.set(id, rect);
                const [minWidth, minHeight] = minSize(window);
                this._extension._cancelPendingWait(window);
                window.move_resize_frame(true, rect.x, rect.y,
                    Math.max(rect.width, minWidth), Math.max(rect.height, minHeight));
            }
        }

        if (final) {
            if (fixed)
                this._extension._moveResize(r.window, fixed);
            // The windows no longer match their zones exactly.
            for (const id of [r.id, ...targets.keys()]) {
                const entry = this._extension._originals.get(id);
                if (entry)
                    entry.zone = null;
            }
        }
    }
}
