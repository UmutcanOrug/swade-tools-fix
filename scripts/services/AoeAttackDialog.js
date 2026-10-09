import * as gb from '../gb.js';
import { resolveWeaponSettingsContext, getLastWeaponSettings, saveLastWeaponSettings } from './LastWeaponSettings.js';

const escapeHTML = value => foundry.utils.escapeHTML(String(value ?? ''));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const field = (html, id) => html?.querySelector?.(`#${id}`) ??
    html?.[0]?.querySelector?.(`#${id}`) ?? html?.find?.(`#${id}`)?.[0];
const COVER_NAMES = Object.freeze({ 0: 'None', '-2': 'Light', '-4': 'Medium', '-6': 'Heavy', '-8': 'Total' });
const ILLUMINATION_NAMES = Object.freeze({ 0: 'None', '-2': 'Dim', '-4': 'Dark', '-6': 'Pitch' });
const restoreAoeFields = (html, saved, settings) => {
    if (!saved) return;
    const modifier = field(html, 'mod');
    if (modifier && ['string', 'number'].includes(typeof saved.modifier)) modifier.value = String(saved.modifier);
    const damageModifier = field(html, 'rof-damage-modifier');
    if (damageModifier && typeof saved.damageModifier === 'string') damageModifier.value = saved.damageModifier;
    const drop = field(html, 'rof-drop');
    if (drop) drop.checked = saved.drop === true;
    const multiAction = field(html, 'multiaction');
    if (multiAction && ['0', '-2', '-4'].includes(String(saved.multiaction))) multiAction.value = String(saved.multiaction);
    for (const [id, mapping] of [['cover', COVER_NAMES], ['illumination', ILLUMINATION_NAMES]]) {
        const input = field(html, id);
        const match = Object.entries(mapping).find(([value, name]) => saved[id] === name || String(saved[id]) === value);
        if (input && match) input.value = match[0];
    }
    const consume = field(html, 'aoe-consume');
    if (consume && settings.consumeMode !== 'none' && !consume.disabled && typeof saved.consumeAmmo === 'boolean') {
        consume.checked = saved.consumeAmmo;
    }
};

export const readAoeAttackDialogValues = (html, {consumeMode} = {}) => {
    const rawModifier = String(field(html, 'mod')?.value ?? '0').trim() || '0';
    const modifierParts = {
        modifier: rawModifier,
        multiAction: number(field(html, 'multiaction')?.value),
        cover: number(field(html, 'cover')?.value),
        illumination: number(field(html, 'illumination')?.value)
    };
    return {
        otherModifierFormula: rawModifier,
        damageModifier: String(field(html, 'rof-damage-modifier')?.value ?? '').trim(),
        theDrop: field(html, 'rof-drop')?.checked === true,
        situationalModifier: modifierParts.multiAction + modifierParts.cover + modifierParts.illumination,
        consume: consumeMode !== 'none' && field(html, 'aoe-consume')?.disabled !== true &&
            field(html, 'aoe-consume')?.checked === true,
        modifierParts
    };
};

const selector = (id, label, options) => `<div class="swadetools-damage-actions swadetools-mod-add">
    <label><strong>${label}:</strong></label><select id="${id}">${options.map(([value, text]) =>
        `<option value="${value}">${text}</option>`).join('')}</select></div>`;

