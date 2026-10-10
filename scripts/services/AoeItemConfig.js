import {
    canEnableAoe, isAoeItem, setAoeEnabled,
    getAoeItemSettings, saveAoeItemSettings, getPowerAoeSettings, savePowerAoeSettings
} from './AoeItemFlags.js';
import launchAoeMacro from './AoeMacroLauncher.js';
import { getWeaponSettingsClickOptions } from './LastWeaponSettings.js';

const openInventoryAoePanel = (actor, item, sheet, event) => {
    const options=getWeaponSettingsClickOptions(event,sheet);
    if (item.type==='power'){
        if (typeof game.swadetools?.item!=='function'){
            ui.notifications.warn('The native power panel is not available. Reload Foundry before using this shortcut.');
            return false;
        }
        return game.swadetools.item(actor,item.id,null,options);
    }
    let unified=false;
    try { unified=game.settings?.get('swade-tools','unifiedRofExperimental')===true; }
    catch { /* Older worlds retain their existing AoE panel. */ }
    if (unified && item.type==='weapon' &&
        (item.system?.isRanged===true || String(item.system?.range ?? '').trim()!=='')){
        if (typeof game.swadetools?.item!=='function'){
            ui.notifications.warn('The unified weapon panel is not available. Reload Foundry before using this shortcut.');
            return false;
        }
        return game.swadetools.item(actor,item.id,null,options);
    }
    return launchAoeMacro(actor,item,{promptAoeSetup:true,...options});
};

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
const inventoryClickTargets = new WeakSet();
const consumptionChoiceTargets = new WeakSet();
const bindAoeConsumptionChoices = html => {
    const root = asElement(html);
    const ammo = root?.querySelector?.('[name="aoeConsumeAmmo"]');
    const item = root?.querySelector?.('[name="aoeConsumeItem"]');
    if (!ammo || !item) return;
    for (const [choice, other] of [[ammo, item], [item, ammo]]) {
        if (consumptionChoiceTargets.has(choice)) continue;
        consumptionChoiceTargets.add(choice);
        choice.addEventListener('change', () => {
            if (choice.checked) other.checked = false;
        });
    }
};
const aoeItemNameSelector = [
    '.name[data-action="showItem"]', '.item-name', '.item-show',
    '.item-image', '.item-img'
].join(', ');
const itemControlSelector = [
    '.item-controls', '.item-actions', '.controls', '[data-item-controls]',
    '[data-swade-tools-aoe-controls]', '.item-edit', '.item-delete',
    '[data-action="editItem"]', '[data-action="deleteItem"]'
].join(', ');

