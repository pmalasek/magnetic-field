// Window helpers shared by extension.js and tilingManager.js.

import Meta from 'gi://Meta';

export const SNAPPABLE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

// Property notifications that accompany a change of the maximized state
// (Mutter 49+ has a single `maximized` property, older versions two).
export const MAXIMIZE_NOTIFY_SIGNALS = ['maximized', 'maximized-horizontally', 'maximized-vertically']
    .filter(name => Meta.Window.find_property(name) !== null)
    .map(name => `notify::${name}`);

// Mutter 49 dropped the horizontal/vertical maximize flags. Older versions
// still expose get_maximized() and expect the flags argument.
export function isMaximized(window) {
    if (window.get_maximized)
        return window.get_maximized() !== 0;
    return window.is_maximized();
}

export function maximize(window) {
    if (window.get_maximized)
        window.maximize(Meta.MaximizeFlags.BOTH);
    else
        window.maximize();
}

export function unmaximize(window) {
    if (window.get_maximized)
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    else
        window.unmaximize();
}
