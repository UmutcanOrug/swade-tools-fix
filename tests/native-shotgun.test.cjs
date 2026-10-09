const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const scripts = path.resolve(__dirname, '../scripts');

// Load the real service with only gb's transitive Foundry UI imports replaced.
// All other helpers are the production modules; no game/server is contacted.
const nativeSource = fs.readFileSync(path.join(scripts, 'services/NativeShotgunAttack.js'), 'utf8')
    .replace("import * as gb from '../gb.js';", 'const gb = {getRange: (source,target) => target.testRange};')
    .replace(/from '\.\/([^']+)'/g, (_, name) => `from '${pathToFileURL(path.join(scripts, 'services', name)).href}'`);
const native = import(`data:text/javascript;base64,${Buffer.from(nativeSource).toString('base64')}`);

const actor = id => ({ id, uuid: `Actor.${id}`, type: 'character', isOwner: true, permission: 3,
    getActiveTokens() { return this.activeTokens ?? []; }, getFlag() {}, items: new Map() });
const token = (id, owner, range = 1) => {
    const document = { id, uuid: `Scene.scene.Token.${id}`, parent: { id: 'scene' }, actor: owner };
    const object = { id, actor: owner, document, scene: document.parent, testRange: range };
    document.object = object; return object;
};
const fixture = (range = 1) => {
    const owner = actor('owner'), enemy = actor('enemy'), source = token('source', owner), target = token('target', enemy, range);
    const item = { id: 'weapon', uuid: `${owner.uuid}.Item.weapon`, type: 'weapon', name: 'Test Shotgun',
        actor: owner, isOwner: true, flags: { 'swade-tools': { sgEnabled: true, sgDoubleBarrel: true } }, calls: [],
        system: { damage: '9d4', range: '12/24/48', quantity: 1, shots: 2, currentShots: 2, reloadType: 'single',
            actions: { trait: 'Shooting', traitMod: '+1' } },
        canExpendResources(cost) { return this.system.currentShots >= cost; },
        async consume(cost) { this.calls.push(cost); this.system.currentShots -= cost; }
    };
    owner.items.set(item.id, item); owner.activeTokens = [source];
    const tokens = new Map([[source.id, source], [target.id, target]]);
    const targets = new Set([target]);
    global.game = { user: { id: 'player', _id: 'player', targets }, settings: { get: () => true }, modules: new Map() };
    global.canvas = { scene: { id: 'scene' }, dimensions: { distance: 1 }, tokens: {
        controlled: [], placeables: [source, target], get: id => tokens.get(id)
    } };
    global.fromUuid = async uuid => [...tokens.values()].find(value => value.document.uuid === uuid)?.document ?? null;
    global.Roll = class {
        static validate(formula) { return /^[\d\s+dDxX().*/-]+$/.test(formula); }
        static replaceFormulaData(formula, data) {
            return formula.replace(/@([\w.]+)/g, (_, key) => key.split('.').reduce((value, part) => value?.[part], data));
        }
    };
    const messages = []; global.ui = { notifications: { warn: message => messages.push(message), error: message => messages.push(message) } };
    return { owner, enemy, source, target, item, targets, tokens, messages, input: { item, weaponOwner: owner, token: source } };
};
const rollStub = () => ({ modifiers: [], flags: {}, targets: [], manageshots: true,
    addModifier(value, reason) { this.modifiers.push([value, reason]); },
    addFlag(key, value) { this.flags[key] = value; }, useTarget(id) { this.targets.push(id); } });

test('native Shot prepares per-target range damage and spends one native shell exactly once', async () => {
    const { prepareNativeShotgunAttack } = await native, f = fixture(20), snapshot = structuredClone(f.item.system);
    const result = await prepareNativeShotgunAttack(f.input);
    assert.equal(result.ok, true); assert.equal(result.rangeBand, 'medium'); assert.equal(result.damage, '2d6');
    assert.equal(result.attackBonus, 2); assert.equal(result.ammoCost, 1); assert.equal(result.consumed, 1);
    assert.deepEqual(f.item.calls, [1]); assert.equal(f.item.system.currentShots, 1);
    assert.equal(result.targetId, f.target.id); assert.equal(result.sourceTokenUuid, f.source.document.uuid);
    assert.equal(f.item.system.damage, snapshot.damage); assert.deepEqual(f.item.system.actions, snapshot.actions);
    assert.deepEqual([...f.targets], [f.target]);
});

test('native Both Barrels is one attack/profile, +4 damage and exactly two shells, never five', async () => {
    const { prepareNativeShotgunAttack } = await native, f = fixture();
    const result = await prepareNativeShotgunAttack({ ...f.input, bothBarrels: true });
    assert.equal(result.ok, true); assert.equal(result.damage, '3d6+4'); assert.equal(result.ammoCost, 2);
    assert.equal(result.rof, 1); assert.deepEqual(f.item.calls, [2]); assert.equal(f.item.system.currentShots, 0);
});

