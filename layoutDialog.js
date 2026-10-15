// Dialog that asks for the name under which the current window layout is
// saved. Enter saves, Esc cancels; an existing layout with the same name is
// replaced.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {normalizeName} from './layouts.js';

export const LayoutNameDialog = GObject.registerClass(
class LayoutNameDialog extends ModalDialog.ModalDialog {
    _init(initialName, onSave) {
        super._init({styleClass: 'magnetic-field-layout-dialog'});
        this._onSave = onSave;

        const content = new Dialog.MessageDialogContent({
            title: _('Save layout'),
            description: _('The apps and window positions of this workspace are ' +
                'saved under this name. A layout with the same name is replaced.'),
        });
        this.contentLayout.add_child(content);

        this._entry = new St.Entry({
            style_class: 'magnetic-field-layout-entry',
            can_focus: true,
            hint_text: _('Layout name'),
            text: initialName ?? '',
        });
        ShellEntry.addContextMenu(this._entry);
        this.contentLayout.add_child(this._entry);
        this.setInitialKeyFocus(this._entry.clutter_text);

        const text = this._entry.clutter_text;
        text.set_selection(0, -1);
        text.connect('activate', () => this._save());
        text.connect('text-changed', () => this._syncSaveButton());

        this.addButton({
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });
        this._saveButton = this.addButton({
            label: _('Save'),
            action: () => this._save(),
            default: true,
        });
        this._syncSaveButton();
    }

    _syncSaveButton() {
        const valid = normalizeName(this._entry.get_text()) !== null;
        this._saveButton.reactive = valid;
        this._saveButton.can_focus = valid;
    }

    _save() {
        const name = normalizeName(this._entry.get_text());
        if (!name)
            return;
        this.close();
        this._onSave(name);
    }
});
