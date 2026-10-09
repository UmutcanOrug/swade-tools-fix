import { nativeWeaponDamageFormula } from './WeaponDamageModifier.js';

// Explicit item opt-in only. Weapon names and native Trait/Damage fields are
// never rewritten or used to infer that a weapon is a shotgun.
export const SHOTGUN_FLAG_SCOPE = 'swade-tools';
export const SHOTGUN_AMMO_COST = Object.freeze({ 1: 1, 2: 5, 3: 10, 4: 20, 5: 40, 6: 50 });
export const SHOTGUN_DAMAGE_DEFAULTS = Object.freeze({
    shot: Object.freeze({ short: '3d6', medium: '2d6', long: '1d6' }),
    slug: Object.freeze({ short: '2d10', medium: '2d10', long: '2d10' })
});

const readFlag = (item, key) => typeof item?.getFlag === 'function'
    ? item.getFlag(SHOTGUN_FLAG_SCOPE, key)
    : item?.flags?.[SHOTGUN_FLAG_SCOPE]?.[key];

export const canEnableShotgunRules = item => item?.type === 'weapon';

export const getShotgunSettings = item => ({
    enabled: canEnableShotgunRules(item) && readFlag(item, 'sgEnabled') === true,
    doubleBarrel: canEnableShotgunRules(item) && readFlag(item, 'sgDoubleBarrel') === true,
    bonusIncluded: canEnableShotgunRules(item) && readFlag(item, 'sgBonusIncluded') === true
});

// Old items need no migration. Return a fresh profile so callers cannot alter
// defaults or the document's stored flags by editing an attack setup.
export const getShotgunDamageProfiles = item => {
    const stored = canEnableShotgunRules(item) ? readFlag(item, 'sgDamageProfiles') : null;
    return Object.fromEntries(Object.entries(SHOTGUN_DAMAGE_DEFAULTS).map(([mode, defaults]) => [mode,
        Object.fromEntries(Object.entries(defaults).map(([band, fallback]) => {
            const value = stored?.[mode]?.[band];
            return [band, typeof value === 'string' && value.trim() ? value.trim() : fallback];
        }))
    ]));
};

// Used only without Foundry's Roll parser (for example offline tooling). Never
// evaluate a formula or use JavaScript eval to decide whether it is valid.
const basicDiceFormula = formula => {
    const tokens = formula.match(/(?:\d+)?d\d+(?:[a-z]+(?:[<>!=]=?)?\d*)*|(?:\d+(?:\.\d*)?|\.\d+)|\*\*|[()+\-*/%]/gi);
    if (!tokens || tokens.join('').toLowerCase() !== formula.replace(/\s/g, '').toLowerCase()) return false;
    let cursor = 0;
    const expression = () => {
        if (!term()) return false;
        while (['+', '-'].includes(tokens[cursor])) { cursor++; if (!term()) return false; }
        return true;
    };
    const term = () => {
        if (!factor()) return false;
        while (['*', '/', '%', '**'].includes(tokens[cursor])) { cursor++; if (!factor()) return false; }
        return true;
    };
    const factor = () => {
        if (['+', '-'].includes(tokens[cursor])) { cursor++; return factor(); }
        if (tokens[cursor] === '(') { cursor++; return expression() && tokens[cursor++] === ')'; }
        const token = tokens[cursor];
        if (!token || !/^(?:(?:\d+)?d\d+(?:[a-z]+(?:[<>!=]=?)?\d*)*|(?:\d+(?:\.\d*)?|\.\d+))$/i.test(token)) return false;
        cursor++; return true;
    };
    return expression() && cursor === tokens.length;
};

