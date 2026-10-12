import {collectPropertyRules, getPropertyConditionResult, isPropertiesEnabled} from './PropertiesRules.js';
import {isAoeItem} from './AoeItemFlags.js';

const SCOPE = 'swade-tools';
const SETTING = 'propertiesEventLedger';
const TOKEN_UUID = /^Scene\.([^.]+)\.Token\.([^.]+)$/;
const TRAITS = new Set(['agility', 'smarts', 'spirit', 'strength', 'vigor']);
const EFFECT_ACTIONS = new Set(['status', 'traitModifier', 'traitSteps', 'skillModifier', 'statModifier']);
const queues = new WeakMap();
const registrations = new WeakSet();
const clone = value => JSON.parse(JSON.stringify(value));
const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? collection ?? []);
const gameOf = runtime => runtime.gameRef ?? runtime.game ?? globalThis.game;
const coreRuntime = runtime => ({...runtime, game: gameOf(runtime)});
const flagsOf = effect => effect?.flags?.[SCOPE]?.propertiesEffect;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const fingerprint = value => {
    // A compact 128-bit non-security fingerprint for detecting configuration
    // changes. Event identities below use exact encoded tuples, not hashes.
    const text = JSON.stringify(value); let left = 2166136261, right = 3339675911, third = 374761393, fourth = 668265263;
    for (let index = 0; index < text.length; index++) {
        const char = text.charCodeAt(index);
        left = Math.imul(left ^ char, 16777619); right = Math.imul(right ^ char, 2246822507);
        third = Math.imul(third ^ char, 3266489909); fourth = Math.imul(fourth ^ char, 668265263);
    }
    return [left, right, third, fourth].map(hash => (hash >>> 0).toString(36)).join('-');
};
const identityKey = value => encodeURIComponent(JSON.stringify(value));

const primaryPropertiesGm = gameRef => values(gameRef?.users).filter(user => user.isGM && user.active)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0];
export const isPrimaryPropertiesGm = (gameRef = globalThis.game) => {
    const elected = primaryPropertiesGm(gameRef);
    return gameRef?.user?.isGM === true && elected?.id === gameRef.user.id;
};

const serial = (runtime, action) => {
    const game = gameOf(runtime);
    if (!game || typeof game !== 'object') return Promise.resolve(null);
    const previous = queues.get(game) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    queues.set(game, task);
    return task.finally(() => {if (queues.get(game) === task) queues.delete(game);});
};
const ledgerOf = runtime => {
    const data = gameOf(runtime)?.settings?.get(SCOPE, SETTING);
    const ledger = data?.version === 1 ? clone(data) : {version: 1, candidates: {}, events: {}};
    ledger.candidates ??= {}; ledger.events ??= {}; ledger.attacks ??= {};
    return ledger;
};
const saveLedger = (ledger, runtime) => gameOf(runtime).settings.set(SCOPE, SETTING, ledger);
const enabled = runtime => isPrimaryPropertiesGm(gameOf(runtime)) && isPropertiesEnabled(coreRuntime(runtime));
const excluded = message => {
    const flags = message?.flags?.[SCOPE] ?? {};
    return Boolean(message?.flags?.world?.aoeAttack || flags.powerAoe || flags.aoeFireDamage ||
        flags.aoeAttack || flags.aoeFire || flags.propertiesResistance);
};
const owns = (actor, user) => user?.isGM || actor?.testUserPermission?.(user, 'OWNER') === true ||
    Number(actor?.ownership?.[user?.id] ?? actor?.ownership?.default ?? 0) >= 3;
const messageSignature = message => fingerprint({rolls: values(message?.rolls).map(roll => ({
    total: roll.total, formula: roll.formula, evaluated: roll._evaluated,
    terms: roll.terms?.map(term => ({total: term.total, results: term.results,
        dice: term.dice?.map(die => ({total: die.total, results: die.results}))}))})),
flags: message?.flags?.[SCOPE], world: message?.flags?.world,
contentVisible: message?.isContentVisible !== false});
const identitySignature = message => {
    // UI mirrors are explicitly untrusted and must not invalidate their own
    // candidate when the primary GM writes the presentation flags.
    const flags = {...(message?.flags?.[SCOPE] ?? {})}; delete flags.propertiesCandidates;
    return messageSignature({...message, rolls: message?.rolls, flags: {...message?.flags, [SCOPE]: flags}});
};
const targetSignature = target => fingerprint({uuid: target.uuid, actorUuid: target.actor?.uuid,
    x: target.x, y: target.y, elevation: target.elevation,
    stats: target.actor?.system?.stats, toughness: target.actor?.system?.toughness,
    statuses: values(target.actor?.statuses).sort(),
    effects: values(target.actor?.effects).map(effect => ({id: effect.id, disabled: effect.disabled,
        suppressed: effect.isSuppressed, changes: effect.changes, statuses: values(effect.statuses)})),
    items: values(target.actor?.items).map(item => ({id: item.id, type: item.type, name: item.name,
        equipStatus: item.system?.equipStatus, swid: item.system?.swid}))});
