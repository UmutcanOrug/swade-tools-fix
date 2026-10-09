import * as gb from '../gb.js';
import { getShotgunSettings, validateShotgunAttack } from './ShotgunRules.js';
import { resolveWeaponSettingsContext } from './LastWeaponSettings.js';
import { aoeResource } from './AoeResourceService.js';
import { withSuppressedAoeAutomation } from './AoeAnimationService.js';
import { nativeWeaponDamageFormula } from './WeaponDamageModifier.js';

const asArray = collection => collection?.contents ?? Array.from(collection ?? []);
const asToken = token => token?.object ?? token;
const documentFor = token => token?.document ?? token;
const uuidFor = token => {
    const document = documentFor(token);
    if (/^Scene\.[^.]+\.Token\.[^.]+$/.test(String(document?.uuid ?? ''))) return document.uuid;
    const scene = document?.parent ?? document?.scene ?? token?.scene;
    return scene?.id && document?.id ? `Scene.${scene.id}.Token.${document.id}` : '';
};
const sameActor = (token, owner) => {
    const actor = token?.actor ?? documentFor(token)?.actor;
    return actor === owner || Boolean(actor?.uuid && actor.uuid === owner?.uuid);
};

const preflightFormula = (value, data, label, runtime, { nativeDamage = false } = {}) => {
    const formula = String(value ?? '').trim();
    if (!formula) return { ok: true, formula: '' };
    const RollClass = runtime.RollClass ?? globalThis.Roll;
    try {
        for (const [, path] of formula.matchAll(/@([\w.]+)/g)) {
            const parts = path.split('.');
            if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) {
                return { ok: false, reason: `${label} contains an invalid data reference.` };
            }
            const value = parts.reduce((object, key) => object?.[key], data);
            if (value === undefined || value === null || typeof value === 'object') {
                return { ok: false, reason: `${label} contains a missing or invalid @${path} reference.` };
            }
        }
        const resolved = formula.includes('@')
            ? RollClass.replaceFormulaData(formula, data, { missing: 0, warn: false }) : formula;
        const normalized = nativeDamage ? String(resolved).replace(/D(?=\d)/g, 'd') : resolved;
        if (!RollClass?.validate?.(normalized) || (nativeDamage && !RollClass.validate(nativeWeaponDamageFormula(normalized)))) {
            return { ok: false, reason: `${label} is not a valid roll formula.` };
        }
        return { ok: true, formula: normalized };
    } catch { return { ok: false, reason: `${label} is not a valid roll formula.` }; }
};

const resolveSource = async ({ item, weaponOwner, operator, token }, runtime) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    const canvasRef = runtime.canvasRef ?? globalThis.canvas;
    let source = token;
    let uuid = typeof source === 'string' ? source : uuidFor(source);
    if (!source) {
        const context = resolveWeaponSettingsContext({ item, weaponOwner, operator, userId: gameRef?.user?.id });
        uuid = context?.tokenUuid ?? '';
    }
    if (!uuid && !source) return null;
    if (typeof source === 'string' || !source) {
        const match = /^Scene\.([^.]+)\.Token\.([^.]+)$/.exec(uuid);
        if (!match) return null;
        source = canvasRef?.scene?.id === match[1] ? canvasRef.tokens?.get?.(match[2]) : null;
        if (!source) {
            const resolver = runtime.fromUuid ?? globalThis.fromUuid;
            source = typeof resolver === 'function' ? await resolver(uuid) : null;
        }
    }
    source = asToken(source);
    if (!source || !sameActor(source, weaponOwner)) return null;
    const sourceScene = documentFor(source)?.parent?.id ?? source.scene?.id;
    if (sourceScene && canvasRef?.scene?.id && sourceScene !== canvasRef.scene.id) return null;
    return uuidFor(source) ? source : null;
};

const measureProfile = (item, source, target, mode, bothBarrels, runtime) => {
    const canvasRef = runtime.canvasRef ?? globalThis.canvas;
    const scale = Number(canvasRef?.dimensions?.distance);
    const ranges = String(item.system?.range ?? '').split('/').map(value => Number(value.trim()));
    if (ranges.length !== 3 || ranges.some(value => !Number.isFinite(value) || value <= 0) ||
        ranges[1] < ranges[0] || ranges[2] < ranges[1]) {
        return { ok: false, reason: 'Set a valid Short/Medium/Long Range on the weapon before using Shotgun Rules.' };
    }
    let distance;
    try {
        const measured = (runtime.getRange ?? gb.getRange)(source, target);
        distance = measured === null || measured === undefined ? NaN : Number(measured) * scale;
    }
    catch { return { ok: false, reason: 'The distance to this target could not be measured.' }; }
    if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(scale) || scale <= 0) {
        return { ok: false, reason: 'The distance to this target could not be measured.' };
    }
    if (distance > ranges[2] * 4) return { ok: false, reason: 'This target is beyond the weapon\'s Extreme range.' };
    const rangeBand = distance <= ranges[0] ? 'short' : distance <= ranges[1] ? 'medium'
        : distance <= ranges[2] ? 'long' : 'extreme';
    return { ...validateShotgunAttack(item, { mode, rangeBand, rof: 1, bothBarrels, targetCount: 1 }), distance };
};

