import { isAoeItem } from './AoeItemFlags.js';
import { aoeResource } from './AoeResourceService.js';
import * as profile from './AoeAttackProfile.js';
import * as aoeChat from './AoeChatControl.js';
import { showAoeAttackDialog } from './AoeAttackDialog.js';
import { playAoeAnimation, withSuppressedAoeAutomation } from './AoeAnimationService.js';
import { nativeWeaponDamageFormula, prepareWeaponDamageModifier } from './WeaponDamageModifier.js';

// Keep the filename used by existing grenade actions and macro references.
const AOE_SCRIPT_PATH =
    'modules/swade-tools/scripts/services/grenade-attack.js';
let compiledAoeAttack = null;
const pendingAoeLaunches = new Set();
const trustedAoePoolAttacks = new WeakMap();

const finitePoint = point => Boolean(point && Number.isFinite(point.x) &&
    Number.isFinite(point.y));
const contextUuid = value => String(value?.uuid ?? '');

const authorizePoolAttack = (attack, scope, options) => {
    if (!attack || options.skipConsumption !== true || attack.disableBenny !== true ||
        !Number.isSafeInteger(attack.candidateIndex) || attack.candidateIndex < 0 ||
        !String(attack.poolId ?? '').trim() || !['skill', 'wild'].includes(attack.source) ||
        !attack.rawRoll || typeof attack.rawRoll.toJSON !== 'function' ||
        !Number.isFinite(Number(attack.rawRoll.total)) || Number(attack.rawRoll.total) < 1 ||
        !Array.isArray(attack.rawRoll.dice) || !attack.rawRoll.dice[0]?.results?.length ||
        !Number.isFinite(Number(attack.baseModifier)) || !finitePoint(options.attackPoint) ||
        !options.attackSetup || typeof options.attackSetup !== 'object') {
        throw new Error('The AoE pool result is incomplete or has not been resolved.');
    }
    const identities = {
        weaponUuid: contextUuid(scope.item),
        weaponActorUuid: contextUuid(scope.weaponActor),
        operatorActorUuid: contextUuid(scope.operatorActor),
    };
    if (Object.entries(identities).some(([key, uuid]) => !uuid || attack[key] !== uuid)) {
        throw new Error('The AoE pool result no longer matches its weapon or operator.');
    }
    const normalized = Object.freeze({...attack, ...identities,
        baseModifier: Number(attack.baseModifier),
        rawTotal: Number(attack.rawRoll.total),
        criticalFailure: attack.criticalFailure === true,
        disableBenny: true,
        label: String(attack.label ?? `Pool result ${attack.candidateIndex + 1}`),
    });
    trustedAoePoolAttacks.set(normalized, {...identities,
        tokenUuid: contextUuid(scope.token?.document ?? scope.token),
        x: Number(options.attackPoint.x), y: Number(options.attackPoint.y),
    });
    return normalized;
};

// The standalone macro cannot skip resources merely by setting a scope flag.
// Only the launcher signs a resolved, identity-checked internal pool payload.
export const isTrustedAoePoolAttack = (attack, {item, weaponOwner, operatorActor, token, point} = {}) => {
    const context = attack && trustedAoePoolAttacks.get(attack);
    return Boolean(context && attack.disableBenny === true &&
        attack.rawTotal === Number(attack.rawRoll?.total) &&
        context.weaponUuid === contextUuid(item) &&
        context.weaponActorUuid === contextUuid(weaponOwner) &&
        context.operatorActorUuid === contextUuid(operatorActor) &&
        context.tokenUuid === contextUuid(token?.document ?? token) && finitePoint(point) &&
        context.x === Number(point.x) && context.y === Number(point.y));
};

const asArray = collection => {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    return Array.from(collection);
};