const rootIdOf = message => String(message?.flags?.[SCOPE]?.propertiesRootId ?? message?.id ?? '');
const messageTime = message => number(message?.timestamp ?? message?._source?.timestamp);
const pruneLedger = (ledger, runtime) => {
    const messages = values(gameOf(runtime)?.messages), ids = new Set(messages.map(message => message.id));
    const roots = new Set(messages.map(rootIdOf));
    for (const [id, entry] of Object.entries(ledger.candidates)) if (!ids.has(entry.messageId)) delete ledger.candidates[id];
    for (const [key, event] of Object.entries(ledger.events)) if (!roots.has(event.rootId) && !ids.has(event.rootId)) delete ledger.events[key];
    for (const root of Object.keys(ledger.attacks)) if (!roots.has(root) && !ids.has(root)) delete ledger.attacks[root];
    return ledger;
};
const withinLimit = (ledger, kind, runtime) => Object.keys(ledger[kind]).length <
    (runtime.ledgerLimits?.[kind] ?? (kind === 'candidates' ? 4000 : 12000));
const warnLimit = runtime => (runtime.notifications ?? globalThis.ui?.notifications)?.warn(
    'Properties history is full. Remove old attack chat messages before resolving new effects; existing effect history is preserved.');
export const cleanupPropertiesEventLedger = (runtime = {}) => serial(runtime, async () => {
    if (!isPrimaryPropertiesGm(gameOf(runtime))) return;
    await saveLedger(pruneLedger(ledgerOf(runtime), runtime), runtime);
});
const updateLatestAttack = (ledger, message, actor, item) => {
    if (message.flags?.[SCOPE]?.rolltype === 'damage') return true;
    const rootId = rootIdOf(message), existing = ledger.attacks[rootId], timestamp = messageTime(message);
    if (existing && (existing.actorUuid !== actor.uuid || existing.itemUuid !== item.uuid)) return false;
    if (existing && existing.messageId !== message.id && timestamp && existing.timestamp && timestamp < existing.timestamp) return false;
    if (!existing || existing.messageId === message.id || !timestamp || !existing.timestamp || timestamp >= existing.timestamp)
        ledger.attacks[rootId] = {messageId: message.id, actorUuid: actor.uuid, itemUuid: item.uuid, timestamp};
    return true;
};
const normalizeOutcome = value => {
    if (typeof value === 'string') return {hit: /^(hit|raise|success)$/i.test(value), raise: /^raise$/i.test(value)};
    if (typeof value === 'number') return {hit: value >= 0, raise: value > 0};
    return {hit: value?.hit === true || value?.success === true || value?.raise === true,
        raise: value?.raise === true || number(value?.raises) > 0};
};
const targetDocument = target => target?.document ?? target;
export const resolvePropertyTarget = (targetUuid, actorUuid, runtime = {}) => {
    const match = TOKEN_UUID.exec(String(targetUuid ?? ''));
    const game = gameOf(runtime), canvas = runtime.canvasRef ?? globalThis.canvas;
    if (!match || canvas?.scene?.id !== match[1]) return null;
    const document = game?.scenes?.get(match[1])?.tokens?.get(match[2]);
    const token = canvas?.tokens?.get?.(match[2]);
    if (!document || document.uuid !== targetUuid || document.actor?.uuid !== actorUuid ||
        (token && (token.document?.uuid !== targetUuid || token.actor?.uuid !== actorUuid))) return null;
    return document;
};
const documentOf = async (uuid, runtime) => {
    const resolver = runtime.fromUuid ?? globalThis.fromUuid;
    if (typeof resolver === 'function') return resolver(uuid);
    const game = gameOf(runtime);
    if (/^Actor\.[^.]+$/.test(uuid)) return game?.actors?.get(uuid.split('.')[1]);
    return null;
};
const approvedSourceEntry = (message, actor, item, target, runtime) => {
    const source = message?.flags?.[SCOPE]?.propertiesSource;
    if (!source) return null;
    return Object.values(ledgerOf(runtime).candidates).find(entry => entry.messageId === source.attackMessageId &&
        entry.rootId === source.rootId && entry.actorUuid === actor?.uuid && entry.itemUuid === item?.uuid &&
        entry.targetUuid === target?.uuid && entry.targetActorUuid === target?.actor?.uuid &&
        entry.hitKey === String(source.hitKey) && entry.outcome?.hit === true) ?? null;
};
const contextIsValid = async ({message, actor, item, target}, runtime) => {
    if (!enabled(runtime) || !message?.id || excluded(message) || message.isContentVisible === false ||
        !['weapon', 'power'].includes(item?.type) || !actor?.uuid || !item?.uuid ||
        (item.actor?.uuid ?? item.parent?.uuid) !== actor.uuid || isAoeItem(item) ||
        Object.values(item.system?.templates ?? {}).some(value => value === true)) return false;
    const game = gameOf(runtime), document = targetDocument(target);
    let authorityMessage = message;
    const source = message.flags?.[SCOPE]?.propertiesSource;
    if (source) {
        if (source.version !== 1 || !['damage', 'soak'].includes(message.flags?.[SCOPE]?.rolltype) ||
            source.actorUuid !== actor.uuid || source.itemUuid !== item.uuid || source.targetUuid !== document?.uuid ||
            source.targetActorUuid !== document?.actor?.uuid || source.rootId !== rootIdOf(message) ||
            String(message.flags?.[SCOPE]?.usetarget) !== String(document?.id)) return false;
        const ledger = ledgerOf(runtime);
        const approved = approvedSourceEntry(message, actor, item, document, runtime);
        authorityMessage = game.messages?.get(source.attackMessageId);
        if (!approved || !authorityMessage || ledger.attacks[source.rootId]?.messageId !== authorityMessage.id ||
            identitySignature(authorityMessage) !== approved.signature) return false;
        const currentAuthorId = message.author?.id ?? message.user?.id ?? message.user;
        const currentAuthor = game?.users?.get?.(currentAuthorId);
        if (!currentAuthor || !owns(actor, currentAuthor) && !owns(document.actor, currentAuthor)) return false;
    }
    const authorId = authorityMessage.author?.id ?? authorityMessage.user?.id ?? authorityMessage.user;
    const author = game?.users?.get?.(authorId) ?? values(game?.users).find(user => user.id === authorId);
    if (!author || !owns(actor, author)) return false;
    return Boolean(resolvePropertyTarget(document?.uuid, document?.actor?.uuid, runtime));
};
const ruleMatches = (rule, context) => EFFECT_ACTIONS.has(rule.action) && rule.enabled !== false &&
    getPropertyConditionResult(rule, context).matches;
