const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesCombat.js')).href);
const fixture = (enabled = true) => {
    const library = {version: 1, presets: [], assignments: {}};
    const settings = {propertiesEnabled: enabled, propertiesLibrary: library, fightingSkill: 'Fighting', BrawnySetting: 'Brawny', SoldierSetting: 'Soldier'};
    const runtime = {game: {settings: {get(scope, key) { assert.equal(scope, 'swade-tools'); return settings[key]; }}}};
    const actor = {uuid: 'Actor.attacker', items: []};
    const item = {uuid: 'Actor.attacker.Item.rifle', type: 'weapon', name: 'Rifle', system: {equipStatus: 3, actions: {trait: 'Shooting'}}};
    const defense = {uuid: 'Actor.target.Item.edge', type: 'edge', name: 'Defense'};
    const target = {uuid: 'Actor.target', items: [defense]};
    actor.items.push(item);
    return {library, settings, runtime, actor, item, defense, target};
};

test('combat defaults off and leaves weapon modifiers, minimum Strength and Soak unchanged', async () => {
    const api = await load(), f = fixture(false);
    f.library.assignments[f.item.uuid] = [{id: 'attack', action: 'attackMod', value: 20}, {id: 'strength', action: 'minStrengthSteps', value: 5}];
    assert.equal(api.canUsePropertiesCombat(f.item, {}, f.runtime), false);
    const result = api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: f.target}, f.runtime);
    assert.equal(result.enabled, false); assert.equal(result.attackDelta, 0); assert.equal(result.incoming, 0); assert.equal(result.cover, 0);
    assert.equal(api.getPropertyStrength(8, f.actor, f.item, {}, f.runtime), 8);
    assert.equal(api.getPropertySoakModifier(f.actor, f.item, {}, f.runtime), 0);
    assert.equal(api.canUsePropertiesCombat(f.item, {}, {game: {}}), false);
});

test('AoE and Flame items/messages remain entirely on their existing rules pipeline', async () => {
    const api = await load(), f = fixture();
    for (const item of [
        {...f.item, flags: {'swade-tools': {aoeEnabled: true}}},
        {...f.item, name: 'Flame Thrower', flags: {'swade-tools': {aoeEnabled: true}}},
        {...f.item, name: 'Fragmentation Grenade'},
        {...f.item, type: 'power', system: {templates: {cone: true}}},
        {...f.item, type: 'power', flags: {'swade-tools': {aoeEnabled: true}}},
        {...f.item, type: 'gear'}, null
    ]) assert.equal(api.canUsePropertiesCombat(item, {}, f.runtime), false);
    const exclusions = ['powerAoe', 'aoeFireDamage', 'aoeFire', 'aoeAttack', 'aoeArea'];
    for (const key of exclusions) {
        for (const flags of [{[key]: true}, {'swade-tools': {[key]: true}}, {flags: {'swade-tools': {[key]: true}}}]) {
            assert.equal(api.canUsePropertiesCombat(f.item, flags, f.runtime), false, `${key} in wrapper`);
        }
    }
    for (const flags of [{world: {aoeAttack: true}}, {flags: {world: {aoeAttack: true}}}]) assert.equal(api.canUsePropertiesCombat(f.item, flags, f.runtime), false);
    assert.equal(api.canUsePropertiesCombat({...f.item, name: 'Grenade Launcher', flags: {'swade-tools': {aoeEnabled: false}}}, {}, f.runtime), true);
});