const bindAoeItemNameClicks = (sheet, actor, row, itemId) => {
    const targets = new Set(row.querySelectorAll(aoeItemNameSelector));
    // VehicleSheetV2 weapon rows use a plain, direct <img> without classes.
    for (const child of row.children) {
        if (child.tagName === 'IMG') targets.add(child);
    }
    for (const target of targets) {
        if (inventoryClickTargets.has(target) || target.closest(itemControlSelector)) continue;
        inventoryClickTargets.add(target);
        target.addEventListener('click', async event => {
            const currentItem = actor.items.get(itemId);
            if (!isAoeItem(currentItem) || !isEditable(sheet, currentItem)) return;
            const clicked = event.target?.nodeType === 1
                ? event.target : event.target?.parentElement;
            if (clicked?.closest(itemControlSelector)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            await openInventoryAoePanel(actor,currentItem,sheet,event);
        }, true);
    }
};

export const showPowerAoeItemSettings = async item => {
    if (item?.type !== 'power' || !item.isOwner) return;
    const settings = getPowerAoeSettings(item);
    const shapes = [
        ['small', 'Small Blast Template'], ['medium', 'Medium Blast Template'],
        ['large', 'Large Blast Template'], ['scone', 'Small Cone Template'],
        ['cone', 'Cone Template'], ['stream', 'Stream Template']
    ];
    try {
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: `${item.name} - Power AoE Settings` },
            position: { width: 420 },
            content: `<div class="standard-form">
                <div class="form-group"><label>Template Shape</label>
                    <div class="form-fields"><select name="aoePowerShape">${shapes.map(([shape, label]) =>
                        `<option value="${shape}" ${settings.shape === shape ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
                </div>
                <div class="form-group"><label>Template Origin</label>
                    <div class="form-fields"><select name="aoePowerOrigin">
                        <option value="caster" ${settings.origin === 'caster' ? 'selected' : ''}>Casting Token</option>
                        <option value="free" ${settings.origin === 'free' ? 'selected' : ''}>Place Freely</option>
                    </select></div>
                </div>
                <p class="hint">Cones and streams only. Free placement: mouse wheel rotates; Shift uses larger steps.</p>
            </div>`,
            ok: { label: 'Save Settings', callback: (_event, button) => ({
                shape: button.form.elements.aoePowerShape.value,
                origin: button.form.elements.aoePowerOrigin.value
            }) },
            rejectClose: false,
            modal: false
        });
        if (!result) return;
        await savePowerAoeSettings(item, result);
        ui.notifications.info('Power AoE settings saved.');
    } catch (error) {
        console.error('SWADE Tools | Power AoE settings could not be saved', error);
        ui.notifications.error('The Power AoE settings could not be saved. Check the template shape and item ownership.');
    }
};

export const showAoeItemSettings = async (actor, item) => {
    if (!item?.isOwner || !canEnableAoe(item)) return;
    if (item.type === 'power') return showPowerAoeItemSettings(item);
    const settings = getAoeItemSettings(item);
    const escape = foundry.utils.escapeHTML;
    const damageOptions = Object.entries(item.system?.actions?.additional ?? {})
        .filter(([, action]) => action?.type === 'damage')
        .map(([key, action]) => `<option value="${escape(key)}" ${settings.damageAction === key ? 'selected' : ''}>${escape(action.name || key)}</option>`).join('');
    try {
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: `${item.name} - AoE Settings` },
            position: { width: 480 },
            content: `<div class="standard-form">
                <p class="hint">Uses the weapon's native Trait${item.system?.actions?.trait ? `: ${escape(String(item.system.actions.trait))}` : ''}. Edit Trait on the weapon's Properties tab to change the attack skill.</p>
                <div class="form-group">
                    <label>Blast Template</label>
                    <div class="form-fields"><select name="aoeBlastSize">${['small', 'medium', 'large'].map(size => `<option value="${size}" ${settings.blastSize === size ? 'selected' : ''}>${size[0].toUpperCase() + size.slice(1)} Blast Template</option>`).join('')}</select></div>
                </div>
                <div class="form-group">
                    <label>Damage Action</label>
                    <div class="form-fields"><select name="aoeDamageAction"><option value="">Weapon Damage / Automatic</option>${damageOptions}</select></div>
                </div>
                <div class="form-group">
                    <label>Uses per Attack</label>
                    <div class="form-fields"><input name="aoeAmmoCost" type="number" value="${settings.ammoCost}" min="1" step="1"></div>
                    <p class="hint">Number of ammunition uses or inventory items spent by one attack.</p>
                </div>
                <div class="form-group">
                    <label>Consume Ammunition</label>
                    <div class="form-fields"><input name="aoeConsumeAmmo" type="checkbox" ${settings.consumeMode === 'ammo' ? 'checked' : ''}></div>
                </div>
                <div class="form-group">
                    <label>Consume Item</label>
                    <div class="form-fields"><input name="aoeConsumeItem" type="checkbox" ${settings.consumeMode === 'item' ? 'checked' : ''}></div>
                    <p class="hint">Choose only one consumption type. Leave both unchecked to spend nothing. Ammunition uses loaded or linked ammo; Item reduces this item's inventory quantity. Benny rerolls never consume another use.</p>
                </div>
            </div>`,
            ok: {
                label: 'Save Settings',
                callback: (event, button) => ({
                    blastSize: button.form.elements.aoeBlastSize.value,
                    damageAction: button.form.elements.aoeDamageAction.value,
                    consumeMode: button.form.elements.aoeConsumeItem.checked ? 'item'
                        : button.form.elements.aoeConsumeAmmo.checked ? 'ammo' : 'none',
                    ammoCost: button.form.elements.aoeAmmoCost.valueAsNumber
                })
            },
            render: (_event, dialog) => bindAoeConsumptionChoices(dialog.element),
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
// use the same explosion shortcut. Opt-in and settings remain on the item sheet
// to keep inventory rows clear; this shortcut always opens the attack panel.
export const bindAoeInventoryControls = (sheet, html) => {
    const root = asElement(html);
    const actor = sheet?.actor ??
        (sheet?.document?.documentName === 'Actor' ? sheet.document : null);
    if (!root?.querySelectorAll || !actor?.items) return;

    for (const row of root.querySelectorAll('[data-item-id]')) {
        const itemId = row.dataset.itemId;
        const item = actor.items.get(itemId);
        // Some alternate sheets expose nested elements with the same item id.
        // Add a single set to the actual row, not another one to each child.
        const ancestor = row.parentElement?.closest('[data-item-id]');
        if (ancestor?.dataset.itemId === itemId) continue;
        let controls = row.querySelector('[data-swade-tools-aoe-controls]');
        if (!canEnableAoe(item) || !isAoeItem(item)) {
            controls?.remove();
            continue;
        }
        bindAoeItemNameClicks(sheet, actor, row, itemId);
        // Remove inventory options left by a previous module version before
        // installing the new explosion-only shortcut.
        if (controls?.querySelector('[data-swade-tools-aoe-enabled], [data-swade-tools-aoe-settings]')) {
            controls.remove();
            controls = null;
        }
        if (!controls) {
            controls = document.createElement('span');
            controls.dataset.swadeToolsAoeControls = '';
            controls.className = 'swade-tools-aoe-controls';
            controls.style.cssText = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap;';

            const attack = document.createElement('button');
            attack.type = 'button';
            attack.dataset.swadeToolsAoe = '';
            attack.title = item.type === 'power' ? 'Open AoE Power' : 'Open AoE Attack';
            attack.setAttribute('aria-label', item.type === 'power' ? 'AoE Power' : 'AoE Attack');
            attack.style.cssText = 'width:24px;height:24px;line-height:20px;flex:0 0 24px;padding:0;';
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-explosion';
            attack.append(icon);
            controls.append(attack);
            const host = row.querySelector('.item-controls, .item-actions, .controls, [data-item-controls]') ?? row;
            host.prepend(controls);

            controls.addEventListener('click', event => event.stopPropagation());
            attack.addEventListener('click', async event => {
                event.preventDefault();
                event.stopPropagation();
                if (attack.disabled) return;
                attack.disabled = true;
                try {
                    await openInventoryAoePanel(actor,item,sheet,event);
                } finally {
                    attack.disabled = !isEditable(sheet, item);
                }
            });
        }
        const attack = controls.querySelector('[data-swade-tools-aoe]');
        attack.disabled = !isEditable(sheet, item);
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
        group.append(label, createSettingsButton(item.actor ?? item.parent, item));
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