const matchingRules = (actor, item, trigger, outcome, context, runtime) => collectPropertyRules(actor, item, coreRuntime(runtime))
    .filter(rule => rule.trigger !== 'passive' && (rule.trigger === trigger ||
        (trigger === 'hit' && outcome.raise && rule.trigger === 'raise')) &&
        (trigger !== 'hit' && trigger !== 'raise' || outcome.hit) &&
        (rule.trigger !== 'raise' || outcome.raise) && ruleMatches(rule, context));

const mirror = async (message, ledger) => {
    const entries = Object.values(ledger.candidates).filter(entry => entry.messageId === message.id)
        .map(entry => ({id: entry.id, targetName: entry.targetName, trigger: entry.trigger,
            status: entry.status, result: entry.result ?? '', rules: entry.ruleNames,
            canUndo: Object.values(ledger.events).some(event => event.candidateId === entry.id && event.status === 'applied')}));
    if (typeof message.update === 'function') await message.update({[`flags.${SCOPE}.propertiesCandidates`]: entries});
};

// Only a primary-GM combat integration can stage candidates. Chat flags are a
// presentation mirror; the authoritative context and ledger are world settings
// which player authors cannot rewrite with their own chat documents.
export const registerPropertyCandidate = (input, runtime = {}) => serial(runtime, async () => {
    if (!await contextIsValid(input, runtime)) return null;
    const {message, actor, item} = input, target = targetDocument(input.target);
    const outcome = normalizeOutcome(input.outcome), trigger = input.trigger ?? 'hit';
    const context = {item, attackType: input.attackType ?? input.context?.attackType ?? 'any',
        range: input.range ?? input.context?.range};
    const rules = matchingRules(actor, item, trigger, outcome, context, runtime);
    const id = `candidate-${identityKey([message.id, target.uuid, String(input.hitKey ?? '0'), trigger])}`;
    const ledger = pruneLedger(ledgerOf(runtime), runtime), previous = ledger.candidates[id];
    const relevant = collectPropertyRules(actor, item, coreRuntime(runtime)).some(rule => EFFECT_ACTIONS.has(rule.action) &&
        rule.trigger !== 'passive');
    if (!previous && !rules.length && !relevant) return null;
    if (!previous && !withinLimit(ledger, 'candidates', runtime)) {warnLimit(runtime); return null;}
    if (!updateLatestAttack(ledger, message, actor, item)) return null;
    const signature = identitySignature(message);
    const resolved = Object.values(ledger.events).filter(event => event.candidateId === id && event.status !== 'undone');
    // Applying a debuff may itself change derived defenses. That does not
    // retroactively change the already-resolved hit or create a new Raise.
    // Only an actual roll/GM-card correction can put that audit into review.
    if (previous?.signature === signature && resolved.length) return previous;
    const ruleBindings = rules.map(rule => ({id: rule.id, sourceUuid: rule.sourceUuid, fingerprint: fingerprint(rule)}));
    const futureRules = collectPropertyRules(actor, item, coreRuntime(runtime)).filter(rule => EFFECT_ACTIONS.has(rule.action) &&
        rule.trigger !== 'passive').map(rule => ({id: rule.id, sourceUuid: rule.sourceUuid, fingerprint: fingerprint(rule)}));
    const targetState = targetSignature(target);
    if (previous?.signature === signature && previous.targetSignature === targetState &&
        JSON.stringify(previous.outcome) === JSON.stringify(outcome) &&
        JSON.stringify(previous.rules) === JSON.stringify(ruleBindings) && JSON.stringify(previous.futureRules) === JSON.stringify(futureRules) &&
        previous.status !== 'stale') return previous;
    const entry = {id, messageId: message.id, rootId: rootIdOf(message), actorUuid: actor.uuid,
        itemUuid: item.uuid, targetUuid: target.uuid, targetActorUuid: target.actor.uuid,
        targetName: target.name ?? target.actor.name, hitKey: String(input.hitKey ?? '0'), trigger,
        outcome, targetSignature: targetState, context: {attackType: context.attackType, ...(typeof context.range === 'number' && Number.isFinite(context.range)
            ? {range: context.range} : {})}, signature,
        rules: ruleBindings, futureRules,
        ruleNames: rules.map(rule => rule.name), status: rules.length ? 'pending' : 'ineligible',
        createdBy: gameOf(runtime).user.id};
    if (resolved.length) {
        entry.status = 'review';
        entry.result = 'Attack or target changed after resolution. Existing effects were not repeated or removed; GM review is required.';
    }
    ledger.candidates[id] = entry;
    await saveLedger(ledger, runtime); await mirror(message, ledger);
    return entry;
});