test('attack type resolves localized skill, skill ID and native SWID without a global game', async () => {
    const api = await load(), f = fixture();
    const fighting = {id: 'fight-id', type: 'skill', name: 'Dövüş', system: {swid: 'fighting'}};
    f.actor.items.push(fighting); f.settings.fightingSkill = 'Dövüş';
    for (const skill of ['Dövüş', 'fight-id', 'fighting', ' FIGHTING ']) assert.equal(api.propertyAttackType(f.actor, f.item, skill, f.runtime), 'melee');
    assert.equal(api.propertyAttackType(f.actor, f.item, 'Shooting', f.runtime), 'ranged');
    f.item.system.actions.trait = 'fight-id';
    assert.equal(api.propertyAttackType(f.actor, f.item, undefined, f.runtime), 'melee');
    assert.equal(api.propertyAttackType({items: []}, f.item, 'Dövüş', f.runtime), 'melee');
});

test('incoming melee and ranged modifiers use the inferred attack type and never the attacker defense', async () => {
    const api = await load(), f = fixture();
    f.library.assignments[f.defense.uuid] = [{id: 'ranged', action: 'incomingRanged', value: -2}, {id: 'melee', action: 'incomingMelee', value: -4}];
    const attackerDefense = {uuid: 'Actor.attacker.Item.defense', type: 'edge'}; f.actor.items.push(attackerDefense);
    f.library.assignments[attackerDefense.uuid] = [{id: 'attacker', action: 'incomingRanged', value: -10}];
    assert.equal(api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: f.target}, f.runtime).incoming, -2);
    f.item.system.actions.trait = 'Fighting';
    assert.equal(api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: {actor: f.target}}, f.runtime).incoming, -4);
    assert.equal(api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: f.target, attackType: 'ranged'}, f.runtime).incoming, -2);
});

test('cover is strongest-only while direct incoming modifiers remain a separate rule type', async () => {
    const api = await load(), f = fixture();
    f.library.assignments[f.defense.uuid] = [
        {id: 'dodge-like', action: 'cover', value: -2, group: 'cover', stack: 'best'},
        {id: 'shield-like', action: 'cover', value: -4, group: 'cover', stack: 'best'},
        {id: 'incoming', action: 'incomingRanged', value: -2}
    ];
    const result = api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: f.target}, f.runtime);
    assert.equal(result.cover, -4); assert.equal(result.incoming, -2);
    assert.equal(result.applied.filter(rule => rule.action === 'cover').length, 1);
    assert.equal(result.ignored.filter(rule => rule.action === 'cover').length, 1);
    // Legacy Dodge/equipped cover joins the caller's same best-only policy,
    // not an additive -2 on top of this -4.
    assert.equal(Math.min(result.cover, -2), -4);
});

test('target-dependent attack bonuses are deltas only, not a duplicate of the shared pool', async () => {
    const api = await load(), f = fixture();
    f.library.assignments[f.item.uuid] = [
        {id: 'common', action: 'attackMod', value: 1},
        {id: 'close', action: 'attackMod', value: 2, conditions: {maxRange: 12}}
    ];
    const common = api.getPropertyCombatModifiers({actor: f.actor, item: f.item}, f.runtime);
    assert.equal(common.totals.attackMod, 1);
    for (const [range, expected] of [[8, 2], [12, 2], [15, 0]]) {
        const result = api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: f.target, range}, f.runtime);
        assert.equal(result.attackDelta, expected); assert.equal(common.totals.attackMod + result.attackDelta, range <= 12 ? 3 : 1);
    }
    assert.equal(api.getPropertyTargetModifiers({actor: f.actor, item: f.item, target: f.target}, f.runtime).attackDelta, 0);
});

test('context opt-out is retained even when the underlying weapon is not AoE flagged', async () => {
    const api = await load(), f = fixture(); f.library.assignments[f.item.uuid] = [{id: 'attack', value: 2}];
    for (const extra of [{isAoe: true}, {isAoE: true}, {aoe: true}, {attackType: 'aoe'}]) assert.equal(api.getPropertyCombatModifiers({actor: f.actor, item: f.item, ...extra}, f.runtime).enabled, false);
});

