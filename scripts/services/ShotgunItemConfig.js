import {
    canEnableShotgunRules, getShotgunSettings, setShotgunEnabled, saveShotgunSettings
} from './ShotgunRules.js';

const asElement = html => {
    // Native V13 <form> elements also expose indexed controls at html[0].
    if (html?.nodeType === 1) return html;
    return html?.jquery ? html[0] : html?.[0] ?? html;
};
const canEdit = (sheet, item) => Boolean(item?.isOwner && sheet?.isEditable !== false);

export const showShotgunItemSettings = async item => {
    if (!canEnableShotgunRules(item) || !item.isOwner) return;
    const settings = getShotgunSettings(item);
    try {
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: `${item.name} - Shotgun Settings` },
            position: { width: 480 },
            content: `<div class="standard-form">
                <p class="hint">Uses the weapon's native Trait and leaves its Trait Modifier and Damage unchanged. Shot / Slug is selected in the attack panel.</p>
                <div class="form-group">
                    <label>Double-barrel weapon</label>
                    <div class="form-fields"><input name="sgDoubleBarrel" type="checkbox" ${settings.doubleBarrel ? 'checked' : ''}></div>
                    <p class="hint">Allows Both Barrels: one Shot attack against one target, +4 damage and two shells. Requires Rate of Fire 1.</p>
                </div>
                <div class="form-group">
                    <label>Shot +2 already included in Trait Modifier</label>
                    <div class="form-fields"><input name="sgBonusIncluded" type="checkbox" ${settings.bonusIncluded ? 'checked' : ''}></div>
                    <p class="hint">Enable only if this weapon's native Trait Modifier already includes the +2 Shot bonus. Shot adds no extra +2, and Slug removes that preincluded +2. Other modifiers are preserved.</p>
                </div>
            </div>`,
            ok: {
                label: 'Save Settings',
                callback: (_event, button) => ({
                    doubleBarrel: button.form.elements.sgDoubleBarrel.checked,
                    bonusIncluded: button.form.elements.sgBonusIncluded.checked
                })
            },
            rejectClose: false,
            modal: false
        });
        if (!result) return;
        await saveShotgunSettings(item, result);
        ui.notifications.info('Shotgun settings saved.');
    } catch (error) {
        console.error('SWADE Tools | Shotgun settings could not be saved', error);
        ui.notifications.error('The Shotgun settings could not be saved. Check item ownership and try again.');
    }
};

const createSettingsButton = (sheet, item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.swadeToolsShotgunSettings = '';
    button.title = 'Shotgun Settings';
    button.setAttribute('aria-label', 'Shotgun Settings');
    button.style.cssText = 'width:24px;height:24px;line-height:20px;flex:0 0 24px;padding:0;';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-gear';
    button.append(icon);
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled || !canEdit(sheet, item)) return;
        button.disabled = true;
        try { await showShotgunItemSettings(item); }
        finally { button.disabled = !canEdit(sheet, item); }
    });
    return button;
};

export const bindShotgunItemSheetControl = (sheet, html) => {
    const root = asElement(html);
    const item = sheet?.item ?? (sheet?.document?.documentName === 'Item' ? sheet.document : null);
    if (!root?.querySelector || !canEnableShotgunRules(item)) return;
    let group = root.querySelector('[data-swade-tools-shotgun-item-option]');
    if (!group) {
        group = document.createElement('div');
        group.dataset.swadeToolsShotgunItemOption = '';
        group.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = 'Enable Shotgun Rules';
        label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.swadeToolsShotgunEnabled = '';
        checkbox.setAttribute('aria-label', 'Enable Shotgun Rules');
        label.prepend(checkbox);
        const hint = document.createElement('p');
        hint.className = 'hint notes';
        hint.textContent = 'Requires the world setting Experimental Unified RoF. Adds Shot / Slug options to the weapon attack panel. Shot uses +2 and range-based damage; Slug uses 2d10 without the Shot bonus. No rules are inferred from the weapon name.';
        group.append(label, createSettingsButton(sheet, item), hint);
        const host = root.querySelector('.tab[data-tab="properties"], .tab[data-tab="details"], section[data-tab="properties"]') ??
            root.querySelector('form') ?? root;
        host.prepend(group);
        group.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', async () => {
            if (checkbox.disabled || !canEdit(sheet, item)) return;
            checkbox.disabled = true;
            try { await setShotgunEnabled(item, checkbox.checked); }
            catch (error) {
                console.error('SWADE Tools | Shotgun option could not be saved', error);
                checkbox.checked = getShotgunSettings(item).enabled;
                ui.notifications.error('The Shotgun option could not be saved. Check item ownership and try again.');
            } finally { checkbox.disabled = !canEdit(sheet, item); }
        });
    }
    const checkbox = group.querySelector('[data-swade-tools-shotgun-enabled]');
    checkbox.checked = getShotgunSettings(item).enabled;
    checkbox.disabled = !canEdit(sheet, item);
    group.querySelector('[data-swade-tools-shotgun-settings]').disabled = !canEdit(sheet, item);
};

let registered = false;
export const registerShotgunItemControls = () => {
    if (registered || !globalThis.Hooks?.on) return;
    registered = true;
    Hooks.on('renderItemSheet', bindShotgunItemSheetControl);
    Hooks.on('renderApplicationV2', (sheet, html) => {
        if (sheet?.document?.documentName === 'Item' || sheet?.item) bindShotgunItemSheetControl(sheet, html);
    });
};
