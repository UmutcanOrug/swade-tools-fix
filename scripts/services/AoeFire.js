import { isPrimaryAoeGm, registerAoeAuthorityHandler, requestAoeAuthority } from './AoeAuthority.js';
import { getAoeTargetResult, withAoeTargetResult } from './AoeTargetResults.js';

const SCOPE = 'swade-tools';
const FLAG = 'aoeBurning';
const FLAMMABILITY = Object.freeze({none: 0, flammable: 6, very: 4, volatile: 2});
const busyHits = new Set();
const busyEffects = new Set();
const messageWrites = new Map();
const actorMutations = new Map();
const registeredDocuments = new WeakSet();
const registeredHooks = new WeakSet();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const env = runtime => ({game: runtime.gameRef ?? globalThis.game,
    fromUuid: runtime.fromUuid ?? globalThis.fromUuid,
    ChatMessage: runtime.ChatMessageClass ?? globalThis.ChatMessage,
    Roll: runtime.RollClass ?? globalThis.Roll});
const warn = (runtime, text) => (runtime.notifications ?? globalThis.ui?.notifications)?.warn(text);
const readFlag = (document, key) => document?.getFlag?.(SCOPE, key) ?? document?.flags?.[SCOPE]?.[key];
const stateOf = effect => readFlag(effect, FLAG);
const actorOf = effect => effect?.parent ?? effect?.actor;
const effectsOf = actor => Array.from(actor?.effects?.values?.() ?? actor?.effects ?? []);
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 10;
const activeGm = runtime => isPrimaryAoeGm(env(runtime).game);
const resultOf = (message, targetUuid) => getAoeTargetResult(message?.flags?.world?.aoeFireResults, targetUuid);
const sourceState = message => message?.flags?.world?.aoeAttack;
const messageId = message => message?.id ?? message?._id;
const serial = (queue, key, task) => {
    const next = (queue.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    queue.set(key, next);
    return next.finally(() => {if (queue.get(key) === next) queue.delete(key);});
};
const privacyOf = source => ({whisper: Array.from(source?.whisper ?? [], user => typeof user === 'string' ? user : user.id)
    .filter(id => typeof id === 'string'), blind: source?.blind === true});
const targetFrom = async (uuid, runtime) => {
    if (!/^Scene\.[^.]+\.Token\.[^.]+$/.test(String(uuid))) return null;
    const token = await env(runtime).fromUuid?.(uuid);
    return token?.actor ? token : null;
};

export const getAoeFireSettings = (message, item) => {
    const saved = sourceState(message)?.fire;
    const initial = saved?.initialIntensity ?? readFlag(item, 'aoeFireIntensity') ?? 3;
    const maximum = saved?.maxIntensity ?? readFlag(item, 'aoeFireMaxIntensity') ?? 3;
    return {enabled: (saved?.enabled ?? readFlag(item, 'aoeFireEnabled')) === true,
        initialIntensity: integer(initial) ? Number(initial) : 3,
        maxIntensity: Math.max(integer(initial) ? Number(initial) : 3, integer(maximum) ? Number(maximum) : 3)};
};

// A separate top-level flag survives attack-result/card refreshes. A repeated
// request, damage click, or reroll of one hit can never produce a second catch roll.
const saveResult = (message, targetUuid, value) => serial(messageWrites, message, async () => {
    const results = withAoeTargetResult(message.flags?.world?.aoeFireResults, targetUuid, value);
    await message.update({'flags.world.aoeFireResults': results});
});
const eligibleHit = (message, targetUuid) => {
    const state = sourceState(message);
    if (!state?.targets?.some(target => target.uuid === targetUuid)) return false;
    const total = Number(state.baseTotal) + Number(state.gmModifier ?? 0);
    const successful = Number.isFinite(total) && total >= 4 && !state.criticalFailure && !state.naturalOneFailure;
    if (!successful && (!state.deviationResolved || ['cone', 'scone', 'stream'].includes(state.shape))) return false;
    if (state.autoEvade && getAoeTargetResult(message.flags?.world?.aoeEvadeResults, targetUuid)?.evaded !== false) return false;
    return true;
};
const createChat = async (content, flags, rolls, runtime, privacy) => {
    const {game, ChatMessage} = env(runtime);
    if (!ChatMessage?.create) throw new Error('Fire chat is unavailable.');
    return ChatMessage.create({user: game.user.id, content, rolls: rolls ?? [],
        ...(privacy ? privacyOf(privacy) : {}), flags: {[SCOPE]: flags}});
};
const flammabilityAction = '<button type="button" data-aoe-fire-flammability hidden style="font-size:11px;height:23px;margin-top:3px">Flammability</button>';
const fireActions = effect => `<div style="display:flex;gap:3px;margin-top:3px"><button type="button" data-aoe-fire-tick hidden style="font-size:11px;height:23px">Roll Fire Turn</button><button type="button" data-aoe-fire-adjust hidden style="font-size:11px;height:23px">Adjust Fire</button><button type="button" data-aoe-fire-extinguish hidden style="font-size:11px;height:23px">Extinguish</button></div>${flammabilityAction}`;
const renderRoll = async roll => typeof roll?.render === 'function' ? roll.render() : '';
const card = (name, body, details = '') => `<section class="swadetools-fire-card" style="font-size:12px;line-height:17px"><strong><i class="fas fa-fire" aria-hidden="true"></i> ${escapeHTML(name)}</strong>${body}${details ? `<details style="font-size:11px"><summary>Dice</summary>${details}</details>` : ''}</section>`;
const roll = async (formula, runtime) => {
    const Roll = env(runtime).Roll;
    if (!Roll) throw new Error('Fire dice are unavailable.');
    const value = new Roll(formula);
    await value.evaluate();
    return value;
};
const damageLine = (intensity, damage) => `<div>Fire Damage: ${intensity}d6 <strong style="font-size:18px">${Number(damage.total)}</strong></div>`;
const manualDamage = '<div style="font-size:10px">Armor applies. GM applies damage manually.</div>';
const turnKey = combat => {
    const combatant = combat?.combatant ?? combat?.turns?.[combat?.turn];
    if (!combatant || !(Number(combat.round) >= 1) || combat.started === false) return null;
    return `${combat.uuid ?? combat.id}:${Number(combat.round)}:${combatant.id ?? combatant._id}`;
};
const currentActor = combat => (combat?.combatant ?? combat?.turns?.[combat?.turn])?.actor;
const sameActor = (a, b) => a === b || Boolean(a?.uuid && a.uuid === b?.uuid);

export const getAoeBurningEffect = actor => effectsOf(actor).find(effect =>
    stateOf(effect)?.version === 1 && !effect.disabled && !effect.isSuppressed);

export const applyAoeBurning = (actor, data, runtime = {}) => serial(actorMutations, actor, async () => {
    if (!activeGm(runtime) || !actor?.createEmbeddedDocuments || !integer(data?.intensity) ||
        !integer(data?.maxIntensity) || Number(data.maxIntensity) < Number(data.intensity)) return null;
    const existing = getAoeBurningEffect(actor);
    if (existing) {
        const state = stateOf(existing);
        await existing.update({[`flags.${SCOPE}.${FLAG}`]: {...state,
            intensity: Math.max(Number(state.intensity), Number(data.intensity)),
            maxIntensity: Math.max(Number(state.maxIntensity), Number(data.maxIntensity))}});
        return existing;
    }
    const combat = env(runtime).game.combat;
    // Ignition during the victim's turn already caused its immediate damage;
    // do not also tick that same turn when combat is refreshed or rewound.
    const key = sameActor(currentActor(combat), actor) ? turnKey(combat) : null;
    const state = {version: 1, intensity: Number(data.intensity), maxIntensity: Number(data.maxIntensity),
        sourceActorUuid: String(data.sourceActorUuid ?? ''), sourceItemUuid: String(data.sourceItemUuid ?? ''),
        tokenUuid: String(data.tokenUuid ?? ''), ...privacyOf(data), turnKeys: key ? [key] : []};
    const created = await actor.createEmbeddedDocuments('ActiveEffect', [{name: 'Burning', img: 'icons/svg/fire.svg',
        disabled: false, transfer: false, changes: [], flags: {[SCOPE]: {[FLAG]: state}}}]);
    return created?.[0] ?? null;
});

export const extinguishAoeBurning = (effect, runtime = {}) => serial(actorMutations, actorOf(effect), async () => {
    if (!activeGm(runtime) || stateOf(effect)?.version !== 1 || !effect?.delete ||
        !effectsOf(actorOf(effect)).includes(effect)) return false;
    await effect.delete();
    return true;
});

export const adjustAoeBurning = (effect, intensity, maximum, runtime = {}) => serial(actorMutations, actorOf(effect), async () => {
    if (!activeGm(runtime) || stateOf(effect)?.version !== 1 || !integer(intensity) ||
        !integer(maximum) || Number(maximum) < Number(intensity) || !effectsOf(actorOf(effect)).includes(effect)) return false;
    await effect.update({[`flags.${SCOPE}.${FLAG}`]: {...stateOf(effect),
        intensity: Number(intensity), maxIntensity: Number(maximum)}});
    return true;
});

const resolveIgnition = async (message, target, flammability, settings, runtime) => {
    if (!activeGm(runtime) || !Object.hasOwn(FLAMMABILITY, flammability)) return {allowed: false};
    const targetUuid = target.uuid;
    const record = resultOf(message, targetUuid);
    if (record?.status !== 'pending') return {allowed: Boolean(record), status: record?.status};
    if (flammability === 'none') {
        await saveResult(message, targetUuid, {status: 'nonflammable'});
        return {allowed: true, status: 'nonflammable'};
    }
    // Persist the claim before rolling/creating an effect. If a client is lost
    // midway, the GM can resolve manually; automatic retry must not duplicate damage.
    await saveResult(message, targetUuid, {status: 'rolling'});
    const check = await roll('1d6', runtime);
    const caught = Number(check.total) >= FLAMMABILITY[flammability];
    let effect = null, damage = null;
    if (caught) {
        const state = sourceState(message);
        effect = await applyAoeBurning(target.actor, {intensity: settings.initialIntensity,
            maxIntensity: settings.maxIntensity, sourceActorUuid: state.operatorActorUuid,
            sourceItemUuid: state.itemUuid, tokenUuid: target.uuid, ...privacyOf(message)}, runtime);
        if (!effect) throw new Error('The Burning effect could not be created.');
        damage = await roll(`${settings.initialIntensity}d6x`, runtime);
    }
    await saveResult(message, targetUuid, {status: caught ? 'burning' : 'not-ignited',
        check: Number(check.total), flammability, effectUuid: effect?.uuid ?? null});
    const body = `<div>Ignition: ${Number(check.total)} — <strong>${caught ? 'Burning' : 'No ignition'}</strong></div>` +
        (caught ? damageLine(settings.initialIntensity, damage) + manualDamage + fireActions(effect) : flammabilityAction);
    await createChat(card(target.name ?? target.actor.name, body,
        (await renderRoll(check)) + (damage ? await renderRoll(damage) : '')),
    {aoeFire: {actorUuid: target.actor.uuid, effectUuid: effect?.uuid ?? null}},
    damage ? [check, damage] : [check], runtime, message);
    return {allowed: true, status: caught ? 'burning' : 'not-ignited'};
};

export const recordAoeFireHitAsGm = async (context, runtime = {}) => {
    const {message, target, item} = context ?? {};
    const uuid = target?.uuid;
    const key = `${messageId(message)}:${uuid}`;
    if (!activeGm(runtime) || !uuid || !target.actor || message?.flags?.world?.aoeSuperseded ||
        !eligibleHit(message, uuid)) return {allowed: false};
    const settings = getAoeFireSettings(message, item);
    if (!settings.enabled) return {allowed: true, status: 'disabled'};
    if (busyHits.has(key)) return {allowed: false, pending: true};
    const previous = resultOf(message, uuid);
    if (previous) return {allowed: true, status: previous.status};
    // Older clients may create a reroll card without copying its target flags.
    // Following the persisted same-attack chain still prevents re-ignition.
    const visited = new Set([messageId(message)]);
    let ancestorId = message.flags?.world?.aoePreviousMessage;
    while (ancestorId && !visited.has(ancestorId)) {
        visited.add(ancestorId);
        const ancestor = env(runtime).game.messages?.get(ancestorId);
        const result = resultOf(ancestor, uuid);
        if (result) return {allowed: true, status: result.status};
        ancestorId = ancestor?.flags?.world?.aoePreviousMessage;
    }
    busyHits.add(key);
    try {
        await saveResult(message, uuid, {status: 'pending', settings});
        const flammability = readFlag(target.actor, 'aoeFlammability');
        if (Object.hasOwn(FLAMMABILITY, flammability)) {
            return await resolveIgnition(message, target, flammability, settings, runtime);
        }
        await createChat(card(target.name ?? target.actor.name,
            '<div>GM: choose target flammability.</div><button type="button" data-aoe-fire-check hidden style="font-size:12px;height:25px">Fire Check</button>'),
        {aoeFireCheck: {attackMessageId: messageId(message), targetUuid: uuid},
            aoeFire: {actorUuid: target.actor.uuid, effectUuid: null}}, [], runtime, message);
        return {allowed: true, status: 'pending'};
    } catch (error) {
        warn(runtime, error?.message ?? 'Fire could not be resolved. GM: review the target manually.');
        return {allowed: false, error: 'Fire could not be resolved. GM: review the target manually.'};
    } finally { busyHits.delete(key); }
};

export const recordAoeFireHit = async (message, targetUuid, runtime = {}) => {
    const result = await requestAoeAuthority('fireHit', {messageId: messageId(message), targetUuid}, runtime);
    if (!result?.allowed) warn(runtime, result?.reason ?? result?.error ?? 'Fire check pending: an active GM is required.');
    return result;
};

export const resolveAoeFireCheck = async (checkMessage, flammability, remember = false, runtime = {}) => {
    if (!activeGm(runtime) || !Object.hasOwn(FLAMMABILITY, flammability)) return false;
    const data = readFlag(checkMessage, 'aoeFireCheck');
    const message = env(runtime).game.messages?.get(data?.attackMessageId);
    const target = await targetFrom(data?.targetUuid, runtime);
    const record = resultOf(message, data?.targetUuid);
    if (!target || record?.status !== 'pending' || !eligibleHit(message, target.uuid)) return false;
    const key = `${messageId(message)}:${target.uuid}`;
    if (busyHits.has(key)) return false;
    busyHits.add(key);
    try {
        if (remember) await target.actor.update({[`flags.${SCOPE}.aoeFlammability`]: flammability});
        const result = await resolveIgnition(message, target, flammability, record.settings, runtime);
        if (result.allowed) await checkMessage.update({content: card(target.name ?? target.actor.name,
            `<div>Fire Check: ${escapeHTML(result.status === 'nonflammable' ? 'Not flammable' : 'resolved')}.</div>${flammabilityAction}`)});
        return result.allowed;
    } catch (error) {
        warn(runtime, error?.message ?? 'Fire could not be resolved. GM: review the target manually.');
        return false;
    } finally { busyHits.delete(key); }
};

export const rollAoeFireTurn = async (effect, key, runtime = {}) => {
    const original = stateOf(effect);
    const id = effect?.uuid ?? effect?.id;
    if (!activeGm(runtime) || original?.version !== 1 || effect.disabled || effect.isSuppressed ||
        !integer(original.intensity) || !integer(original.maxIntensity) || original.maxIntensity < original.intensity ||
        !key || busyEffects.has(id) ||
        original.turnKeys?.includes(key)) return false;
    busyEffects.add(id);
    try {
        return await serial(actorMutations, actorOf(effect), async () => {
            const latest = stateOf(effect);
            if (!activeGm(runtime) || latest?.version !== 1 || latest.turnKeys?.includes(key) ||
                effect.disabled || effect.isSuppressed || !effectsOf(actorOf(effect)).includes(effect)) return false;
            const state = {...latest, turnKeys: [...(latest.turnKeys ?? []), key]};
            await effect.update({[`flags.${SCOPE}.${FLAG}`]: state});
            const damage = await roll(`${state.intensity}d6x`, runtime);
            // Fire intensity is a plain d6, never an exploding Savage Worlds roll.
            const check = await roll('1d6', runtime);
            const next = Number(check.total) === 1 ? state.intensity - 1 : Number(check.total) === 6
                ? Math.min(state.maxIntensity, state.intensity + 1) : state.intensity;
            if (next < 1) await effect.delete();
            else await effect.update({[`flags.${SCOPE}.${FLAG}`]: {...state, intensity: next}});
            const result = next < 1 ? 'Extinguished' : next > state.intensity ? `Fire grows to ${next}d6`
                : next < state.intensity ? `Fire drops to ${next}d6` : `Fire continues at ${next}d6`;
            const actor = actorOf(effect);
            await createChat(card(actor?.name ?? 'Burning', damageLine(state.intensity, damage) +
                `<div>Fire Check: ${Number(check.total)} — <strong>${result}</strong></div>` + manualDamage +
                (next >= 1 ? fireActions(effect) : flammabilityAction), (await renderRoll(damage)) + (await renderRoll(check))),
            {aoeFire: {actorUuid: actor?.uuid, effectUuid: next >= 1 ? effect.uuid : null}}, [damage, check], runtime, state);
            return true;
        });
    } catch (error) {
        warn(runtime, error?.message ?? 'Fire turn failed. GM: resolve this turn manually.');
        return false;
    } finally { busyEffects.delete(id); }
};

export const handleAoeFireCombatTurn = async (combat, change = {}, runtime = {}) => {
    if (!activeGm(runtime) || !['round', 'turn', 'started', 'active'].some(key => Object.hasOwn(change, key))) return false;
    const key = turnKey(combat);
    const actor = currentActor(combat);
    if (!key || !actor || combat.active === false) return false;
    const effects = effectsOf(actor).filter(effect => stateOf(effect)?.version === 1);
    for (const effect of effects) await rollAoeFireTurn(effect, key, runtime);
    return effects.length > 0;
};

const promptFlammability = async (runtime = {}, editOnly = false) => {
    const Dialog = runtime.DialogClass ?? globalThis.foundry?.applications?.api?.DialogV2;
    if (!Dialog?.prompt) return null;
    return Dialog.prompt({window: {title: editOnly ? 'Target Flammability' : 'Fire Check'},
        classes: ['swadetools-rof-dialog', 'theme-light'], content:
        '<div class="standard-form"><div class="form-group"><label>Target Flammability</label><select name="flammability"><option value="none">Not Flammable</option><option value="flammable">Flammable (6)</option><option value="very">Very Flammable (4–6)</option><option value="volatile">Volatile (2–6)</option></select></div>' +
        (editOnly ? '<p class="hint">Applies to future fire checks. Existing damage and fire are unchanged.</p>' : '<label><input type="checkbox" name="remember" checked> Remember for this actor</label>') + '</div>',
        ok: {label: editOnly ? 'Save' : 'Check Ignition', callback: (_event, button) => {
            const form = button.form ?? button.closest?.('form');
            return {flammability: form?.elements?.flammability?.value,
                remember: form?.elements?.remember?.checked === true};
        }}, rejectClose: false});
};

export const registerAoeFire = (runtime = {}) => {
    registerAoeAuthorityHandler('fireHit', recordAoeFireHitAsGm);
    const hooks = runtime.Hooks ?? globalThis.Hooks;
    const document = runtime.document ?? globalThis.document;
    if (hooks && !registeredHooks.has(hooks)) {
        registeredHooks.add(hooks);
        hooks.on('updateCombat', (combat, change) => {
            void handleAoeFireCombatTurn(combat, change, runtime).catch(error => warn(runtime, error.message));
        });
        hooks.on('renderChatMessageHTML', (_message, html) => {
            // Foundry's HTML sanitizer removes the serialized hidden attribute.
            // Every client must restore visibility from its own current role.
            const element = html?.[0] ?? html;
            element?.querySelectorAll?.('[data-aoe-fire-check],[data-aoe-fire-tick],[data-aoe-fire-adjust],[data-aoe-fire-extinguish],[data-aoe-fire-flammability]')
                .forEach(button => {button.hidden = !activeGm(runtime);});
        });
    }
    if (!document || registeredDocuments.has(document)) return;
    registeredDocuments.add(document);
    document.addEventListener('click', async event => {
        const control = event.target.closest?.('[data-aoe-fire-check],[data-aoe-fire-tick],[data-aoe-fire-adjust],[data-aoe-fire-extinguish],[data-aoe-fire-flammability]');
        if (!control || !activeGm(runtime)) return;
        const id = control.closest('[data-message-id]')?.dataset?.messageId;
        const message = env(runtime).game.messages?.get(id);
        if (!message) return;
        event.preventDefault(); event.stopPropagation();
        try {
            if (control.hasAttribute('data-aoe-fire-check')) {
                const choice = await promptFlammability(runtime);
                if (choice) await resolveAoeFireCheck(message, choice.flammability, choice.remember, runtime);
                return;
            }
            const data = readFlag(message, 'aoeFire');
            if (control.hasAttribute('data-aoe-fire-flammability')) {
                const actor = await env(runtime).fromUuid?.(data?.actorUuid);
                if (!actor?.update) return;
                const choice = await promptFlammability(runtime, true);
                if (choice && Object.hasOwn(FLAMMABILITY, choice.flammability)) {
                    await actor.update({[`flags.${SCOPE}.aoeFlammability`]: choice.flammability});
                    const labels = {none: 'Not Flammable', flammable: 'Flammable', very: 'Very Flammable', volatile: 'Volatile'};
                    const status = `<div data-aoe-flammability-setting style="font-size:10px">Future fire checks: ${labels[choice.flammability]}.</div>`;
                    const existing = /<div\b[^>]*data-aoe-flammability-setting[^>]*>[\s\S]*?<\/div>/i;
                    await message.update({content: existing.test(message.content) ? message.content.replace(existing, status)
                        : message.content + status});
                }
                return;
            }
            const effect = await env(runtime).fromUuid?.(data?.effectUuid);
            if (!effect || stateOf(effect)?.version !== 1 || actorOf(effect)?.uuid !== data.actorUuid) return;
            if (control.hasAttribute('data-aoe-fire-extinguish')) {
                await extinguishAoeBurning(effect, runtime);
                await message.update({content: card(actorOf(effect).name, `<div>Fire extinguished by GM.</div>${flammabilityAction}`)});
            } else if (control.hasAttribute('data-aoe-fire-tick')) {
                const combat = env(runtime).game.combat;
                const key = sameActor(currentActor(combat), actorOf(effect)) ? turnKey(combat) : null;
                if (combat?.started && !key) {warn(runtime, 'Fire ticks at the start of the burning target\'s turn.'); return;}
                const done = await rollAoeFireTurn(effect, key ?? `manual:${messageId(message)}`, runtime);
                if (!done) warn(runtime, 'This fire turn was already resolved.');
            } else {
                const state = stateOf(effect);
                const Dialog = runtime.DialogClass ?? globalThis.foundry?.applications?.api?.DialogV2;
                const choice = await Dialog?.prompt({window: {title: 'Adjust Fire'},
                    classes: ['swadetools-rof-dialog', 'theme-light'], content:
                    `<div class="standard-form"><div class="form-group"><label>Fire Damage (d6)</label><input type="number" name="intensity" min="1" max="10" value="${state.intensity}"></div><div class="form-group"><label>Maximum (d6)</label><input type="number" name="maximum" min="1" max="10" value="${state.maxIntensity}"></div></div>`,
                    ok: {label: 'Save', callback: (_event, button) => ({intensity: button.form?.elements?.intensity?.value,
                        maximum: button.form?.elements?.maximum?.value})}, rejectClose: false});
                if (choice && !await adjustAoeBurning(effect, choice.intensity, choice.maximum, runtime))
                    warn(runtime, 'Use whole dice counts from 1 to 10; maximum cannot be below current intensity.');
            }
        } catch (error) {warn(runtime, error?.message ?? 'Fire could not be resolved.');}
    });
};