const tokenBelongsToActor = (token, actor) => {
    if (!actor || !token?.actor) return false;
    if (token.actor === actor) return true;
    // Unlinked tokens may share a base actor id but have different weapon
    // inventories. Never launch one clone's weapon from another's token.
    if (actor.uuid && token.actor.uuid) return token.actor.uuid === actor.uuid;
    return Boolean(actor.id && token.actor.id === actor.id);
};

export const findAoeActorToken = actor => {
    if (!actor) return null;
    const sheetToken = actor.token?.object ?? actor.token ??
        actor.sheet?.token?.object ?? actor.sheet?.token;
    if (tokenBelongsToActor(sheetToken, actor)) return sheetToken;
    const belongsToActor = token => tokenBelongsToActor(token, actor);
    const controlled = asArray(globalThis.canvas?.tokens?.controlled);
    const active = typeof actor.getActiveTokens === 'function'
        ? asArray(actor.getActiveTokens()) : [];
    const selected = controlled.filter(belongsToActor);
    if (selected.length === 1) return selected[0];
    const available = selected.length ? selected : active.filter(belongsToActor);
    if (available.length === 1) return available[0];
    if (available.length > 1) {
        globalThis.ui?.notifications?.warn('Select exactly one firing token for this AoE weapon.');
    }
    return null;
};

const getVehicleOperator = async (vehicle, item) => {
    const assignedGunner = vehicle.system?.getCrewMemberForWeapon?.(item);
    if (assignedGunner) return assignedGunner;
    if (vehicle.system?.operator?.items) return vehicle.system.operator;
    if (typeof vehicle.getDriver === 'function') {
        try {
            const driver = await vehicle.getDriver();
            if (driver) return driver;
        } catch (error) {
            console.warn('SWADE Tools | Vehicle operator lookup failed', error);
        }
    }
    const reference = vehicle.system?.driver?.id;
    if (!reference) return null;
    if (typeof reference === 'object' && reference.type) return reference;
    const uuid = String(reference);
    if (typeof globalThis.fromUuid === 'function' && uuid.includes('.')) {
        try {
            const driver = await globalThis.fromUuid(uuid);
            if (driver?.documentName === 'Actor' || driver?.items) return driver;
        } catch (error) {
            console.warn('SWADE Tools | Vehicle operator UUID lookup failed', error);
        }
    }
    const actorId = uuid.startsWith('Actor.') ? uuid.split('.')[1] : uuid;
    return game.actors?.get(actorId) ?? null;
};

export const resolveAoeLaunchScope = async (actor, item, options = {}) => {
    if (item?.type === 'power') throw new Error('Power AoE must use the native power casting panel, not the weapon AoE engine.');
    const weaponActor = item?.actor ?? item?.parent ?? actor;
    const vehicleActor = weaponActor?.type === 'vehicle' ? weaponActor : null;
    const operatorActor = options.operatorActor ??
        (vehicleActor ? await getVehicleOperator(vehicleActor, item) : actor);
    const scope = {
        actor: operatorActor ?? weaponActor,
        operatorActor,
        weaponActor,
        vehicleActor,
        vehicle: vehicleActor,
        item,
        weapon: item,
        itemUuid: item?.uuid,
        promptAoeSetup: options.promptAoeSetup === true,
        restoreLast: options.restoreLast === true,
        attackSetup: options.attackSetup && typeof options.attackSetup === 'object'
            ? {...options.attackSetup} : null,
        token: options.token?.object ?? options.token ??
            findAoeActorToken(weaponActor),
        aoeResource,
        aoeServices: { ...profile, ...aoeChat, aoeResource,
            nativeWeaponDamageFormula, prepareWeaponDamageModifier,
            showAoeAttackDialog: context => showAoeAttackDialog({ ...context,
                token: scope.token, restoreLast: scope.restoreLast }),
            playAoeAnimation, withSuppressedAoeAutomation, isTrustedAoePoolAttack }
    };
    if (options.poolAttack) {
        scope.poolAttack = authorizePoolAttack(options.poolAttack, scope, options);
        scope.skipConsumption = true;
        scope.attackPoint = {x: Number(options.attackPoint.x), y: Number(options.attackPoint.y)};
    } else if (options.skipConsumption) {
        throw new Error('Only a resolved RoF pool can skip AoE resource consumption.');
    }
    return scope;
};

