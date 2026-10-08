import { isAoeItem } from './AoeItemFlags.js';
import { aoeResource } from './AoeResourceService.js';
import * as profile from './AoeAttackProfile.js';

// Keep the filename used by existing grenade actions and macro references.
const AOE_SCRIPT_PATH =
    'modules/swade-tools/scripts/services/grenade-attack.js';
let compiledAoeAttack = null;
const pendingAoeLaunches = new Set();

const asArray = collection => {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    return Array.from(collection);
};

export const findAoeActorToken = actor => {
    if (!actor) return null;
    const belongsToActor = token => {
        if (token?.actor === actor) return true;
        // Unlinked tokens may share a base actor id but have different weapon
        // inventories. Never launch one clone's weapon from another's token.
        if (actor.uuid && token?.actor?.uuid) {
            return token.actor.uuid === actor.uuid;
        }
        return Boolean(actor.id && token?.actor?.id === actor.id);
    };
    const controlled = asArray(globalThis.canvas?.tokens?.controlled);
    const active = typeof actor.getActiveTokens === 'function'
        ? asArray(actor.getActiveTokens()) : [];
    return controlled.find(belongsToActor) ??
        active.find(belongsToActor) ?? null;
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
    const weaponActor = item?.actor ?? item?.parent ?? actor;
    const vehicleActor = weaponActor?.type === 'vehicle' ? weaponActor : null;
    const operatorActor = options.operatorActor ??
        (vehicleActor ? await getVehicleOperator(vehicleActor, item) : actor);
    return {
        actor: operatorActor ?? weaponActor,
        operatorActor,
        weaponActor,
        vehicleActor,
        vehicle: vehicleActor,
        item,
        weapon: item,
        itemUuid: item?.uuid,
        promptAoeSetup: options.promptAoeSetup === true,
        token: options.token?.object ?? options.token ??
            findAoeActorToken(weaponActor),
        aoeResource,
        aoeServices: { ...profile, aoeResource }
    };
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
