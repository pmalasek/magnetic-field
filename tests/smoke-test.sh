#!/bin/sh
# Smoke test for Magnetic Field.
#
# Starts a headless GNOME Shell (virtual 1920x1080 monitor, private D-Bus
# session, in-memory GSettings, --unsafe-mode so org.gnome.Shell.Eval works),
# installs the extension zip into a temporary XDG_DATA_HOME, enables it, opens
# two windows and drives the extension through Eval. Nothing is displayed and
# neither your real session nor your installed extensions are touched.
#
# Usage:  just test                  (builds the zip first)
#         tests/smoke-test.sh [ZIP]  (defaults to the zip in the project root)
#
# Requirements: gnome-shell, gnome-text-editor, gnome-calculator, gdbus, unzip.
# The Shell log is kept in $TMPDIR/magnetic-field-shell.log.

set -u
UUID=magnetic-field@petr.malasek.gmail.com
SHELL_LOG=${TMPDIR:-/tmp}/magnetic-field-shell.log

# --- outer part: set up an isolated session and re-run this script inside -----
if [ -z "${MF_INNER:-}" ]; then
    # Wayland socket paths are limited to 108 bytes, so keep the runtime dir short.
    RT=$(mktemp -d /tmp/mf-rt.XXXXXX) || exit 1
    chmod 700 "$RT"
    ZIP=${1:-$(dirname "$0")/../$UUID.shell-extension.zip}
    DEST=$RT/data/gnome-shell/extensions/$UUID
    mkdir -p "$DEST"
    # Like `gnome-extensions install`, which also compiles the schema (the zip
    # only carries the XML). That tool cannot move directories across file
    # systems, so unpack by hand.
    if ! unzip -q "$ZIP" -d "$DEST" || ! glib-compile-schemas "$DEST/schemas"; then
        echo "cannot install $ZIP, run 'just zip' first" >&2
        rm -rf "$RT"
        exit 1
    fi
    MF_INNER=1 XDG_RUNTIME_DIR=$RT XDG_DATA_HOME=$RT/data GSETTINGS_BACKEND=memory \
        dbus-run-session -- "$0"
    status=$?
    # the document and gvfs portals leave FUSE mounts behind
    fusermount3 -u "$RT/doc" 2>/dev/null
    fusermount3 -u "$RT/gvfs" 2>/dev/null
    rm -rf "$RT" 2>/dev/null
    exit $status
fi

# --- inner part: runs inside dbus-run-session ---------------------------------
export WAYLAND_DISPLAY=mf-test
export GDK_BACKEND=wayland
unset DISPLAY

gnome-shell --headless --no-x11 --virtual-monitor 1920x1080 --wayland \
    --wayland-display="$WAYLAND_DISPLAY" --unsafe-mode >"$SHELL_LOG" 2>&1 &
SHELL_PID=$!

APP_PIDS=""
cleanup() {
    # shellcheck disable=SC2086
    kill $APP_PIDS "$SHELL_PID" 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 40); do
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 && break
    sleep 0.5
done

FAIL=0
ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1 |
        sed -e "s/^(true, '\"\\{0,1\\}//" -e "s/\"\\{0,1\\}')\$//"
}
check() { # label expected actual
    if [ "$2" = "$3" ]; then
        echo "PASS  $1: $3"
    else
        echo "FAIL  $1: expected [$2] got [$3]"
        FAIL=$((FAIL + 1))
    fi
}
check_prefix() { # label expected-prefix actual
    case "$3" in
    "$2"*) echo "PASS  $1: $3" ;;
    *) echo "FAIL  $1: expected prefix [$2] got [$3]"; FAIL=$((FAIL + 1)) ;;
    esac
}

