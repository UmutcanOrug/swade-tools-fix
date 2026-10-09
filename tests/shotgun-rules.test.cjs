const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const rules = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/ShotgunRules.js')).href);
const weapon = (flags = {}) => ({
    type: 'weapon', name: 'Double-barrel Shotgun', isOwner: true,
    flags: { 'swade-tools': flags },
    system: { damage: '4d8+1', actions: { trait: 'Custom Shooting', traitMod: '+2' } }
});
const enabled = flags => weapon({ sgEnabled: true, ...flags });

test('shotgun rules require explicit boolean opt-in and never infer capability from names', async () => {
    const { getShotgunSettings, getShotgunAttackBonus, getShotgunDamage } = await rules;
    assert.deepEqual(getShotgunSettings(weapon()), { enabled: false, doubleBarrel: false, bonusIncluded: false });
    assert.equal(getShotgunSettings(weapon({ sgEnabled: 'true' })).enabled, false);
    assert.equal(getShotgunSettings({ ...enabled({ sgDoubleBarrel: true }), type: 'gear' }).enabled, false);
    assert.equal(getShotgunAttackBonus(weapon(), 'shot'), 0);
    assert.equal(getShotgunDamage(weapon()), null);
    assert.deepEqual(getShotgunSettings(enabled({ sgDoubleBarrel: true, sgBonusIncluded: true })), {
        enabled: true, doubleBarrel: true, bonusIncluded: true
    });
});

test('Shot bonus is additive and Slug subtracts only an explicitly preincluded Shot bonus', async () => {
    const { getShotgunAttackBonus } = await rules;
    const item = enabled();
    assert.equal(getShotgunAttackBonus(item, 'shot'), 2);
    // A native +2 is deliberately ambiguous and must not be subtracted.
    assert.equal(getShotgunAttackBonus(item, 'slug'), 0);
    item.flags['swade-tools'].sgBonusIncluded = true;
    assert.equal(getShotgunAttackBonus(item, 'shot'), 0);
    assert.equal(getShotgunAttackBonus(item, 'slug'), -2);
    assert.equal(getShotgunAttackBonus(item, 'invalid'), 0);
    assert.equal(item.system.actions.traitMod, '+2');
    assert.equal(item.system.actions.trait, 'Custom Shooting');
});

test('Shot damage uses range bands without Extreme and Slug uses 2d10 at all four bands', async () => {
    const { getShotgunDamage } = await rules;
    const item = enabled();
    assert.deepEqual(['short', 'medium', 'long', 'extreme'].map(rangeBand =>
        getShotgunDamage(item, { mode: 'shot', rangeBand })), ['3d6', '2d6', '1d6', null]);
    for (const rangeBand of ['short', 'medium', 'long', 'extreme']) {
        assert.equal(getShotgunDamage(item, { mode: 'slug', rangeBand }), '2d10');
    }
    assert.equal(getShotgunDamage(item, { mode: ' Shot ', rangeBand: 'LONG' }), '1d6');
    assert.equal(getShotgunDamage(item, { rangeBand: 'beyond' }), null);
    assert.equal(getShotgunDamage(item, { mode: 'invalid' }), null);
    assert.equal(item.system.damage, '4d8+1');
});

test('supported Both Barrels uses one Shot damage roll plus4 and requires item capability', async () => {
    const { getShotgunDamage } = await rules;
    assert.equal(getShotgunDamage(enabled(), { bothBarrels: true }), null);
    const item = enabled({ sgDoubleBarrel: true });
    assert.equal(getShotgunDamage(item, { bothBarrels: true }), '3d6+4');
    assert.equal(getShotgunDamage(item, { rangeBand: 'medium', bothBarrels: true }), '2d6+4');
    assert.equal(getShotgunDamage(item, { rangeBand: 'long', bothBarrels: true }), '1d6+4');
    assert.equal(getShotgunDamage(item, { mode: 'slug', bothBarrels: true }), null);
});

test('shotgun ammo uses standard RoF table except two shells for a single Both Barrels attack', async () => {
    const { getSGammoCost } = await rules;
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(rof => getSGammoCost(rof)), [1, 5, 10, 20, 40, 50]);
    assert.equal(getSGammoCost('3'), 10);
    assert.equal(getSGammoCost(1, true), 2);
    for (const rof of [0, -1, 1.5, 7, NaN, Infinity, 'bad']) assert.equal(getSGammoCost(rof), null);
    assert.equal(getSGammoCost(2, true), null);
});

