# Magnetic Field

Magnet-style window management for GNOME Shell. Snap windows into halves,
quarters and thirds of the screen with keyboard shortcuts, or by dragging them
to a screen edge or corner. Inspired by [Magnet](https://magnet.crowdcafe.com/)
for macOS.

Tested on GNOME Shell 51 (Wayland). The code has compatibility branches for
GNOME 45-50 but those versions have not been tested.

## Features

- Snap the focused window to the **left / right / top / bottom half**.
- Snap to any **quarter** of the screen.
- Snap to the **left / center / right third** or to **two thirds**.
- **Maximize**, **center** and **restore** the previous size and position.
- **Move a window to the next or previous display**, keeping its zone.
- **Tiling and layouts**: Arrange tiles all windows of the workspace, the
  focused one in the left column. Tiled windows share their edges: resizing
  one resizes its neighbours live, and windows can be swapped by dragging or
  with the keyboard. Save the arrangement under a name and restore it later;
  restoring reuses open windows and launches the apps that are missing.
  Layouts store proportions, so they work on any screen size.
- **Drag to snap**: drag a window to an edge or corner, a translucent preview
  shows where it will land, release to snap.
- **Top bar menu**: a magnet icon in the top bar lists every action with its
  shortcut, toggles drag snapping and opens a help dialog with a map of the
  drag zones. It can be hidden in the preferences.
- Optional **gap** between snapped windows.
- All shortcuts and drag parameters are configurable in the preferences.

## Default shortcuts

Magnet uses Ctrl+Option on macOS. On GNOME, Ctrl+Alt+Arrows switch
workspaces, so Magnetic Field uses Super+Ctrl instead. Every shortcut can be
changed in the preferences.

| Action                   | Shortcut                 |
|--------------------------|--------------------------|
| Left half                | Super+Ctrl+Left          |
| Right half               | Super+Ctrl+Right         |
| Top half                 | Super+Ctrl+Up            |
| Bottom half              | Super+Ctrl+Down          |
| Top left quarter         | Super+Ctrl+U             |
| Top right quarter        | Super+Ctrl+I             |
| Bottom left quarter      | Super+Ctrl+J             |
| Bottom right quarter     | Super+Ctrl+K             |
| Left third               | Super+Ctrl+D             |
| Center third             | Super+Ctrl+F             |
| Right third              | Super+Ctrl+G             |
| Left two thirds          | Super+Ctrl+E             |
| Right two thirds         | Super+Ctrl+T             |
| Maximize                 | Super+Ctrl+Enter         |
| Center                   | Super+Ctrl+C             |
| Restore                  | Super+Ctrl+Backspace     |
| Next display             | Super+Ctrl+Alt+Right     |
| Previous display         | Super+Ctrl+Alt+Left      |
| Arrange windows          | Super+Ctrl+A             |
| Save layout              | Super+Ctrl+S             |
| Restore last layout      | Super+Ctrl+L             |
| Swap left / right        | Super+Ctrl+Shift+Left / Right |
| Swap up / down           | Super+Ctrl+Shift+Up / Down    |
| Release from tiling      | Super+Ctrl+Shift+Backspace    |

## Top bar menu

Clicking the magnet icon opens a menu with all actions grouped as in the
preferences. Each item shows a miniature of the target area and its current
shortcut. Picking an item moves the window that was focused when the menu was
opened; items that cannot apply to that window (Restore before a snap, display
moves with a single monitor) are greyed out or hidden. Below the actions:

- **Layouts** opens a submenu with Arrange windows, Save layout, Restore last
  layout, the swap actions, Release from tiling and the **Linked resizing**
  switch,
- **Saved layouts** lists the saved layouts; picking one restores it,
- **Drag to snap** switches drag snapping on and off,
- **Help** opens a dialog with a map of the drag zones and a short how-to,
- **Settings** opens the preferences.

## Tiling and layouts

1. Open the apps you want, for example Visual Studio Code, Tilix and Firefox.
2. **Arrange windows** (Super+Ctrl+A) tiles every window of the current
   workspace, one tiling per monitor. The focused window gets the left
   column; the others fill the columns to its right in the order they had on
   screen (left to right, then top to bottom). The number of columns is the
   square root of the number of windows, rounded up, and the first columns
   get the fewest windows:

   ```
   3 windows        4 windows        5 windows
   +-----+-----+    +-----+-----+    +---+---+---+
   |     |  2  |    |  1  |  3  |    |   | 2 | 4 |
   |  1  +-----+    +-----+-----+    | 1 +---+---+
   |     |  3  |    |  2  |  4  |    |   | 3 | 5 |
   +-----+-----+    +-----+-----+    +---+---+---+
   ```

3. Adjust the tiling:
   - **Resize** a window by dragging its edge: the divider moves and the
     windows on the other side shrink or grow with it, live. Switch this off
     with **Linked resizing** in the menu or the preferences; a window resized
     by hand then leaves the tiling.
   - **Swap** two windows by dragging one onto the other (a preview shows the
     target) or with Super+Ctrl+Shift+arrow, which swaps with the neighbour
     sharing the longest stretch of that edge. A window dropped anywhere else
     returns to its cell.
   - A window **leaves the tiling** when it is closed, minimized, maximized,
     made fullscreen, snapped to a zone (by shortcut or by dragging it to a
     screen edge, zones win over swapping), moved to another monitor or
     workspace, or released with Super+Ctrl+Shift+Backspace. Its neighbours
     take its space.
4. **Save layout** (Super+Ctrl+S) asks for a name and stores the apps with
   the proportions of the tiling. Saving under an existing name replaces that
   layout. Save works at any time: windows that are not tiled yet (placed by
   hand or snapped to zones) are tiled where they are first. The dividers go
   between the windows, gaps are shared by the neighbours, and windows
   overlapping too much to be separated by straight lines are arranged as in
   step 2.
5. Later, pick the layout in the **Saved layouts** submenu of the top bar
   menu, or press Super+Ctrl+L for the layout saved or restored last.

What restoring does:

- Each saved window is paired with an open window of the same app on the
  current workspace; every open window is used once. Paired windows are
  tiled again (and unminimized).
- Apps without a matching window are launched: the app itself if it is not
  running, otherwise a new window of it. Their cells stay empty until the
  windows appear. After 30 seconds the extension stops waiting and gives the
  empty cells to their neighbours.
- The tiling of a monitor that is no longer connected goes to the primary
  monitor.
- Windows that do not belong to an installed app (no `.desktop` file) are
  matched by their window class but cannot be launched.

A window cannot be made smaller than its minimum size. If a neighbour would
have to shrink below it, the divider stops there.

Layouts can be renamed and deleted in the preferences, on the Layouts page.

## Drag zones

While dragging a window, moving the pointer into one of the zones below shows
a preview. Releasing the window there snaps it. The corner zones extend
`corner-size` pixels along each edge (150 px by default), the edge band is
`edge-threshold` pixels wide (24 px by default).

```
+----------+------------------------+----------+
| top-left |        maximize        | top-rght |
| quarter  |                        | quarter  |
+----------+                        +----------+
|          |                        |          |
| left     |                        |    right |
| half     |                        |     half |
|          |                        |          |
+----------+--------+-------+-------+----------+
| bottom-l |  left  | centr | right | bottom-r |
| quarter  |  third | third | third | quarter  |
+----------+--------+-------+-------+----------+
```

GNOME's built-in edge tiling (`org.gnome.mutter edge-tiling`) would fight with
these zones, so the extension turns it off while drag snapping is enabled and
restores the previous value when the extension is disabled or drag snapping is
switched off.

## Installation

```sh
just install
```

This compiles the GSettings schema and copies the extension to
`~/.local/share/gnome-shell/extensions/magnetic-field@petr.malasek.gmail.com`.

On Wayland the running Shell does not pick up new extensions until you log out
and back in. After that:

```sh
just enable          # gnome-extensions enable magnetic-field@petr.malasek.gmail.com
just prefs           # open the preferences window
```

On X11 you can restart the Shell instead of logging out: press Alt+F2, type
`r`, press Enter.

To build a zip for extensions.gnome.org:

```sh
just zip
```

## Settings

Open them with `just prefs` or from the Extensions app.

| Key               | Default | Meaning                                                      |
|-------------------|---------|--------------------------------------------------------------|
| `show-indicator`  | true    | Show the magnet icon and its menu in the top bar             |
| `window-gap`      | 0       | Pixels between snapped windows and the screen edges          |
| `drag-snapping`   | true    | Enable snapping by dragging                                  |
| `show-preview`    | true    | Show the translucent preview while dragging                  |
| `edge-threshold`  | 24      | Width in pixels of the band along the edges that triggers    |
| `corner-size`     | 150     | Length in pixels of the corner zones along each edge         |
| `linked-resizing` | true    | Tiled windows resize their neighbours                        |
| `layouts`         | ''      | Saved layouts as JSON (see the schema for the format)        |
| `last-layout`     | ''      | Name of the layout saved or restored last                    |

The shortcut keys are listed in `schemas/*.gschema.xml`. You can also change
them from the command line, for example:

```sh
gsettings --schemadir schemas set org.gnome.shell.extensions.magnetic-field \
    snap-left-half "['<Super><Control>Left']"
```

## Project layout

```
extension.js        Shell-side code: keybindings, drag detection, window placement
indicator.js        Top bar icon and its menu
helpDialog.js       Help dialog with the drag zone map, opened from the menu
layoutDialog.js     Dialog that asks for the name of a layout to save
actions.js          Zone geometry and the list of actions, shared with prefs.js
layouts.js          Layout geometry and JSON format, shared with prefs.js
tiling.js           Split trees: arrange, resize, swap, remove (pure, unit tested)
tilingManager.js    Tiling groups on the Shell side: signals, live resizing, swaps
windowUtils.js      Window helpers shared by extension.js and tilingManager.js
prefs.js            Preferences window (GTK4 + libadwaita), runs in a separate process
metadata.json       UUID, name, supported Shell versions, schema id
stylesheet.css      Style of the drag preview, the menu and the help dialog
icons/              Symbolic top bar icon
schemas/            GSettings schema (must be compiled, see justfile)
tests/smoke-test.sh Headless end-to-end test (just test)
tests/tiling-test.js Unit tests of tiling.js and layouts.js (just unit)
justfile            install / zip / log / devkit / headless / test recipes
```

## Debugging and development

### Where the logs are

`extension.js` runs inside the `gnome-shell` process, `prefs.js` runs in a
separate `gjs` process started on demand. Each has its own log:

```sh
just log             # journalctl -f -o cat /usr/bin/gnome-shell
just log-prefs       # journalctl -f -o cat /usr/bin/gjs
```

Use `console.log()`, `console.warn()` and `console.error()` in the code. Stack
traces of uncaught exceptions land in the same log. Errors that happen while
the extension is enabled or disabled are also shown by:

```sh
gnome-extensions info magnetic-field@petr.malasek.gmail.com
```

If the state there is `ERROR`, the message is the first line of the exception;
the full trace is in the `gnome-shell` log.

### Reloading code

GNOME Shell loads an extension's JavaScript once per session. On Wayland there
is no way to reload it short of logging out, so during development you run a
second Shell. GNOME 49 removed the old `gnome-shell --nested` mode, which
leaves three options:

1. **Mutter DevKit** shows the second Shell in a window on your desktop:

   ```sh
   just devkit        # dbus-run-session -- gnome-shell --devkit --unsafe-mode
   ```

   It needs Mutter built with devkit support and the `mutter-devkit` package.
   On some distributions (CachyOS / Arch with GNOME 51 at the time of writing)
   the flag is missing from `gnome-shell --help`; then use one of the other
   two options.

2. **Headless Shell** runs invisibly with a virtual 1920x1080 monitor:

   ```sh
   just headless
   ```

   You cannot see it, but with `--unsafe-mode` you can drive it over D-Bus,
   which is what the smoke test does (see "Scripted testing" below). This works
   everywhere and is the fastest loop for logic changes.

3. **A second real session** on another virtual terminal (Ctrl+Alt+F3, log in
   as the same user, `dbus-run-session -- gnome-shell --wayland --display-server`).
   Slow, but it is the only way to try the drag preview by hand without logging
   out of your main session.

All of them use `GSETTINGS_BACKEND=memory`, so nothing you enable or change
inside the second Shell touches your real session; enable the extension again
inside it:

```sh
gnome-extensions enable magnetic-field@petr.malasek.gmail.com
```

Shell output, including every `console.log()` from the extension, goes to the
terminal that started it.

After changing `extension.js`: `just install`, stop the second Shell, start it
again. After changing `prefs.js`: just close and reopen the preferences window,
it is a new process every time. After changing the schema: `just install`
(the justfile recompiles it) and restart whatever holds the settings.

### Scripted testing

```sh
just unit            # split tree and layout format, plain gjs, no Shell
just test            # unit tests, then the headless smoke test
```

`just test` builds the zip first, so the test also catches files missing from
the package. `tests/smoke-test.sh` unpacks the zip into a temporary
`XDG_DATA_HOME` (your installed copy in `~/.local/share` is neither used nor
touched), starts a headless Shell in its own D-Bus session, enables the
extension, opens GNOME Text Editor and Calculator and calls into the live
extension object through `org.gnome.Shell.Eval`:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval \
    "Main.extensionManager.lookup('magnetic-field@petr.malasek.gmail.com').stateObj._onAction('snap-left-half')"
```

It checks the zone geometry, every keyboard action, a window with a minimum
size, a simulated drag with a virtual pointer (`Clutter.VirtualInputDevice`,
relative motion only: absolute motion ignores x in the headless backend), the
top bar menu (shortcut labels, acting on the focused window, the drag switch,
the help dialog, hiding the icon), tiling (arranging two and three windows,
live linked resizing, swapping by keyboard and by dragging, zones taking a
window out, closing a window), layouts (save, restore, launching a closed app
into its cell, the save dialog, the menu of saved layouts), the preferences
window, and that
`org.gnome.mutter edge-tiling` is restored on disable. Each check prints
`PASS` or `FAIL`; the Shell log is left in `/tmp/magnetic-field-shell.log`.
`Eval` only works with `--unsafe-mode`, never in a normal session.

The same technique is handy interactively: start `just headless` in one
terminal, then in another terminal run `gdbus` commands against it. To reach
the headless session's bus, start the Shell from a script under
`dbus-run-session` as the smoke test does, or note the `DBUS_SESSION_BUS_ADDRESS`
it prints.

### Looking Glass

GNOME Shell has a built-in inspector. Press Alt+F2, type `lg`, press Enter
(works in a devkit Shell too). Useful bits:

- **Extensions** tab: state of every extension, with a button to open the
  log of errors for that extension.
- **Evaluator** tab: run JavaScript in the Shell context. For example
  `global.display.focus_window.get_frame_rect()` or
  `Main.extensionManager.lookup('magnetic-field@petr.malasek.gmail.com').stateObj`
  gives you the live extension instance, so you can call
  `._zoneRect('snap-left-half', 0)` or inspect `._originals`.
- **Windows** tab: lists the window actors with their geometry.
- The **picker** (crosshair icon) lets you click an actor on screen and inspect
  it, handy for checking the preview widget.

### Testing the preferences on their own

```sh
just prefs
```

This asks the Shell to launch the preferences process; errors show up in
`just log-prefs`. Because the window is a fresh process you can iterate on
`prefs.js` without touching the Shell at all. Since GNOME 45 the window runs
inside the `org.gnome.Shell.Extensions` service (a `gjs` process), so the
process name you will see is `gjs`, not `gnome-extensions`.

### Typical problems

- **Extension does not appear** in `gnome-extensions list`: the directory name
  must equal the `uuid` in `metadata.json`, and on Wayland you must log out and
  in after the first install.
- **"Schema ... not found"**: `schemas/gschemas.compiled` is missing or stale.
  Run `just schemas` (or `just install`, which does it) and check that
  `settings-schema` in `metadata.json` matches the `id` in the XML.
- **A shortcut does nothing**: another binding wins. Check with
  `gsettings list-recursively org.gnome.desktop.wm.keybindings | grep -i '<Super><Control>'`
  and the same for `org.gnome.mutter.keybindings` and
  `org.gnome.shell.keybindings`.
- **Drag snapping and GNOME's own tiling both react**: edge tiling was turned
  back on while the extension was active. Check with
  `gsettings get org.gnome.mutter edge-tiling`; the extension restores the
  value stored in its `edge-tiling-previous` key when it is disabled.
- **A maximized window ignores the snap**: `allows_resize()` is false while
  a window is maximized or fullscreen, so do not use it as the eligibility
  check; the code uses the `resizeable` property. `_moveResize()` unmaximizes
  first and, if the window has not reported the new state yet, waits for it
  (with a 500 ms fallback) before sending the new geometry.
- **A window lands at the right size but the wrong place**: the client refused
  the size (minimum size hints), and Mutter then keeps the old position too.
  `_moveResize()` re-sends the position once the client has answered; check
  the shell log if that does not happen.

- **A neighbour does not shrink when I resize a tiled window**: it is at its
  minimum size, so the divider stops. During the drag a window that cannot
  shrink further keeps its minimum size; the final position is exact.
- **A layout restores but an app's window is not placed**: the app could not
  open another window (single-instance apps that refuse a new window), it did
  not appear within 30 seconds, or its window reports a different app than the
  one saved. `gsettings get org.gnome.shell.extensions.magnetic-field layouts`
  shows what was saved; the `app` field must name an installed `.desktop` file.

### Code style

GNOME Shell extensions use ES modules and the GJS flavour of JavaScript. The
upstream lint rules can be applied with
[eslint and the gnome-shell config](https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/lint).
The review guidelines for extensions.gnome.org are at
<https://gjs.guide/extensions/review-guidelines/review-guidelines.html>; the
important ones for this code base: disconnect every signal and remove every
timeout in `disable()`, and never keep Shell objects alive after that.

### Release checklist

1. Bump `version` in `metadata.json`.
2. `just zip` and install the zip on a clean session with
   `gnome-extensions install --force <zip>`.
3. `just test` must pass.
4. Enable, run through the shortcuts and the drag zones by hand, disable, and
   confirm `gsettings get org.gnome.mutter edge-tiling` is back to its old
   value.
