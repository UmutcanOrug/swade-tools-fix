import { getAoeTargetResult } from './AoeTargetResults.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const uuidOf = target => target.uuid ?? target.document?.uuid;
const defenseOf = (target, state) => getAoeTargetResult(state.evadeResults, uuidOf(target));
const fireOf = (target, state) => getAoeTargetResult(state.fireResults, uuidOf(target));

export const renderAoeTargetSummary = (target, state) => {
    const defense = defenseOf(target, state), fire = fireOf(target, state), lines = [];
    if (defense) lines.push(`Evade: ${defense.pending ? 'GM decision needed' :
        `${Number.isFinite(defense.total) ? defense.total + ' — ' : ''}${defense.evaded ? 'Evaded' : 'Hit'}${defense.gmOverride ? ' (GM)' : ''}`}`);
    if (fire) {
        const text = {pending: 'Pending', rolling: 'Rolling', nonflammable: 'Not flammable',
            'not-ignited': 'No ignition', burning: 'On Fire', extinguished: 'Extinguished', error: 'GM review needed'}[fire.status] ?? 'Pending';
        lines.push(`Fire: ${Number.isFinite(fire.check) ? `${fire.check}${fire.threshold ? '/' + fire.threshold : ''} — ` : ''}${text}` +
            (Number.isFinite(fire.damageTotal) ? ` · Damage ${fire.damageTotal} (${fire.initialIntensity}d6)` : ''));
    }
    return lines.length ? `<div class="swadetools-aoe-resolution-line" style="font-size:11px;line-height:15px;padding:0 3px">${lines.map(escape).join('<br>')}</div>` : '';
};

export const renderAoeResolutionDetails = (targets, state) => {
    const entries = targets.map(target => {
        const uuid = uuidOf(target), defense = defenseOf(target, state), fire = fireOf(target, state);
        if (!defense && !fire) return '';
        const controls = defense ? `<div data-aoe-evade-gm hidden style="display:flex;gap:3px;margin:2px 0">` +
            ['hit', 'evaded'].map(value => `<button type="button" data-aoe-evade-override="${value}" data-aoe-evade-target="${escape(uuid)}" style="font-size:10px;height:22px;line-height:18px;flex:1">GM: ${value === 'hit' ? 'Hit' : 'Evaded'}</button>`).join('') + '</div>' : '';
        const fireControls = fire?.effectUuid && fire.status === 'burning'
            ? `<div style="display:flex;gap:3px">${['adjust', 'extinguish'].map(action =>
                `<button type="button" data-aoe-fire-${action} data-aoe-fire-effect="${escape(fire.effectUuid)}" data-aoe-fire-actor="${escape(fire.actorUuid)}" data-aoe-fire-target="${escape(uuid)}" hidden style="font-size:10px;height:22px;line-height:18px;flex:1">${action === 'adjust' ? 'Adjust Fire' : 'Extinguish'}</button>`).join('')}</div>` : '';
        return `<div style="margin:3px 0"><strong>${escape(target.name ?? target.actor?.name ?? 'Target')}</strong>` +
            controls + fireControls + (defense?.rollHtml ? `<div>Evade</div>${defense.rollHtml}` : '') +
            (fire?.rollHtml ? `<div>Fire</div>${fire.rollHtml}` : '') + '</div>';
    }).filter(Boolean);
    if (!entries.length) return '';
    return `<details class="swadetools-aoe-resolution-details" style="font-size:11px;margin:3px 0"><summary>AoE Details</summary>${entries.join('')}` +
        (targets.some(target => Number.isFinite(fireOf(target, state)?.damageTotal))
            ? '<div style="font-size:10px">Fire damage: armor applies. GM applies damage manually.</div>' : '') + '</details>';
};