export const buildAoeAttackDialogContent = ({item, weaponOwner, operatorActor, attackSkill, settings, resource}) => {
    const action = settings.damageAction ? item.system?.actions?.additional?.[settings.damageAction] : null;
    const damage = String(action?.override ?? action?.dmgOverride ?? item.system?.damage ?? '').trim();
    const ap = action?.ap ?? item.system?.ap ?? 0;
    const blast = String(settings.blastSize ?? 'medium');
    const blastLabel = blast[0].toUpperCase() + blast.slice(1);
    const consumeMode = settings.consumeMode ?? (settings.consume ? 'ammo' : 'none');
    const consumeLabel = consumeMode === 'item' ? 'Consume Item' : 'Ammunition';
    return `<div class="swadetools-dialog-item">
      <div class="swadetools-itemfulldata"><div class="swadetools-weapon-summary"><div class="swadetools-2grid">
        <div><strong>Damage:</strong> ${escapeHTML(damage || 'Not configured')} (AP: ${escapeHTML(ap)})</div>
        <div><strong>Shots:</strong> ${escapeHTML(item.system?.currentShots ?? '—')}/${escapeHTML(item.system?.shots ?? '—')}</div>
        <div><strong>Range:</strong> ${escapeHTML(item.system?.range || '5/10/20')}</div>
        <div><strong>RoF:</strong> ${escapeHTML(item.system?.rof ?? 1)}</div>
        <div><strong>Blast:</strong> ${escapeHTML(blastLabel)} Blast Template</div>
        <div><strong>Trait:</strong> ${escapeHTML(attackSkill.name)}</div>
      </div><div class="swadetools-weapon-checks">
        <label class="swadetools-small-check" title="The Drop: +4 attack and +4 damage"><input id="rof-drop" type="checkbox">The Drop</label>
        <label class="swadetools-small-check" title="Consume the configured resource on this attack"><input type="checkbox" id="aoe-consume" ${consumeMode === 'none' ? 'disabled' : 'checked'}>${consumeLabel}</label>
      </div></div>${weaponOwner.type === 'vehicle' ? `<p><strong>Operator:</strong> ${escapeHTML(operatorActor.name)} (${escapeHTML(weaponOwner.name)})</p>` : ''}</div>
      <div class="swadetools-formpart swadetools-2grid">
        <div class="swadetools-mod-add"><label><strong>Mod.</strong>
          <i class="far fa-question-circle swadetools-hint" title="Situational attack modifier. Range, Wounds, Fatigue and prepared effects are added automatically."></i></label>
          <input type="text" id="mod" size="3" class="swadetools-input-number" value="0"></div>
        <div class="swadetools-mod-add"><label for="rof-damage-modifier"><strong>Damage Mod.</strong></label>
          <input type="text" id="rof-damage-modifier" size="3" class="swadetools-input-number" value="" title="Damage only, for example +2 or +1d6x"></div>
      </div>
      <h2>Other Modifiers</h2>
      ${selector('multiaction', 'Multi-Action Penalty', [[0,'None (0)'],[-2,'-2'],[-4,'-4']])}
      ${selector('cover', 'Cover', [[0,'None (0)'],[-2,'Light (-2)'],[-4,'Medium (-4)'],[-6,'Heavy (-6)'],[-8,'Total (-8)']])}
      ${selector('illumination', 'Illumination', [[0,'None (0)'],[-2,'Dim (-2)'],[-4,'Dark (-4)'],[-6,'Pitch Darkness (-6)']])}
    </div>`;
};

// The same classic Dialog wrapper, classes and +/- helper as SWADE Tools'
// ordinary ItemDialog, without importing ItemDialog or adding a second attack.
export const showAoeAttackDialog = (context, {
    DialogClass = globalThis.Dialog,
    addModifierButtons = gb.modButtons
} = {}) => new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    const memoryContext = resolveWeaponSettingsContext({ item: context.item,
        weaponOwner: context.weaponOwner, operator: context.operatorActor, token: context.token });
    const saved = context.restoreLast === true ? getLastWeaponSettings(memoryContext) : null;
    const content = buildAoeAttackDialogContent(context) +
        (saved ? '<div style="font-size:11px;margin-top:3px">Last settings restored.</div>' : '');
    const dialog = new DialogClass({
        title: context.item.name,
        content,
        default: 'attack',
        buttons: {
            attack: {
                icon: '<i class="fas fa-explosion"></i>',
                label: `${escapeHTML(context.attackSkill.name)} / AoE`,
                callback: html => {
                    try {
                        const result = readAoeAttackDialogValues(html, context.settings);
                        if (memoryContext) saveLastWeaponSettings(memoryContext, {
                            ...getLastWeaponSettings(memoryContext),
                            // This legacy panel always fires one projectile.
                            // Do not recall a former unified volley as its last action.
                            rof: '1', recoil: false, damageModifier: result.damageModifier,
                            drop: result.theDrop,
                            modifier: String(field(html, 'mod')?.value ?? ''),
                            multiaction: String(result.modifierParts.multiAction),
                            cover: COVER_NAMES[result.modifierParts.cover] ?? 'None',
                            illumination: ILLUMINATION_NAMES[result.modifierParts.illumination] ?? 'None',
                            consumeAmmo: result.consume
                        });
                        finish(result);
                    }
                    catch (error) { ui.notifications.warn(error.message); finish(null); }
                }
            },
            ...(typeof context.item.reload === 'function' && Number(context.item.system?.shots) > 0 &&
                String(context.item.system?.reloadType ?? '').toLowerCase() !== 'none' ? {
                reload: {
                    icon: '<i class="fas fa-sync"></i>', label: 'Reload',
                    callback: async () => {
                        try { await context.item.reload(); }
                        catch (error) { console.error('SWADE AoE Attack | Reload failed', error); ui.notifications.warn('The weapon could not be reloaded.'); }
                        finish(null);
                    }
                }
            } : {}),
            cancel: {icon: '<i class="fas fa-times"></i>', label: 'Cancel', callback: () => finish(null)}
        },
        render: html => { restoreAoeFields(html, saved, context.settings); addModifierButtons(html); },
        close: () => finish(null)
    }, {classes: ['dialog swadetools-vertical'], width: 500});
    dialog.render(true);
});

export default showAoeAttackDialog;