test('zero/multiple targets, invalid source/range, unsupported combinations and permissions spend no ammo', async () => {
    const { prepareNativeShotgunAttack } = await native;
    for (const mutate of [
        f => f.targets.clear(), f => f.targets.add(token('other', f.enemy)),
        f => { f.input.token = token('wrong-owner', f.enemy); },
        f => { f.item.system.range = 'bad'; }, f => { f.target.testRange = 49; },
        f => { f.item.isOwner = false; }, f => { f.owner.isOwner = false; },
        f => { f.input.operator = { isOwner: false }; },
        f => { f.item.flags['swade-tools'].sgDoubleBarrel = false; f.input.bothBarrels = true; },
        f => { f.input.mode = 'slug'; f.input.bothBarrels = true; },
        f => { f.item.system.currentShots = 0; }, f => { f.target.testRange = null; }
    ]) {
        const f = fixture(); mutate(f); const result = await prepareNativeShotgunAttack(f.input);
        assert.equal(result.ok, false, String(mutate)); assert.equal(f.item.calls.length, 0);
    }
});

test('Slug allows Extreme but not beyond Extreme and removes only explicit preincluded Shot bonus', async () => {
    const { prepareNativeShotgunAttack } = await native;
    const f = fixture(120); f.item.flags['swade-tools'].sgBonusIncluded = true;
    const result = await prepareNativeShotgunAttack({ ...f.input, mode: 'slug' });
    assert.equal(result.ok, true); assert.equal(result.rangeBand, 'extreme');
    assert.equal(result.damage, '2d10'); assert.equal(result.attackBonus, -2);
    const far = fixture(193);
    assert.match((await prepareNativeShotgunAttack({ ...far.input, mode: 'slug' })).reason, /beyond/);
    assert.equal(far.item.calls.length, 0);
});

test('damage-only, consume-off and global ammo management off keep all resources unchanged', async () => {
    const { prepareNativeShotgunAttack } = await native;
    for (const options of [{ action: 'damage' }, { consumeAmmo: false }, { globalOff: true }]) {
        const f = fixture(); if (options.globalOff) game.settings.get = () => false;
        const result = await prepareNativeShotgunAttack({ ...f.input, ...options });
        assert.equal(result.ok, true); assert.equal(result.consumed, 0);
        assert.equal(f.item.calls.length, 0); assert.equal(f.item.system.currentShots, 2);
    }
});

test('source choice is explicit or uniquely owner-matched, never first of ambiguous linked/synthetic copies', async () => {
    const { prepareNativeShotgunAttack } = await native;
    const f = fixture(); delete f.input.token;
    const otherOwner = actor('other'), unrelated = token('unrelated', otherOwner);
    canvas.tokens.controlled = [unrelated];
    assert.equal((await prepareNativeShotgunAttack({ ...f.input, action: 'damage' })).sourceTokenUuid, f.source.document.uuid);
    f.owner.activeTokens = [f.source, token('linked-copy', f.owner)];
    assert.equal((await prepareNativeShotgunAttack({ ...f.input, action: 'damage' })).ok, false);
    canvas.tokens.controlled = [f.source];
    assert.equal((await prepareNativeShotgunAttack({ ...f.input, action: 'damage' })).ok, true);
    canvas.tokens.controlled = [f.source, f.owner.activeTokens[1]];
    assert.equal((await prepareNativeShotgunAttack({ ...f.input, action: 'damage' })).ok, false);
    const wrongScene = token('elsewhere', f.owner); wrongScene.document.parent.id = 'elsewhere';
    wrongScene.document.uuid = 'Scene.elsewhere.Token.elsewhere';
    assert.equal((await prepareNativeShotgunAttack({ ...f.input, token: wrongScene, action: 'damage' })).ok, false);
});

test('ammunition uses actual linked resource AA guard and failure never returns an attack-ready profile', async () => {
    const { prepareNativeShotgunAttack } = await native, f = fixture(), ammo = { uuid: 'Actor.owner.Item.ammo' };
    let guarded, spent = 0;
    const runtime = { resource: {
        validate: () => ({ ok: true, resource: ammo }),
        spend: async (_item, _owner, options) => { spent++; assert.equal(options.mode, 'ammo'); assert.equal(options.cost, 1); return { ok: true, consumed: 1 }; }
    }, automationGuard: async (items, callback, options) => {
        guarded = items; assert.equal(options.trackConsumption, true); return callback();
    } };
    assert.equal((await prepareNativeShotgunAttack(f.input, runtime)).ok, true);
    assert.deepEqual(guarded, [f.item, ammo]); assert.equal(spent, 1);
    runtime.resource.spend = async () => { throw new Error('denied'); };
    assert.equal((await prepareNativeShotgunAttack(f.input, runtime)).ok, false);
});

