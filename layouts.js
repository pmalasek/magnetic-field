// Saved window layouts: geometry, grid and serialisation helpers shared by
// the Shell side and the preferences window.
//
// This module must not import anything from the Shell or from GTK: it is
// loaded both by extension.js (Shell process) and by prefs.js (gjs process).
//
// The layouts live in the `layouts` setting as JSON:
//
//   {"version": 1, "layouts": [{"name": "Dev1", "windows": [
//       {"app": "org.gnome.TextEditor.desktop",  // desktop id, null if unknown
//        "wmClass": "org.gnome.TextEditor",
//        "monitor": 0,
//        "rect": {"x": 0, "y": 0, "w": 0.5, "h": 1},
//        "maximized": false}]}]}
//
// `rect` is a fraction of the monitor work area as if the window gap were 0,
// so a layout keeps its proportions on another screen size and with another
// gap: the gap is applied again when the layout is restored.

export const LAYOUTS_VERSION = 1;

// Edges closer than this to 0 or 1 count as screen edges.
const EDGE_EPS = 0.001;
// Fractions are stored with this precision (a fraction of a pixel on 8K).
const PRECISION = 1e5;
const MIN_FRACTION = 0.02;

// Fraction {x, y, w, h} of a work area -> pixel rect {x, y, width, height}.
// Outer gap towards the screen edges, half a gap on inner edges so two
// neighbouring tiles end up exactly one gap apart.
export function fractionToRect(frac, workArea, gap) {
    const innerX = workArea.x + gap;
    const innerY = workArea.y + gap;
    const innerW = workArea.width - 2 * gap;
    const innerH = workArea.height - 2 * gap;

    const left = innerX + frac.x * innerW + (frac.x > EDGE_EPS ? gap / 2 : 0);
    const right = innerX + (frac.x + frac.w) * innerW - (frac.x + frac.w < 1 - EDGE_EPS ? gap / 2 : 0);
    const top = innerY + frac.y * innerH + (frac.y > EDGE_EPS ? gap / 2 : 0);
    const bottom = innerY + (frac.y + frac.h) * innerH - (frac.y + frac.h < 1 - EDGE_EPS ? gap / 2 : 0);

    const x = Math.round(left);
    const y = Math.round(top);
    return {
        x,
        y,
        width: Math.round(right) - x,
        height: Math.round(bottom) - y,
    };
}

function round(value) {
    return Math.round(value * PRECISION) / PRECISION;
}

function clamp(value) {
    return Math.min(1, Math.max(0, value));
}

// One axis of rectToFraction: [start, end) in pixels -> [from, to] in 0..1.
function axisToFraction(start, end, areaStart, areaSize, gap) {
    const inner = areaSize - 2 * gap;
    if (inner <= 0)
        return [0, 1];

    const innerStart = areaStart + gap;
    const innerEnd = innerStart + inner;
    // Within half a gap (plus a pixel of rounding) of the inner edge counts
    // as touching the screen edge, which is where fractionToRect puts it.
    const slack = gap / 2 + 1;

    const from = start - innerStart <= slack ? 0 : (start - gap / 2 - innerStart) / inner;
    const to = innerEnd - end <= slack ? 1 : (end + gap / 2 - innerStart) / inner;
    return [clamp(from), clamp(to)];
}

// Pixel rect {x, y, width, height} -> gap-free fraction {x, y, w, h}; the
// inverse of fractionToRect.
export function rectToFraction(rect, workArea, gap) {
    let [x, right] = axisToFraction(rect.x, rect.x + rect.width, workArea.x, workArea.width, gap);
    let [y, bottom] = axisToFraction(rect.y, rect.y + rect.height, workArea.y, workArea.height, gap);

    if (right - x < MIN_FRACTION) {
        x = Math.min(x, 1 - MIN_FRACTION);
        right = x + MIN_FRACTION;
    }
    if (bottom - y < MIN_FRACTION) {
        y = Math.min(y, 1 - MIN_FRACTION);
        bottom = y + MIN_FRACTION;
    }
    return {x: round(x), y: round(y), w: round(right - x), h: round(bottom - y)};
}

// Cells of an automatic grid for n windows, row by row from the top left.
// cols = ceil(sqrt(n)), rows = ceil(n / cols); the last row holds the rest
// and its cells stretch to the full width (3 -> 2 + 1, 5 -> 3 + 2).
export function gridCells(n) {
    if (n <= 0)
        return [];

    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cells = [];
    for (let row = 0; row < rows; row++) {
        const inRow = row < rows - 1 ? cols : n - cols * (rows - 1);
        for (let col = 0; col < inRow; col++)
            cells.push({x: col / inRow, y: row / rows, w: 1 / inRow, h: 1 / rows});
    }
    return cells;
}

function emptyLayouts() {
    return {version: LAYOUTS_VERSION, layouts: []};
}

function isFraction(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validWindow(entry) {
    return entry && typeof entry === 'object' &&
        (entry.app === null || typeof entry.app === 'string') &&
        typeof entry.wmClass === 'string' &&
        Number.isInteger(entry.monitor) &&
        entry.rect && ['x', 'y', 'w', 'h'].every(k => isFraction(entry.rect[k]));
}

// Setting value -> {version, layouts}. Anything unreadable gives no layouts
// rather than an exception, so a broken value cannot break the menu.
export function parseLayouts(json) {
    if (!json)
        return emptyLayouts();

    let data;
    try {
        data = JSON.parse(json);
    } catch (e) {
        console.warn(`Saved layouts are not valid JSON, ignoring them: ${e.message}`);
        return emptyLayouts();
    }
    if (data?.version !== LAYOUTS_VERSION || !Array.isArray(data.layouts))
        return emptyLayouts();

    const layouts = data.layouts
        .filter(l => l && typeof l.name === 'string' && Array.isArray(l.windows))
        .map(l => ({
            name: l.name,
            windows: l.windows.filter(validWindow).map(w => ({
                app: w.app,
                wmClass: w.wmClass,
                monitor: w.monitor,
                rect: {x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h},
                maximized: !!w.maximized,
            })),
        }));
    return {version: LAYOUTS_VERSION, layouts};
}

export function serializeLayouts(data) {
    return JSON.stringify({version: LAYOUTS_VERSION, layouts: data.layouts});
}

export function findLayout(data, name) {
    return data.layouts.find(l => l.name === name) ?? null;
}

// Replace the layout with the same name, or append it.
export function upsertLayout(data, layout) {
    const index = data.layouts.findIndex(l => l.name === layout.name);
    const layouts = [...data.layouts];
    if (index >= 0)
        layouts[index] = layout;
    else
        layouts.push(layout);
    return {...data, layouts};
}

export function removeLayout(data, name) {
    return {...data, layouts: data.layouts.filter(l => l.name !== name)};
}

// Returns the new data, or null if the new name is empty or already taken.
export function renameLayout(data, oldName, newName) {
    const name = normalizeName(newName);
    if (!name || !findLayout(data, oldName))
        return null;
    if (name !== oldName && findLayout(data, name))
        return null;
    return {
        ...data,
        layouts: data.layouts.map(l => (l.name === oldName ? {...l, name} : l)),
    };
}

// Trimmed name, or null if nothing is left.
export function normalizeName(name) {
    const trimmed = (name ?? '').trim();
    return trimmed === '' ? null : trimmed;
}
