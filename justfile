uuid        := "magnetic-field@petr.malasek.gmail.com"
install_dir := env("HOME") / ".local/share/gnome-shell/extensions" / uuid
sources     := "extension.js prefs.js actions.js indicator.js metadata.json stylesheet.css"
schema      := "schemas/org.gnome.shell.extensions.magnetic-field.gschema.xml"
zip_file    := uuid + ".shell-extension.zip"

# List available recipes
default:
    @just --list --unsorted

# Compile the GSettings schema (required after every change to the .gschema.xml)
schemas:
    glib-compile-schemas --strict schemas/

# Copy the extension into the user extension directory
install: schemas
    mkdir -p {{install_dir}}/schemas {{install_dir}}/icons
    cp {{sources}} {{install_dir}}/
    cp icons/*.svg {{install_dir}}/icons/
    cp {{schema}} schemas/gschemas.compiled {{install_dir}}/schemas/
    @echo "Installed to {{install_dir}}"
    @echo "On Wayland, log out and back in (or use 'just devkit' / 'just headless') for changes to take effect."

# Remove the installed extension
uninstall:
    rm -rf {{install_dir}}

# Build a zip suitable for extensions.gnome.org
zip: schemas
    rm -f {{zip_file}}
    gnome-extensions pack --force --extra-source=actions.js --extra-source=indicator.js \
        --extra-source=icons --out-dir=. .
    @ls -l {{zip_file}}

# Enable the extension
enable:
    gnome-extensions enable {{uuid}}

# Disable the extension
disable:
    gnome-extensions disable {{uuid}}

# Open the preferences window
prefs:
    gnome-extensions prefs {{uuid}}

# Follow the GNOME Shell log (extension errors land here)
log:
    journalctl -f -o cat /usr/bin/gnome-shell

# Follow the log of the preferences process
log-prefs:
    journalctl -f -o cat /usr/bin/gjs

# Development sessions. GNOME 49+ removed `gnome-shell --nested`; the
# replacement `--devkit` needs Mutter built with devkit support plus the
# mutter-devkit package, and is not available on every distribution.
# GSETTINGS_BACKEND=memory keeps the session's settings separate from yours.

# Nested development Shell (needs mutter-devkit)
devkit:
    GSETTINGS_BACKEND=memory dbus-run-session -- gnome-shell --devkit --unsafe-mode

# Driven over D-Bus, see README "Scripted testing".

# Invisible headless Shell (1920x1080 virtual monitor, --unsafe-mode)
headless:
    GSETTINGS_BACKEND=memory dbus-run-session -- gnome-shell --headless --no-x11 \
        --virtual-monitor 1920x1080 --wayland --wayland-display=mf-dev --unsafe-mode

# Install, then run the headless smoke test
test: install
    tests/smoke-test.sh

# Remove build artifacts
clean:
    rm -f schemas/gschemas.compiled {{zip_file}}
