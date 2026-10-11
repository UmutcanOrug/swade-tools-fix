import { registerAoeAuthorityHandler, requestAoeAuthority, validateAoeAuthorityContext } from './AoeAuthority.js';
import { getAoeTargetResult, withAoeTargetResult } from './AoeTargetResults.js';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const resultOf = (message, uuid) => getAoeTargetResult(message?.flags?.world?.aoeEvadeResults, uuid);
const completed = result => ({...result, allowed: result.evaded !== true, pending: false});
const pending = reason => ({allowed: false, evaded: false, pending: true, reason});
const registeredDocuments = new WeakSet();
const rollDice = roll => roll?.dice ?? roll?.terms?.[0]?.dice ?? [roll?.terms?.[0]].filter(Boolean);
const firstFace = die => Number(die?.results?.[0]?.result ?? die?.total);
const improvedDodge = actor => Array.from(actor?.items?.contents ?? actor?.items ?? [])
    .some(item => item.type === 'edge' && (String(item.system?.swid ?? item.flags?.swade?.swid ?? '')
        .toLowerCase().replace(/[^a-z]/g, '') === 'improveddodge' ||
        String(item.name ?? '').trim().toLowerCase() === 'improved dodge'));

export const renderAoeEvadeCard = (actorName, result, attackId, targetUuid) =>
    `<article class="swadetools-aoe-evade" style="font-size:12px;line-height:18px"><strong>${escapeHTML(actorName)}</strong>` +
    `<div>Evade — ${result.pending ? 'no Agility die; GM decision required' : result.total == null ? 'GM adjudication (no Agility die)' : `Agility${result.modifier >= 0 ? ' +' : ' '}${result.modifier}${result.improvedDodge ? ', Improved Dodge +2' : ''}`}</div>` +
    `<div class="dice-roll"><div class="dice-total" style="font-size:20px;line-height:26px;color:${result.pending ? 'gray' : result.evaded ? 'green' : '#a61b1b'}">${result.total == null ? result.pending ? 'GM Decision' : result.evaded ? 'Evaded (GM)' : 'Hit (GM)' : `${escapeHTML(result.total)} — ${result.evaded ? 'Evaded' : result.criticalFailure ? 'Critical Failure' : 'Hit'}`}</div></div>` +
    `<div data-aoe-evade-gm hidden style="margin-top:3px"><button type="button" data-aoe-evade-override="hit" style="width:49%;height:24px;line-height:20px;font-size:11px">GM: Hit</button> <button type="button" data-aoe-evade-override="evaded" style="width:49%;height:24px;line-height:20px;font-size:11px">GM: Evaded</button></div>` +
    '</article>';

const refresh = async (message, runtime) => {
    if (runtime.refreshAoeChatCard) return runtime.refreshAoeChatCard(message, runtime);
    const module = await import('./AoeChatControl.js');
    return module.refreshAoeChatCard?.(message, runtime);
};

const rollAudit = async roll => {
    const audit = {};
    // Keep the native roll on the attack's result record rather than posting a
    // separate defense message for every victim. Rendering is optional: an
    // unavailable dice renderer must never prevent a valid defense result.
    try {
        if (typeof roll?.toJSON === 'function') audit.rollData = JSON.parse(JSON.stringify(roll.toJSON()));
    } catch (error) {
        console.warn('SWADE Tools: Could not serialize the Evade roll.', error);
    }
    try {
        if (typeof roll?.render === 'function') audit.rollHtml = await roll.render();
    } catch (error) {
        console.warn('SWADE Tools: Could not render the Evade roll.', error);
    }
    return audit;
};

const resolveAsGm = async (context, runtime) => {
    const {message, target, actor, state} = context;
    if (state.autoEvade !== true) return {allowed: true, evaded: false, pending: false};
    const existing = resultOf(message, target.uuid);
    if (existing && typeof existing.evaded === 'boolean') return completed(existing);
    if (existing?.pending) return pending(existing.reason);
    if (!actor.system?.attributes?.agility?.die?.sides) {
        const result = {pending: true, evaded: null, total: null,
            reason: 'This target has no Agility die. The GM can choose Hit or Evaded on the AoE attack card.'};
        await message.update({'flags.world.aoeEvadeResults': withAoeTargetResult(message.flags.world.aoeEvadeResults, target.uuid, result)});
        await refresh(message, runtime);
        return pending(result.reason);
    }
    const modifier = Number.isFinite(Number(state.evadeModifier)) ? Math.max(-20, Math.min(20, Number(state.evadeModifier))) : -2;
    const CharRollClass = runtime.CharRollClass ?? (await import('../class/CharRoll.js')).default;
    const charRoll = new CharRollClass(actor);
    charRoll.addModifier(modifier, 'Evade');
    const dodge = improvedDodge(actor);
    if (dodge) charRoll.addModifier(2, 'Improved Dodge');
    const roll = await charRoll.rollAtt('agility');
    const dice = rollDice(roll);
    const isWild = actor.isWildcard === true;
    const naturalOneFailure = !isWild && firstFace(dice[0]) === 1;
    const criticalFailure = isWild && firstFace(dice[0]) === 1 && firstFace(dice[1]) === 1;
    const total = Number(roll.total);
    if (!Number.isFinite(total)) return pending('The Evade roll did not return a valid result.');
    const audit = await rollAudit(roll);
    // Re-check after awaiting the roll: a Benny or GM correction may have
    // superseded the originating attack while the dice animation was running.
    const latest = await validateAoeAuthorityContext({messageId: message.id, targetUuid: target.uuid}, context.requester.id, runtime);
    if (!latest || latest.message !== message || latest.state.autoEvade !== true) return pending('This AoE attack changed before Evade completed.');
    const result = {evaded: total >= 4 && !criticalFailure && !naturalOneFailure,
        total, modifier, improvedDodge: dodge, criticalFailure, naturalOneFailure, ...audit};
    await message.update({'flags.world.aoeEvadeResults': withAoeTargetResult(message.flags.world.aoeEvadeResults, target.uuid, result)});
    await refresh(message, runtime);
    return completed(result);
};

