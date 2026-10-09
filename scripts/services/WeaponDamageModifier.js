// Mirror the existing native SWADE Tools conversion without importing gb's UI
// dependency graph or changing its global behavior. Check this result before
// resources are consumed: e.g. max(1,2) is a valid Roll expression, but native
// conversion removes its "x" and would make the eventual damage invalid.
export const nativeWeaponDamageFormula = value => String(value ?? '')
    .replace(/D(?=\d)/g, 'd')
    .replace(/x|=/g, '')
    .replace(/d[0-9]{1,2}/g, '$&x')
    .replace(/(d[0-1])(x)/g, '$1');

// Resolve data references once when the attack is submitted. Dice remain part
// of the formula and are rolled only when native damage is actually requested.
export const prepareWeaponDamageModifier = (value, actor, runtime = {}) => {
    const input = String(value ?? '').trim();
    if (!input) return { ok: true, formula: '' };
    const RollClass = runtime.RollClass ?? globalThis.Roll;
    try {
        const data = typeof actor?.getRollData === 'function' ? actor.getRollData() : actor?.system ?? {};
        for (const [, path] of input.matchAll(/@([\w.]+)/g)) {
            const parts = path.split('.');
            if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) {
                return { ok: false, reason: 'Damage Mod contains an invalid data reference.' };
            }
            const reference = parts.reduce((object, key) => object?.[key], data);
            if (reference === undefined || reference === null || typeof reference === 'object') {
                return { ok: false, reason: `Damage Mod contains a missing or invalid @${path} reference.` };
            }
        }
        const resolved = input.includes('@')
            ? RollClass.replaceFormulaData(input, data, { missing: 0, warn: false }) : input;
        // Native SWADE Tools' exploding-dice conversion uses lower-case dice.
        const formula = String(resolved).replace(/D(?=\d)/g, 'd');
        if (formula.includes('@') || !RollClass?.validate?.(formula)) {
            return { ok: false, reason: 'Damage Mod is not a valid roll formula.' };
        }
        if (!RollClass.validate(nativeWeaponDamageFormula(formula))) {
            return { ok: false, reason: 'Damage Mod is not supported by native SWADE Tools damage conversion.' };
        }
        return { ok: true, formula };
    } catch {
        return { ok: false, reason: 'Damage Mod is not a valid roll formula.' };
    }
};