EXT="Main.extensionManager.lookup('$UUID').stateObj"
R='const R = r => [r.x, r.y, r.width, r.height].join(",");'
focus() {
    # A window that maps late can take the focus back, so retry a few times.
    for _ in 1 2 3 4 5; do
        result=$(ev "const w = global.get_window_actors().map(a => a.meta_window).find(x => x.get_wm_class() === '$1'); if (w) Main.activateWindow(w); w ? 'ok' : 'missing'")
        sleep 0.5
        [ "$(ev "global.display.focus_window?.get_wm_class()")" = "$1" ] && break
        result="focus is on $(ev "global.display.focus_window?.get_wm_class()")"
    done
    echo "$result"
}
# The extension state may take a moment to settle after enable/disable.
ext_state() { # expected
    for _ in $(seq 1 20); do
        state=$(gnome-extensions info "$UUID" 2>/dev/null |
            sed -n 's/.*: *\(ACTIVE\|ERROR\|INACTIVE\|OUT OF DATE\).*/\1/p')
        [ "$state" = "$1" ] && break
        sleep 0.5
    done
    echo "$state"
}
rect() {
    ev "$R const w = global.display.focus_window; R(w.get_frame_rect()) + (w.is_maximized() ? ' max' : '')"
}
action() {
    ev "$EXT._onAction('$1'); 'ok'" >/dev/null
    sleep 1.5
}
# Poll an Eval expression until it gives the expected value (up to 30 s).
wait_for() { # label expected expression
    for _ in $(seq 1 60); do
        result=$(ev "$3")
        [ "$result" = "$2" ] && break
        sleep 0.5
    done
    check "$1" "$2" "$result"
}

echo "== extension"
gnome-extensions enable "$UUID"
sleep 2
check "state" "ACTIVE" "$(ext_state ACTIVE)"
check "edge tiling overridden" "mutter=false overridden=true previous=true" \
    "$(ev "'mutter=' + $EXT._mutterSettings.get_boolean('edge-tiling') + ' overridden=' + $EXT._settings.get_boolean('edge-tiling-overridden') + ' previous=' + $EXT._settings.get_boolean('edge-tiling-previous')")"

echo "== zone geometry (work area 0,32,1920,1048)"
check "work area" "0,32,1920,1048" "$(ev "$R R(Main.layoutManager.getWorkAreaForMonitor(0))")"
check "zone at left edge" "snap-left-half" "$(ev "$EXT._zoneAtPointer(10, 540).zone")"
check "zone at top-left corner" "snap-top-left-quarter" "$(ev "$EXT._zoneAtPointer(0, 0).zone")"
check "zone at top edge" "snap-maximize" "$(ev "$EXT._zoneAtPointer(960, 0).zone")"
check "zone at bottom edge" "snap-center-third" "$(ev "$EXT._zoneAtPointer(960, 1079).zone")"
check "zone at bottom-right corner" "snap-bottom-right-quarter" "$(ev "$EXT._zoneAtPointer(1919, 1079).zone")"
check "no zone in the middle" "null" "$(ev "$EXT._zoneAtPointer(500, 500)")"
check "gap 10 left half" "10,42,945,1028" \
    "$(ev "$R $EXT._settings.set_int('window-gap', 10); const r = R($EXT._zoneRect('snap-left-half', 0)); $EXT._settings.set_int('window-gap', 0); r")"

echo "== keyboard actions on a text editor window"
gnome-text-editor >/dev/null 2>&1 &
APP_PIDS="$APP_PIDS $!"
gnome-calculator >/dev/null 2>&1 &
APP_PIDS="$APP_PIDS $!"
sleep 5
check "editor focused" "ok" "$(focus org.gnome.TextEditor)"
ORIGINAL=$(rect)
echo "      original: $ORIGINAL"
action snap-left-half;            check "left half" "0,32,960,1048" "$(rect)"
action snap-bottom-right-quarter; check "bottom right quarter" "960,556,960,524" "$(rect)"
action snap-maximize;             check "maximize" "0,32,1920,1048 max" "$(rect)"
action snap-center-third;         check "center third after maximize" "640,32,640,1048" "$(rect)"
action snap-right-two-thirds;     check "right two thirds" "640,32,1280,1048" "$(rect)"
action snap-center-two-thirds;    check "center two thirds" "320,32,1280,1048" "$(rect)"
action center-window
check "center" "centered" "$(ev "$R const w = global.display.focus_window; const f = w.get_frame_rect(); const wa = Main.layoutManager.getWorkAreaForMonitor(0); (f.x === wa.x + Math.round((wa.width - f.width) / 2) && f.y === wa.y + Math.round((wa.height - f.height) / 2)) ? 'centered' : 'off: ' + R(f)")"
action restore-window;            check "restore" "$ORIGINAL" "$(rect)"
check "no original kept after restore" "0" "$(ev "$EXT._originals.size")"

