const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const scripts = path.resolve(__dirname, '../scripts');
const helper = import(pathToFileURL(path.join(scripts, 'services/WeaponDamageModifier.js')).href);
const stripImports = text => text.replace(/^import[^\n]+;\r?\n/gm, '');
const gb = {
    trans: value => value, systemSetting: () => true, realInt: value => Number(value) || 0,
    findAttr: () => false, stringDiceMod: value => /^[+-]/.test(value) ? value : `+${value}`,
    explodeAllDice: value => value.replace(/d(\d+)(?![\dx])/g, 'd$1x'),
    stringMod: value => value < 0 ? String(value) : `+${value}`, setting: () => false
};
const classFor = (name, bindings) => {
    const source = stripImports(fs.readFileSync(path.join(scripts, `class/${name}.js`), 'utf8'))
        .replace(`export default class ${name}`, `class ${name}`);
    return Function(...Object.keys(bindings), `${source}\nreturn ${name};`)(...Object.values(bindings));
};
const BasicRoll = classFor('BasicRoll', { gb });
const CharRoll = classFor('CharRoll', { gb, BasicRoll, Char: class {} });
const ItemRoll = classFor('ItemRoll', { gb, CharRoll });
const formulaRuntime = () => {
    let created = 0;
    class FormulaRoll {
        constructor() { created++; throw new Error('Preflight must not roll dice'); }
        static validate(formula) { return /^[\d\sdDxX()+*/.\-]+$/.test(formula); }
        static replaceFormulaData(formula, data) {
            return formula.replace(/@([\w.]+)/g, (_, name) => name.split('.').reduce((value, part) => value?.[part], data));
        }
    }
    return { RollClass: FormulaRoll, created: () => created };
};
const fixture = () => {
    const actor = { id: 'owner', permission: 3, system: { stats: { globalMods: { damage: [{ value: '+3', label: 'Global' }] } } },
        getRollData: () => ({ bonus: 4 }) };
    const updates = [];
    const item = { id: 'weapon', type: 'weapon', name: 'Test weapon', system: {
        damage: '2d8', ap: 1, bonusDamageDie: 8, shots: 10, currentShots: 10, reloadType: 'single',
        actions: { trait: 'Shooting', traitMod: '+1', dmgMod: '+2', additional: {
            burst: { type: 'trait', resourcesUsed: 2, modifier: '+1', dice: 1 },
            alternate: { type: 'damage', modifier: '+5', override: '3d6' }
        } }
    }, update: async patch => { updates.push(patch); Object.assign(item.system, { currentShots: patch['system.currentShots'] }); } };
    const roll = new ItemRoll(actor, item);
    roll.rollSkill = async () => { if (roll.manageshots) await roll.countShots(); };
    roll.rollDamage = async function (damage, ap, raiseDie) { this.damageResult = { damage, ap, raiseDie, modifier: this.mod, formula: this.diceModifier }; };
    return { actor, item, roll, updates };
};

test('Damage Mod preflight resolves data references once without evaluating modifier dice', async () => {
    const { prepareWeaponDamageModifier } = await helper, runtime = formulaRuntime();
    const actor = { getRollData: () => ({ bonus: 3, nested: { bonus: 2 } }) };
    assert.deepEqual(prepareWeaponDamageModifier('', actor, runtime), { ok: true, formula: '' });
    assert.deepEqual(prepareWeaponDamageModifier('1D6+@bonus-@nested.bonus', actor, runtime),
        { ok: true, formula: '1d6+3-2' });
    assert.deepEqual(prepareWeaponDamageModifier('0', actor, runtime), { ok: true, formula: '0' });
    for (const value of ['@missing', '@nested', '@constructor.name', '@__proto__.polluted', 'invalid)', '@bonus@']) {
        const result = prepareWeaponDamageModifier(value, actor, runtime);
        assert.equal(result.ok, false, value); assert.match(result.reason, /^Damage Mod/);
    }
    assert.equal(runtime.created(), 0);
});

