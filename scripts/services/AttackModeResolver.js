export const STANDARD_ROF_RESOURCE_COSTS = Object.freeze({
    1: 1,
    2: 5,
    3: 10,
    4: 20,
    5: 40,
    6: 50
});

export const MAX_STANDARD_ROF = 6;

function toNonNegativeInteger(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return null;
    }

    return Math.floor(number);
}

export function normalizeRof(value) {
    const rof = toNonNegativeInteger(value);
    return Math.max(1, rof ?? 1);
}

export function getStandardRofResourceCost(rof) {
    return STANDARD_ROF_RESOURCE_COSTS[normalizeRof(rof)] ?? null;
}

export function resolveActionResourceCost(action = {}, rof = 1) {
    const explicitCost = toNonNegativeInteger(action?.resourcesUsed);

    if (explicitCost !== null) {
        return explicitCost;
    }

    return getStandardRofResourceCost(rof);
}

export function buildAttackModes(maxRof = 1, rofBonus = 0) {
    const requestedMaximum = normalizeRof(maxRof) +
        Math.max(0, toNonNegativeInteger(rofBonus) ?? 0);
    // The core table ends at RoF 6. Higher-rate attacks remain available
    // through explicit additional actions with a Resources Used value, but
    // must not create an unbounded number of buttons from malformed item data.
    const maximum = Math.min(MAX_STANDARD_ROF, requestedMaximum);
    const modes = [];

    for (let rof = 1; rof <= maximum; rof += 1) {
        modes.push({
            rof,
            resourcesUsed: getStandardRofResourceCost(rof),
            requiresExplicitCost: getStandardRofResourceCost(rof) === null
        });
    }

    return modes;
}