echo "== window with a minimum size (calculator) keeps the requested position"
check "calculator focused" "ok" "$(focus org.gnome.Calculator)"
action snap-bottom-right-quarter; check_prefix "bottom right quarter x" "960," "$(rect)"

echo "== drag to snap (virtual pointer)"
# ClutterVirtualInputDevice works in the headless backend. Absolute motion
# does not apply the x coordinate there, so move relative to a known origin.
check "virtual pointer" "ok" "$(ev "const Clutter = imports.gi.Clutter; const seat = global.stage.context.get_backend().get_default_seat(); globalThis.__mfPointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE); __mfPointer ? 'ok' : 'none'")"
move_pointer() {
    ev "const [x, y] = global.get_pointer(); globalThis.__mfPointer.notify_relative_motion(GLib.get_monotonic_time(), $1 - x, $2 - y); 'ok'" >/dev/null
    sleep 0.3
}
check "editor focused" "ok" "$(focus org.gnome.TextEditor)"
move_pointer 600 400
ev "$EXT._onGrabBegin(global.display.focus_window, Meta.GrabOp.MOVING); 'ok'" >/dev/null
check "polling while dragging" "true" "$(ev "$EXT._pollId !== 0")"
check "no zone in the middle" "null" "$(ev "$EXT._dragZone")"
move_pointer 3 540
check "pointer moved" "3,540" "$(ev "global.get_pointer().slice(0, 2).join(',')")"
check "left edge zone" "snap-left-half" "$(ev "$EXT._dragZone")"
check "preview visible" "true/255" "$(ev "$EXT._preview.visible + '/' + $EXT._preview.opacity")"
move_pointer 1915 1075
check "bottom right corner zone" "snap-bottom-right-quarter" "$(ev "$EXT._dragZone")"
move_pointer 700 1078
check "bottom edge zone" "snap-center-third" "$(ev "$EXT._dragZone")"
ev "$EXT._onGrabEnd(global.display.focus_window, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "polling stopped" "false" "$(ev "$EXT._pollId !== 0")"
check "dropped into center third" "640,32,640,1048" "$(rect)"

echo "== top bar indicator"
IND="Main.panel.statusArea['$UUID']"
check "indicator in the panel" "true" "$(ev "!!$IND")"
check "editor focused" "ok" "$(focus org.gnome.TextEditor)"
action snap-left-half
ev "$IND.menu.open(false); 'ok'" >/dev/null
sleep 0.5
check "menu open" "true" "$(ev "$IND.menu.isOpen")"
check "target is the focused window" "org.gnome.TextEditor" "$(ev "$IND._targetWindow.get_wm_class()")"
check "shortcut label" "Super+Ctrl+←" "$(ev "$IND._items.get('snap-left-half').shortcut")"
check "shortcut label with Alt" "Super+Ctrl+Alt+→" "$(ev "$IND._items.get('move-to-next-display').shortcut")"
check "displays hidden with one monitor" "false" "$(ev "$IND._displaySection.actor.visible")"
check "restore available after a snap" "true" "$(ev "$IND._items.get('restore-window').sensitive")"
ev "const Clutter = imports.gi.Clutter; $IND._items.get('snap-right-half').activate(Clutter.get_current_event()); 'ok'" >/dev/null
sleep 1.5
check "menu closed after activation" "false" "$(ev "$IND.menu.isOpen")"
check "menu item snapped right half" "960,32,960,1048" "$(rect)"
ev "$IND.menu.open(false); $IND._dragSwitch.toggle(); $IND.menu.close(false); 'ok'" >/dev/null
check "drag switch turns drag snapping off" "false" "$(ev "$EXT._settings.get_boolean('drag-snapping')")"
ev "$IND.menu.open(false); $IND._dragSwitch.toggle(); $IND.menu.close(false); 'ok'" >/dev/null
check "drag switch turns drag snapping on" "true" "$(ev "$EXT._settings.get_boolean('drag-snapping')")"
ev "$IND._showHelp(); 'ok'" >/dev/null
sleep 1
check "help dialog open" "true" "$(ev "$IND._helpDialog?.state === 0")"
ev "$IND._helpDialog.close(); 'ok'" >/dev/null
sleep 1
check "help dialog closed and destroyed" "false" "$(ev "!!$IND._helpDialog")"
ev "$EXT._settings.set_boolean('show-indicator', false); 'ok'" >/dev/null
check "indicator hidden by setting" "false" "$(ev "!!$IND")"
ev "$EXT._settings.set_boolean('show-indicator', true); 'ok'" >/dev/null
check "indicator shown again" "true" "$(ev "!!$IND")"