const STATS = {toughness: 'system.stats.toughness.value', armor: 'system.stats.toughness.armor',
    parry: 'system.stats.parry.value', pace: 'system.pace.ground', running: 'system.pace.running.mod',
    attack: 'system.stats.globalMods.attack', damage: 'system.stats.globalMods.damage', ap: 'system.stats.globalMods.ap',
    incomingDamage: 'system.stats.globalMods.targetDamage'};
export const stepPropertyDie = (die, steps) => {
    const sides = number(die?.sides), modifier = number(die?.modifier);
    if (![4, 6, 8, 10, 12].includes(sides) || !Number.isInteger(Number(steps))) return null;
    // d12+n represents the next die steps; d4 is the minimum supported die.
    const level = Math.max(0, (sides - 4) / 2 + (sides === 12 ? Math.max(0, modifier) : 0) + Number(steps));
    const flatModifier = sides === 12 ? Math.min(0, modifier) : modifier;
    return {sides: level < 4 ? 4 + level * 2 : 12,
        modifier: flatModifier + Math.max(0, level - 4)};
};
export const applyPropertyDieStepChange = (actor, change, _current, _delta, changes = {}) => {
    const provenance = flagsOf(change?.effect), trait = provenance?.trait;
    if (provenance?.action !== 'traitSteps' || !TRAITS.has(trait) || change.mode !== 0 ||
        change.key !== `system.attributes.${trait}.die.sides`) return;
    const effects = values(actor?.effects).filter(effect => effect.active !== false && !effect.disabled && !effect.isSuppressed &&
        flagsOf(effect)?.action === 'traitSteps' && flagsOf(effect)?.trait === trait)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (effects[0]?.id !== change.effect.id) return;
    const steps = effects.reduce((sum, effect) => sum + number(flagsOf(effect).value), 0);
    const die = actor.system?.attributes?.[trait]?.die, next = stepPropertyDie(die, steps);
    if (!next || !die) return;
    die.sides = next.sides; die.modifier = next.modifier;
    changes[`system.attributes.${trait}.die.sides`] = next.sides;
    changes[`system.attributes.${trait}.die.modifier`] = next.modifier;
};

const effectDuration = (rule, runtime) => {
    const game = gameOf(runtime), combat = game.combat;
    if (!number(rule.duration?.rounds)) return {};
    return {rounds: number(rule.duration.rounds), startTime: number(game.time?.worldTime),
        ...(combat ? {combat: combat.id, startRound: number(combat.round), startTurn: number(combat.turn)} : {})};
};
export const buildPropertyEffectData = (rule, actor, binding, runtime = {}) => {
    const value = number(rule.value), add = runtime.effectModes?.ADD ?? globalThis.CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2;
    let changes = [], base = {};
    if (rule.action === 'traitModifier' && TRAITS.has(rule.trait)) {
        changes = [{key: `system.attributes.${rule.trait}.die.modifier`, mode: add, value: String(value)}];
    } else if (rule.action === 'traitSteps' && TRAITS.has(rule.trait) && Number.isInteger(value)) {
        changes = [{key: `system.attributes.${rule.trait}.die.sides`, mode: 0, value: String(value), priority: 60}];
    } else if (rule.action === 'skillModifier') {
        const skill = values(actor.items).find(item => item.type === 'skill' &&
            (item.id === rule.skill || item.name?.toLocaleLowerCase() === String(rule.skill).toLocaleLowerCase()));
        if (!skill || !/^[A-Za-z0-9_-]+$/.test(skill.id)) throw new Error('The target does not have the selected skill.');
        changes = [{key: `@skill{${skill.id}}[system.die.modifier]`, mode: add, value: String(value)}];
    } else if (rule.action === 'statModifier' && STATS[rule.stat]) {
        changes = [{key: STATS[rule.stat], mode: add, value: String(value)}];
    } else if (rule.action === 'status') {
        const native = values(runtime.statusEffects ?? globalThis.CONFIG?.statusEffects).find(status => status.id === rule.status);
        if (!native) throw new Error('This status is not available in the current SWADE system.');
        base = clone(native); delete base.id; delete base._id;
        changes = base.changes ?? [];
    } else throw new Error('This effect action is not supported by the native adapter.');
    const provenance = {version: 1, managed: true, sourceUuid: rule.sourceUuid, ruleId: rule.id,
        group: rule.group || `${rule.sourceUuid}:${rule.id}`, action: rule.action,
        trait: rule.trait ?? '', skill: rule.skill ?? '', stat: rule.stat ?? '', status: rule.status ?? '',
        stack: rule.stack, value, passive: rule.trigger === 'passive', ...binding};
    return {...base, name: rule.name, img: base.img ?? 'systems/swade/assets/icons/active-effect.svg',
        origin: rule.sourceUuid, transfer: false, disabled: false, changes,
        ...(rule.action === 'status' ? {statuses: [rule.status]} : {}),
        duration: effectDuration(rule, runtime), system: {...(base.system ?? {}),
            ...(number(rule.duration?.rounds) ? {expiration: rule.duration.expiry === 'turnEnd' ? 2 : 0} : {})},
        flags: {...(base.flags ?? {}), [SCOPE]: {...(base.flags?.[SCOPE] ?? {}), propertiesEffect: provenance}}};
};