test('validation has no override for disabled items and validates modes/ranges/RoF before spending', async () => {
    const { validateShotgunAttack } = await rules;
    assert.deepEqual(validateShotgunAttack(weapon(), { mode: 'bad' }), { ok: true, enabled: false });
    const item = enabled();
    assert.match(validateShotgunAttack(item, { mode: 'bad' }).reason, /Shot or Slug/);
    assert.match(validateShotgunAttack(item, { rangeBand: 'beyond' }).reason, /range band/);
    assert.match(validateShotgunAttack(item, { rangeBand: 'extreme' }).reason, /Extreme/);
    assert.match(validateShotgunAttack(item, { rof: 2.5 }).reason, /Rate of Fire/);
    assert.deepEqual(validateShotgunAttack(item, { mode: 'slug', rangeBand: 'extreme', rof: 2 }), {
        ok: true, enabled: true, mode: 'slug', rangeBand: 'extreme', rof: 2,
        bothBarrels: false, damage: '2d10', attackBonus: 0, ammoCost: 5
    });
});

test('Both Barrels requires capability, supported Shot mode, RoF1 and exactly one target', async () => {
    const { validateShotgunAttack } = await rules;
    assert.match(validateShotgunAttack(enabled(), { bothBarrels: true, targetCount: 1 }).reason, /Double-barrel/);
    const item = enabled({ sgDoubleBarrel: true });
    assert.match(validateShotgunAttack(item, { bothBarrels: true, mode: 'slug', targetCount: 1 }).reason, /Shot only/);
    assert.match(validateShotgunAttack(item, { bothBarrels: true, rof: 2, targetCount: 1 }).reason, /Rate of Fire 1/);
    for (const targetCount of [undefined, 0, 2]) {
        assert.match(validateShotgunAttack(item, { bothBarrels: true, targetCount }).reason, /exactly one target/);
    }
    const result = validateShotgunAttack(item, { bothBarrels: true, targetCount: 1 });
    assert.equal(result.ok, true); assert.equal(result.damage, '3d6+4');
    assert.equal(result.rof, 1); assert.equal(result.ammoCost, 2);
});

test('profile supports document flags and only writes requested item flags with ownership', async () => {
    const { getShotgunSettings, setShotgunEnabled, saveShotgunSettings } = await rules;
    const item = weapon(), changes = [], originalSystem = structuredClone(item.system);
    item.getFlag = (scope, key) => item.flags[scope]?.[key];
    item.setFlag = async (scope, key, value) => {
        changes.push({ scope, key, value }); item.flags[scope][key] = value;
    };
    item.update = async patch => changes.push(patch);
    await setShotgunEnabled(item, true);
    assert.equal(getShotgunSettings(item).enabled, true);
    assert.deepEqual(await saveShotgunSettings(item, { doubleBarrel: true, bonusIncluded: false }), {
        doubleBarrel: true, bonusIncluded: false
    });
    assert.deepEqual(changes, [
        { scope: 'swade-tools', key: 'sgEnabled', value: true },
        { 'flags.swade-tools.sgDoubleBarrel': true, 'flags.swade-tools.sgBonusIncluded': false }
    ]);
    assert.deepEqual(item.system, originalSystem);
    item.isOwner = false;
    await assert.rejects(setShotgunEnabled(item, false), /own/);
    await assert.rejects(saveShotgunSettings(item), /own/);
    assert.equal(changes.length, 2);
});

test('flag update fallback works without setFlag and ineligible item types cannot be configured', async () => {
    const { setShotgunEnabled, saveShotgunSettings } = await rules;
    const item = weapon(), changes = [];
    item.update = async patch => changes.push(patch);
    await setShotgunEnabled(item, false);
    assert.deepEqual(changes, [{ 'flags.swade-tools.sgEnabled': false }]);
    item.type = 'power';
    await assert.rejects(setShotgunEnabled(item, true), /eligible/);
    await assert.rejects(saveShotgunSettings(item, { doubleBarrel: true }), /eligible/);
    assert.equal(changes.length, 1);
});

test('custom Shot and Slug profiles use independent range damage and Slug Extreme reuses Long', async () => {
    const { getShotgunDamage, getShotgunDamageProfiles } = await rules;
    const item = enabled({ sgDoubleBarrel: true, sgDamageProfiles: {
        shot: { short: '4d8+1', medium: '3d8', long: '2d8' },
        slug: { short: '3d10', medium: '2d10+2', long: '1d12+4' }
    } });
    assert.deepEqual(['short', 'medium', 'long', 'extreme'].map(rangeBand =>
        getShotgunDamage(item, { mode: 'shot', rangeBand })), ['4d8+1', '3d8', '2d8', null]);
    assert.deepEqual(['short', 'medium', 'long', 'extreme'].map(rangeBand =>
        getShotgunDamage(item, { mode: 'slug', rangeBand })), ['3d10', '2d10+2', '1d12+4', '1d12+4']);
    assert.equal(getShotgunDamage(item, { bothBarrels: true }), '4d8+1+4');
    const profile = getShotgunDamageProfiles(item); profile.shot.short = '99d99';
    assert.equal(getShotgunDamage(item), '4d8+1');
    assert.equal(item.system.damage, '4d8+1');
});