// Used by the attack panel and native chat's target damage buttons. An explicit
// target does not read or alter the current user's target rings.
export const prepareNativeShotgunDamageForTarget = async ({
    item, weaponOwner = item?.actor ?? item?.parent, operator, token,
    mode = 'shot', bothBarrels = false, target
} = {}, runtime = {}) => {
    if (!getShotgunSettings(item).enabled) return { ok: false, reason: 'Shotgun Rules are not enabled for this weapon.' };
    if (!item.isOwner || !weaponOwner?.isOwner || (operator && !operator.isOwner)) {
        return { ok: false, reason: 'You do not have permission to use this weapon.' };
    }
    const sourceToken = await resolveSource({ item, weaponOwner, operator, token }, runtime);
    if (!sourceToken) return { ok: false, reason: 'Select the firing token or open the weapon from its token sheet. The firing token must be unambiguous.' };
    const targetToken = asToken(target);
    const targetId = targetToken?.id ?? documentFor(targetToken)?.id;
    if (!targetToken?.actor || !targetId) return { ok: false, reason: 'Select exactly one valid target for this Shotgun attack.' };
    const profile = measureProfile(item, sourceToken, targetToken, mode, Boolean(bothBarrels), runtime);
    if (!profile.ok) return profile;
    const rollActor = operator ?? weaponOwner;
    const rollData = typeof rollActor?.getRollData === 'function' ? rollActor.getRollData() : rollActor?.system ?? {};
    const damage = preflightFormula(profile.damage, rollData, 'Shotgun damage', runtime, { nativeDamage: true });
    if (!damage.ok) return damage;
    profile.damage = damage.formula;
    return {
        ...profile, targetId, sourceToken, sourceTokenUuid: uuidFor(sourceToken),
        shotgunProfile: {
            mode: profile.mode, bothBarrels: profile.bothBarrels,
            rangeBand: profile.rangeBand, damage: profile.damage, ammoCost: profile.ammoCost,
            sourceTokenUuid: uuidFor(sourceToken)
        }
    };
};

export const prepareNativeShotgunAttack = async ({
    item, weaponOwner = item?.actor ?? item?.parent, operator, token,
    mode = 'shot', bothBarrels = false, action = 'attack', consumeAmmo = true, modifierFormula = ''
} = {}, runtime = {}) => {
    if (!getShotgunSettings(item).enabled) return { ok: true, enabled: false };
    if (!['attack', 'damage'].includes(action)) return { ok: false, reason: 'Choose an attack or damage action.' };
    const rollActor = operator ?? weaponOwner;
    const rollData = typeof rollActor?.getRollData === 'function' ? rollActor.getRollData() : rollActor?.system ?? {};
    const modifier = preflightFormula(modifierFormula, rollData, 'Modifier', runtime);
    if (!modifier.ok) return modifier;
    const traitModifier = action === 'attack'
        ? preflightFormula(item.system?.actions?.traitMod, rollData, 'Weapon Trait Modifier', runtime)
        : { ok: true, formula: '' };
    if (!traitModifier.ok) return traitModifier;
    const gameRef = runtime.gameRef ?? globalThis.game;
    const targets = asArray(gameRef?.user?.targets);
    if (targets.length !== 1) return { ok: false, reason: 'Select exactly one target for this Shotgun attack.' };
    const prepared = await prepareNativeShotgunDamageForTarget({
        item, weaponOwner, operator, token, mode, bothBarrels, target: targets[0]
    }, runtime);
    if (!prepared.ok) return prepared;
    const formulaData = { modifierFormulaResolved: modifier.formula, traitModifierResolved: traitModifier.formula };
    if (action === 'damage') return { ...prepared, ...formulaData, action, consumed: 0 };
    const resources = runtime.resource ?? aoeResource;
    const options = { mode: 'ammo', consume: consumeAmmo !== false, cost: prepared.ammoCost };
    const validation = resources.validate(item, weaponOwner, options);
    if (!validation.ok) return {
        ok: false, reason: validation.reason === 'insufficient'
            ? `${item.name}: not enough ammunition (${validation.available}/${validation.cost}).`
            : 'This weapon\'s ammunition could not be used. Check ownership and ammunition settings.'
    };
    const guard = runtime.automationGuard ?? withSuppressedAoeAutomation;
    let spent;
    try {
        spent = await guard([item, validation.resource], () => resources.spend(item, weaponOwner, options), {
            gameRef, hooksRef: runtime.hooksRef, trackConsumption: true
        });
    } catch {
        return { ok: false, reason: 'The ammunition could not be consumed. No Shotgun attack was rolled.' };
    }
    if (!spent?.ok) return { ok: false, reason: 'The ammunition could not be consumed. No Shotgun attack was rolled.' };
    return { ...prepared, ...formulaData, action, consumed: spent.consumed ?? 0 };
};

export const applyNativeShotgunProfile = (itemRoll, prepared) => {
    if (!prepared?.ok || !prepared.enabled) return false;
    if (prepared.action === 'attack') {
        if (prepared.traitModifierResolved !== undefined) itemRoll.shotgunTraitModOverride = prepared.traitModifierResolved;
        itemRoll.addModifier(prepared.attackBonus, prepared.mode === 'shot' ? 'Shot' : 'Slug');
        // The native resource API was already committed exactly once above.
        itemRoll.manageshots = false;
    }
    itemRoll.addFlag('shotgunMode', prepared.mode);
    itemRoll.addFlag('shotgunBothBarrels', prepared.bothBarrels);
    itemRoll.addFlag('shotgunSourceTokenUuid', prepared.sourceTokenUuid);
    itemRoll.addFlag('shotgunProfile', prepared.shotgunProfile);
    if (prepared.targetId) itemRoll.useTarget(prepared.targetId);
    return true;
};
