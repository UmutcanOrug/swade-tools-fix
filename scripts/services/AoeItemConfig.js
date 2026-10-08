import {
    canEnableAoe, isAoeItem, setAoeEnabled,
    getAoeItemSettings, saveAoeItemSettings
} from './AoeItemFlags.js';
import launchAoeMacro, { resolveAoeLaunchScope } from './AoeMacroLauncher.js';

const asElement = html => {
    // HTMLFormElement is indexed by its form controls. V13 DocumentSheetV2
    // renders a native <form>, so html[0] can be an input, not the sheet root.
    if (html?.nodeType === 1) return html;
    if (html?.jquery) return html[0];
    return html?.[0] ?? html;
};
const isEditable = (sheet, item) => Boolean(
    item?.isOwner && sheet?.isEditable !== false
);

export const showAoeItemSettings = async (actor, item) => {
    if (!item?.isOwner || !canEnableAoe(item)) return;
    const settings = getAoeItemSettings(item);
    const scope = await resolveAoeLaunchScope(actor ?? item.actor ?? item.parent, item);
    const skillNames = new Set();
    for (const candidate of [scope.operatorActor, scope.weaponActor]) {
        for (const skill of candidate?.items ?? []) {
            if (skill.type === 'skill') skillNames.add(String(skill.name));
        }
    }
    const escape = foundry.utils.escapeHTML;
    const skills = [...skillNames].sort((a, b) => a.localeCompare(b))
        .map(name => `<option value="${escape(name)}"></option>`).join('');
    const damageOptions = Object.entries(item.system?.actions?.additional ?? {})
        .filter(([, action]) => action?.type === 'damage')
        .map(([key, action]) => `<option value="${escape(key)}" ${settings.damageAction === key ? 'selected' : ''}>${escape(action.name || key)}</option>`).join('');
    try {
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: `${item.name} - AoE Settings` },
            position: { width: 480 },
            content: `<div class="standard-form">
                <div class="form-group">
                    <label>Attack Skill</label>
                    <div class="form-fields"><input name="aoeSkill" type="text" list="swade-tools-aoe-skills" value="${escape(settings.skill)}"><datalist id="swade-tools-aoe-skills">${skills}</datalist></div>
                    <p class="hint">Choose an operator's skill or enter a custom skill such as Gunnery. Leave blank to use the weapon's Trait.</p>
                </div>
                <div class="form-group">
                    <label>Blast Template</label>
                    <div class="form-fields"><select name="aoeBlastSize">${['small', 'medium', 'large'].map(size => `<option value="${size}" ${settings.blastSize === size ? 'selected' : ''}>${size[0].toUpperCase() + size.slice(1)} Blast Template</option>`).join('')}</select></div>
                </div>
                <div class="form-group">
                    <label>Damage Action</label>
                    <div class="form-fields"><select name="aoeDamageAction"><option value="">Weapon Damage / Automatic</option>${damageOptions}</select></div>
                </div>
                <div class="form-group">
                    <label>Ammo per Attack</label>
                    <div class="form-fields"><input name="aoeAmmoCost" type="number" value="${settings.ammoCost}" min="1" step="1"></div>
                    <p class="hint">Uses the weapon's loaded or linked ammunition, never the number of tank guns.</p>
                </div>
                <div class="form-group">
                    <label>Consume Ammunition</label>
                    <div class="form-fields"><input name="aoeConsume" type="checkbox" ${settings.consume ? 'checked' : ''}></div>
                    <p class="hint">Consumes ammunition or a thrown item once. Benny rerolls never consume another shot.</p>
                </div>
            </div>`,
            ok: {
                label: 'Save Settings',
                callback: (event, button) => ({
                    skill: button.form.elements.aoeSkill.value,
                    blastSize: button.form.elements.aoeBlastSize.value,
                    damageAction: button.form.elements.aoeDamageAction.value,
                    consume: button.form.elements.aoeConsume.checked,
                    ammoCost: button.form.elements.aoeAmmoCost.valueAsNumber
                })
            },
            rejectClose: false,
            modal: false
        });
        if (!result) return;
        await saveAoeItemSettings(item, result);
        ui.notifications.info('AoE settings saved.');
    } catch (error) {
        console.error('SWADE Tools | AoE settings could not be saved', error);
        ui.notifications.error('The AoE settings could not be saved. Check item ownership and try again.');
    }
};

const createSettingsButton = (actor, item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.swadeToolsAoeSettings = '';
    button.title = 'AoE Settings';
    button.setAttribute('aria-label', 'AoE Settings');
    button.style.cssText = 'width:24px;height:24px;line-height:20px;flex:0 0 24px;padding:0;';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-gear';
    button.append(icon);
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try { await showAoeItemSettings(actor, item); }
        finally { button.disabled = !item.isOwner; }
    });
    return button;
};

const persistToggle = async (sheet, item, input, updateAction) => {
    input.disabled = true;
    try {
        await setAoeEnabled(item, input.checked);
        updateAction?.();
    } catch (error) {
        console.error('SWADE Tools | AoE option could not be saved', error);
        input.checked = isAoeItem(item);
        ui.notifications.error('The AoE option could not be saved. Check item ownership and try again.');
    } finally {
        input.disabled = !isEditable(sheet, item);
    }
};