export const validateShotgunDamageFormula = (value, { RollClass = globalThis.Roll } = {}) => {
    const formula = typeof value === 'string' ? value.trim().replace(/D(?=\d)/g, 'd') : '';
    const invalid = { ok: false, reason: 'Enter a valid damage roll formula.' };
    if (!formula || formula.length > 256 || /[;{}\[\]"'`\\<>]/.test(formula.replace(/(?:[a-z]+)[<>]=?\d+/gi, ''))) return invalid;
    let syntax = formula;
    for (const [, path] of formula.matchAll(/@([\w.]+)/g)) {
        if (path.split('.').some(part => !part || ['__proto__', 'constructor', 'prototype'].includes(part))) return invalid;
    }
    // Syntax placeholders, not actor data: references are resolved and checked
    // against the actual operator immediately before an attack or damage roll.
    syntax = syntax.replace(/@[\w.]+/g, '1');
    if (syntax.includes('@')) return invalid;
    try {
        const nativeSyntax = nativeWeaponDamageFormula(syntax);
        const validate = typeof RollClass?.validate === 'function'
            ? value => RollClass.validate(value) === true : basicDiceFormula;
        const valid = validate(syntax) && validate(nativeSyntax);
        return valid === true ? { ok: true, formula } : invalid;
    } catch { return invalid; }
};

const normalizeMode = mode => {
    const value = String(mode ?? 'shot').trim().toLowerCase();
    return ['shot', 'slug'].includes(value) ? value : null;
};

const normalizeRange = rangeBand => {
    const value = String(rangeBand ?? 'short').trim().toLowerCase();
    return ['short', 'medium', 'long', 'extreme'].includes(value) ? value : null;
};

// This is a delta to the existing native Trait Modifier, not a replacement.
// Only an explicit setting may remove a preincluded pellet bonus for Slug.
export const getShotgunAttackBonus = (item, mode = 'shot') => {
    const settings = getShotgunSettings(item);
    const selectedMode = normalizeMode(mode);
    if (!settings.enabled || !selectedMode) return 0;
    if (selectedMode === 'shot') return settings.bonusIncluded ? 0 : 2;
    return settings.bonusIncluded ? -2 : 0;
};

export const getShotgunDamage = (item, { mode = 'shot', rangeBand = 'short', bothBarrels = false } = {}) => {
    const settings = getShotgunSettings(item);
    const selectedMode = normalizeMode(mode);
    const selectedRange = normalizeRange(rangeBand);
    if (!settings.enabled || !selectedMode || !selectedRange) return null;
    // Both Barrels is one attack, never a second attack die / RoF 2 pool.
    if (bothBarrels && (!settings.doubleBarrel || selectedMode !== 'shot')) return null;
    if (selectedMode === 'shot' && selectedRange === 'extreme') return null;
    const damage = getShotgunDamageProfiles(item)[selectedMode][selectedRange === 'extreme' ? 'long' : selectedRange];
    return damage ? `${damage}${bothBarrels ? '+4' : ''}` : null;
};

export const getSGammoCost = (rof = 1, bothBarrels = false) => {
    const value = Number(rof);
    if (!Number.isInteger(value) || !Object.hasOwn(SHOTGUN_AMMO_COST, value)) return null;
    if (bothBarrels) return value === 1 ? 2 : null;
    return SHOTGUN_AMMO_COST[value];
};

export const validateShotgunAttack = (item, {
    mode = 'shot', rangeBand = 'short', rof = 1, bothBarrels = false, targetCount
} = {}) => {
    const settings = getShotgunSettings(item);
    if (!settings.enabled) return { ok: true, enabled: false };
    const selectedMode = normalizeMode(mode);
    const selectedRange = normalizeRange(rangeBand);
    const selectedRof = Number(rof);
    const failure = reason => ({ ok: false, enabled: true, reason });
    if (!selectedMode) return failure('Choose Shot or Slug.');
    if (!selectedRange) return failure('Choose a valid range band.');
    if (selectedMode === 'shot' && selectedRange === 'extreme') {
        return failure('Shot cannot be fired at Extreme range. Use Slug instead.');
    }
    if (getSGammoCost(selectedRof) === null) return failure('Rate of Fire must be a whole number from 1 to 6.');
    if (bothBarrels) {
        if (!settings.doubleBarrel) return failure('Enable Double-barrel weapon in this item\'s Shotgun Settings first.');
        if (selectedMode !== 'shot') return failure('Both Barrels is available for Shot only.');
        if (selectedRof !== 1) return failure('Both Barrels requires Rate of Fire 1; it is one attack, not a RoF 2 attack.');
        if (Number(targetCount) !== 1) return failure('Both Barrels requires exactly one target for the single attack.');
    }
    return {
        ok: true, enabled: true, mode: selectedMode, rangeBand: selectedRange,
        rof: selectedRof, bothBarrels: Boolean(bothBarrels),
        damage: getShotgunDamage(item, { mode: selectedMode, rangeBand: selectedRange, bothBarrels }),
        attackBonus: getShotgunAttackBonus(item, selectedMode),
        ammoCost: getSGammoCost(selectedRof, bothBarrels)
    };
};

const requireOwnedWeapon = item => {
    if (!canEnableShotgunRules(item) || !item.isOwner) {
        throw new Error('You do not own an eligible weapon.');
    }
};

export const setShotgunEnabled = async (item, enabled) => {
    requireOwnedWeapon(item);
    const value = Boolean(enabled);
    if (typeof item.setFlag === 'function') await item.setFlag(SHOTGUN_FLAG_SCOPE, 'sgEnabled', value);
    else await item.update({ 'flags.swade-tools.sgEnabled': value });
    return value;
};

export const saveShotgunSettings = async (item, settings = {}) => {
    requireOwnedWeapon(item);
    const saved = {
        doubleBarrel: settings.doubleBarrel === true,
        bonusIncluded: settings.bonusIncluded === true
    };
    const patch = {
        'flags.swade-tools.sgDoubleBarrel': saved.doubleBarrel,
        'flags.swade-tools.sgBonusIncluded': saved.bonusIncluded
    };
    if (settings.damageProfiles !== undefined) {
        const profiles = getShotgunDamageProfiles(item);
        for (const mode of ['shot', 'slug']) {
            for (const band of ['short', 'medium', 'long']) {
                const candidate = settings.damageProfiles?.[mode]?.[band] ?? profiles[mode][band];
                const validation = validateShotgunDamageFormula(candidate);
                if (!validation.ok) throw new Error(`${mode === 'shot' ? 'Shot' : 'Slug'} ${band} damage: ${validation.reason}`);
                profiles[mode][band] = validation.formula;
            }
        }
        saved.damageProfiles = profiles;
        patch['flags.swade-tools.sgDamageProfiles'] = profiles;
    }
    await item.update(patch);
    return saved;
};