test('old and partial damage flags fall back per range without mutating shared defaults', async () => {
    const { getShotgunDamageProfiles, SHOTGUN_DAMAGE_DEFAULTS } = await rules;
    assert.deepEqual(getShotgunDamageProfiles(weapon()), SHOTGUN_DAMAGE_DEFAULTS);
    const first = getShotgunDamageProfiles(enabled({ sgDamageProfiles: {
        shot: { short: ' 4d6 ', medium: '', long: 4 }, slug: { long: '3d12' }
    } }));
    assert.deepEqual(first, {
        shot: { short: '4d6', medium: '2d6', long: '1d6' },
        slug: { short: '2d10', medium: '2d10', long: '3d12' }
    });
    first.slug.short = '1';
    assert.equal(getShotgunDamageProfiles(weapon()).slug.short, '2d10');
    assert.equal(Object.isFrozen(SHOTGUN_DAMAGE_DEFAULTS.shot), true);
});

test('damage profile save validates all six fields before the single item flag write', async () => {
    const { saveShotgunSettings, getShotgunDamageProfiles } = await rules;
    const item = enabled(), changes = [], originalSystem = structuredClone(item.system);
    item.update = async patch => changes.push(patch);
    const profiles = {
        shot: { short: ' 4d6+2 ', medium: '(3d6+1)*2', long: '1d8' },
        slug: { short: '2d12', medium: '2d10+@damage.bonus', long: '2d8x' }
    };
    const result = await saveShotgunSettings(item, { doubleBarrel: true, damageProfiles: profiles });
    assert.equal(changes.length, 1); assert.equal(result.damageProfiles.shot.short, '4d6+2');
    assert.equal(result.damageProfiles.slug.medium, '2d10+@damage.bonus');
    assert.deepEqual(changes[0]['flags.swade-tools.sgDamageProfiles'], result.damageProfiles);
    assert.equal(changes[0]['flags.swade-tools.sgEnabled'], undefined);
    assert.deepEqual(item.system, originalSystem);
    for (const [mode, band] of [['shot','short'], ['shot','medium'], ['shot','long'], ['slug','short'], ['slug','medium'], ['slug','long']]) {
        const invalid = structuredClone(profiles); invalid[mode][band] = 'not a roll';
        await assert.rejects(saveShotgunSettings(item, { damageProfiles: invalid }), new RegExp(`${mode === 'shot' ? 'Shot' : 'Slug'} ${band} damage`));
        assert.equal(changes.length, 1);
    }
    assert.equal(getShotgunDamageProfiles(item).shot.short, '3d6');
});

test('profile formula validation uses no actor data or dice evaluation and safely rejects malformed input', async () => {
    const { validateShotgunDamageFormula } = await rules;
    const seen = [];
    const RollClass = { validate: value => { seen.push(value); return true; },
        evaluate: () => { throw new Error('Must not roll'); },
        replaceFormulaData: () => { throw new Error('Must not look up actor references'); } };
    assert.deepEqual(validateShotgunDamageFormula(' 3d6 + @system.bonus ', { RollClass }), {
        ok: true, formula: '3d6 + @system.bonus'
    });
    assert.deepEqual(seen, ['3d6 + 1', '3d6x + 1']);
    for (const value of ['', '3d6;', '<script>', '3d6+@constructor.name', '3d6+@foo..bar', '3d6+@', null, 8, 'd6'.repeat(129)]) {
        assert.equal(validateShotgunDamageFormula(value, { RollClass }).ok, false, String(value));
    }
    for (const value of ['3d6', '(3d6+1)*2', '2d10+@bonus', '1d6x+4', '2d8kh1']) {
        assert.equal(validateShotgunDamageFormula(value, { RollClass: null }).ok, true, value);
    }
    for (const value of ['bogus', '3d6+', '(3d6', '3d6 2', '3d6+()', '3d6**']) {
        assert.equal(validateShotgunDamageFormula(value, { RollClass: null }).ok, false, value);
    }
    assert.equal(validateShotgunDamageFormula('3d6', { RollClass: { validate: () => { throw new Error('parse'); } } }).ok, false);
});

test('damage validation normalizes uppercase dice and rejects formulas broken by native explosion conversion', async () => {
    const { validateShotgunDamageFormula, saveShotgunSettings } = await rules;
    const seen = [];
    const RollClass = { validate: formula => {
        seen.push(formula);
        return ['2d6+1', '2d6x+1', 'max(1,2)'].includes(formula);
    } };
    assert.deepEqual(validateShotgunDamageFormula(' 2D6+1 ', { RollClass }), { ok: true, formula: '2d6+1' });
    assert.equal(validateShotgunDamageFormula('max(1,2)', { RollClass }).ok, false);
    assert.deepEqual(seen, ['2d6+1', '2d6x+1', 'max(1,2)', 'ma(1,2)']);
    const item = enabled(), changes = []; item.update = async patch => changes.push(patch);
    const previousRoll = global.Roll; global.Roll = RollClass;
    try {
        await assert.rejects(saveShotgunSettings(item, { damageProfiles: { shot: { short: 'max(1,2)' } } }), /Shot short damage/);
        assert.equal(changes.length, 0);
    } finally { global.Roll = previousRoll; }
});
