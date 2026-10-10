import { prepareWeaponDamageModifier } from './WeaponDamageModifier.js';
import { withSuppressedAoeAutomation } from './AoeAnimationService.js';

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
    const title = outcome.success ? 'Targets: click to roll damage.' : 'Targets:';
    return `<div class="swadetools-target-title" style="font-size:11px;margin-bottom:2px">${title}${targets.length ? '' : ' None'}</div>${targets.map(target => {
        const name = escapeHTML(target.name || target.actor?.name || 'Unknown');
        const uuid = escapeHTML(target.uuid || target.document?.uuid || '');
        const term = outcome.raise ? 'raise' : outcome.success ? 'hit' : 'miss';
        const content = `<i class="fas fa-${outcome.success ? 'bullseye' : 'times-circle'}" aria-hidden="true"></i><div class="swadetools-targetname">${name}: ${outcome.status}</div>`;
        const row = outcome.success
            ? `<a data-aoe-damage-target="${uuid}" class="swadetools-rolldamage-style" title="Roll Damage">${content}</a>`
            : content;
        return `<div class="swadetools-aoe-target swadetools-targetwrap swadetools-term-${term}" style="margin:3px 0;border:1px solid #737171;border-radius:3px;font-size:12px;line-height:17px;overflow-wrap:anywhere">${row}</div>`;
    }).join('')}`;
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
    result = updateRegion(result, 'data-aoe-deviation', outcome.success ? ''
        : '<div style="font-size:11px;margin:4px 0"><strong>Deviation:</strong> GM: move the red template to resolve.</div>',
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

const validateMessage = (message, runtime) => {
    const state = stateOf(message);
    if (!state || state.version !== 1 || message.flags?.world?.aoeSuperseded) {
        notify(runtime, 'This AoE attack card is no longer active.');
        return null;
    }
    return state;
};

const collectCircleTargets = (canvasRef, template, previousTargets) => {
    if (!template || !canvasRef?.tokens?.placeables) return previousTargets;
    const gridDistance = Number(canvasRef.scene?.grid?.distance);
    const gridSize = Number(canvasRef.grid?.size ?? canvasRef.scene?.grid?.size);
    const radius = Number(template.distance) / gridDistance * gridSize;
    if (!Number.isFinite(radius) || radius < 0) return previousTargets;
    return canvasRef.tokens.placeables.filter(token => token.actor && token.isVisible !== false &&
        token.visible !== false && !token.document?.hidden &&
        Math.hypot(Number(token.center?.x) - Number(template.x),
            Number(token.center?.y) - Number(template.y)) <= radius + 0.5)
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
    if (!current || busyMessages.has(message.id)) return false;
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
            const color = outcome.success ? '#ff6b35' : '#d62828';
            const changes = {fillColor: color, borderColor: color,
                'flags.world.throwSucceeded': outcome.success,
                'flags.world.pendingDeviation': !outcome.success,
                'flags.world.aoeGmCorrection': true};
            if (outcome.success && !getAoeAttackOutcome(current).success && state.originalPoint) {
                changes.x = state.originalPoint.x;
                changes.y = state.originalPoint.y;
            }
            await template.update(changes);
            state.targets = collectCircleTargets(canvasRef, template, state.targets);
        }
        await message.update({'flags.world.aoeAttack': state,
            content: replaceCardOutcome(message.content, state)});
        return true;
    } finally {
        busyMessages.delete(message.id);
    }
};

export const rollAoeChatTargetDamage = async (message, targetUuid, runtime = {}) => {
    const state = validateMessage(message, runtime);
    const {gameRef, canvasRef, fromUuid} = contextOf(runtime);
    if (!state || !getAoeAttackOutcome(state).success || busyMessages.has(message.id)) return false;
    const targetState = state.targets?.find(target => target.uuid === targetUuid);
    if (!targetState || sceneIdOf(targetUuid) !== state.sceneId ||
        String(canvasRef?.scene?.id ?? '') !== state.sceneId) {
        notify(runtime, 'Open the original AoE attack scene before rolling its target damage.');
        return false;
    }
    const [owner, operator, item, targetDocument] = await Promise.all([
        fromUuid(state.weaponActorUuid), fromUuid(state.operatorActorUuid),
        fromUuid(state.damageItemUuid), fromUuid(targetUuid),
    ]);
    const target = targetDocument?.object ?? targetDocument;
    if (!owner || !operator || !item || !target?.actor || !targetDocument?.id ||
        (item.actor?.uuid ?? item.parent?.uuid) !== owner.uuid) {
        notify(runtime, 'The AoE weapon, operator or target is no longer available.');
        return false;
    }
    if (!gameRef?.user?.isGM && (!owner.isOwner || !operator.isOwner || item.isOwner === false)) {
        notify(runtime, 'You do not own this AoE attack.');
        return false;
    }
    const action = state.damageActionId ? item.system?.actions?.additional?.[state.damageActionId] : null;
    if (state.damageActionId && action?.type !== 'damage') {
        notify(runtime, 'The configured AoE damage action is no longer available.');
        return false;
    }
    const prepared = prepareWeaponDamageModifier(state.damageModifier, operator,
        {RollClass: runtime.RollClass ?? globalThis.Roll});
    if (!prepared.ok) { notify(runtime, prepared.reason); return false; }
    busyMessages.add(message.id);
    try {
        const ItemRollClass = runtime.ItemRollClass ?? (await import('../class/ItemRoll.js')).default;
        const roll = new ItemRollClass(operator, item);
        if (owner.type === 'vehicle') roll.usingVehicle(owner);
        // Explicitly disable native resource accounting on this damage-only
        // roll as well as avoiding every attack/consume/cast method.
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

export const registerAoeChatControls = (runtime = {}) => {
    const documentRef = runtime.documentRef ?? globalThis.document;
    const hooksRef = runtime.hooksRef ?? globalThis.Hooks;
    if (!documentRef?.addEventListener || registeredDocuments.has(documentRef)) return;
    registeredDocuments.add(documentRef);
    hooksRef?.on?.('renderChatMessageHTML', (_message, html) => {
        const gameRef = runtime.gameRef ?? globalThis.game;
        const root = html?.querySelectorAll ? html : html?.[0];
        for (const button of root?.querySelectorAll?.('[data-aoe-gm-mod]') ?? []) {
            button.hidden = !gameRef?.user?.isGM;
        }
    });
    documentRef.addEventListener('click', async event => {
        const gameRef = runtime.gameRef ?? globalThis.game;
        const button = event.target?.closest?.('[data-aoe-gm-mod], [data-aoe-damage-target]');
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
            } else {
                await rollAoeChatTargetDamage(message, button.dataset.aoeDamageTarget, runtime);
            }
        } catch (error) {
            (runtime.logger ?? console).error('SWADE Tools | AoE chat control failed', error);
            notify(runtime, 'The AoE chat action could not be completed.');
        }
    });
};