const eventKeyOf = (entry, rule, actorUuid) => identityKey([entry.rootId, rule.sourceUuid, rule.id,
    rule.frequency === 'attack' ? '*' : rule.target === 'self' ? actorUuid : `${entry.targetUuid}:${actorUuid}`,
    rule.frequency === 'hit' ? entry.hitKey : '*']);
const existingEffects = (actor, rule) => values(actor.effects).filter(effect => {
    const flags = flagsOf(effect);
    return flags?.managed && flags.group === (rule.group || `${rule.sourceUuid}:${rule.id}`) &&
        flags.action === rule.action && flags.trait === (rule.trait ?? '') &&
        flags.skill === (rule.skill ?? '') && flags.stat === (rule.stat ?? '') && flags.status === (rule.status ?? '') &&
        effect.disabled !== true && effect.isSuppressed !== true;
});
const resistance = async (rule, actor, runtime) => {
    if (!rule.resist?.enabled) return null;
    if (!TRAITS.has(rule.resist.trait) || !actor.system?.attributes?.[rule.resist.trait]?.die?.sides)
        return {pending: true, reason: 'The target has no selected resistance trait.'};
    const CharRoll = runtime.CharRollClass ?? (await import('../class/CharRoll.js')).default;
    const roller = new CharRoll(actor); roller.dontDisplay = true;
    roller.addModifier(number(rule.resist.modifier), rule.name);
    const roll = await roller.rollAtt(rule.resist.trait);
    const total = Number(roll?.total);
    if (!Number.isFinite(total)) return {pending: true, reason: 'Resistance returned no valid total.'};
    const dice = roll.dice ?? roll.terms?.[0]?.dice ?? [];
    const first = die => number(die?.results?.[0]?.result ?? die?.total);
    const critical = actor.isWildcard === true && dice.length > 1 && first(dice[0]) === 1 && first(dice[1]) === 1;
    let rollData; try {rollData = clone(roll.toJSON?.() ?? {total, formula: roll.formula});} catch {rollData = {total};}
    return {total, tn: number(rule.resist.tn) || 4, resisted: !critical && total >= (number(rule.resist.tn) || 4),
        critical, rollData};
};

const executeEvent = async (entry, message, actor, item, target, runtime, ledger, input = {}) => {
    const rules = matchingRules(actor, item, entry.trigger, entry.outcome, {item, ...entry.context}, runtime);
    const results = [];
    for (const rule of rules) {
        if (entry.rules && !entry.rules.some(saved => saved.id === rule.id && saved.sourceUuid === rule.sourceUuid &&
            saved.fingerprint === fingerprint(rule))) continue;
        const recipient = rule.target === 'self' ? actor : target.actor;
        const key = eventKeyOf(entry, rule, recipient.uuid), existing = ledger.events[key];
        if (existing) {results.push(existing); continue;}
        if (!withinLimit(ledger, 'events', runtime)) {
            warnLimit(runtime); results.push({name: rule.name, status: 'review', reason: 'Effect history is full.'}); continue;
        }
        const record = {key, rootId: entry.rootId, messageId: message.id, candidateId: entry.id,
            ruleId: rule.id, sourceUuid: rule.sourceUuid, name: rule.name,
            actorUuid: recipient.uuid, targetUuid: target.uuid, createdEffectIds: [], status: 'claimed'};
        // Claim before awaiting dice or document creation. Retrying a failed
        // operation never repeats the resistance roll or an already-created AE.
        ledger.events[key] = record; await saveLedger(ledger, runtime);
        try {
            if (entry.trigger === 'wound' && number(input.wounds) <= 0) {record.status = 'ineligible'; continue;}
            const resist = await resistance(rule, recipient, runtime);
            if (resist) {record.resistance = resist; await saveLedger(ledger, runtime);}
            if (resist?.pending) {record.status = 'review'; record.reason = resist.reason; continue;}
            if (resist?.resisted) {record.status = 'resisted'; continue;}
            if (!await contextIsValid({message, actor, item, target}, runtime) ||
                identitySignature(message) !== entry.signature) {record.status = 'stale'; continue;}
            const siblings = existingEffects(recipient, rule);
            if (rule.action === 'status' && recipient.statuses?.has?.(rule.status) && !siblings.length) {
                record.status = 'alreadyActive'; continue;
            }
            if (siblings.length && rule.stack === 'unique') {record.status = 'alreadyActive'; continue;}
            if (siblings.length && rule.stack === 'refresh') {
                await siblings[0].update({duration: effectDuration(rule, runtime)});
                record.status = 'refreshed'; continue;
            }
            if (siblings.length && rule.stack === 'best' && siblings.some(effect =>
                Math.abs(number(flagsOf(effect).value)) >= Math.abs(number(rule.value)))) {
                record.status = 'alreadyActive'; continue;
            }
            // Best replacement disables only this system's weaker effects;
            // native/user-created statuses and effects are never removed.
            const data = buildPropertyEffectData(rule, recipient, {eventKey: key, rootId: entry.rootId,
                targetUuid: target.uuid, actorUuid: recipient.uuid}, runtime);
            if (siblings.length && rule.stack === 'best') {
                record.replacedEffects = siblings.map(effect => effect.id);
                await saveLedger(ledger, runtime);
                await recipient.updateEmbeddedDocuments('ActiveEffect', siblings.map(effect => ({_id: effect.id, disabled: true,
                    [`flags.${SCOPE}.propertiesEffect.bestSuppressed`]: true})));
            }
            const created = await recipient.createEmbeddedDocuments('ActiveEffect', [data]);
            record.createdEffectIds = values(created).map(effect => effect.id);
            record.status = record.createdEffectIds.length ? 'applied' : 'review';
        } catch (error) {
            record.status = 'review'; record.reason = String(error?.message ?? error).slice(0, 250);
            if (record.replacedEffects?.length && !record.createdEffectIds.length) {
                try {await recipient.updateEmbeddedDocuments('ActiveEffect', record.replacedEffects.map(id => ({_id: id, disabled: false,
                    [`flags.${SCOPE}.propertiesEffect.bestSuppressed`]: false})));}
                catch {record.reason += ' Previous effects need GM review.';}
            }
        }
        finally {await saveLedger(ledger, runtime); results.push(record);}
    }
    entry.status = results.some(result => result.status === 'review' || result.status === 'claimed') ? 'review' :
        results.some(result => result.status === 'applied' || result.status === 'refreshed') ? 'applied' :
            results.some(result => result.status === 'resisted') ? 'resisted' : 'resolved';
    entry.result = results.map(result => `${result.name}: ${result.status}${result.resistance?.total != null
        ? ` (${result.resistance.total} vs ${result.resistance.tn})` : ''}`).join('; ');
    await saveLedger(ledger, runtime); await mirror(message, ledger);
    return {status: entry.status, results};
};

