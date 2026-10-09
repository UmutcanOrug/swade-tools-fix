/** Pure attack-profile helpers shared by the AoE launcher and regression tests. */
import {isLegacyGrenadeItem, isAoeItem} from './AoeItemFlags.js';
export {isLegacyGrenadeItem, isAoeItem, getAoeItemSettings} from './AoeItemFlags.js';
const normalized = value => String(value ?? '').trim().toLowerCase();
const normalizedSwid = value => normalized(value).replace(/[\s_]+/g, '-');

const values = collection => Array.isArray(collection)
    ? collection
    : collection?.contents ?? Array.from(collection ?? []);

// Compatibility alias used by launchers from the first AoE prototype.
export const isAoeEnabledItem = isAoeItem;

export const getAoeSkills = actor => values(actor?.items)
    .filter(item => item?.type === 'skill')
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));

export const resolveAoeSkill = (actor, item, override = null) => {
    const skills = getAoeSkills(actor);
    const reference = String(override ?? item?.system?.actions?.trait ?? '').trim();
    if (!reference) return null;
    return skills.find(skill =>
        skill.id === reference || skill.uuid === reference ||
        normalized(skill.name) === normalized(reference) ||
        (skill.system?.swid && normalizedSwid(skill.system.swid) === normalizedSwid(reference))
    ) ?? null;
};

export const listAoeOperators = ({weaponOwner, preferredActor, driverActor, actors = [], isGM = false}) => {
    const candidates = weaponOwner?.type === 'vehicle'
        ? [preferredActor, driverActor, ...values(actors)]
        : [preferredActor ?? weaponOwner];
    const unique = new Map();
    for (const actor of candidates) {
        if (!actor || actor.type === 'vehicle' || (!isGM && !actor.isOwner) || !getAoeSkills(actor).length) continue;
        const key = actor.uuid ?? actor.id;
        if (!key || unique.has(key)) continue;
        unique.set(key, actor);
    }
    return Array.from(unique.values());
};