echo "== tiling"
WINS="global.get_window_actors().map(a => a.meta_window)"
# JS expression for the n-th window (0-based, in creation order) of a class.
win() {
    echo "($WINS.filter(x => x.get_wm_class() === '$1').sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence())[$2])"
}
E1=$(win org.gnome.TextEditor 0)
E2=$(win org.gnome.TextEditor 1)
CALC=$(win org.gnome.Calculator 0)
rect_w() { # JS window expression
    ev "$R const w = $1; w ? R(w.get_frame_rect()) : 'missing'"
}
focus_w() { # JS window expression
    ev "Main.activateWindow($1); 'ok'" >/dev/null
    sleep 0.5
}
tiled() { # JS window expressions
    list=$(printf '%s,' "$@")
    ev "[$list].map(w => $EXT._tiling.isTiled(w)).join(' ')"
}
LAYOUT_NAMES="$EXT._getLayouts().map(l => l.name + ':' + (JSON.stringify(l.monitors).match(/wmClass/g) || []).length).join(',')"

focus_w "$E1"
ev "$EXT._onAction('arrange-windows'); 'ok'" >/dev/null
sleep 1.5
check "arrange 2: focused window on the left" "0,32,960,1048" "$(rect_w "$E1")"
check "arrange 2: other window on the right" "960,32,960,1048" "$(rect_w "$CALC")"
check "arranged windows are tiled" "true true" "$(tiled "$E1" "$CALC")"

echo "== layouts: save and restore"
check "save" "ok" "$(ev "$EXT._saveLayout('Dev1') ? 'ok' : 'empty'")"
check "saved layouts" "Dev1:2" "$(ev "$LAYOUT_NAMES")"
check "saved tree" "2 v 0.5 org.gnome.TextEditor.desktop org.gnome.Calculator" \
    "$(ev "const d = JSON.parse($EXT._settings.get_string('layouts')); const t = d.layouts[0].monitors[0].tree; [d.version, t.split, t.ratio, t.a.app, t.b.wmClass].join(' ')")"
check "last layout" "Dev1" "$(ev "$EXT._settings.get_string('last-layout')")"
check "save again replaces" "Dev1:2" "$(ev "$EXT._saveLayout('Dev1'); $LAYOUT_NAMES")"
focus_w "$E1"
action snap-bottom-right-quarter
check "a zone takes the window out of the tiling" "false true" "$(tiled "$E1" "$CALC")"
check "the neighbour takes its space" "0,32,1920,1048" "$(rect_w "$CALC")"
check "the window is in the zone" "960,556,960,524" "$(rect_w "$E1")"
check "restore" "true" "$(ev "$EXT._restoreLayout('Dev1')")"
sleep 2
check "restore: editor back on the left" "0,32,960,1048" "$(rect_w "$E1")"
check "restore: calculator back on the right" "960,32,960,1048" "$(rect_w "$CALC")"
check "restore: tiled again" "true true" "$(tiled "$E1" "$CALC")"
check "nothing left to launch" "false" "$(ev "!!$EXT._layoutRestore")"
check "unknown layout" "false" "$(ev "$EXT._restoreLayout('nope')")"
ev "$CALC.delete(global.get_current_time()); 'ok'" >/dev/null
wait_for "calculator closed" "missing" "$R const w = $CALC; w ? R(w.get_frame_rect()) : 'missing'"
check "the last window fills the screen" "0,32,1920,1048" "$(rect_w "$E1")"
focus_w "$E1"
action snap-maximize
check "maximizing takes the window out" "false" "$(tiled "$E1")"
check "restore launches the missing app" "true" "$(ev "$EXT._restoreLayout('Dev1')")"
wait_for "launched calculator fills its cell" "960,32,960,1048" "$R const w = $CALC; w ? R(w.get_frame_rect()) : 'missing'"
wait_for "restore finished" "false" "!!$EXT._layoutRestore"
check "maximized editor back on the left" "0,32,960,1048" "$(rect_w "$E1")"
check "both tiled after the launch" "true true" "$(tiled "$E1" "$CALC")"