test('minimum Strength die steps modify only the effective calculator and honor the d4 floor', async () => {
    const api = await load(), f = fixture();
    f.actor.system = {attributes: {strength: {die: {sides: 6, modifier: 0}}}};
    f.library.assignments[f.item.uuid] = [{id: 'strength', action: 'minStrengthSteps', value: 2}];
    assert.equal(api.getPropertyStrength(6, f.actor, f.item, {}, f.runtime), 10);
    assert.equal(f.actor.system.attributes.strength.die.sides, 6);
    f.library.assignments[f.item.uuid][0].value = -5;
    assert.equal(api.getPropertyStrength(6, f.actor, f.item, {}, f.runtime), 4);
    assert.equal(api.getPropertyStrength(8, f.actor, f.item, {aoeAttack: true}, f.runtime), 8);
});

test('native Brawny/Soldier properties are not counted twice, but distinct custom sources still work', async () => {
    const api = await load(), f = fixture();
    const brawny = {uuid: 'Actor.attacker.Item.brawny', type: 'edge', name: 'Brawny', system: {swid: 'brawny'}};
    const soldier = {uuid: 'Actor.attacker.Item.soldier', type: 'edge', name: 'Soldier', system: {swid: 'soldier'}};
    const custom = {uuid: 'Actor.attacker.Item.custom', type: 'edge', name: 'Campaign Heavy Weapon Training'};
    f.actor.items.push(brawny, soldier, custom);
    for (const source of [brawny, soldier]) f.library.assignments[source.uuid] = [{id: `${source.name}-property`, action: 'minStrengthSteps', value: 2, stack: 'best', group: 'minimum-strength'}];
    f.library.assignments[custom.uuid] = [{id: 'custom', action: 'minStrengthSteps', value: 1, stack: 'best', group: 'minimum-strength'}];
    assert.equal(api.getPropertyStrength(10, f.actor, f.item, {}, f.runtime), 12, 'base already included Brawny and Soldier; native properties must not hide custom weaker value');
    brawny.name = 'Büyük'; delete brawny.system.swid; f.settings.BrawnySetting = 'Büyük';
    soldier.name = 'Renamed Edge';
    assert.equal(api.getPropertyStrength(8, f.actor, f.item, {}, f.runtime), 12,
        'single fire did not count the renamed Soldier; its custom property must still work');
    custom.type = 'ability';
    assert.equal(api.getPropertyStrength(10, f.actor, f.item, {}, {...f.runtime,nativeStrengthSources:[brawny.uuid,soldier.uuid]}), 12,
        'RoF supplies the exact SWID/Ability sources its base already counted');
});

test('a renamed SWID Ability can mimic minimum Strength without being mistaken for a native single-fire bonus',async()=>{
    const api=await load(),f=fixture();
    const source={uuid:'Actor.attacker.Item.training',type:'ability',name:'Campaign Training',system:{swid:'brawny'}};
    f.actor.items.push(source);
    f.library.assignments[source.uuid]=[{id:'training',action:'minStrengthSteps',value:1}];
    assert.equal(api.getPropertyStrength(6,f.actor,f.item,{},f.runtime),8);
    assert.equal(api.getPropertyStrength(8,f.actor,f.item,{}, {...f.runtime,nativeStrengthSources:[source.uuid]}),8);
});

test('Soak properties come from the target bearer and do not import the attacking weapon attachment', async () => {
    const api = await load(), f = fixture();
    f.library.assignments[f.item.uuid] = [{id: 'weapon-soak', action: 'soakMod', value: 20}];
    f.library.assignments[f.defense.uuid] = [{id: 'target-soak', action: 'soakMod', value: 2}];
    assert.equal(api.getPropertySoakModifier(f.target, f.item, {}, f.runtime), 2);
    assert.equal(api.getPropertySoakModifier(f.target, f.item, {aoeFireDamage: true}, f.runtime), 0);
    assert.equal(api.getPropertySoakModifier(f.target, {...f.item, flags: {'swade-tools': {aoeEnabled: true}}}, {}, f.runtime), 0);
});
