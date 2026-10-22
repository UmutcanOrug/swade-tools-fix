import { prepareWeaponDamageModifier } from './WeaponDamageModifier.js';
import { withSuppressedAoeAutomation } from './AoeAnimationService.js';
import { resolveAoeEvade } from './AoeEvade.js';
import { recordAoeFireHit } from './AoeFire.js';
import { collectAoeTemplateTargets } from './AoeGeometry.js';
import { getAoeTargetResult } from './AoeTargetResults.js';
import { renderAoeTargetSummary, renderAoeResolutionDetails } from './AoeResultSummary.js';
import { isAoeTemplateDirectional } from './AoeItemFlags.js';
export { renderAoeResolutionDetails };

const registeredDocuments = new WeakSet();
const busyMessages = new Set();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const stateOf = message => message?.flags?.world?.aoeAttack;
const contextOf = runtime => ({gameRef: runtime.gameRef ?? globalThis.game,
    canvasRef: runtime.canvasRef ?? globalThis.canvas,
    fromUuid: runtime.fromUuid ?? globalThis.fromUuid});
const notify = (runtime, text) => (runtime.notifications ?? globalThis.ui?.notifications)?.warn(text);
const sceneIdOf = uuid => String(uuid ?? '').match(/^Scene\.([^.]+)\./)?.[1];
const isDirectional = state => isAoeTemplateDirectional(state?.shape, state?.customShape);
const canDamage = state => getAoeAttackOutcome(state).success ||
    (!isDirectional(state) && state?.deviationResolved === true);
export const isAoeChatTransactionPending = (message, key = 'aoeResolving') => {
    const flag = message?.flags?.world?.[key];
    if (!flag) return false;
    const expiry = Number(flag.expiresAt);
    return !Number.isFinite(expiry) || Date.now() < expiry;
};

export const getAoeAttackOutcome = state => {
    const baseTotal = Number(state?.baseTotal);
    const gmModifier = Number(state?.gmModifier ?? 0);
    const total = baseTotal + gmModifier;
    const success = Number.isFinite(total) && !state?.criticalFailure &&
        !state?.naturalOneFailure && total >= 4;
    const raise = success && total >= 8;
    return {total, success, raise,
        status: state?.criticalFailure ? 'Critical Failure' : raise ? 'Raise' : success ? 'Hit' : 'Miss',
        color: raise ? 'purple' : success ? 'green' : 'gray'};
};

// Shared by the macro and every chat client. The target is persisted by UUID;
// clicking this row never reads or changes the current user's target rings.
export const renderAoeAttackTargets = (targets, state) => {
    const outcome = getAoeAttackOutcome(state);
    const blast = !isDirectional(state) && state?.deviationResolved === true && !outcome.success;
    const damageAllowed = outcome.success || blast;
    const title = damageAllowed ? 'Targets: click to roll damage.' : 'Targets:';
    return `<div class="swadetools-target-title" style="font-size:11px;margin-bottom:2px">${title}${targets.length ? '' : ' None'}</div>${targets.map(target => {
        const name = escapeHTML(target.name || target.actor?.name || 'Unknown');
        const uuid = escapeHTML(target.uuid || target.document?.uuid || '');
        const evaded = getAoeTargetResult(state.evadeResults, target.uuid || target.document?.uuid)?.evaded === true;
        const term = evaded ? 'miss' : blast ? 'blast' : outcome.raise ? 'raise' : outcome.success ? 'hit' : 'miss';
        const content = `<i class="fas fa-${damageAllowed && !evaded ? 'bullseye' : 'times-circle'}" aria-hidden="true"></i><div class="swadetools-targetname">${name}: ${evaded ? 'Evaded' : blast ? 'Blast' : outcome.status}</div>`;
        const row = damageAllowed && !evaded
            ? `<a data-aoe-damage-target="${uuid}" class="swadetools-rolldamage-style" title="Roll Damage">${content}</a>`
            : content;
        return `<div class="swadetools-aoe-target swadetools-targetwrap swadetools-term-${term}" style="display:block;margin:3px 0;border:1px solid #737171;border-radius:3px;font-size:12px;line-height:17px;overflow-wrap:anywhere">${row}${renderAoeTargetSummary(target, state)}</div>`;
    }).join('')}`;
};