echo "== tiling: three windows"
ev "Shell.AppSystem.get_default().lookup_app('org.gnome.TextEditor.desktop').open_new_window(-1); 'ok'" >/dev/null
wait_for "second editor window" "2" "$WINS.filter(x => x.get_wm_class() === 'org.gnome.TextEditor').length"
sleep 1
check "a new window is not tiled" "false" "$(tiled "$E2")"
focus_w "$E2"
action snap-top-left-quarter
focus_w "$E1"
ev "$EXT._onAction('arrange-windows'); 'ok'" >/dev/null
sleep 1.5
check "arrange 3: focused window alone on the left" "0,32,960,1048" "$(rect_w "$E1")"
check "arrange 3: top right" "960,32,960,524" "$(rect_w "$E2")"
check_prefix "arrange 3: bottom right" "960,556,960," "$(rect_w "$CALC")"

echo "== tiling: linked resizing"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.RESIZING_E); $E1.move_resize_frame(true, 0, 32, 1200, 1048); 'ok'" >/dev/null
sleep 1
check "live: top right follows the divider" "1200,32,720,524" "$(rect_w "$E2")"
check_prefix "live: bottom right follows the divider" "1200,556,720," "$(rect_w "$CALC")"
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.RESIZING_E); 'ok'" >/dev/null
sleep 1.5
check "divider ratio" "0.625" "$(ev "$EXT._tiling.groupOf($E1).tree.ratio")"
check "resized window fills its cell" "0,32,1200,1048" "$(rect_w "$E1")"
check "still tiled" "true true true" "$(tiled "$E1" "$E2" "$CALC")"
ev "$EXT._onGrabBegin($E2, Meta.GrabOp.RESIZING_S); $E2.move_resize_frame(true, 1200, 32, 720, 400); 'ok'" >/dev/null
sleep 1
ev "$EXT._onGrabEnd($E2, Meta.GrabOp.RESIZING_S); 'ok'" >/dev/null
sleep 1.5
check "bottom edge: window above shrinks" "1200,32,720,400" "$(rect_w "$E2")"
check "bottom edge: window below grows" "1200,432,720,648" "$(rect_w "$CALC")"
check "left column untouched" "0,32,1200,1048" "$(rect_w "$E1")"

echo "== tiling: swapping"
focus_w "$E1"
check "swap right available" "true" "$(ev "$EXT.canPerform('swap-right', $E1)")"
check "nothing to swap with on the left" "false" "$(ev "$EXT.canPerform('swap-left', $E1)")"
action swap-right
check "swap right: the neighbour sharing most of the edge" "1200,432,720,648" "$(rect_w "$E1")"
check "swap right: calculator in the left column" "0,32,1200,1048" "$(rect_w "$CALC")"
action swap-left
check "swap left: back" "0,32,1200,1048" "$(rect_w "$E1")"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 1560 232
check "drag onto the middle of another window: swap" "true center" "$(ev "($EXT._dropTarget?.window === $E2) + ' ' + $EXT._dropTarget?.region")"
check "drag onto another window: preview" "true" "$(ev "$EXT._preview.visible")"
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "dropped: windows swapped" "1200,32,720,400" "$(rect_w "$E1")"
check "dropped: other window in the dragged one's cell" "0,32,1200,1048" "$(rect_w "$E2")"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 1560 900
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "dropped onto the calculator" "1200,432,720,648" "$(rect_w "$E1")"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 1300 300
check "near the edge of another window: split" "left" "$(ev "$EXT._dropTarget?.region")"
ev "$E1.move_frame(true, 700, 300); 'ok'" >/dev/null
move_pointer 1500 800
check "over its own cell: no drop target" "false" "$(ev "!!$EXT._dropTarget")"
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "dropped onto its own cell after moving: back in place" "1200,432,720,648" "$(rect_w "$E1")"
ev "$EXT._onGrabBegin($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 3 540
check "zones win over dropping onto a window" "snap-left-half false" "$(ev "$EXT._dragZone + ' ' + !!$EXT._dropTarget")"
ev "$EXT._onGrabEnd($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "dropped into a zone: out of the tiling" "false" "$(tiled "$E2")"
check "dropped into a zone: snapped" "0,32,960,1048" "$(rect_w "$E2")"
check "the right column takes the whole width" "0,432,1920,648" "$(rect_w "$E1")"

