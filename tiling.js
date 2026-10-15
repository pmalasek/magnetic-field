// Split trees for tiled windows.
//
// This module must not import anything from the Shell or from GTK: it is
// loaded both by extension.js (Shell process) and by prefs.js (gjs process),
// and by tests/tiling-test.js.
//
// A tree describes how one monitor is divided between windows:
//
//   split = {split: 'v' | 'h', ratio: 0..1, a: node, b: node}
//           'v' divides left (a) from right (b), 'h' top (a) from bottom (b);
//           ratio is the share of a.
//   leaf  = {id: window id}   (saved layouts use {app, wmClass} instead)
//
// Functions that change a tree do it in place and return the (possibly new)
// root; mapLeaves and cloneTree return new trees. Edges and directions are
// 'left', 'right', 'top' and 'bottom'.

const EPS = 1e-6;

export function isLeaf(node) {
    return !('split' in node);
}

export function leafIds(tree) {
    if (!tree)
        return [];
    return isLeaf(tree) ? [tree.id] : [...leafIds(tree.a), ...leafIds(tree.b)];
}

export function hasLeaf(tree, id) {
    if (!tree)
        return false;
    return isLeaf(tree) ? tree.id === id : hasLeaf(tree.a, id) || hasLeaf(tree.b, id);
}

export function countLeaves(tree) {
    return leafIds(tree).length;
}

export function mapLeaves(tree, fn) {
    if (!tree)
        return null;
    if (isLeaf(tree))
        return fn(tree);
    return {split: tree.split, ratio: tree.ratio, a: mapLeaves(tree.a, fn), b: mapLeaves(tree.b, fn)};
}

export function cloneTree(tree) {
    return mapLeaves(tree, leaf => ({...leaf}));
}

// Equal shares: the first node gets 1/n, the rest is divided the same way.
function chain(nodes, split) {
    if (nodes.length === 1)
        return nodes[0];
    return {split, ratio: 1 / nodes.length, a: nodes[0], b: chain(nodes.slice(1), split)};
}

// Columns for n windows: ceil(sqrt(n)) columns, the windows divided among
// them as evenly as possible with the first columns getting the fewest, so
// the first window (the focused one) gets the most room:
// 3 -> 1 + 2, 4 -> 2 + 2, 5 -> 1 + 2 + 2, 7 -> 2 + 2 + 3.
export function columnsTree(ids) {
    const n = ids.length;
    if (n === 0)
        return null;

    const cols = Math.ceil(Math.sqrt(n));
    const base = Math.floor(n / cols);
    const extra = n % cols;
    const columns = [];
    let next = 0;
    for (let col = 0; col < cols; col++) {
        const count = base + (col >= cols - extra ? 1 : 0);
        columns.push(chain(ids.slice(next, next + count).map(id => ({id})), 'h'));
        next += count;
    }
    return chain(columns, 'v');
}

function childBounds(node, bounds) {
    const r = node.ratio;
    if (node.split === 'v') {
        return [
            {x: bounds.x, y: bounds.y, w: bounds.w * r, h: bounds.h},
            {x: bounds.x + bounds.w * r, y: bounds.y, w: bounds.w * (1 - r), h: bounds.h},
        ];
    }
    return [
        {x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h * r},
        {x: bounds.x, y: bounds.y + bounds.h * r, w: bounds.w, h: bounds.h * (1 - r)},
    ];
}

const UNIT = {x: 0, y: 0, w: 1, h: 1};

// Map id -> {x, y, w, h} in the unit square.
export function leafRects(tree) {
    const rects = new Map();
    const walk = (node, bounds) => {
        if (isLeaf(node)) {
            rects.set(node.id, bounds);
            return;
        }
        const [a, b] = childBounds(node, bounds);
        walk(node.a, a);
        walk(node.b, b);
    };
    if (tree)
        walk(tree, UNIT);
    return rects;
}

// [{node, side, bounds}] from the root down to the parent of leaf `id`;
// bounds are those of `node`.
function pathTo(tree, id) {
    const path = [];
    const walk = (node, bounds) => {
        if (isLeaf(node))
            return node.id === id;
        const [a, b] = childBounds(node, bounds);
        for (const [side, child, childB] of [['a', node.a, a], ['b', node.b, b]]) {
            path.push({node, side, bounds});
            if (walk(child, childB))
                return true;
            path.pop();
        }
        return false;
    };
    return tree && walk(tree, UNIT) ? path : null;
}

// The split whose divider is the given edge of leaf `id`: the nearest
// ancestor where the leaf is on the side touching that edge. Null when the
// edge is the edge of the screen.
export function findSplitForEdge(tree, id, edge) {
    const want = {right: ['v', 'a'], left: ['v', 'b'], bottom: ['h', 'a'], top: ['h', 'b']}[edge];
    const path = pathTo(tree, id);
    if (!want || !path)
        return null;
    for (let i = path.length - 1; i >= 0; i--) {
        const {node, side, bounds} = path[i];
        if (node.split === want[0] && side === want[1])
            return {node, bounds};
    }
    return null;
}

// Move the divider at `edge` of leaf `id` to `fraction` (0..1 along the
// monitor). Returns true when a ratio changed.
export function resizeEdge(tree, id, edge, fraction, {min = 0.05} = {}) {
    const hit = findSplitForEdge(tree, id, edge);
    if (!hit)
        return false;
    const {node, bounds} = hit;
    let ratio = node.split === 'v'
        ? (fraction - bounds.x) / bounds.w
        : (fraction - bounds.y) / bounds.h;
    ratio = Math.min(1 - min, Math.max(min, ratio));
    if (Math.abs(ratio - node.ratio) < EPS)
        return false;
    node.ratio = ratio;
    return true;
}