test('typed modifier and native Trait Modifier formulas are validated before ammunition, without rolling dice', async () => {
    const { prepareNativeShotgunAttack, applyNativeShotgunProfile } = await native;
    for (const modifierFormula of ['invalid)', '@missing.path+2', '@constructor.name']) {
        const f = fixture();
        const result = await prepareNativeShotgunAttack({ ...f.input, modifierFormula });
        assert.equal(result.ok, false); assert.match(result.reason, /Modifier/); assert.equal(f.item.calls.length, 0);
    }
    const badTrait = fixture(); badTrait.item.system.actions.traitMod = '@missing';
    assert.equal((await prepareNativeShotgunAttack(badTrait.input)).ok, false);
    assert.equal(badTrait.item.calls.length, 0);
    const f = fixture(); f.owner.getRollData = () => ({ bonus: 3 });
    f.item.system.actions.traitMod = '@bonus-1';
    const result = await prepareNativeShotgunAttack({ ...f.input, modifierFormula: '1d6+@bonus' });
    assert.equal(result.ok, true); assert.equal(result.modifierFormulaResolved, '1d6+3');
    assert.equal(result.traitModifierResolved, '3-1'); assert.deepEqual(f.item.calls, [1]);
    const roll = rollStub(); applyNativeShotgunProfile(roll, result);
    assert.equal(roll.shotgunTraitModOverride, '3-1');
    assert.equal(f.item.system.actions.traitMod, '@bonus-1');
});

test('profile application preserves mode/source/target flags but adds attack bonus only to attacks', async () => {
    const { prepareNativeShotgunAttack, applyNativeShotgunProfile } = await native, f = fixture();
    const prepared = await prepareNativeShotgunAttack(f.input), roll = rollStub();
    assert.equal(applyNativeShotgunProfile(roll, prepared), true);
    assert.deepEqual(roll.modifiers, [[2, 'Shot']]); assert.equal(roll.manageshots, false);
    assert.equal(roll.flags.shotgunMode, 'shot'); assert.equal(roll.flags.shotgunBothBarrels, false);
    assert.equal(roll.flags.shotgunSourceTokenUuid, f.source.document.uuid);
    assert.deepEqual(roll.targets, [f.target.id]);
    const damage = rollStub(); applyNativeShotgunProfile(damage, { ...prepared, action: 'damage' });
    assert.equal(damage.modifiers.length, 0); assert.equal(damage.manageshots, true);
    assert.equal(applyNativeShotgunProfile(rollStub(), { ok: true, enabled: false }), false);
});

const noImports = source => source.replace(/^import[^\n]+;\r?\n/gm, '');
test('actual ItemRoll override retains damage modifiers/AP/Raise and does not mutate the item', async () => {
    const source = noImports(fs.readFileSync(path.join(scripts, 'class/ItemRoll.js'), 'utf8'))
        .replace('export default class ItemRoll', 'class ItemRoll');
    class Base {
        addFlavor() {} isItem() {} defineAction(action) { this.action = action; }
        addModifier(value) { (this.mods ??= []).push(value); }
        async rollDamage(...args) { this.args = args; }
    }
    const ItemRoll = Function('CharRoll', 'gb', `${source}\nreturn ItemRoll;`)(Base, { trans: value => value });
    const f = fixture(); f.owner.system = {}; f.item.system.actions.dmgMod = '+1';
    const roll = new ItemRoll(f.owner, f.item);
    await roll.rollBaseDamage('2d6+4');
    assert.deepEqual(roll.args, ['2d6+4', '', 6]); assert.deepEqual(roll.mods, ['+1']);
    await roll.rollBaseDamage(); assert.equal(roll.args[0], '9d4'); assert.equal(f.item.system.damage, '9d4');
});