export const applyRegisteredPropertyCandidate = (message, candidateId, runtime = {}) => serial(runtime, async () => {
    if (!enabled(runtime)) return null;
    const ledger = ledgerOf(runtime), entry = ledger.candidates[candidateId];
    if (!entry || entry.messageId !== message?.id || entry.status === 'ineligible' || excluded(message)) return null;
    if (['hit', 'raise'].includes(entry.trigger) && ledger.attacks[entry.rootId]?.messageId !== message.id)
        return {status: 'stale'};
    if (entry.signature !== identitySignature(message)) {
        entry.status = 'stale'; entry.result = 'Attack changed; review its current target result.';
        await saveLedger(ledger, runtime); await mirror(message, ledger); return {status: 'stale'};
    }
    const [actor, item] = await Promise.all([documentOf(entry.actorUuid, runtime), documentOf(entry.itemUuid, runtime)]);
    const target = resolvePropertyTarget(entry.targetUuid, entry.targetActorUuid, runtime);
    if (!await contextIsValid({message, actor, item, target}, runtime)) return null;
    const anyResolved = Object.values(ledger.events).some(event => event.candidateId === entry.id);
    if (!anyResolved && entry.targetSignature !== targetSignature(target)) {
        entry.status = 'stale'; entry.result = 'Target defenses or placement changed; review the current attack.';
        await saveLedger(ledger, runtime); await mirror(message, ledger); return {status: 'stale'};
    }
    if (runtime.resolvePropertyCandidate) {
        const current = await runtime.resolvePropertyCandidate({message, actor, item, target, entry});
        if (!current || JSON.stringify(normalizeOutcome(current.outcome)) !== JSON.stringify(entry.outcome)) return {status: 'stale'};
    }
    return executeEvent(entry, message, actor, item, target, runtime, ledger);
});

// Called only after native GM Apply Damage/Soak has actually changed the
// victim. It never runs from card rendering, damage previews or dice rolls.
export const applyPropertiesForEvent = (input, runtime = {}) => serial(runtime, async () => {
    if (!['damageApplied', 'wound'].includes(input.trigger) || input.damageApplied !== true ||
        (input.trigger === 'wound' && number(input.wounds) <= 0) || !await contextIsValid(input, runtime)) return null;
    const {message, actor, item} = input, target = targetDocument(input.target), ledger = pruneLedger(ledgerOf(runtime), runtime);
    const approved = approvedSourceEntry(message, actor, item, target, runtime);
    const entry = {id: `event-${identityKey([message.id, target.uuid, input.trigger, input.hitKey ?? '0'])}`,
        messageId: message.id, rootId: rootIdOf(message), actorUuid: actor.uuid, itemUuid: item.uuid,
        targetUuid: target.uuid, targetActorUuid: target.actor.uuid, targetName: target.name ?? target.actor.name,
        hitKey: String(approved?.hitKey ?? input.hitKey ?? '0'), trigger: input.trigger,
        outcome: approved?.outcome ?? normalizeOutcome(input.outcome ?? 'hit'),
        ...(approved ? {rules: approved.futureRules ?? []} : {}),
        signature: identitySignature(message), context: approved?.context ?? {attackType: input.attackType ?? input.context?.attackType ?? 'any',
            ...(typeof (input.range ?? input.context?.range) === 'number' && Number.isFinite(input.range ?? input.context?.range)
                ? {range: input.range ?? input.context?.range} : {})}};
    if (!matchingRules(actor, item, entry.trigger, entry.outcome, {item, ...entry.context}, runtime).length) return null;
    if (!ledger.candidates[entry.id] && !withinLimit(ledger, 'candidates', runtime)) {warnLimit(runtime); return null;}
    ledger.candidates[entry.id] = entry;
    return executeEvent(entry, message, actor, item, target, runtime, ledger, input);
});