echo "== tiling: linked resizing off"
ev "$EXT._settings.set_boolean('linked-resizing', false); 'ok'" >/dev/null
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.RESIZING_N); $E1.move_resize_frame(true, 0, 300, 1920, 780); 'ok'" >/dev/null
sleep 1
check "neighbour untouched (taller than its cell: minimum height)" "0,32,1920,616" "$(rect_w "$CALC")"
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.RESIZING_N); 'ok'" >/dev/null
sleep 1.5
check "resized window is on its own" "false" "$(tiled "$E1")"
check "the other window takes the space" "0,32,1920,1048" "$(rect_w "$CALC")"
ev "$EXT._settings.set_boolean('linked-resizing', true); 'ok'" >/dev/null

echo "== tiling: closing a window"
focus_w "$E1"
ev "$EXT._onAction('arrange-windows'); 'ok'" >/dev/null
sleep 1.5
check "three tiled" "true true true" "$(tiled "$E1" "$E2" "$CALC")"
# The window is closed by its client in the middle of a drag (like a browser
# tab dropped back onto the tab bar). Mutter then ends the grab for the
# unmanaged window; moving it there used to crash the Shell.
ev "$EXT._onGrabBegin($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 3 540
check "dragging the window into a zone" "snap-left-half" "$(ev "$EXT._dragZone")"
ev "globalThis.__mfClosed = $E2; __mfClosed.delete(global.get_current_time()); 'ok'" >/dev/null
wait_for "second editor closed" "1" "$WINS.filter(x => x.get_wm_class() === 'org.gnome.TextEditor').length"
check "closing the dragged window stops the drag" "false null true" \
    "$(ev "($EXT._pollId !== 0) + ' ' + $EXT._dragWindow + ' ' + $EXT._grab?.gone")"
check "grab end for the closed window is ignored" "ok null" \
    "$(ev "$EXT._onGrabEnd(__mfClosed, Meta.GrabOp.MOVING); delete globalThis.__mfClosed; 'ok ' + $EXT._grab")"
wait_for "the other window of its column takes the space" "960,32,960,1048" "$R R($CALC.get_frame_rect())"
check "release available" "true" "$(ev "$EXT.canPerform('untile-window', $E1)")"

echo "== layouts: dialog and menu"
ev "$EXT._onAction('save-layout'); 'ok'" >/dev/null
sleep 1
check "save dialog open" "true" "$(ev "$EXT._layoutDialog?.state === 0")"
check "save dialog prefilled" "Dev1" "$(ev "$EXT._layoutDialog._entry.get_text()")"
ev "$EXT._layoutDialog._entry.set_text('  '); 'ok'" >/dev/null
check "save disabled for a blank name" "false" "$(ev "$EXT._layoutDialog._saveButton.reactive")"
ev "$EXT._layoutDialog._entry.set_text('Dev2'); $EXT._layoutDialog._entry.clutter_text.activate(); 'ok'" >/dev/null
sleep 1
check "save dialog closed by Enter" "false" "$(ev "!!$EXT._layoutDialog")"
check "saved from the dialog" "Dev1:2,Dev2:2" "$(ev "$LAYOUT_NAMES")"
ev "$IND.menu.open(false); 'ok'" >/dev/null
sleep 0.5
check "menu lists saved layouts" "Dev1,Dev2" "$(ev "$IND._savedSection._getMenuItems().map(i => i.label.text).join(',')")"
check "arrange item enabled" "true" "$(ev "$IND._items.get('arrange-windows').sensitive")"
check "release item enabled for a tiled window" "true" "$(ev "$IND._items.get('untile-window').sensitive")"
ev "$IND._linkedSwitch.toggle(); 'ok'" >/dev/null
check "linked resizing switch off" "false" "$(ev "$EXT._settings.get_boolean('linked-resizing')")"
ev "$IND._linkedSwitch.toggle(); 'ok'" >/dev/null
check "linked resizing switch on" "true" "$(ev "$EXT._settings.get_boolean('linked-resizing')")"
ev "$IND.menu.close(false); 'ok'" >/dev/null
check "delete" "true" "$(ev "$EXT._deleteLayout('Dev2')")"
check "layouts after delete" "Dev1:2" "$(ev "$LAYOUT_NAMES")"
ev "$EXT._settings.set_string('layouts', 'not json'); 'ok'" >/dev/null
check "broken setting gives no layouts" "" "$(ev "$LAYOUT_NAMES")"
ev "$IND.menu.open(false); 'ok'" >/dev/null
sleep 0.5
check "menu shows the empty state" "No layouts saved yet" "$(ev "$IND._savedSection._getMenuItems().map(i => i.label.text).join(',')")"
ev "$IND.menu.close(false); 'ok'" >/dev/null
check "restore last layout unavailable" "false" "$(ev "$EXT.canPerform('restore-last-layout', null)")"
focus_w "$E1"
action untile-window
focus_w "$CALC"
action untile-window
check "released windows" "false false" "$(tiled "$E1" "$CALC")"
focus_w "$E1"
action snap-left-third
focus_w "$CALC"
action snap-right-two-thirds
check "save windows placed by hand" "ok" "$(ev "$EXT._saveLayout('Thirds') ? 'ok' : 'empty'")"
check "saved where they are" "v 0.333 org.gnome.TextEditor org.gnome.Calculator" \
    "$(ev "const t = $EXT._getLayouts().find(l => l.name === 'Thirds').monitors[0].tree; [t.split, t.ratio.toFixed(3), t.a.wmClass, t.b.wmClass].join(' ')")"