test('Damage Mod rejects formulas broken by native conversion before any dice or resource side effects', async () => {
    const { prepareWeaponDamageModifier, nativeWeaponDamageFormula } = await helper;
    const validated = [];
    class FormulaRoll {
        constructor() { throw new Error('No dice should be rolled'); }
        static validate(formula) {
            validated.push(formula);
            return ['max(1,2)', 'exp(1)', 'floor(1.5)', '1d6+2', '1d6x+2'].includes(formula);
        }
    }
    for (const formula of ['max(1,2)', 'exp(1)']) {
        const result = prepareWeaponDamageModifier(formula, {}, { RollClass: FormulaRoll });
        assert.equal(result.ok, false); assert.match(result.reason, /native SWADE Tools/);
    }
    assert.deepEqual(validated.slice(0, 4), ['max(1,2)', 'ma(1,2)', 'exp(1)', 'ep(1)']);
    assert.equal(prepareWeaponDamageModifier('1D6+2', {}, { RollClass: FormulaRoll }).formula, '1d6+2');
    assert.equal(prepareWeaponDamageModifier('floor(1.5)', {}, { RollClass: FormulaRoll }).ok, true);
    assert.equal(nativeWeaponDamageFormula('1d6x+1d1+1d0'), '1d6x+1d1+1d0');
    // Pin the pure mirror to the converter used by native damage at runtime.
    const source = fs.readFileSync(path.join(scripts, 'gb.js'), 'utf8');
    const body = source.match(/export const explodeAllDice=\(weaponDamage\)=>\{([\s\S]*?)\n\s*\}/)[1];
    const actual = Function('weaponDamage', body);
    for (const formula of ['3d6', '1d6x+2d10+1d1', 'max(1,2)', '1d8r=8', '(2d8)+1d6']) {
        assert.equal(nativeWeaponDamageFormula(formula), actual(formula), formula);
    }
});

test('separate Damage Mod never enters attack and is added exactly once to native damage', async () => {
    const f = fixture(); f.roll.setWeaponDamageModifier('1d6+4');
    await f.roll.rollBaseSkill();
    assert.equal(f.roll.diceModifier, ''); assert.equal(f.roll.mod, 1);
    assert.equal(f.roll.flagUpdate.weaponDamageModifier, '1d6+4');
    // Actual UI creates a fresh ItemRoll for damage, as does the chat target button.
    const damage = new ItemRoll(f.actor, f.item); damage.setWeaponDamageModifier(f.roll.flagUpdate.weaponDamageModifier);
    damage.rollDamage = f.roll.rollDamage; damage.raiseDmg();
    await damage.rollBaseDamage();
    assert.equal(damage.damageResult.damage, '2d8'); assert.equal(damage.damageResult.ap, ' [Ap: 1]');
    assert.equal(damage.damageResult.raiseDie, 8); assert.equal(damage.dmgraise, true);
    assert.equal(damage.damageResult.modifier, 5); assert.equal(damage.damageResult.formula, '+(1d6+4)');
    damage.addDmgMod(); assert.equal(damage.diceModifier, '+(1d6+4)');
    assert.equal(damage.reasons.filter(value => value.startsWith('Damage Mod:')).length, 1);
    assert.equal(f.item.system.damage, '2d8');
});

test('direct and explicit additional damage actions use the same modifier pipeline without changing item data', async () => {
    const f = fixture(); f.roll.setWeaponDamageModifier('-2');
    const snapshot = structuredClone(f.item.system);
    await f.roll.rollAction('alternate');
    assert.equal(f.roll.damageResult.damage, '3d6'); assert.equal(f.roll.damageResult.modifier, 10);
    assert.equal(f.roll.damageResult.formula, '+(-2)');
    assert.deepEqual(f.item.system, snapshot);
});

test('The Drop adds attack +4 and damage +4 separately once, alongside damage-only modifiers', async () => {
    const attack = fixture(); attack.roll.setWeaponTheDrop(true); attack.roll.setWeaponDamageModifier('1d6+4');
    await attack.roll.rollBaseSkill();
    assert.equal(attack.roll.mod, 5); assert.equal(attack.roll.diceModifier, '');
    assert.equal(attack.roll.flagUpdate.weaponTheDrop, true);
    const damage = new ItemRoll(attack.actor, attack.item); damage.rollDamage = attack.roll.rollDamage;
    damage.setWeaponTheDrop(attack.roll.flagUpdate.weaponTheDrop);
    damage.setWeaponDamageModifier(attack.roll.flagUpdate.weaponDamageModifier);
    await damage.rollBaseDamage();
    assert.equal(damage.damageResult.modifier, 9); assert.equal(damage.damageResult.formula, '+(1d6+4)');
    damage.addDmgMod();
    assert.equal(damage.reasons.filter(value => value === 'The Drop: +4').length, 1);
    assert.equal(damage.diceModifier, '+(1d6+4)');
    const unchanged = fixture(); unchanged.roll.setWeaponTheDrop(false); await unchanged.roll.rollBaseSkill();
    assert.equal(unchanged.roll.mod, 1); assert.equal(unchanged.roll.flagUpdate.weaponTheDrop, false);
});

test('The Drop works on native additional trait/damage actions without changing action modifiers', async () => {
    const attack = fixture(); attack.roll.setWeaponTheDrop(true); await attack.roll.rollAction('burst');
    assert.equal(attack.roll.mod, 6); assert.equal(attack.item.system.currentShots, 8);
    const damage = fixture(); damage.roll.setWeaponTheDrop(true); await damage.roll.rollAction('alternate');
    assert.equal(damage.roll.damageResult.modifier, 14); assert.equal(damage.item.system.currentShots, 10);
});