export const renderAoeDeviationControls = state => {
    if (isDirectional(state)) return '';
    if (state?.deviationResolved) return '<div style="font-size:11px;margin:4px 0"><strong>Deviation:</strong> resolved by GM.</div>';
    if (getAoeAttackOutcome(state).success) return '';
    if (state?.damageWorkflowStarted) return '<div style="font-size:11px;margin:4px 0">GM: review existing damage and blast location.</div>';
    return '<div style="font-size:11px;margin:4px 0"><strong>Deviation:</strong> pending GM placement.</div><button type="button" data-aoe-resolve-deviation hidden style="height:24px;line-height:20px;font-size:12px;margin:0" title="Place the actual blast and roll its target damage">Resolve Deviation</button>';
};

// ChatMessage.content is sanitized HTML: comments are not persistent markers.
// Match a controlled div region and balance its nested divs so target rows can
// be replaced without consuming the surrounding dice, Benny or Details blocks.
// This also works without a browser DOM (for headless regression checks).
const replaceDivRegion = (content, openingPattern, replacement) => {
    const opening = openingPattern.exec(content);
    if (!opening) return null;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = opening.index + opening[0].length;
    let depth = 1, tag;
    while ((tag = tags.exec(content))) {
        depth += /^<\//.test(tag[0]) ? -1 : 1;
        if (depth === 0) return content.slice(0, opening.index) + replacement + content.slice(tags.lastIndex);
    }
    return null;
};
const regionPattern = attribute => new RegExp(`<div\\b(?=[^>]*\\s${attribute}(?:\\s|=|>))[^>]*>`, 'i');
const insertBeforeDetails = (content, html) => /<details\b/i.test(content)
    ? content.replace(/<details\b/i, `${html}<details`)
    : content + html;
const updateRegion = (content, attribute, html, legacyPattern, insert) => {
    const wrapper = `<div ${attribute}>${html}</div>`;
    return replaceDivRegion(content, regionPattern(attribute), wrapper)
        ?? (legacyPattern ? replaceDivRegion(content, legacyPattern, wrapper) : null)
        ?? (insert ?? insertBeforeDetails)(content, wrapper);
};