function findLeaf(tree, id) {
    if (!tree)
        return null;
    if (isLeaf(tree))
        return tree.id === id ? tree : null;
    return findLeaf(tree.a, id) ?? findLeaf(tree.b, id);
}

export function swapLeaves(tree, idA, idB) {
    const a = findLeaf(tree, idA);
    const b = findLeaf(tree, idB);
    if (a && b && a !== b)
        [a.id, b.id] = [b.id, a.id];
    return tree;
}

// Remove a leaf; its sibling takes the space. Returns the new root, null
// when the tree is empty.
export function removeLeaf(tree, id) {
    if (!tree)
        return null;
    if (isLeaf(tree))
        return tree.id === id ? null : tree;
    if (hasLeaf(tree.a, id)) {
        const a = removeLeaf(tree.a, id);
        if (a === null)
            return tree.b;
        tree.a = a;
    } else if (hasLeaf(tree.b, id)) {
        const b = removeLeaf(tree.b, id);
        if (b === null)
            return tree.a;
        tree.b = b;
    }
    return tree;
}

// The leaf across the given edge of leaf `id` that shares the longest
// stretch of that edge; null at the edge of the screen.
export function neighbourLeaf(tree, id, direction) {
    const rects = leafRects(tree);
    const r = rects.get(id);
    if (!r)
        return null;

    const horizontal = direction === 'left' || direction === 'right';
    let best = null;
    let bestOverlap = 0;
    for (const [other, c] of rects) {
        if (other === id)
            continue;
        let adjacent;
        switch (direction) {
        case 'right': adjacent = Math.abs(c.x - (r.x + r.w)) < EPS; break;
        case 'left': adjacent = Math.abs(c.x + c.w - r.x) < EPS; break;
        case 'bottom': adjacent = Math.abs(c.y - (r.y + r.h)) < EPS; break;
        case 'top': adjacent = Math.abs(c.y + c.h - r.y) < EPS; break;
        default: adjacent = false;
        }
        if (!adjacent)
            continue;
        const overlap = horizontal
            ? Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y)
            : Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
        if (overlap > bestOverlap + EPS) {
            best = other;
            bestOverlap = overlap;
        }
    }
    return best;
}

// Put leaf `newId` next to leaf `targetId`, sharing the target's cell: the
// new leaf takes the half at `edge`.
export function insertBeside(tree, targetId, newId, edge) {
    const split = edge === 'left' || edge === 'right' ? 'v' : 'h';
    const first = edge === 'left' || edge === 'top';
    return mapLeaves(tree, leaf => {
        if (leaf.id !== targetId)
            return leaf;
        return first
            ? {split, ratio: 0.5, a: {id: newId}, b: {id: targetId}}
            : {split, ratio: 0.5, a: {id: targetId}, b: {id: newId}};
    });
}

// Give leaf `oldId` the id `newId`.
export function replaceLeafId(tree, oldId, newId) {
    return mapLeaves(tree, leaf => (leaf.id === oldId ? {id: newId} : leaf));
}

// A tree that reproduces windows placed by hand: items are {id, rect} with
// rects as fractions of the monitor. The windows are split recursively by
// a straight line that no window crosses (vertical lines first, so columns
// win); gaps between windows are shared by their neighbours. Returns null
// when the windows overlap so that no such line exists.
export function treeFromRects(items, {tolerance = 0.02} = {}) {
    if (items.length === 0)
        return null;
    return cut(items, {x: 0, y: 0, w: 1, h: 1}, tolerance);
}

function cut(items, bounds, tolerance) {
    if (items.length === 1)
        return {id: items[0].id};

    for (const [split, pos, size] of [['v', 'x', 'w'], ['h', 'y', 'h']]) {
        const ends = [...new Set(items.map(i => i.rect[pos] + i.rect[size]))].sort((a, b) => a - b);
        for (const end of ends) {
            const before = items.filter(i => i.rect[pos] + i.rect[size] <= end + tolerance);
            const after = items.filter(i => i.rect[pos] >= end - tolerance);
            if (before.length === 0 || after.length === 0 ||
                before.length + after.length !== items.length ||
                before.some(i => after.includes(i)))
                continue;

            // The divider sits in the middle of the gap (or overlap) between
            // the two sides.
            const line = (Math.max(...before.map(i => i.rect[pos] + i.rect[size])) +
                Math.min(...after.map(i => i.rect[pos]))) / 2;
            const ratio = Math.min(0.95, Math.max(0.05, (line - bounds[pos]) / bounds[size]));
            const a = {...bounds, [size]: bounds[size] * ratio};
            const b = {...bounds, [pos]: bounds[pos] + bounds[size] * ratio, [size]: bounds[size] * (1 - ratio)};
            const treeA = cut(before, a, tolerance);
            const treeB = cut(after, b, tolerance);
            if (treeA && treeB)
                return {split, ratio, a: treeA, b: treeB};
        }
    }
    return null;
}

// Whether a saved tree (leaves {app, wmClass}) is well formed.
export function validTree(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 64)
        return false;
    if ('id' in node)
        return false;
    if ('app' in node || 'wmClass' in node) {
        return (node.app === null || typeof node.app === 'string') &&
            typeof node.wmClass === 'string';
    }
    return (node.split === 'v' || node.split === 'h') &&
        typeof node.ratio === 'number' && node.ratio > 0 && node.ratio < 1 &&
        validTree(node.a, depth + 1) && validTree(node.b, depth + 1);
}