test('Ammunition unchecked prevents native single-shot and additional-action consumption, not power management', async () => {
    for (const action of ['base', 'burst']) {
        const f = fixture(); f.roll.setConsumeAmmunition(false);
        assert.equal(f.roll.manageshots, false);
        if (action === 'base') await f.roll.rollBaseSkill(); else await f.roll.rollAction(action);
        assert.equal(f.item.system.currentShots, 10); assert.equal(f.updates.length, 0);
    }
    const enabled = fixture(); enabled.roll.setConsumeAmmunition(true); await enabled.roll.rollBaseSkill();
    assert.equal(enabled.item.system.currentShots, 9); assert.equal(enabled.updates.length, 1);
    const globalOff = fixture(); globalOff.roll.manageshots = false; globalOff.roll.setConsumeAmmunition(true);
    await globalOff.roll.rollBaseSkill(); assert.equal(globalOff.updates.length, 0);
    const power = fixture(); power.item.type = 'power'; power.roll.manageshots = true;
    power.roll.setConsumeAmmunition(false); assert.equal(power.roll.manageshots, true);
});

const targetFunction = (control, item, prepareWeaponDamageModifier, calls) => {
    const source = fs.readFileSync(path.join(scripts, 'class/RollControl.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('this.targetFunction= async (targetid,raiseDmg)=>{');
    const end = source.indexOf('\n        }\n        }\n    }', start);
    const assignment = source.slice(start, end + '\n        }'.length);
    class CaptureItemRoll {
        constructor() { this.record = {}; calls.push(this.record); }
        setWeaponDamageModifier(formula) { this.record.modifier = formula; }
        setWeaponTheDrop(enabled) { this.record.drop = enabled; }
        useTarget(target) { this.record.target = target; } raiseDmg() { this.record.raise = true; }
        async rollBaseDamage(formula) { this.record.damage = formula; } display() { this.record.display = true; }
    }
    return Function('item', 'gangup', 'gb', 'ItemRoll', 'Char', 'prepareWeaponDamageModifier',
        `${assignment};return this.targetFunction;`).call(control, item, 0, gb, CaptureItemRoll, class {}, prepareWeaponDamageModifier);
};

test('actual native Hit damage restores frozen modifier from chat, keeps Raise, and rejects corrupt formulas', async () => {
    const { prepareWeaponDamageModifier } = await helper, runtime = formulaRuntime();
    const f = fixture(), calls = [], warnings = [];
    global.Roll = runtime.RollClass;
    global.ui = { notifications: { warn: value => warnings.push(value), error: value => warnings.push(value) } };
    const flags = { weaponDamageModifier: '1d6+4', weaponTheDrop: true };
    const control = { chat: { flags: { 'swade-tools': flags } }, getActor: () => f.actor, getItemOwner: () => f.actor };
    await targetFunction(control, f.item, prepareWeaponDamageModifier, calls)('enemy', true);
    assert.deepEqual(calls[0], { drop: true, modifier: '1d6+4', target: 'enemy', raise: true, damage: null, display: true });
    flags.weaponDamageModifier = 'broken)';
    assert.equal(await targetFunction(control, f.item, prepareWeaponDamageModifier, calls)('enemy', false), false);
    assert.equal(calls[1].display, undefined); assert.match(warnings[0], /^Damage Mod/); assert.equal(f.updates.length, 0);
});

test('actual native Benny reroll keeps Damage Mod/The Drop and rerolls its augmented formula without another bonus', async () => {
    const f = fixture(), flags = { weaponDamageModifier: '1d6+4', weaponTheDrop: true, itemroll: f.item.id }, patches = [];
    const Control = classFor('RollControl', { gb: { ...gb, raiseCount: () => 0 }, Char: class { hasEdgeSetting() { return false; } } });
    global.game = { user: { _id: 'player', id: 'player' } }; f.actor.items = new Map([[f.item.id, f.item]]);
    global.CONFIG = { Dice: { SwadeRoll: class {
        constructor(formula) { this.formula = formula; this.terms = [{}]; this.total = 7; }
        async evaluate() {} async toMessage() { patches.push(this.formula); return { update: async patch => patches.push(patch) }; }
    } } };
    global.ChatMessage = { getSpeaker: () => ({}) }; global.Hooks = { call() {} };
    const chat = { rolls: [{ formula: '1d8x-2+4', terms: [{ options: {} }] }], flavor: 'Attack', flags: { 'swade-tools': flags } };
    await new Control(chat, {}, 'player').rerollBasic(f.actor, true);
    assert.equal(patches[0], '1d8x-2+4'); assert.equal(patches[1]['flags.swade-tools'].weaponDamageModifier, '1d6+4');
    assert.equal(patches[1]['flags.swade-tools'].weaponTheDrop, true);
    assert.equal(f.item.system.currentShots, 10); assert.equal(f.updates.length, 0);
});
