import * as gb from '../gb.js';

const escapeHTML = value => foundry.utils.escapeHTML(String(value ?? ''));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const field = (html, id) => html?.querySelector?.(`#${id}`) ??
    html?.[0]?.querySelector?.(`#${id}`) ?? html?.find?.(`#${id}`)?.[0];

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
    const consumeLabel = consumeMode === 'item' ? 'Consume Item' : 'Consume Ammunition';
    return `<div class="swadetools-dialog-item">
      <div class="swadetools-itemfulldata"><div class="swadetools-2grid">
        <div><strong>Damage:</strong> ${escapeHTML(damage || 'Not configured')} (AP: ${escapeHTML(ap)})</div>
        <div><strong>Shots:</strong> ${escapeHTML(item.system?.currentShots ?? '—')}/${escapeHTML(item.system?.shots ?? '—')}</div>
        <div><strong>Range:</strong> ${escapeHTML(item.system?.range || '5/10/20')}</div>
        <div><strong>RoF:</strong> ${escapeHTML(item.system?.rof ?? 1)}</div>
        <div><strong>Blast:</strong> ${escapeHTML(blastLabel)} Blast Template</div>
        <div><strong>Trait:</strong> ${escapeHTML(attackSkill.name)}</div>
      </div>${weaponOwner.type === 'vehicle' ? `<p><strong>Operator:</strong> ${escapeHTML(operatorActor.name)} (${escapeHTML(weaponOwner.name)})</p>` : ''}</div>
      <div class="swadetools-formpart swadetools-2grid">
        <div class="swadetools-mod-add"><label><strong>Mod.</strong>
          <i class="far fa-question-circle swadetools-hint" title="Situational attack modifier. Range, Wounds, Fatigue and prepared effects are added automatically."></i></label>
          <input type="text" id="mod" size="3" class="swadetools-input-number" value="0"></div>
        <div class="swadetools-raise"><label><input type="checkbox" id="aoe-consume" ${consumeMode === 'none' ? 'disabled' : settings.consume ? 'checked' : ''}>
          <strong>${consumeLabel}</strong></label></div>
      </div>
      ${consumeMode === 'none' ? '<p class="hint">Resource consumption is disabled. Configure Consume Ammunition or Consume Item in AoE Settings.</p>' : ''}
      <h2>Other Modifiers</h2>
      ${selector('multiaction', 'Multi-Action Penalty', [[0,'None (0)'],[-2,'-2'],[-4,'-4']])}
      ${selector('cover', 'Cover', [[0,'None (0)'],[-2,'Light (-2)'],[-4,'Medium (-4)'],[-6,'Heavy (-6)'],[-8,'Total (-8)']])}
      ${selector('illumination', 'Illumination', [[0,'None (0)'],[-2,'Dim (-2)'],[-4,'Dark (-4)'],[-6,'Pitch Darkness (-6)']])}
      <p class="hint">Choose the blast point, then this attack rolls automatically. A Raise adds damage automatically.
        Only this attack spends the configured resource; Benny rerolls do not.</p>
      <p class="hint">${consumeMode === 'item' ? 'Items' : 'Ammo'} per Attack: ${escapeHTML(settings.ammoCost ?? 1)}.
        ${escapeHTML(resource?.label ?? '')}${Number.isFinite(resource?.available) ? `: ${escapeHTML(resource.available)} available.` : ''}</p>
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
    const content = buildAoeAttackDialogContent(context);
    const dialog = new DialogClass({
        title: context.item.name,
        content,
        default: 'attack',
        buttons: {
            attack: {
                icon: '<i class="fas fa-explosion"></i>',
                label: `${escapeHTML(context.attackSkill.name)} / AoE`,
                callback: html => {
                    try { finish(readAoeAttackDialogValues(html, context.settings)); }
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
        render: html => addModifierButtons(html),
        close: () => finish(null)
    }, {classes: ['dialog swadetools-vertical'], width: 500});
    dialog.render(true);
});

export default showAoeAttackDialog;