export const undoPropertyCandidate = (message, candidateId, runtime = {}) => serial(runtime, async () => {
    if (!isPrimaryPropertiesGm(gameOf(runtime))) return false;
    const ledger = ledgerOf(runtime), entry = ledger.candidates[candidateId];
    if (!entry || entry.messageId !== message?.id) return false;
    const target = resolvePropertyTarget(entry.targetUuid, entry.targetActorUuid, runtime);
    if (!target) return false;
    for (const record of Object.values(ledger.events).filter(event => event.candidateId === candidateId && event.status === 'applied')) {
        const actor = record.actorUuid === target.actor.uuid ? target.actor : await documentOf(record.actorUuid, runtime);
        if (!actor || actor.uuid !== record.actorUuid) continue;
        const remove = values(actor.effects).filter(effect => record.createdEffectIds.includes(effect.id) &&
            flagsOf(effect)?.eventKey === record.key && flagsOf(effect)?.actorUuid === actor.uuid).map(effect => effect.id);
        if (remove.length) await actor.deleteEmbeddedDocuments('ActiveEffect', remove);
        if (record.replacedEffects?.length) {
            const restore = values(actor.effects).filter(effect => record.replacedEffects.includes(effect.id) && flagsOf(effect)?.managed);
            if (restore.length) await actor.updateEmbeddedDocuments('ActiveEffect', restore.map(effect => ({_id: effect.id, disabled: false,
                [`flags.${SCOPE}.propertiesEffect.bestSuppressed`]: false})));
        }
        record.status = 'undone';
    }
    entry.status = 'undone'; entry.result = 'Only effects created by this application were removed.';
    await saveLedger(ledger, runtime); await mirror(message, ledger); return true;
});

export const renderPropertyCandidates = (message, runtime = {}) => {
    if (message?.isContentVisible === false || excluded(message)) return '';
    const entries = message?.flags?.[SCOPE]?.propertiesCandidates;
    if (!Array.isArray(entries) || !entries.some(entry => entry.status !== 'ineligible')) return '';
    // Native single-fire and RoF append this section after the chat render
    // hooks have already run. Set viewer permissions here as well, rather
    // than relying on an earlier hook to unhide a not-yet-existing control.
    const game = gameOf(runtime), canManage = isPrimaryPropertiesGm(game);
    const manager = primaryPropertiesGm(game);
    const approvalNote = game?.user?.isGM && !canManage ?
        `<p style="margin:3px 0;font-size:11px">${manager ?
            `Approval GM: ${escapeHTML(manager.name ?? manager.id)}. Only that active GM can apply these effects.` :
            'No active GM is available for effects approval.'}</p>` : '';
    return '<details class="swadetools-properties-chat" style="font-size:12px;line-height:1.35;margin-top:4px">' +
        '<summary>Effects · More Details</summary>' + approvalNote + entries.filter(entry => entry.status !== 'ineligible').map(entry =>
        `<div style="padding:3px 0;border-top:1px solid #9996"><strong>${escapeHTML(entry.targetName)}</strong> — ` +
        `<span style="color:${entry.status === 'applied' ? '#23752b' : entry.status === 'resisted' ? '#8a4c00' : '#333'}">${escapeHTML(entry.status)}</span>` +
        `<div>${escapeHTML(entry.result || (entry.rules ?? []).join(', '))}</div>` +
        `<span data-properties-gm${canManage ? '' : ' hidden'}>${entry.status === 'pending' ?
            `<button type="button" data-properties-apply="${escapeHTML(entry.id)}" style="height:24px;line-height:20px">Apply Effects</button>` : ''}` +
        `${entry.canUndo ? `<button type="button" data-properties-undo="${escapeHTML(entry.id)}" style="height:24px;line-height:20px">Undo Created Effects</button>` : ''}</span></div>`).join('') + '</details>';
};

