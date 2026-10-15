// Unit tests for tiling.js and layouts.js. Run with `just unit`.

import {
    columnsTree, countLeaves, findSplitForEdge, leafIds, leafRects, mapLeaves,
    neighbourLeaf, removeLeaf, resizeEdge, swapLeaves, treeFromRects,
} from '../tiling.js';
import {layoutWindowCount, parseLayouts, serializeLayouts} from '../layouts.js';

let failures = 0;
function check(label, expected, actual) {
    const e = JSON.stringify(expected);
    const a = JSON.stringify(actual);
    if (e === a) {
        print(`PASS  ${label}`);
    } else {
        print(`FAIL  ${label}: expected ${e} got ${a}`);
        failures++;
    }
}
const r3 = rect => [rect.x, rect.y, rect.w, rect.h].map(v => Math.round(v * 1000) / 1000);
const rects = tree => Object.fromEntries([...leafRects(tree)].map(([id, r]) => [id, r3(r)]));
const columnCounts = tree => {
    const counts = [];
    const walk = node => {
        if (node.split === 'v') {
            walk(node.a);
            walk(node.b);
        } else {
            counts.push(countLeaves(node));
        }
    };
    walk(tree);
    return counts;
};

// columnsTree
check('no windows', null, columnsTree([]));
check('one window fills the screen', {A: [0, 0, 1, 1]}, rects(columnsTree(['A'])));
check('two windows side by side', {A: [0, 0, 0.5, 1], B: [0.5, 0, 0.5, 1]}, rects(columnsTree(['A', 'B'])));
check('three: master left, two stacked right',
    {A: [0, 0, 0.5, 1], B: [0.5, 0, 0.5, 0.5], C: [0.5, 0.5, 0.5, 0.5]},
    rects(columnsTree(['A', 'B', 'C'])));
for (const [n, counts] of [[4, [2, 2]], [5, [1, 2, 2]], [6, [2, 2, 2]], [7, [2, 2, 3]], [9, [3, 3, 3]], [10, [2, 2, 3, 3]]]) {
    const ids = [...Array(n).keys()].map(i => `w${i}`);
    check(`${n} windows in columns ${counts}`, counts, columnCounts(columnsTree(ids)));
}
check('five: equal column widths', [0.33, 0.33, 0.33],
    [...new Set([...leafRects(columnsTree(['a', 'b', 'c', 'd', 'e'])).values()].map(r => r3(r)[0]))]
        .map((x, i, xs) => Math.round(((xs[i + 1] ?? 1) - x) * 100) / 100));
check('leaf order', ['A', 'B', 'C'], leafIds(columnsTree(['A', 'B', 'C'])));

// findSplitForEdge / resizeEdge
let t = columnsTree(['A', 'B', 'C']);
check('A right edge is the root divider', true, findSplitForEdge(t, 'A', 'right')?.node === t);
check('A left edge is the screen', null, findSplitForEdge(t, 'A', 'left'));
check('A top edge is the screen', null, findSplitForEdge(t, 'A', 'top'));
check('B left edge is the root divider', true, findSplitForEdge(t, 'B', 'left')?.node === t);
check('B bottom edge is the stack divider', true, findSplitForEdge(t, 'B', 'bottom')?.node === t.b);
check('C top edge is the stack divider', true, findSplitForEdge(t, 'C', 'top')?.node === t.b);
check('C bottom edge is the screen', null, findSplitForEdge(t, 'C', 'bottom'));
check('drag A right edge to 0.625', true, resizeEdge(t, 'A', 'right', 0.625));
check('ratio after drag', 0.625, t.ratio);
check('same position again changes nothing', false, resizeEdge(t, 'A', 'right', 0.625));
check('neighbours follow',
    {A: [0, 0, 0.625, 1], B: [0.625, 0, 0.375, 0.5], C: [0.625, 0.5, 0.375, 0.5]}, rects(t));
resizeEdge(t, 'B', 'bottom', 400 / 1048);
check('B bottom edge moves the stack divider', 0.382, Math.round(t.b.ratio * 1000) / 1000);
resizeEdge(t, 'C', 'left', 0.99);
check('divider clamped to 0.95', 0.95, t.ratio);
resizeEdge(t, 'A', 'right', -1);
check('divider clamped to 0.05', 0.05, t.ratio);
t = columnsTree(['a', 'b', 'c', 'd', 'e']);
resizeEdge(t, 'a', 'right', 0.25);
check('master column narrowed, other columns keep their share',
    [0, 0.25, 0.625], [...new Set([...leafRects(t).values()].map(r => r3(r)[0]))]);

// neighbourLeaf
t = columnsTree(['A', 'B', 'C']);
t.b.ratio = 0.3;
check('right of A: the window sharing most of the edge', 'C', neighbourLeaf(t, 'A', 'right'));
check('left of B', 'A', neighbourLeaf(t, 'B', 'left'));
check('below B', 'C', neighbourLeaf(t, 'B', 'bottom'));
check('above C', 'B', neighbourLeaf(t, 'C', 'top'));
check('nothing left of A', null, neighbourLeaf(t, 'A', 'left'));
check('nothing above B', null, neighbourLeaf(t, 'B', 'top'));