sleep 1.5
check "saving tiles them" "true true" "$(tiled "$E1" "$CALC")"
check "saving does not move them: left" "0,32,640,1048" "$(rect_w "$E1")"
check "saving does not move them: right" "640,32,1280,1048" "$(rect_w "$CALC")"
focus_w "$E1"
action snap-maximize
focus_w "$CALC"
action snap-maximize
check "restore after maximizing both" "true" "$(ev "$EXT._restoreLayout('Thirds')")"
sleep 2
check "restored: left third" "0,32,640,1048" "$(rect_w "$E1")"
check "restored: right two thirds" "640,32,1280,1048" "$(rect_w "$CALC")"
ev "$EXT._onAction('save-layout'); 'ok'" >/dev/null
sleep 1
check "save dialog opens any time" "true" "$(ev "$EXT._layoutDialog?.state === 0")"
ev "$EXT._layoutDialog.close(); 'ok'" >/dev/null
sleep 1
ev "$IND.menu.open(false); 'ok'" >/dev/null
sleep 0.5
check "saved layouts submenu" "Thirds" "$(ev "$IND._savedSection._getMenuItems().map(i => i.label.text).join(',')")"
ev "$IND._savedSection._getMenuItems()[0].activate(imports.gi.Clutter.get_current_event()); 'ok'" >/dev/null
sleep 1.5
check "picking a saved layout restores it" "Thirds" "$(ev "$EXT._settings.get_string('last-layout')")"

echo "== snapped windows: linked edges"
linked() { # JS window expressions
    list=$(printf '%s,' "$@")
    ev "[$list].map(w => $EXT._isLinked(w)).join(' ')"
}
ev "$EXT._tiling.releaseAll(); 'ok'" >/dev/null
focus_w "$E1"
action snap-left-half
focus_w "$CALC"
action snap-right-half
check "windows snapped to zones are linked" "true true" "$(linked "$E1" "$CALC")"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.RESIZING_E); $E1.move_resize_frame(true, 0, 32, 1200, 1048); 'ok'" >/dev/null
sleep 1
check "live: the neighbour follows the shared edge" "1200,32,720,1048" "$(rect_w "$CALC")"
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.RESIZING_E); 'ok'" >/dev/null
sleep 1.5
check "after the resize" "0,32,1200,1048 1200,32,720,1048" "$(rect_w "$E1") $(rect_w "$CALC")"
check "still linked after the resize" "true true" "$(linked "$E1" "$CALC")"

echo "== snapped windows: dropping onto a window"
ev "Shell.AppSystem.get_default().lookup_app('org.gnome.TextEditor.desktop').open_new_window(-1); 'ok'" >/dev/null
wait_for "second editor window" "2" "$WINS.filter(x => x.get_wm_class() === 'org.gnome.TextEditor').length"
sleep 1
check "a new window is not linked" "false" "$(linked "$E2")"
ev "$EXT._onGrabBegin($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 1560 100
check "drop target: top of the calculator" "true top 1200,32,720,524" \
    "$(ev "$R ($EXT._dropTarget?.window === $CALC) + ' ' + $EXT._dropTarget?.region + ' ' + R($EXT._dropTarget.preview)")"