// Collect all points before the parent RoF workflow commits ammunition. A
// cancelled/invalid point cancels the entire volley, not a partially paid burst.
export const prepareAoePoolPoints = async ({actor, item, weaponOwner, token, candidates, setup} = {}) => {
    if (item?.type === 'power' || !isAoeItem(item) || !Array.isArray(candidates) || !candidates.length) return [];
    const scope = await resolveAoeLaunchScope(actor, item, {operatorActor: actor, token, attackSetup: setup});
    const owner = scope.weaponActor;
    const operator = scope.operatorActor;
    const isGM = globalThis.game?.user?.isGM === true;
    if (!owner || (weaponOwner && contextUuid(owner) !== contextUuid(weaponOwner)) ||
        !operator || (!isGM && (owner.isOwner !== true || operator.isOwner !== true)) ||
        !scope.token || contextUuid(scope.token.actor) !== contextUuid(owner)) return [];
    const crosshair = globalThis.Sequencer?.Crosshair;
    if (!crosshair?.show) return [];
    const settings = profile.getAoeItemSettings(item);
    const configuredActionExists = () => !settings.damageAction ||
        item.system?.actions?.additional?.[settings.damageAction]?.type === 'damage';
    if (!configuredActionExists()) {
        globalThis.ui?.notifications?.warn('This item’s configured AoE damage action no longer exists. Update AoE Settings before firing.');
        return [];
    }
    const blastSize = settings.blastSize;
    const sceneDistance = Number(globalThis.canvas?.scene?.grid?.distance) || 1;
    const distance = ({small: 1, medium: 2, large: 3}[blastSize] ?? 2) * sceneDistance;
    const rangeParts = String(item.system?.range ?? '').split('/').map(Number);
    const longRange = rangeParts[2];
    if (!Number.isFinite(longRange) || longRange <= 0) {
        globalThis.ui?.notifications?.warn('Set valid Short/Medium/Long ranges before using an AoE RoF pool.');
        return [];
    }
    const points = [];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        if (!Number.isFinite(Number(candidate?.roll?.total)) ||
            !Number.isFinite(Number(candidate?.modifier))) return [];
        let cancelled = false;
        const point = await crosshair.show({
            t: 'circle', distance, borderColor: '#ff6b35', fillColor: '#ff6b35',
            fillAlpha: 0.2, gridHighlight: true,
            snap: {position: (globalThis.CONST?.GRID_SNAPPING_MODES?.CENTER ?? 1) |
                (globalThis.CONST?.GRID_SNAPPING_MODES?.VERTEX ?? 2), resolution: 1},
            label: {text: `${item.name} - ${candidate.label ?? `Pool result ${candidateIndex + 1}`} (${candidateIndex + 1}/${candidates.length})`},
            location: {obj: scope.token, limitMaxRange: longRange, showRange: true,
                wallBehavior: crosshair.PLACEMENT_RESTRICTIONS?.ANYWHERE,
                displayRangePoly: true, rangePolyFillColor: 0xff6b35,
                rangePolyLineColor: 0xff6b35, rangePolyFillAlpha: 0.08, rangePolyLineAlpha: 0.5},
        }, {[crosshair.CALLBACKS?.CANCEL ?? 'cancel']: () => { cancelled = true; }});
        if (cancelled || !finitePoint(point)) return [];
        const source = scope.token.center ?? {
            x: scope.token.x + scope.token.w / 2, y: scope.token.y + scope.token.h / 2,
        };
        const grid = globalThis.canvas?.grid;
        const gridSize = Number(grid?.size ?? globalThis.canvas?.scene?.grid?.size) || 100;
        let measuredDistance = Math.hypot(point.x - source.x, point.y - source.y) / gridSize * sceneDistance;
        if (typeof grid?.measurePath === 'function') {
            try {
                const measurement = grid.measurePath([source, point]);
                const result = Number(measurement?.distance ??
                    measurement?.segments?.reduce((sum, segment) => sum + Number(segment.distance ?? 0), 0));
                if (Number.isFinite(result)) measuredDistance = result;
            } catch { /* retain straight-line fallback */ }
        }
        if (!Number.isFinite(measuredDistance) || measuredDistance > longRange + Number.EPSILON) {
            globalThis.ui?.notifications?.warn('The AoE pool point is outside this weapon’s Long Range. The volley was cancelled.');
            return [];
        }
        points.push({candidateIndex, attackPoint: {x: Number(point.x), y: Number(point.y)}});
    }
    const currentSettings = profile.getAoeItemSettings(item);
    if (!isAoeItem(item) || !configuredActionExists() ||
        currentSettings.damageAction !== settings.damageAction ||
        currentSettings.blastSize !== settings.blastSize ||
        currentSettings.consumeMode !== settings.consumeMode) {
        globalThis.ui?.notifications?.warn('AoE settings changed during placement. The volley was cancelled before consuming resources.');
        return [];
    }
    return points;
};