const replaceCardOutcome = (content, state) => {
    const outcome = getAoeAttackOutcome(state);
    const resultLabel = state.criticalFailure ? 'Critical Failure' : outcome.raise ? 'Raise' : outcome.success ? 'Success' : 'Failure';
    let result = String(content)
        .replace(/<!--aoe-[\s\S]*?-->/g, '')
        .replace(/(<span data-aoe-result[^>]*>)[\s\S]*?(<\/span>)/,
            `$1${resultLabel}$2`)
        .replace(/(<div class="dice-total"[^>]*>)[\s\S]*?(<\/div>)/,
            `$1${outcome.total}$2`);
    result = updateRegion(result, 'data-grenade-targets', renderAoeAttackTargets(state.targets ?? [], state));
    result = updateRegion(result, 'data-aoe-resolution', renderAoeResolutionDetails(state.targets ?? [], state));
    result = updateRegion(result, 'data-aoe-deviation', renderAoeDeviationControls(state),
        /<div\b[^>]*>(?=\s*<strong>Deviation:<\/strong>)/i);
    result = updateRegion(result, 'data-aoe-gm-modifier', state.gmModifier
        ? `<div class="swadetools-aoe-gm-mod" style="font-size:11px">GM Modifier: ${state.gmModifier >= 0 ? '+' : ''}${state.gmModifier}</div>` : '',
        /<div\b[^>]*class="swadetools-aoe-gm-mod"[^>]*>/i,
        (html, region) => /<div\b[^>]*class="dice-roll"/i.test(html)
            ? html.replace(/<div\b(?=[^>]*class="dice-roll")/i, `${region}<div`)
            : insertBeforeDetails(html, region));
    result = updateRegion(result, 'data-aoe-review', state.reviewExistingDamage
        ? '<div data-aoe-gm-review style="color:#a61b1b;font-size:12px;margin:4px 0"><strong>GM: review existing damage.</strong></div>' : '',
        regionPattern('data-aoe-gm-review'));
    // Color belongs to the effective result, not to the original failed die.
    result = result.replace(/(<span data-aoe-result[^>]*style=")[^"]*(")/,
        `$1color:${outcome.color};font-weight:bold$2`)
        .replace(/(<div class="dice-total"[^>]*style=")[^"]*(")/,
            `$1font-size:20px;line-height:26px;color:${outcome.color}$2`);
    return result;
};

// Defense results live outside the attack snapshot so another client's native
// GM correction or Benny refresh cannot accidentally erase them.
export const refreshAoeChatCard = async (message, runtime = {}) => {
    const state = stateOf(message);
    if (!state || message.flags?.world?.aoeSuperseded) return false;
    const gameRef = runtime.gameRef ?? globalThis.game;
    if (!gameRef?.user?.isGM && message.isOwner === false) return false;
    await message.update({content: replaceCardOutcome(message.content, {...state,
        evadeResults: message.flags?.world?.aoeEvadeResults ?? {},
        fireResults: message.flags?.world?.aoeFireResults ?? {}})});
    return true;
};

const validateMessage = (message, runtime) => {
    const state = stateOf(message);
    if (!state || state.version !== 1 || message.flags?.world?.aoeSuperseded) {
        notify(runtime, 'This AoE attack card is no longer active.');
        return null;
    }
    return state;
};

const collectTemplateTargets = (canvasRef, template, previousTargets, state = {}) => {
    if (!template || !canvasRef?.tokens?.placeables) return previousTargets;
    const gridDistance = Number(canvasRef.scene?.grid?.distance);
    const gridSize = Number(canvasRef.grid?.size ?? canvasRef.scene?.grid?.size);
    if (!(gridDistance > 0) || !(gridSize > 0)) return previousTargets;
    return collectAoeTemplateTargets(template, canvasRef.tokens.placeables, {
        gridSize, sceneDistance: gridDistance, sourceTokenUuid: state.sourceTokenUuid,
        excludeSource: isDirectional(state) && state.origin !== 'free'})
        .map(token => ({id: token.id, uuid: token.document?.uuid, name: token.name || token.actor.name}));
};

// Native + semantics: the entered modifier replaces the previous GM modifier.
// It changes the existing attack only; ammunition, animation and damage are not
// repeated. Damage starts only when a now-successful target row is clicked.
export const applyAoeGmModifier = async (message, value, runtime = {}) => {
    const {gameRef, canvasRef} = contextOf(runtime);
    if (!gameRef?.user?.isGM) {
        notify(runtime, 'Only the GM can adjust an AoE attack.');
        return false;
    }
    const current = validateMessage(message, runtime);
    if (!current || busyMessages.has(message.id) || isAoeChatTransactionPending(message) || isAoeChatTransactionPending(message, 'aoeBennyInProgress')) return false;
    const input = String(value ?? '').trim();
    let gmModifier = input ? Number(input) : 0;
    if (!Number.isFinite(gmModifier)) {
        const RollClass = runtime.RollClass ?? globalThis.Roll;
        if (!RollClass?.validate?.(input) || input.includes('@')) {
            notify(runtime, 'Enter a valid numeric modifier or dice formula.');
            return false;
        }
        const rolled = await new RollClass(input).evaluate();
        gmModifier = Number(rolled.total);
    }
    if (!Number.isFinite(gmModifier)) return false;
    const state = {...current, gmModifier};
    const previousOutcome = getAoeAttackOutcome(current);
    const outcome = getAoeAttackOutcome(state);
    if (state.damageWorkflowStarted &&
        (previousOutcome.success !== outcome.success || previousOutcome.raise !== outcome.raise)) {
        state.reviewExistingDamage = true;
    }
    state.success = outcome.success;
    state.raise = outcome.raise;
    state.total = outcome.total;
    busyMessages.add(message.id);
    try {
        const sameScene = String(canvasRef?.scene?.id ?? '') === String(state.sceneId);
        const template = sameScene ? canvasRef.scene.templates?.get(state.templateId) : null;
        if (template) {
            const color = outcome.success || state.deviationResolved ? '#ff6b35' : '#d62828';
            const changes = {fillColor: color, borderColor: color,
                'flags.world.throwSucceeded': outcome.success,
                'flags.world.pendingDeviation': !isDirectional(state) && !outcome.success && !state.deviationResolved,
                'flags.world.aoeGmCorrection': true};
            if (outcome.success && !getAoeAttackOutcome(current).success && !state.deviationResolved && state.originalPoint) {
                changes.x = state.originalPoint.x;
                changes.y = state.originalPoint.y;
            }
            await template.update(changes, {aoeGmCorrection: true});
            state.targets = collectTemplateTargets(canvasRef, template, state.targets, state);
        }
        await message.update({'flags.world.aoeAttack': state,
            content: replaceCardOutcome(message.content, {...state,
                evadeResults: message.flags?.world?.aoeEvadeResults ?? {},
                fireResults: message.flags?.world?.aoeFireResults ?? {}})});
        return true;
    } finally {
        busyMessages.delete(message.id);
    }
};

const prepareAoeDamageContext = async (state, runtime) => {
    const {gameRef, fromUuid} = contextOf(runtime);
    const [owner, operator, item] = await Promise.all([
        fromUuid(state.weaponActorUuid), fromUuid(state.operatorActorUuid),
        fromUuid(state.damageItemUuid),
    ]);
    if (!owner || !operator || !item ||
        (item.actor?.uuid ?? item.parent?.uuid) !== owner.uuid) {
        notify(runtime, 'The AoE weapon or operator is no longer available.');
        return null;
    }
    if (!gameRef?.user?.isGM && (!owner.isOwner || !operator.isOwner || item.isOwner === false)) {
        notify(runtime, 'You do not own this AoE attack.');
        return null;
    }
    const action = state.damageActionId ? item.system?.actions?.additional?.[state.damageActionId] : null;
    if (state.damageActionId && action?.type !== 'damage') {
        notify(runtime, 'The configured AoE damage action is no longer available.');
        return null;
    }
    const prepared = prepareWeaponDamageModifier(state.damageModifier, operator,
        {RollClass: runtime.RollClass ?? globalThis.Roll});
    if (!prepared.ok) { notify(runtime, prepared.reason); return null; }
    return {owner, operator, item, action, prepared};
};

const rollPreparedAoeTargetDamage = async (state, targetUuid, context, runtime, message) => {
    const {gameRef, canvasRef, fromUuid} = contextOf(runtime);
    if (!state.targets?.some(target => target.uuid === targetUuid) ||
        sceneIdOf(targetUuid) !== state.sceneId || String(canvasRef?.scene?.id ?? '') !== state.sceneId) return false;
    const targetDocument = await fromUuid(targetUuid);
    const target = targetDocument?.object ?? targetDocument;
    if (!target?.actor || !targetDocument?.id) {
        notify(runtime, 'The AoE target is no longer available.');
        return false;
    }
    if (state.autoEvade === true) {
        const defense = await (runtime.resolveAoeEvade ?? resolveAoeEvade)(message, targetUuid, runtime);
        if (!defense?.allowed) return defense?.evaded === true;
        const latest = stateOf(message);
        if (!latest || message.flags?.world?.aoeSuperseded || !canDamage(latest) ||
            !latest.targets?.some(value => value.uuid === targetUuid)) return false;
    }
    const {owner, operator, item, action, prepared} = context;
    const ItemRollClass = runtime.ItemRollClass ?? (await import('../class/ItemRoll.js')).default;
    const roll = new ItemRollClass(operator, item);
    if (owner.type === 'vehicle') roll.usingVehicle(owner);
    // Damage-only rolls never consume another shell, grenade or Power Point.
    roll.manageshots = false;
    roll.useTarget(targetDocument.id);
    roll.addFlag('aoeArea', {sceneId: state.sceneId, targets: [targetUuid]});
    roll.setWeaponDamageModifier(prepared.formula);
    if (getAoeAttackOutcome(state).raise) roll.raiseDmg();
    const suppress = runtime.withSuppressedAoeAutomation ?? withSuppressedAoeAutomation;
    await suppress([item], async () => {
        if (action) await roll.rollAction(state.damageActionId);
        else await roll.rollBaseDamage();
        await roll.display();
    }, {gameRef, hooksRef: runtime.hooksRef ?? globalThis.Hooks});
    if (state.fire?.enabled === true) {
        try { await (runtime.recordAoeFireHit ?? recordAoeFireHit)(message, targetUuid, runtime); }
        catch (error) {
            (runtime.logger ?? console).error('SWADE Tools | Fire check could not be completed', error);
            notify(runtime, 'Damage was rolled, but the fire check needs GM review.');
        }
    }
    return true;
};

export const rollAoeChatTargetDamage = async (message, targetUuid, runtime = {}) => {
    const state = validateMessage(message, runtime);
    const {gameRef, canvasRef} = contextOf(runtime);
    if (!state || !canDamage(state) || busyMessages.has(message.id) ||
        isAoeChatTransactionPending(message) || isAoeChatTransactionPending(message, 'aoeBennyInProgress')) return false;
    if (!state.targets?.some(target => target.uuid === targetUuid) || sceneIdOf(targetUuid) !== state.sceneId ||
        String(canvasRef?.scene?.id ?? '') !== state.sceneId) {
        notify(runtime, 'Open the original AoE attack scene before rolling its target damage.');
        return false;
    }
    busyMessages.add(message.id);
    try {
        const context = await prepareAoeDamageContext(state, runtime);
        if (!context || !await rollPreparedAoeTargetDamage(state, targetUuid, context, runtime, message)) return false;
        // A later Benny must not automatically duplicate manually requested
        // damage. The existing damage cards remain under the GM's control.
        if (gameRef.user.isGM || message.isOwner !== false) {
            const latest = stateOf(message) ?? state;
            await message.update({'flags.world.aoeAttack': {...latest, damageWorkflowStarted: true}});
        }
        return true;
    } finally {
        busyMessages.delete(message.id);
    }
};

// A missed explosive still detonates. The GM chooses its actual location;
// that explicit resolution enables damage without changing a miss into a hit.
export const resolveAoeChatDeviation = async (message, runtime = {}) => {
    const {gameRef, canvasRef} = contextOf(runtime);
    if (!gameRef?.user?.isGM) { notify(runtime, 'Only the GM can resolve AoE deviation.'); return false; }
    const current = validateMessage(message, runtime);
    if (!current || isDirectional(current) || busyMessages.has(message.id) || isAoeChatTransactionPending(message) || isAoeChatTransactionPending(message, 'aoeBennyInProgress') ||
        getAoeAttackOutcome(current).success || current.deviationResolved || current.damageWorkflowStarted) return false;
    const sameScene = () => String(canvasRef?.scene?.id ?? '') === current.sceneId;
    const template = sameScene() ? canvasRef.scene.templates?.get(current.templateId) : null;
    if (!template || !(Number(template.distance) > 0)) {
        notify(runtime, 'Open the original scene and keep the blast template before resolving deviation.');
        return false;
    }
    if (canvasRef.ready === false || !Array.isArray(canvasRef.tokens?.placeables) ||
        !(Number(canvasRef.scene.grid?.distance) > 0) ||
        !(Number(canvasRef.grid?.size ?? canvasRef.scene.grid?.size) > 0)) {
        notify(runtime, 'Wait for the original scene to finish loading before resolving deviation.');
        return false;
    }
    const sequencerRef = runtime.sequencerRef ?? globalThis.Sequencer;
    if (!sequencerRef?.Crosshair?.show || gameRef.modules?.get?.('sequencer')?.active === false) {
        notify(runtime, 'AoE deviation placement requires Sequencer to be active.');
        return false;
    }
    busyMessages.add(message.id);
    const resolutionId = `${gameRef.user.id ?? 'gm'}:${Date.now()}:${Math.random()}`;
    try {
        const context = await prepareAoeDamageContext(current, runtime);
        if (!context) return false;
        const constRef = runtime.constRef ?? globalThis.CONST;
        let cancelled = false;
        const cancelEvent = sequencerRef.Crosshair.CALLBACKS?.CANCEL ?? 'cancel';
        const point = await sequencerRef.Crosshair.show({
            t: 'circle', distance: Number(template.distance),
            distanceMin: Number(template.distance), distanceMax: Number(template.distance),
            lockDrag: true, lockManualRotation: true, gridHighlight: true,
            borderColor: '#ff6b35', fillColor: '#ff6b35', fillAlpha: 0.2,
            snap: {position: (constRef?.GRID_SNAPPING_MODES?.CENTER ?? 1) |
                (constRef?.GRID_SNAPPING_MODES?.VERTEX ?? 2), resolution: 1},
            label: {text: `${context.item.name ?? 'AoE'} - Place Deviated Blast`},
        }, {[cancelEvent]: () => { cancelled = true; }});
        if (cancelled || !point || point.cancelled || point.canceled || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
        const latest = validateMessage(message, runtime);
        if (!latest || !sameScene() || isAoeChatTransactionPending(message, 'aoeBennyInProgress') || getAoeAttackOutcome(latest).success || latest.deviationResolved || latest.damageWorkflowStarted ||
            canvasRef.scene.templates?.get(current.templateId) !== template) {
            notify(runtime, 'The AoE attack changed during placement. Review its current card before resolving deviation.');
            return false;
        }
        // Persist a cross-client lock before moving or publishing clickable
        // targets. Benny and manual target clicks respect this same flag.
        await message.update({'flags.world.aoeResolving': {id: resolutionId, expiresAt: Date.now() + 300000}});
        const stillCurrent = () => !message.flags?.world?.aoeSuperseded &&
            !isAoeChatTransactionPending(message, 'aoeBennyInProgress') &&
            message.flags?.world?.aoeResolving?.id === resolutionId && sameScene();
        if (!stillCurrent()) return false;
        await template.update({x: point.x, y: point.y, fillColor: '#ff6b35', borderColor: '#ff6b35',
            'flags.world.pendingDeviation': false, 'flags.world.deviationResolved': true,
            'flags.world.aoeGmCorrection': true}, {aoeGmCorrection: true});
        // A template round trip can overlap a Benny from another client.
        // Never continue from the pre-update message snapshot.
        const active = validateMessage(message, runtime);
        if (!active || !stillCurrent() || getAoeAttackOutcome(active).success || active.deviationResolved ||
            active.damageWorkflowStarted || canvasRef.scene.templates?.get(current.templateId) !== template) {
            notify(runtime, 'The AoE attack changed. No deviation damage was rolled; review its current card.');
            return false;
        }
        const state = {...active, deviationResolved: true, resolvedPoint: {x: point.x, y: point.y},
            targets: collectTemplateTargets(canvasRef, template, active.targets, active)};
        state.damageWorkflowStarted = state.targets.length > 0;
        await message.update({'flags.world.aoeAttack': state, content: replaceCardOutcome(message.content, state)});
        let completed = 0;
        for (const target of state.targets) {
            if (!stillCurrent()) break;
            try {
                if (await rollPreparedAoeTargetDamage(state, target.uuid, context, runtime, message)) completed++;
            } catch (error) {
                (runtime.logger ?? console).error('SWADE Tools | Deviated blast damage failed', error);
            }
        }
        if (completed !== state.targets.length) notify(runtime, `${completed}/${state.targets.length} blast damage rolls completed. Click a target to retry missing damage.`);
        else if (!state.targets.length) notify(runtime, 'The resolved blast contains no visible targets.');
        return true;
    } finally {
        try {
            if (message.flags?.world?.aoeResolving?.id === resolutionId) {
                await message.update({'flags.world.aoeResolving': null});
            }
        } finally { busyMessages.delete(message.id); }
    }
};

export const registerAoeChatControls = (runtime = {}) => {
    const documentRef = runtime.documentRef ?? globalThis.document;
    const hooksRef = runtime.hooksRef ?? globalThis.Hooks;
    if (!documentRef?.addEventListener || registeredDocuments.has(documentRef)) return;
    registeredDocuments.add(documentRef);
    hooksRef?.on?.('renderChatMessageHTML', (_message, html) => {
        const gameRef = runtime.gameRef ?? globalThis.game;
        const root = html?.querySelectorAll ? html : html?.[0];
        for (const button of root?.querySelectorAll?.('[data-aoe-gm-mod], [data-aoe-resolve-deviation], [data-grenade-benny][data-benny-source="gm"]') ?? []) {
            button.hidden = !gameRef?.user?.isGM;
        }
    });
    documentRef.addEventListener('click', async event => {
        const gameRef = runtime.gameRef ?? globalThis.game;
        const button = event.target?.closest?.('[data-aoe-gm-mod], [data-aoe-damage-target], [data-aoe-resolve-deviation]');
        if (!button || button.disabled) return;
        const messageId = button.closest?.('[data-message-id]')?.dataset?.messageId;
        const message = gameRef?.messages?.get(messageId);
        if (!message) return;
        event.preventDefault();
        try {
            if (button.hasAttribute('data-aoe-gm-mod')) {
                if (!gameRef.user.isGM) return;
                const current = stateOf(message);
                if (!current) return;
                const DialogClass = globalThis.foundry?.applications?.api?.DialogV2;
                const prompt = runtime.prompt ?? DialogClass?.prompt?.bind(DialogClass);
                const value = await prompt({window: {title: 'Adjust AoE Attack'},
                    classes: ['swadetools-rof-dialog', 'themed', 'theme-light'],
                    content: `<div class="standard-form"><div class="form-group"><label>GM Modifier</label><div class="form-fields"><input type="text" name="modifier" value="${escapeHTML(current.gmModifier ?? 0)}"></div></div></div>`,
                    ok: {label: 'Apply Modifier', callback: (_event, control) => control.form.elements.modifier.value},
                    rejectClose: false, modal: false});
                if (value !== null && value !== undefined) await applyAoeGmModifier(message, value, runtime);
            } else if (button.hasAttribute('data-aoe-resolve-deviation')) {
                await resolveAoeChatDeviation(message, runtime);
            } else {
                await rollAoeChatTargetDamage(message, button.dataset.aoeDamageTarget, runtime);
            }
        } catch (error) {
            (runtime.logger ?? console).error('SWADE Tools | AoE chat control failed', error);
            notify(runtime, 'The AoE chat action could not be completed.');
        }
    });
};
