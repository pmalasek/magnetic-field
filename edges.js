// Geometry of snapped windows: drop regions inside a window, splitting a
// window's area, and finding the windows that share an edge.
//
// This module must not import anything from the Shell or from GTK so it can
// be unit tested with plain gjs (tests/tiling-test.js). Rects are pixel
// rects {x, y, width, height}.

// Where inside `rect` the point (x, y) is: within `band` (a fraction of the
// width or height) of an edge it is that edge ('left', 'right', 'top',
// 'bottom'; the nearest one in the corners), otherwise 'center'.
export function dropRegion(rect, x, y, band = 0.25) {
    const fx = (x - rect.x) / rect.width;
    const fy = (y - rect.y) / rect.height;
    const distances = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
    const [edge, distance] = distances.reduce((best, d) => (d[1] < best[1] ? d : best));
    return distance < band ? edge : 'center';
}

// Split `rect` in two halves `gap` pixels apart: `inserted` is the half at
// `edge`, `remaining` the other one.
export function splitRect(rect, edge, gap) {
    if (edge === 'left' || edge === 'right') {
        const first = Math.floor((rect.width - gap) / 2);
        const a = {x: rect.x, y: rect.y, width: first, height: rect.height};
        const b = {x: rect.x + first + gap, y: rect.y, width: rect.width - first - gap, height: rect.height};
        return edge === 'left' ? {inserted: a, remaining: b} : {inserted: b, remaining: a};
    }
    const first = Math.floor((rect.height - gap) / 2);
    const a = {x: rect.x, y: rect.y, width: rect.width, height: first};
    const b = {x: rect.x, y: rect.y + first + gap, width: rect.width, height: rect.height - first - gap};
    return edge === 'top' ? {inserted: a, remaining: b} : {inserted: b, remaining: a};
}

function axis(vertical) {
    return vertical
        ? {pos: 'x', size: 'width', spanPos: 'y', spanSize: 'height'}
        : {pos: 'y', size: 'height', spanPos: 'x', spanSize: 'width'};
}

// The divider at `edge` of window `id`: the windows whose far edge (right or
// bottom) lies on the line (`before`) and those whose near edge lies one gap
// further (`after`), collected transitively along the line, so all windows
// sharing the divider move together. `line` is the far-edge coordinate.
// Null when no other window shares the edge.
export function linkedLine(rects, id, edge, gap, tolerance = 2) {
    const own = rects.get(id);
    if (!own)
        return null;
    const vertical = edge === 'left' || edge === 'right';
    const {pos, size, spanPos, spanSize} = axis(vertical);
    const line = edge === 'right' || edge === 'bottom'
        ? own[pos] + own[size]
        : own[pos] - gap;

    const before = new Set();
    const after = new Set();
    (edge === 'right' || edge === 'bottom' ? before : after).add(id);

    const overlaps = (a, b) =>
        Math.min(a[spanPos] + a[spanSize], b[spanPos] + b[spanSize]) -
        Math.max(a[spanPos], b[spanPos]) > tolerance;

    let changed = true;
    while (changed) {
        changed = false;
        for (const [other, r] of rects) {
            if (before.has(other) || after.has(other))
                continue;
            if (Math.abs(r[pos] + r[size] - line) <= tolerance &&
                [...after].some(a => overlaps(r, rects.get(a)))) {
                before.add(other);
                changed = true;
            } else if (Math.abs(r[pos] - (line + gap)) <= tolerance &&
                [...before].some(b => overlaps(r, rects.get(b)))) {
                after.add(other);
                changed = true;
            }
        }
    }

    if (before.size === 0 || after.size === 0)
        return null;
    return {vertical, line, before: [...before], after: [...after]};
}

// The far-edge coordinate of the divider at `edge` for a window at `rect`.
export function lineOf(rect, edge, gap) {
    switch (edge) {
    case 'right': return rect.x + rect.width;
    case 'left': return rect.x - gap;
    case 'bottom': return rect.y + rect.height;
    default: return rect.y - gap;
    }
}

// `rect` with its edge on the divider moved to `line`.
export function moveLine(rect, link, id, line, gap) {
    const {pos, size} = axis(link.vertical);
    const moved = {...rect};
    if (link.before.includes(id)) {
        moved[size] = line - rect[pos];
    } else {
        moved[pos] = line + gap;
        moved[size] = rect[pos] + rect[size] - moved[pos];
    }
    return moved;
}

// How far the divider can go without making a window other than `except`
// smaller than its minimum size: [lowest line, highest line].
// minSizes: Map id -> [width, height].
export function lineRange(rects, link, minSizes, gap, except) {
    const {pos, size} = axis(link.vertical);
    const index = link.vertical ? 0 : 1;
    let low = -Infinity;
    let high = Infinity;
    for (const id of link.before) {
        if (id === except)
            continue;
        const r = rects.get(id);
        low = Math.max(low, r[pos] + (minSizes.get(id)?.[index] ?? 1));
    }
    for (const id of link.after) {
        if (id === except)
            continue;
        const r = rects.get(id);
        high = Math.min(high, r[pos] + r[size] - (minSizes.get(id)?.[index] ?? 1) - gap);
    }
    return [low, high];
}