const getBundledAoeAttack = async () => {
    if (compiledAoeAttack) return compiledAoeAttack;
    const route = foundry.utils.getRoute(AOE_SCRIPT_PATH);
    const moduleVersion = game.modules.get('swade-tools')?.version ?? '';
    const response = await fetch(
        `${route}?v=${encodeURIComponent(moduleVersion)}`,
        { cache: 'no-store' }
    );
    if (!response.ok) {
        throw new Error(`Bundled AoE script could not be loaded (${response.status}).`);
    }
    const source = await response.text();
    if (!source.includes('SWADE AoE Attack') &&
        !source.includes('SWADE Throw Grenade - Automatic Item Damage')) {
        throw new Error('Bundled AoE script marker is missing.');
    }
    compiledAoeAttack = new foundry.utils.AsyncFunction('scope', source);
    return compiledAoeAttack;
};

export const launchAoeMacro = async (actor, item, options = {}) => {
    if (item?.type === 'power') {
        ui.notifications.warn('Power AoE uses the native power casting panel. Open this power from its actor sheet.');
        return false;
    }
    if (!isAoeItem(item)) {
        ui.notifications.warn('Enable AoE for this item in its inventory row or item sheet.');
        return false;
    }
    const launchKey = item.uuid ?? item;
    if (pendingAoeLaunches.has(launchKey)) return false;
    pendingAoeLaunches.add(launchKey);
    try {
        const scope = await resolveAoeLaunchScope(actor, item, options);
        if (!scope.actor) {
            ui.notifications.warn('This AoE item has no actor owner.');
            return false;
        }
        if (!scope.token) {
            ui.notifications.warn('Place the weapon owner on the current scene before using an AoE attack.');
            return false;
        }
        if (!tokenBelongsToActor(scope.token, scope.weaponActor)) {
            ui.notifications.warn('The firing token does not own this AoE weapon. Select the correct token before firing.');
            return false;
        }
        if (!game.user?.isGM && (scope.weaponActor?.isOwner !== true ||
            scope.operatorActor?.isOwner !== true)) {
            ui.notifications.warn('You must own both this AoE weapon and its acting operator.');
            return false;
        }
        const execute = await getBundledAoeAttack();
        await execute(scope);
        return true;
    } catch (error) {
        console.error('SWADE Tools | Bundled AoE attack failed', error);
        ui.notifications.error('The AoE attack could not be started. Check the browser console for details.');
        return false;
    } finally {
        pendingAoeLaunches.delete(launchKey);
    }
};

export { isAoeItem };
export default launchAoeMacro;