export const registerAoeEvadeAuthority = () => registerAoeAuthorityHandler('evade', resolveAsGm);

export const resolveAoeEvade = async (message, targetUuid, runtime = {}) => {
    if (message?.flags?.world?.aoeAttack?.autoEvade !== true) return {allowed: true, evaded: false, pending: false};
    const existing = resultOf(message, targetUuid);
    if (existing && typeof existing.evaded === 'boolean') return completed(existing);
    registerAoeEvadeAuthority();
    const result = await requestAoeAuthority('evade', {messageId: message.id, targetUuid}, runtime);
    if (!result.allowed && result.evaded !== true) (runtime.notifications ?? globalThis.ui?.notifications)?.warn(
        result.reason || 'Evade could not be resolved. The GM should review this AoE attack.');
    return result;
};

const currentAttackId = (originalId, gameRef) => {
    let message = gameRef?.messages?.get?.(originalId);
    const visited = new Set();
    const identityKeys = ['sceneId', 'weaponActorUuid', 'operatorActorUuid', 'itemUuid'];
    for (let hop = 0; message && hop < 16; hop++) {
        if (visited.has(message.id)) return null;
        visited.add(message.id);
        if (!message.flags?.world?.aoeSuperseded) return message.id;
        const next = gameRef.messages.get(message.flags.world.aoeSupersededBy);
        const state = message.flags.world.aoeAttack;
        const nextState = next?.flags?.world?.aoeAttack;
        if (!nextState || next.flags.world.aoePreviousMessage !== message.id ||
            identityKeys.some(key => !state?.[key] || state[key] !== nextState[key])) return null;
        message = next;
    }
    return null;
};

const updateAoeEvadeOutcome = async (attackMessage, targetUuid, evaded, runtime) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    if (!gameRef?.user?.isGM || typeof evaded !== 'boolean' || typeof targetUuid !== 'string') return null;
    // A missing-Agility decision can still be pending when a Benny creates a
    // successor card. Follow only the bidirectional persisted same-attack
    // chain; never mutate the superseded card's original defense audit data.
    const attackId = currentAttackId(attackMessage?.id, gameRef);
    if (!attackId) return null;
    const context = await validateAoeAuthorityContext({messageId: attackId, targetUuid}, gameRef.user.id, runtime);
    const previous = resultOf(context?.message, targetUuid);
    if (!context || context.state.autoEvade !== true || !previous) return null;
    const result = {...previous, evaded, pending: false, gmOverride: true};
    await context.message.update({'flags.world.aoeEvadeResults': withAoeTargetResult(context.message.flags.world.aoeEvadeResults,
        targetUuid, result),
    ...(context.state.damageWorkflowStarted && previous.evaded !== evaded
        ? {'flags.world.aoeAttack': {...context.state, reviewExistingDamage: true}} : {})});
    await refresh(context.message, runtime);
    return {context, result};
};

// GM adjudication covers targets unable to see the attack or with no escape
// route. It never moves tokens, spends Bennies or silently reverses damage.
export const setAoeAttackEvadeOutcome = async (attackMessage, targetUuid, evaded, runtime = {}) =>
    Boolean(await updateAoeEvadeOutcome(attackMessage, targetUuid, evaded, runtime));

// Retain controls on defense messages created before the integrated AoE card.
export const setAoeEvadeOutcome = async (defenseMessage, evaded, runtime = {}) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    const check = defenseMessage?.flags?.world?.aoeEvadeCheck;
    if (!check) return false;
    const attack = gameRef?.messages?.get?.(check.attackId);
    const update = await updateAoeEvadeOutcome(attack, check.targetUuid, evaded, runtime);
    if (!update) return false;
    await defenseMessage.update({content: renderAoeEvadeCard(update.context.actor.name, update.result,
        check.attackId, check.targetUuid)});
    return true;
};

export const registerAoeEvadeControls = (runtime = {}) => {
    const documentRef = runtime.documentRef ?? globalThis.document;
    const hooks = runtime.hooks ?? globalThis.Hooks;
    const gameRef = runtime.gameRef ?? globalThis.game;
    if (!documentRef?.addEventListener || !hooks?.on || registeredDocuments.has(documentRef)) return;
    registeredDocuments.add(documentRef);
    hooks.on('renderChatMessageHTML', (_message, html) => {
        const element = html?.[0] ?? html;
        // Foundry's persisted HTML sanitizer removes hidden attributes, so
        // enforce the viewer's role on every render, including player clients.
        element.querySelectorAll?.('[data-aoe-evade-gm]').forEach(control => control.hidden = gameRef?.user?.isGM !== true);
    });
    documentRef.addEventListener('click', async event => {
        const control = event.target?.closest?.('[data-aoe-evade-override]');
        if (!control) return;
        event.preventDefault();
        const messageId = control.closest('[data-message-id]')?.dataset.messageId;
        const message = gameRef?.messages?.get?.(messageId);
        const evaded = control.dataset.aoeEvadeOverride === 'evaded';
        if (control.dataset.aoeEvadeTarget) {
            await setAoeAttackEvadeOutcome(message, control.dataset.aoeEvadeTarget, evaded, runtime);
        } else await setAoeEvadeOutcome(message, evaded, runtime);
    });
};