const allActors = game => {
    const actors = new Map(values(game?.actors).map(actor => [actor.uuid, actor]));
    for (const scene of values(game?.scenes)) for (const token of values(scene.tokens)) if (token.actor?.uuid) actors.set(token.actor.uuid, token.actor);
    return [...actors.values()];
};
const restoreBestGroup = (deleted, runtime) => serial(runtime, async () => {
    const source = flagsOf(deleted), actor = deleted?.parent;
    if (!enabled(runtime) || source?.stack !== 'best' || source.passive || !actor?.effects) return;
    const candidates = values(actor.effects).filter(effect => {
        const flags = flagsOf(effect);
        return flags?.managed && !flags.passive && flags.group === source.group && flags.action === source.action &&
            flags.trait === source.trait && flags.skill === source.skill && flags.stat === source.stat && flags.status === source.status &&
            (!effect.disabled || flags.bestSuppressed === true) && !effect.isSuppressed &&
            !(number(effect.duration?.rounds) > 0 && Number.isFinite(effect.duration?.remaining) && effect.duration.remaining <= 0);
    }).sort((left, right) => Math.abs(number(flagsOf(right).value)) - Math.abs(number(flagsOf(left).value)) ||
        String(left.id).localeCompare(String(right.id)));
    if (!candidates.length) return;
    const updates = candidates.flatMap((effect, index) => {
        const disabled = index !== 0;
        return effect.disabled === disabled ? [] : [{_id: effect.id, disabled,
            [`flags.${SCOPE}.propertiesEffect.bestSuppressed`]: disabled}];
    });
    if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates);
});
export const synchronizePropertyEffects = (runtime = {}) => serial(runtime, async () => {
    const game = gameOf(runtime);
    if (!isPrimaryPropertiesGm(game)) return;
    const active = isPropertiesEnabled(coreRuntime(runtime));
    const selected = runtime.actorUuids ? new Set(runtime.actorUuids) : null;
    for (const actor of allActors(game).filter(actor => !selected || selected.has(actor.uuid))) {
        let rules = active ? collectPropertyRules(actor, null, coreRuntime(runtime)).filter(rule =>
            rule.trigger === 'passive' && rule.target === 'self' && rule.enabled !== false && EFFECT_ACTIONS.has(rule.action)) : [];
        const groups = new Map();
        for (const rule of rules) {
            const key = `${rule.action}:${rule.trait}:${rule.skill}:${rule.stat}:${rule.status}:${rule.group}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(rule);
        }
        rules = [...groups.values()].flatMap(group => group.every(rule => rule.stack === 'sum') ? group :
            [[...group].sort((left, right) => Math.abs(number(right.value)) - Math.abs(number(left.value)) ||
                `${left.sourceUuid}:${left.id}`.localeCompare(`${right.sourceUuid}:${right.id}`))[0]]);
        const desired = new Map(rules.map(rule => [`${rule.sourceUuid}:${rule.id}`, rule]));
        const managed = values(actor.effects).filter(effect => flagsOf(effect)?.managed === true);
        for (const effect of managed) {
            const flags = flagsOf(effect), key = `${flags.sourceUuid}:${flags.ruleId}`;
            if (!active || flags.passive && !desired.has(key)) {
                if (!effect.disabled) await effect.update({disabled: true});
            } else if (flags.passive && desired.has(key)) {
                const rule = desired.get(key), data = buildPropertyEffectData(rule, actor, {passive: true,
                    actorUuid: actor.uuid, ruleFingerprint: fingerprint(rule)}, runtime);
                if (flags.ruleFingerprint !== fingerprint(rule) || effect.disabled) await effect.update(data);
                desired.delete(key);
            }
        }
        for (const rule of desired.values()) await actor.createEmbeddedDocuments('ActiveEffect', [buildPropertyEffectData(rule, actor,
            {passive: true, actorUuid: actor.uuid, ruleFingerprint: fingerprint(rule)}, runtime)]);
    }
});
export const registerPropertiesEffects = (runtime = {}) => {
    const hooks = runtime.hooks ?? globalThis.Hooks;
    if (!hooks?.on || registrations.has(hooks)) return;
    registrations.add(hooks);
    hooks.on('applyActiveEffect', applyPropertyDieStepChange);
    // Equipment/readied state and Edge removal change passive eligibility.
    // These callbacks never run the on-hit pipeline or touch AoE services.
    let scheduled = false; const actorUuids = new Set();
    const schedule = item => {
        const parent = item?.parent;
        if (!parent?.uuid || !isPrimaryPropertiesGm(gameOf(runtime))) return;
        const managed = values(parent.effects).some(effect => flagsOf(effect)?.passive &&
            (item.uuid == null || flagsOf(effect)?.sourceUuid === item.uuid));
        let assigned = false;
        try {assigned = gameOf(runtime)?.settings?.get(SCOPE, 'propertiesLibrary')?.assignments?.[item.uuid]
            ?.some(rule => rule.trigger === 'passive' && EFFECT_ACTIONS.has(rule.action)) === true;} catch { /* settings not ready */ }
        if (!managed && !assigned) return;
        actorUuids.add(parent.uuid);
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(async () => {
            scheduled = false; const selected = [...actorUuids]; actorUuids.clear();
            try {await synchronizePropertyEffects({...runtime, actorUuids: selected});}
            catch (error) {console.warn('SWADE Tools property effect synchronization:', error);}
        });
    };
    for (const event of ['createItem', 'deleteItem']) hooks.on(event, schedule);
    hooks.on('updateItem', (item, change = {}) => {
        const relevant = Object.keys(change).some(key => ['name', 'type', 'disabled', 'isSuppressed',
            'system.equipStatus', 'system.disabled'].includes(key)) ||
            Object.hasOwn(change.system ?? {}, 'equipStatus') || Object.hasOwn(change.system ?? {}, 'disabled');
        if (relevant) schedule(item);
    });
    hooks.on('createActor', actor => schedule({parent: actor}));
    hooks.on('deleteActiveEffect', effect => restoreBestGroup(effect, runtime).catch(error =>
        console.warn('SWADE Tools property stacking recovery:', error)));
    hooks.on('deleteChatMessage', () => cleanupPropertiesEventLedger(runtime).catch(error =>
        console.warn('SWADE Tools property history cleanup:', error)));
};