// swapLeaves
t = columnsTree(['A', 'B', 'C']);
swapLeaves(t, 'A', 'C');
check('swap exchanges cells', {C: [0, 0, 0.5, 1], B: [0.5, 0, 0.5, 0.5], A: [0.5, 0.5, 0.5, 0.5]}, rects(t));

// removeLeaf
t = columnsTree(['A', 'B', 'C']);
t = removeLeaf(t, 'B');
check('removed window: sibling takes its space', {A: [0, 0, 0.5, 1], C: [0.5, 0, 0.5, 1]}, rects(t));
t = removeLeaf(t, 'A');
check('removing the master leaves one window filling the screen', {C: [0, 0, 1, 1]}, rects(t));
check('last window removed', null, removeLeaf(t, 'C'));
t = columnsTree(['A', 'B']);
check('removing an unknown id keeps the tree', 2, countLeaves(removeLeaf(t, 'X')));

// treeFromRects
const item = (id, x, y, w, h) => ({id, rect: {x, y, w, h}});
const fromRects = list => rects(treeFromRects(list));
check('from screen: two halves', {A: [0, 0, 0.5, 1], B: [0.5, 0, 0.5, 1]},
    fromRects([item('A', 0, 0, 0.5, 1), item('B', 0.5, 0, 0.5, 1)]));
check('from screen: thirds', {A: [0, 0, 0.333, 1], B: [0.333, 0, 0.667, 1]},
    fromRects([item('A', 0, 0, 1 / 3, 1), item('B', 1 / 3, 0, 2 / 3, 1)]));
check('from screen: master and stack',
    {A: [0, 0, 0.6, 1], B: [0.6, 0, 0.4, 0.3], C: [0.6, 0.3, 0.4, 0.7]},
    fromRects([item('C', 0.6, 0.3, 0.4, 0.7), item('A', 0, 0, 0.6, 1), item('B', 0.6, 0, 0.4, 0.3)]));
check('from screen: windows that do not fill the screen grow to fill it',
    {A: [0, 0, 0.5, 1], B: [0.5, 0, 0.5, 1]},
    fromRects([item('A', 0.1, 0.2, 0.3, 0.5), item('B', 0.6, 0.1, 0.3, 0.6)]));
check('from screen: grid splits into columns first', 'v',
    treeFromRects([item('A', 0, 0, 0.5, 0.5), item('B', 0.5, 0, 0.5, 0.5),
        item('C', 0, 0.5, 0.5, 0.5), item('D', 0.5, 0.5, 0.5, 0.5)]).split);
check('from screen: small overlaps are tolerated', {A: [0, 0, 0.505, 1], B: [0.505, 0, 0.495, 1]},
    fromRects([item('A', 0, 0, 0.51, 1), item('B', 0.5, 0, 0.5, 1)]));
check('from screen: stacked windows', {A: [0, 0, 1, 0.5], B: [0, 0.5, 1, 0.5]},
    fromRects([item('A', 0, 0, 1, 0.5), item('B', 0, 0.5, 1, 0.5)]));
check('from screen: overlapping windows give no tree', null,
    treeFromRects([item('A', 0, 0, 0.7, 0.7), item('B', 0.3, 0.3, 0.7, 0.7)]));
check('from screen: pinwheel gives no tree', null,
    treeFromRects([item('A', 0, 0, 0.7, 0.3), item('B', 0.7, 0, 0.3, 0.7),
        item('C', 0.3, 0.7, 0.7, 0.3), item('D', 0, 0.3, 0.3, 0.7), item('E', 0.3, 0.3, 0.4, 0.4)]));
check('from screen: one window', {A: [0, 0, 1, 1]}, fromRects([item('A', 0.2, 0.2, 0.3, 0.3)]));

// layouts v2
const saved = mapLeaves(columnsTree(['a.desktop', 'b.desktop', 'c']), leaf => ({
    app: leaf.id === 'c' ? null : leaf.id,
    wmClass: leaf.id.replace('.desktop', ''),
}));
const data = {version: 2, layouts: [{name: 'Dev1', monitors: [{monitor: 0, tree: saved}]}]};
const parsed = parseLayouts(serializeLayouts(data));
check('v2 round trip', serializeLayouts(data), serializeLayouts(parsed));
check('window count', 3, layoutWindowCount(parsed.layouts[0]));
check('v1 gives no layouts', [], parseLayouts(JSON.stringify({version: 1, layouts: [{name: 'x', windows: []}]})).layouts);
check('empty setting', [], parseLayouts('').layouts);
const bad = JSON.parse(serializeLayouts(data));
bad.layouts[0].monitors[0].tree.ratio = 1.5;
check('ratio out of range drops the monitor', [], parseLayouts(JSON.stringify(bad)).layouts[0].monitors);
const runtime = JSON.parse(serializeLayouts(data));
runtime.layouts[0].monitors[0].tree.a = {id: 3};
check('runtime ids are not accepted', [], parseLayouts(JSON.stringify(runtime)).layouts[0].monitors);

print(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures > 0)
    imports.system.exit(1);
