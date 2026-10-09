import {
    canEnableShotgunRules, getShotgunSettings, getShotgunDamageProfiles, setShotgunEnabled, saveShotgunSettings
} from './ShotgunRules.js';

const escapeAttribute = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const asElement = html => {
    // Native V13 <form> elements also expose indexed controls at html[0].
    if (html?.nodeType === 1) return html;
    return html?.jquery ? html[0] : html?.[0] ?? html;
};
const canEdit = (sheet, item) => Boolean(item?.isOwner && sheet?.isEditable !== false);

export const showShotgunItemSettings = async item => {
    if (!canEnableShotgunRules(item) || !item.isOwner) return;
    const settings = getShotgunSettings(item);
    const damageProfiles = getShotgunDamageProfiles(item);
    try {
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: `${item.name} - Shotgun Settings` },
            position: { width: 500 },
            content: `<div class="standard-form">
                <fieldset>
                    <legend>Damage by Range</legend>
                    <table style="margin:0">
                        <thead><tr><th>Ammunition</th><th>Short</th><th>Medium</th><th>Long</th></tr></thead>
                        <tbody>${['shot', 'slug'].map(mode => `<tr><th>${mode === 'shot' ? 'Shot' : 'Slug'}</th>${['short', 'medium', 'long'].map(band =>
                            `<td><input type="text" name="sg${mode === 'shot' ? 'Shot' : 'Slug'}${band[0].toUpperCase()}${band.slice(1)}" value="${escapeAttribute(damageProfiles[mode][band])}" aria-label="${mode === 'shot' ? 'Shot' : 'Slug'} ${band} damage" required></td>`
                        ).join('')}</tr>`).join('')}</tbody>
                    </table>
                    <p class="hint">Slug uses Long damage at Extreme range. Shot cannot reach Extreme.</p>
                </fieldset>
                <div class="form-group">
                    <label>Double-barrel weapon</label>
                    <div class="form-fields"><input name="sgDoubleBarrel" type="checkbox" ${settings.doubleBarrel ? 'checked' : ''}></div>
                    <p class="hint">Both Barrels: +4 damage, two shells, one target, Rate of Fire 1.</p>
                </div>
                <div class="form-group">
                    <label>Shot +2 already included in Trait Modifier</label>
                    <div class="form-fields"><input name="sgBonusIncluded" type="checkbox" ${settings.bonusIncluded ? 'checked' : ''}></div>
                    <p class="hint">Avoids adding Shot +2 twice. Slug removes this preincluded bonus.</p>
                </div>
            </div>`,
            ok: {
                label: 'Save Settings',
                callback: (_event, button) => ({
                    doubleBarrel: button.form.elements.sgDoubleBarrel.checked,
                    bonusIncluded: button.form.elements.sgBonusIncluded.checked,
                    damageProfiles: Object.fromEntries(['shot', 'slug'].map(mode => [mode,
                        Object.fromEntries(['short', 'medium', 'long'].map(band => [band,
                            button.form.elements[`sg${mode === 'shot' ? 'Shot' : 'Slug'}${band[0].toUpperCase()}${band.slice(1)}`]?.value ?? damageProfiles[mode][band]
                        ]))
                    ]))
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
        ui.notifications.error(/^(Shot|Slug) (short|medium|long) damage:/.test(error?.message ?? '')
            ? error.message : 'The Shotgun settings could not be saved. Check item ownership and try again.');
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
        group.append(label, createSettingsButton(sheet, item));
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