check "preview of the half" "true" "$(ev "$EXT._preview.visible")"
ev "$EXT._onGrabEnd($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "dropped window takes the top half" "1200,32,720,524" "$(rect_w "$E2")"
check_prefix "the target keeps the bottom half" "1200,556,720," "$(rect_w "$CALC")"
check "all three linked" "true true true" "$(linked "$E1" "$E2" "$CALC")"
ev "$EXT._onGrabBegin($E2, Meta.GrabOp.RESIZING_W); $E2.move_resize_frame(true, 1000, 32, 920, 524); 'ok'" >/dev/null
sleep 1
ev "$EXT._onGrabEnd($E2, Meta.GrabOp.RESIZING_W); 'ok'" >/dev/null
sleep 1.5
check "a divider shared by three windows: left window" "0,32,1000,1048" "$(rect_w "$E1")"
check_prefix "a divider shared by three windows: window below" "1000,556,920," "$(rect_w "$CALC")"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 1460 294
check "drop target: middle of a window swaps" "true center" "$(ev "($EXT._dropTarget?.window === $E2) + ' ' + $EXT._dropTarget?.region")"
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "swapped: dragged window in the target's place" "1000,32,920,524" "$(rect_w "$E1")"
check "swapped: target where the dragged window was" "0,32,1000,1048" "$(rect_w "$E2")"
check "swapped windows stay linked" "true true" "$(linked "$E1" "$E2")"
ev "$EXT._onGrabBegin($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 1700 200
check "nothing under the dragged window: no drop target" "false" "$(ev "!!$EXT._dropTarget")"
ev "$E1.move_frame(true, 1300, 100); 'ok'" >/dev/null
ev "$EXT._onGrabEnd($E1, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1
check "moved away by hand: no longer linked" "false" "$(linked "$E1")"

echo "== tiled windows: dropping onto an edge"
focus_w "$E1"
ev "$EXT._onAction('arrange-windows'); 'ok'" >/dev/null
sleep 1.5
focus_w "$E2"
action untile-window
check "one window released" "true false true" "$(tiled "$E1" "$E2" "$CALC")"
ev "$EXT._onGrabBegin($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
move_pointer 100 556
check "drop target: left edge of a tiled window" "true left" "$(ev "($EXT._dropTarget?.window === $E1) + ' ' + $EXT._dropTarget?.region")"
ev "$EXT._onGrabEnd($E2, Meta.GrabOp.MOVING); 'ok'" >/dev/null
sleep 1.5
check "inserted into the tiling" "true true true" "$(tiled "$E1" "$E2" "$CALC")"
check "inserted window takes the left half of the cell" "0,32,480,1048" "$(rect_w "$E2")"
check "the target keeps the other half" "480,32,480,1048" "$(rect_w "$E1")"

echo "== preferences window"
gnome-extensions prefs "$UUID"
sleep 5
check "prefs window open" "true" "$(ev "global.get_window_actors().some(a => a.meta_window.get_title() === 'Magnetic Field')")"

echo "== disable"
# Windows the Shell launched are not children of this script; close them all.
ev "global.get_window_actors().map(a => a.meta_window).filter(w => w.get_window_type() === Meta.WindowType.NORMAL && w.get_title() !== 'Magnetic Field').forEach(w => w.delete(global.get_current_time())); 'ok'" >/dev/null
gnome-extensions disable "$UUID"
sleep 2
check "state" "INACTIVE" "$(ext_state INACTIVE)"
check "indicator removed" "false" "$(ev "!!$IND")"
check "edge tiling restored" "true" "$(ev "new Gio.Settings({schema_id: 'org.gnome.mutter'}).get_boolean('edge-tiling')")"

echo "== shell log"
if grep -iE "magnetic|JS ERROR" "$SHELL_LOG" | grep -v "^$" | head -20 | grep .; then
    echo "FAIL  errors mentioning the extension in $SHELL_LOG"
    FAIL=$((FAIL + 1))
else
    echo "PASS  no errors in $SHELL_LOG"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PASSED"
else
    echo "$FAIL CHECK(S) FAILED"
fi
exit "$FAIL"