const loadTargetFunction = (control, item, api, calls) => {
    const source = fs.readFileSync(path.join(scripts, 'class/RollControl.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('this.targetFunction= async (targetid,raiseDmg)=>{');
    const end = source.indexOf('\n        }\n        }\n    }', start);
    const assignment = source.slice(start, end + '\n        }'.length);
    class ItemRoll {
        constructor(actor,item) { this.record = { actor,item,flags: {}, mods: [] }; calls.push(this.record); }
        usingVehicle(vehicle) {this.record.vehicle=vehicle;} addModifier(...args) { this.record.mods.push(args); }
        addFlag(key, value) { this.record.flags[key] = value; } useTarget(id) { this.record.target = id; }
        raiseDmg() { this.record.raise = true; }
        async rollAction(id) { this.record.action = id; }
        async rollBaseDamage(formula) { this.record.damage = formula; }
        display() { this.record.displayed = true; }
    }
    return Function('item', 'gangup', 'gb', 'ItemRoll', 'Char', 'prepareNativeShotgunDamageForTarget', 'applyNativeShotgunProfile',
        `${assignment};return this.targetFunction;`).call(control, item, 0, {
            trans: value => value, setting: () => false
        }, ItemRoll, class {}, api.prepareNativeShotgunDamageForTarget, api.applyNativeShotgunProfile);
};

test('actual native target damage branch remeasures recorded source, preserves Raise and never consumes again', async () => {
    const api = await native, f = fixture(30), calls = [];
    // Current user targets may be empty or different; the clicked chat target is authoritative.
    f.targets.clear();
    const control = { chat: { flags: { 'swade-tools': {
        shotgunMode: 'shot', shotgunBothBarrels: true, shotgunSourceTokenUuid: f.source.document.uuid
    } } }, getActor: () => f.owner, getItemOwner: () => f.owner };
    const action = loadTargetFunction(control, f.item, api, calls);
    await action(f.target.id, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].damage, '1d6+4');
    assert.equal(calls[0].raise, true); assert.equal(calls[0].displayed, true);
    assert.equal(calls[0].flags.shotgunMode, 'shot'); assert.equal(f.item.calls.length, 0);
    f.target.testRange = 50;
    assert.equal(await action(f.target.id, false), false);
    assert.equal(calls.length, 1); assert.match(f.messages[0], /Extreme/);
});

test('native mounted Shotgun damage retains its operator and vehicle resource owner separately',async()=>{
    const api=await native,f=fixture(20),calls=[],operator=actor('gunner');f.owner.type='vehicle';
    const control={chat:{flags:{'swade-tools':{shotgunMode:'shot',shotgunSourceTokenUuid:f.source.document.uuid,
        usevehicle:f.owner.id}}},getActor:()=>operator,getItemOwner:()=>f.owner};
    await loadTargetFunction(control,f.item,api,calls)(f.target.id,false);
    assert.equal(calls.length,1);assert.equal(calls[0].actor,operator);assert.equal(calls[0].vehicle,f.owner);
    assert.equal(calls[0].item,f.item);assert.equal(calls[0].damage,'2d6');assert.equal(f.item.calls.length,0);
});

test('native target branch keeps explicit additional damage actions and ordinary non-SG fallback intact', async () => {
    const api = await native, f = fixture(), calls = [];
    const flags = { shotgunMode: 'slug', shotgunSourceTokenUuid: f.source.document.uuid, damageaction: 'custom-damage' };
    const control = { chat: { flags: { 'swade-tools': flags } }, getActor: () => f.owner, getItemOwner: () => f.owner };
    await loadTargetFunction(control, f.item, api, calls)(f.target.id, false);
    assert.equal(calls[0].action, 'custom-damage'); assert.equal(calls[0].damage, undefined);
    delete flags.shotgunMode; delete flags.damageaction;
    await loadTargetFunction(control, f.item, api, calls)(f.target.id, false);
    assert.equal(calls[1].damage, null); assert.equal(calls[1].displayed, true);
});

test('actual native Benny reroll copies shotgun mode/barrels/source flags without repeating resource preparation', async () => {
    const f = fixture(), flags = { shotgunMode: 'shot', shotgunBothBarrels: true,
        shotgunSourceTokenUuid: f.source.document.uuid, itemroll: f.item.id };
    const source = noImports(fs.readFileSync(path.join(scripts, 'class/RollControl.js'), 'utf8'))
        .replace('export default class RollControl', 'class RollControl');
    const Control = Function('gb', 'Char', `${source}\nreturn RollControl;`)(
        { raiseCount: () => 0, stringMod: value => String(value), trans: value => value },
        class { hasEdgeSetting() { return false; } });
    let updated;
    global.CONFIG = { Dice: { SwadeRoll: class {
        constructor(formula) { this.formula = formula; this.terms = [{}]; this.total = 8; }
        async evaluate() {} async toMessage() { return { update: async patch => { updated = patch; } }; }
    } } };
    global.ChatMessage = { getSpeaker: () => ({}) }; global.Hooks = { call() {} };
    const chat = { rolls: [{ formula: '1d6+2', terms: [{ options: {} }] }], flavor: 'Test', flags: { 'swade-tools': flags } };
    const control = new Control(chat, {}, 'player'); await control.rerollBasic(f.owner);
    assert.equal(updated['flags.swade-tools'].shotgunMode, 'shot');
    assert.equal(updated['flags.swade-tools'].shotgunBothBarrels, true);
    assert.equal(updated['flags.swade-tools'].shotgunSourceTokenUuid, f.source.document.uuid);
    assert.equal(f.item.calls.length, 0);
});