// Both legacy SWADE sheets (jQuery) and V13 ApplicationV2 sheets (HTMLElement)
// use these controls. They deliberately do not change attack skill or item data
// beyond the single opt-in flag, so normal item clicks retain their old behavior.
export const bindAoeInventoryControls = (sheet, html) => {
    const root = asElement(html);
    const actor = sheet?.actor ??
        (sheet?.document?.documentName === 'Actor' ? sheet.document : null);
    if (!root?.querySelectorAll || !actor?.items) return;

    for (const row of root.querySelectorAll('[data-item-id]')) {
        const itemId = row.dataset.itemId;
        const item = actor.items.get(itemId);
        if (!canEnableAoe(item)) continue;
        // Some alternate sheets expose nested elements with the same item id.
        // Add a single set to the actual row, not another one to each child.
        const ancestor = row.parentElement?.closest('[data-item-id]');
        if (ancestor?.dataset.itemId === itemId) continue;
        let controls = row.querySelector('[data-swade-tools-aoe-controls]');
        if (!controls) {
            controls = document.createElement('span');
            controls.dataset.swadeToolsAoeControls = '';
            controls.className = 'swade-tools-aoe-controls';
            controls.style.cssText = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap;';

            const label = document.createElement('label');
            label.title = 'Enable an area-of-effect attack for this item';
            label.style.cssText = 'display:inline-flex;align-items:center;gap:2px;font-size:11px;cursor:pointer;';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.swadeToolsAoeEnabled = '';
            input.setAttribute('aria-label', 'Enable AoE Attack');
            input.style.cssText = 'width:13px;height:13px;margin:0;';
            label.append(input, document.createTextNode('AoE'));

            const attack = document.createElement('button');
            attack.type = 'button';
            attack.dataset.swadeToolsAoe = '';
            attack.title = 'AoE Attack (Shift-click for attack options)';
            attack.setAttribute('aria-label', 'AoE Attack');
            attack.style.cssText = 'width:24px;height:24px;line-height:20px;flex:0 0 24px;padding:0;';
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-explosion';
            attack.append(icon);
            controls.append(label, createSettingsButton(actor, item), attack);
            const host = row.querySelector('.item-controls, .item-actions, [data-item-controls]') ?? row;
            host.prepend(controls);

            const updateAction = () => {
                attack.hidden = !isAoeItem(item);
                attack.style.display = attack.hidden ? 'none' : '';
                attack.disabled = !isEditable(sheet, item);
            };
            controls.addEventListener('click', event => event.stopPropagation());
            input.addEventListener('change', () =>
                persistToggle(sheet, item, input, updateAction)
            );
            attack.addEventListener('click', async event => {
                event.preventDefault();
                event.stopPropagation();
                if (attack.disabled) return;
                attack.disabled = true;
                try {
                    await launchAoeMacro(actor, item, {
                        promptAoeSetup: event.shiftKey === true
                    });
                } finally {
                    attack.disabled = !isEditable(sheet, item);
                }
            });
            updateAction();
        }
        const input = controls.querySelector('[data-swade-tools-aoe-enabled]');
        const attack = controls.querySelector('[data-swade-tools-aoe]');
        input.checked = isAoeItem(item);
        input.disabled = !isEditable(sheet, item);
        attack.hidden = !isAoeItem(item);
        attack.style.display = attack.hidden ? 'none' : '';
        attack.disabled = !isEditable(sheet, item);
        controls.querySelector('[data-swade-tools-aoe-settings]').disabled = !isEditable(sheet, item);
    }
};

export const bindAoeItemSheetControl = (sheet, html) => {
    const root = asElement(html);
    const item = sheet?.item ??
        (sheet?.document?.documentName === 'Item' ? sheet.document : null);
    if (!root?.querySelector || !canEnableAoe(item)) return;
    let group = root.querySelector('[data-swade-tools-aoe-item-option]');
    if (!group) {
        group = document.createElement('div');
        group.dataset.swadeToolsAoeItemOption = '';
        group.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = 'Enable AoE';
        label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('aria-label', 'Enable AoE Attack');
        input.dataset.swadeToolsAoeEnabled = '';
        label.prepend(input);
        const hint = document.createElement('p');
        hint.className = 'hint notes';
        hint.textContent = 'Adds the explosion button to this item in the inventory. The attack can use any skill, including Gunnery. Shift-click the explosion button for attack options.';
        group.append(label, createSettingsButton(item.actor ?? item.parent, item), hint);
        const host = root.querySelector('.tab[data-tab="properties"], .tab[data-tab="details"], section[data-tab="properties"]') ??
            root.querySelector('form') ?? root;
        host.prepend(group);
        group.addEventListener('click', event => event.stopPropagation());
        input.addEventListener('change', () => persistToggle(sheet, item, input));
    }
    const input = group.querySelector('[data-swade-tools-aoe-enabled]');
    input.checked = isAoeItem(item);
    input.disabled = !isEditable(sheet, item);
    group.querySelector('[data-swade-tools-aoe-settings]').disabled = !isEditable(sheet, item);
};

let registered = false;
export const registerAoeItemControls = () => {
    if (registered) return;
    registered = true;
    Hooks.on('renderActorSheet', bindAoeInventoryControls);
    Hooks.on('renderItemSheet', bindAoeItemSheetControl);
    Hooks.on('renderApplicationV2', (sheet, html) => {
        if (sheet?.document?.documentName === 'Item' || sheet?.item) {
            bindAoeItemSheetControl(sheet, html);
        } else {
            bindAoeInventoryControls(sheet, html);
        }
    });
};
