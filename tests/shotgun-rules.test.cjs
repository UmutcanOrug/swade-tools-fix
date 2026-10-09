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
