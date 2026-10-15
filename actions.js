// Actions shared by the Shell side and the preferences window.
//
// This module must not import anything from the Shell or from GTK: it is
// loaded both by extension.js (Shell process) and by prefs.js (gjs process).

// Target areas as fractions of the work area: {x, y, w, h}.
// The keys double as the names of the keybinding settings.
export const ZONES = {
    'snap-left-half': {x: 0, y: 0, w: 1 / 2, h: 1},
    'snap-right-half': {x: 1 / 2, y: 0, w: 1 / 2, h: 1},
    'snap-top-half': {x: 0, y: 0, w: 1, h: 1 / 2},
    'snap-bottom-half': {x: 0, y: 1 / 2, w: 1, h: 1 / 2},

    'snap-top-left-quarter': {x: 0, y: 0, w: 1 / 2, h: 1 / 2},
    'snap-top-right-quarter': {x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2},
    'snap-bottom-left-quarter': {x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2},
    'snap-bottom-right-quarter': {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},

    'snap-left-third': {x: 0, y: 0, w: 1 / 3, h: 1},
    'snap-center-third': {x: 1 / 3, y: 0, w: 1 / 3, h: 1},
    'snap-right-third': {x: 2 / 3, y: 0, w: 1 / 3, h: 1},
    'snap-left-two-thirds': {x: 0, y: 0, w: 2 / 3, h: 1},
    'snap-right-two-thirds': {x: 1 / 3, y: 0, w: 2 / 3, h: 1},

    'snap-maximize': {x: 0, y: 0, w: 1, h: 1},
};

// Every action in the order shown in the preferences and in the panel menu.
// Each entry is [settings key, title]; titles are passed through gettext by
// the caller.
export const ACTION_GROUPS = [
    {
        title: 'Halves',
        actions: [
            ['snap-left-half', 'Left half'],
            ['snap-right-half', 'Right half'],
            ['snap-top-half', 'Top half'],
            ['snap-bottom-half', 'Bottom half'],
        ],
    },
    {
        title: 'Quarters',
        actions: [
            ['snap-top-left-quarter', 'Top left'],
            ['snap-top-right-quarter', 'Top right'],
            ['snap-bottom-left-quarter', 'Bottom left'],
            ['snap-bottom-right-quarter', 'Bottom right'],
        ],
    },
    {
        title: 'Thirds',
        actions: [
            ['snap-left-third', 'Left third'],
            ['snap-center-third', 'Center third'],
            ['snap-right-third', 'Right third'],
            ['snap-left-two-thirds', 'Left two thirds'],
            ['snap-right-two-thirds', 'Right two thirds'],
        ],
    },
    {
        title: 'Window',
        actions: [
            ['snap-maximize', 'Maximize'],
            ['center-window', 'Center'],
            ['restore-window', 'Restore'],
        ],
    },
    {
        title: 'Displays',
        actions: [
            ['move-to-next-display', 'Next display'],
            ['move-to-previous-display', 'Previous display'],
        ],
    },
    {
        title: 'Layouts',
        actions: [
            ['arrange-windows', 'Arrange windows'],
            ['save-layout', 'Save layout…'],
            ['restore-last-layout', 'Restore last layout'],
        ],
    },
];

export const ACTION_NAMES = ACTION_GROUPS.flatMap(group => group.actions.map(([name]) => name));

// Actions that work on all windows of the workspace rather than on one.
export const WINDOWLESS_ACTIONS = new Set(['arrange-windows', 'save-layout', 'restore-last-layout']);
