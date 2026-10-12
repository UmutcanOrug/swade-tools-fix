import {evaluatePropertyModifiers, isPropertiesEnabled} from './PropertiesRules.js';
import {isAoeItem} from './AoeItemFlags.js';

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const scopeFlags = value => value?.flags?.['swade-tools'] ?? value?.['swade-tools'] ?? value ?? {};
const gameOf = runtime => runtime.game ?? globalThis.game;
const itemsOf = actor => Array.from(actor?.items?.contents ?? actor?.items?.values?.() ?? actor?.items ?? []);

// The existing AoE/Flame engine deliberately does not opt into this adapter.
export const canUsePropertiesCombat = (item, messageOrFlags, runtime = {}) => {
    if (!isPropertiesEnabled(runtime) || !['weapon', 'power'].includes(item?.type)) return false;
    const flags = scopeFlags(messageOrFlags);
    return !isAoeItem(item) && !messageOrFlags?.flags?.world?.aoeAttack && !messageOrFlags?.world?.aoeAttack &&
        !flags.powerAoe && !flags.aoeFireDamage && !flags.aoeFire && !flags.aoeAttack && !flags.aoeArea &&
        !Object.values(item.system?.templates ?? {}).some(value => value === true);
};

export const propertyAttackType = (actor, item, skill, runtime = {}) => {
    const reference = String(skill ?? item?.system?.actions?.trait ?? '').trim();
    const entries = itemsOf(actor);
    const trait = entries.find(entry => entry.type === 'skill' &&
        [entry.id, entry.name, entry.system?.swid].some(value => String(value ?? '').toLowerCase() === reference.toLowerCase()));
    let fighting = 'Fighting';
    try { fighting = gameOf(runtime)?.settings?.get('swade-tools', 'fightingSkill') ?? fighting; } catch { /* not ready */ }
    return [reference, trait?.name, trait?.system?.swid].some(value =>
        ['fighting', String(fighting).toLowerCase()].includes(String(value ?? '').toLowerCase())) ? 'melee' : 'ranged';
};

export const getPropertyCombatModifiers = (context, runtime = {}) => evaluatePropertyModifiers({
    ...context, isAoe: context.isAoe || context.isAoE || context.aoe || !canUsePropertiesCombat(context.item, context.message ?? context.flags, runtime),
    attackType: context.attackType ?? propertyAttackType(context.actor, context.item, context.skill, runtime)
}, runtime);

// Outgoing, context-free bonuses are already in the rolled pool. Only the
// target/range-dependent difference belongs in target-number calculations.
export const getPropertyTargetModifiers = (context, runtime = {}) => {
    const attackType = context.attackType ?? propertyAttackType(context.actor, context.item, context.skill, runtime);
    const result = getPropertyCombatModifiers({...context, attackType}, runtime);
    const common = getPropertyCombatModifiers({...context, target: undefined, range: undefined}, runtime);
    return {...result, attackDelta: number(result.totals.attackMod) - number(common.totals.attackMod),
        cover: number(result.totals.cover),
        incoming: number(result.totals[attackType === 'melee' ? 'incomingMelee' : 'incomingRanged'])};
};

const nativeMinimumStrengthSource = (rule, actor, runtime) => {
    if (rule.action !== 'minStrengthSteps') return false;
    const source = itemsOf(actor).find(item => item.uuid === rule.sourceUuid);
    if (!source || !['edge', 'ability'].includes(source.type)) return false;
    if (Array.isArray(runtime.nativeStrengthSources)) return runtime.nativeStrengthSources.includes(source.uuid);
    // Native single fire recognizes configured Edge names, whereas the RoF
    // pool also recognizes SWIDs/Abilities. Its caller supplies the exact
    // sources it already counted, rather than guessing from a renamed item.
    if (source.type!=='edge') return false;
    return ['Brawny', 'Soldier'].some(name => {
        let configured = name;
        try { configured = gameOf(runtime)?.settings?.get('swade-tools', `${name}Setting`) ?? name; } catch { /* optional setting */ }
        return String(source.name ?? '').trim()===String(configured).trim();
    });
};

export const getPropertyStrength = (baseSides, actor, item, flags, runtime = {}) => {
    // baseSides already contains the existing Brawny/Soldier adjustment.
    // Suppress those sources before stacking, so a custom weaker property
    // cannot disappear behind a duplicated native best-only contribution.
    const ignore = runtime.ignorePropertyRule;
    const result = getPropertyCombatModifiers({actor, item, flags}, {...runtime,
        ignorePropertyRule: (rule, context) => nativeMinimumStrengthSource(rule, actor, runtime)
            ? 'Already included by native minimum Strength handling.' : ignore?.(rule, context)});
    if (!result.enabled || !result.totals.minStrengthSteps) return baseSides;
    return Math.max(4, number(baseSides) + number(result.totals.minStrengthSteps) * 2);
};

export const getPropertySoakModifier = (actor, item, message, runtime = {}) => {
    if (!canUsePropertiesCombat(item, message, runtime)) return 0;
    return number(evaluatePropertyModifiers({actor, item: null, attackType: 'any'}, runtime).totals.soakMod);
};

export const propertySourceForTarget = ({message, item, actor, target, outcome, hitKey = '0', attackType, range},runtime={}) => {
    if (!canUsePropertiesCombat(item, message,runtime)) return null;
    const document = target?.document ?? target;
    if (!document?.uuid || !document.actor?.uuid || !actor?.uuid || !item?.uuid) return null;
    return {version: 1, attackMessageId: message.id, rootId: message.flags?.['swade-tools']?.propertiesRootId ?? message.id,
        actorUuid: actor.uuid, itemUuid: item.uuid, targetUuid: document.uuid, targetActorUuid: document.actor.uuid,
        outcome, hitKey: String(hitKey), attackType, ...(Number.isFinite(range) ? {range} : {})};
};

export const propertyPoolData = ({actor,item,token,assignments},runtime={}) => {
    if (!canUsePropertiesCombat(item,undefined,runtime) || !actor?.uuid || !token?.document?.uuid) return null;
    return {version:1,actorUuid:actor.uuid,itemUuid:item.uuid,sourceTokenUuid:token.document.uuid,
        assignments:assignments.map((entry,index)=>({
            targetUuid:entry.targetToken.document.uuid,targetActorUuid:entry.targetToken.actor.uuid,
            hitKey:String(entry.result?.id ?? entry.result?.index ?? index),outcome:entry.outcome,
            total:Number(entry.result?.total),modifier:Number(entry.targetProfile?.total ?? 0),
            range:Number(entry.targetProfile?.distance),attackType:propertyAttackType(actor,item,undefined,runtime)
        }))};
};
