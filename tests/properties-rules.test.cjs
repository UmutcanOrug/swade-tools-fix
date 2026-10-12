const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesRules.js')).href);
const fixture = (enabled = true) => {
    const state = {version: 1, presets: [], assignments: {}};
    const runtime = {game: {settings: {get(scope, key) { assert.equal(scope, 'swade-tools'); return key === 'propertiesEnabled' ? enabled : state; }}}};
    const actor = {uuid: 'Actor.attacker', items: []};
    const item = {uuid: 'Actor.attacker.Item.rifle', name: 'Rifle', type: 'weapon', system: {equipStatus: 3}};
    actor.items.push(item);
    return {state, runtime, actor, item};
};

test('properties are opt-in and fail closed when settings are missing or malformed', async () => {
    const {isPropertiesEnabled, evaluatePropertyModifiers, collectPropertyRules} = await load();
    assert.equal(isPropertiesEnabled({game: {}}), false);
    assert.equal(isPropertiesEnabled({game: {settings: {get() { throw new Error(); }}}}), false);
    const f = fixture(false); f.state.assignments[f.item.uuid] = [{action: 'attackMod', value: 20}];
    assert.deepEqual(collectPropertyRules(f.actor, f.item, f.runtime), []);
    assert.equal(evaluatePropertyModifiers({actor: f.actor, item: f.item}, f.runtime).totals.attackMod, 0);
    for (const value of [1, 'true', {}, undefined]) assert.equal(isPropertiesEnabled({game: {settings: {get: () => value}}}), false);
});

test('rule schema supplies bounded typed defaults and rejects code, paths and unsupported behaviors', async () => {
    const {normalizeRule, validateRules} = await load();
    const rule = normalizeRule({id: 'custom.attack', action: 'attackMod', value: 2});
    assert.equal(rule.version, 1); assert.equal(rule.trigger, 'passive'); assert.equal(rule.enabled, true);
    assert.deepEqual(rule.conditions, {attackType: 'any', weaponType: 'any'});
    assert.equal(rule.resist.enabled, false);
    for (const raw of [
        {action: 'grantEdge', edgeUuid: 'Item.edge'}, {version: 2}, {code: 'actor.update({})'},
        {action: 'statModifier', stat: 'system.attributes.strength'}, {action: 'attackMod', value: Infinity},
        {action: 'attackMod', value: '2'}, {action: 'traitSteps', value: 9}, {action: 'skillModifier', skill: 'Shooting}[system.die.sides]'},
        {action: 'status', status: '<script>'}, {action: 'attackMod', conditions: {expression: 'true'}},
        {duration: {rounds: 101}}, {resist: {tn: 0}}, {trigger: 'hit', action: 'attackMod'},
        JSON.parse('{"__proto__":{"admin":true}}')
    ]) assert.throws(() => normalizeRule(raw));
    assert.throws(() => validateRules([{id: 'same'}, {id: 'same'}]), /Duplicate/);
    assert.throws(() => validateRules(Array.from({length: 101}, () => ({}))), /100/);
    assert.throws(() => normalizeRule(Object.create({action: 'attackMod'})), /plain object/);
});

test('native passive effects are self-only and cannot silently apply attack conditions globally', async () => {
    const {normalizeRule} = await load();
    const rule = normalizeRule({action: 'traitSteps', trigger: 'passive', target: 'self', trait: 'strength', value: 1});
    assert.equal(rule.trigger, 'passive');
    for (const extra of [{target: 'target'}, {conditions: {attackType: 'ranged'}}, {conditions: {maxRange: 12}}, {resist: {enabled: true}}, {duration: {rounds: 2}}]) {
        assert.throws(() => normalizeRule({action: 'traitSteps', trigger: 'passive', value: 1, ...extra}));
    }
});

test('Automatic Accept is typed, opt-in and only retained for hit or raise effect rules', async () => {
    const {normalizeRule} = await load();
    assert.equal(normalizeRule({action: 'traitSteps', value: -1}).automaticAccept, false);
    for (const trigger of ['hit', 'raise']) {
        const rule = normalizeRule({action: 'traitSteps', value: -1, trigger, automaticAccept: true, automaticAcceptSince: 123});
        assert.equal(rule.automaticAccept, true); assert.equal(rule.automaticAcceptSince, 123);
    }
    for (const trigger of ['passive', 'damageApplied', 'wound']) {
        const rule = normalizeRule({action: 'traitSteps', value: -1, trigger, automaticAccept: true, automaticAcceptSince: 123});
        assert.equal(rule.automaticAccept, false); assert.equal(rule.automaticAcceptSince, 0);
    }
    assert.equal(normalizeRule({action: 'attackMod', value: 2, automaticAccept: true}).automaticAccept, false);
    for (const automaticAccept of ['true', 1, {}, null]) assert.throws(() => normalizeRule({automaticAccept}), /Automatic Accept/);
    assert.throws(() => normalizeRule({automaticAccept: true, code: 'actor.update({})'}), /unsupported field/);
    assert.equal(normalizeRule({action: 'traitSteps', value: -1, automaticAccept: true}).automaticAcceptSince, 0);
    assert.equal(normalizeRule({action: 'traitSteps', value: -1, automaticAccept: false, automaticAcceptSince: 123}).automaticAcceptSince, 0);
    for (const automaticAcceptSince of ['123', -1, 1.5, NaN, Infinity, 8640000000000001]) {
        assert.throws(() => normalizeRule({automaticAcceptSince}), /Activation/);
    }
});

test('collector trusts only exact GM world assignments, not arbitrary item flags or prototype keys', async () => {
    const {collectPropertyRules} = await load();
    const f = fixture(); f.item.flags = {'swade-tools': {properties: [{action: 'attackMod', value: 20}]}};
    assert.equal(collectPropertyRules(f.actor, f.item, f.runtime).length, 0);
    f.state.assignments[f.item.uuid] = [{id: 'approved', action: 'attackMod', value: 2}];
    const rules = collectPropertyRules(f.actor, f.item, f.runtime);
    assert.equal(rules.length, 1); assert.equal(rules[0].value, 2); assert.equal(rules[0].sourceUuid, f.item.uuid);
    assert.equal(rules[0].sourceName, 'Rifle');
    f.state.assignments[f.item.uuid] = [{id: 'bad', action: 'javascript'}];
    assert.equal(collectPropertyRules(f.actor, f.item, f.runtime).length, 0);
    f.state.version = 2;
    assert.equal(collectPropertyRules(f.actor, f.item, f.runtime).length, 0);
});

test('collector handles readied physical items, suppressed edges and synthetic actors without offensive leakage', async () => {
    const {collectPropertyRules} = await load();
    const f = fixture();
    const edge = {uuid: 'Actor.attacker.Item.edge', type: 'edge'}, offhand = {uuid: 'Actor.attacker.Item.pistol', type: 'weapon', system: {equipStatus: 3}};
    const armor = {uuid: 'Actor.attacker.Item.armor', type: 'armor', system: {equipStatus: 2}};
    const suppressed = {uuid: 'Actor.attacker.Item.suppressed', type: 'ability', isSuppressed: true};
    f.actor.items.push(edge, offhand, armor, suppressed);
    f.state.assignments[edge.uuid] = [{id: 'edge', action: 'attackMod', value: 1}];
    f.state.assignments[offhand.uuid] = [{id: 'offense', action: 'attackMod', value: 9}, {id: 'defense', action: 'cover', value: -2}];
    f.state.assignments[armor.uuid] = [{id: 'armor', action: 'soakMod', value: 2}];
    f.state.assignments[suppressed.uuid] = [{id: 'suppressed', action: 'attackMod', value: 20}];
    const rules = collectPropertyRules(f.actor, f.item, f.runtime);
    assert.deepEqual(rules.map(rule => rule.id), ['edge', 'defense']);
    armor.system.equipStatus = 3;
    assert.equal(collectPropertyRules(f.actor, f.item, f.runtime).some(rule => rule.id === 'armor'), true);
    const synthetic = {uuid: 'Scene.scene.Token.target.Actor.actor.Item.edge', type: 'edge'};
    f.state.assignments[synthetic.uuid] = [{id: 'synthetic', action: 'cover', value: -4}];
    assert.equal(collectPropertyRules({items: new Map([[1, synthetic]])}, null, f.runtime)[0].sourceUuid, synthetic.uuid);
});

test('passive ledger keeps per-target defenses separate from shared outgoing modifiers', async () => {
    const {evaluatePropertyModifiers} = await load();
    const f = fixture(); f.state.assignments[f.item.uuid] = [{id: 'attack', action: 'attackMod', value: 1}, {id: 'damage', action: 'damageMod', value: 2}];
    const attackerEdge = {uuid: 'Actor.attacker.Item.edge', type: 'edge'};
    f.actor.items.push(attackerEdge); f.state.assignments[attackerEdge.uuid] = [{id: 'self-defense', action: 'incomingRanged', value: -10}];
    const targetEdge = {uuid: 'Actor.defender.Item.edge', type: 'edge'};
    const defender = {uuid: 'Actor.defender', items: [targetEdge]};
    f.state.assignments[targetEdge.uuid] = [{id: 'target-defense', action: 'incomingRanged', value: -2}, {id: 'cover', action: 'cover', value: -4}];
    const result = evaluatePropertyModifiers({actor: f.actor, item: f.item, target: {actor: defender}, attackType: 'ranged'}, f.runtime);
    assert.equal(result.totals.attackMod, 1); assert.equal(result.totals.damageMod, 2);
    assert.equal(result.totals.incomingRanged, -2); assert.equal(result.totals.cover, -4);
    assert.equal(result.contributions.some(rule => rule.id === 'self-defense'), false);
    assert.equal(evaluatePropertyModifiers({actor: f.actor, item: f.item, target: defender, attackType: 'melee'}, f.runtime).totals.cover, 0);
});

test('on-hit Edge and ability rules follow their bearer but another weapon on-hit rule does not', async () => {
    const {collectPropertyRules} = await load();
    const f = fixture();
    const edge = {uuid: 'Actor.attacker.Item.edge', type: 'edge'}, offhand = {uuid: 'Actor.attacker.Item.offhand', type: 'weapon', system: {equipStatus: 3}};
    f.actor.items.push(edge, offhand);
    f.state.assignments[edge.uuid] = [{id: 'edge-hit', action: 'status', status: 'distracted', trigger: 'hit'}];
    f.state.assignments[offhand.uuid] = [{id: 'weapon-hit', action: 'status', status: 'stunned', trigger: 'hit'}];
    assert.deepEqual(collectPropertyRules(f.actor, f.item, f.runtime).map(rule => rule.id), ['edge-hit']);
});

test('typed stacking sums additions but best/unique families do not duplicate', async () => {
    const {evaluatePropertyModifiers} = await load();
    const f = fixture();
    f.state.assignments[f.item.uuid] = [
        {id: 'a', action: 'attackMod', value: 1, group: 'sum'}, {id: 'b', action: 'attackMod', value: 2, group: 'sum'},
        {id: 'c', action: 'damageMod', value: 2, group: 'best', stack: 'best'}, {id: 'd', action: 'damageMod', value: 4, group: 'best', stack: 'best'},
        {id: 'e', action: 'cover', value: -2, group: 'cover', stack: 'best'}, {id: 'f', action: 'cover', value: -4, group: 'cover', stack: 'best'},
        {id: 'g', action: 'soakMod', value: 2, group: 'soak', stack: 'unique'}, {id: 'h', action: 'soakMod', value: 2, group: 'soak', stack: 'unique'}
    ];
    const result = evaluatePropertyModifiers({actor: f.actor, item: f.item, attackType: 'ranged'}, f.runtime);
    assert.equal(result.totals.attackMod, 3); assert.equal(result.totals.damageMod, 4); assert.equal(result.totals.cover, -4); assert.equal(result.totals.soakMod, 2);
    assert.equal(result.ignored.length, 3); assert.match(result.ignored[0].reason, /Not stacked/);
    assert.equal(result.applied.length + result.ignored.length, result.contributions.length);
});

test('range and item conditions fail safely when unknown and respect inclusive bounds', async () => {
    const {normalizeRule, getPropertyConditionResult} = await load();
    const rule = normalizeRule({conditions: {attackType: 'ranged', weaponType: 'weapon', minRange: 12, maxRange: 24}});
    for (const range of [12, 15, 24]) assert.equal(getPropertyConditionResult(rule, {attackType: 'ranged', item: {type: 'weapon'}, range}).matches, true);
    for (const range of [11.9, 24.1, NaN, undefined]) assert.equal(getPropertyConditionResult(rule, {attackType: 'ranged', item: {type: 'weapon'}, range}).matches, false);
    assert.equal(getPropertyConditionResult(rule, {attackType: 'melee', item: {type: 'weapon'}, range: 15}).matches, false);
    assert.equal(getPropertyConditionResult(rule, {attackType: 'ranged', item: {type: 'power'}, range: 15}).matches, false);
});

test('AoE and Fire routes are explicitly excluded and effects never enter numeric totals twice', async () => {
    const {evaluatePropertyModifiers} = await load();
    const f = fixture(); f.state.assignments[f.item.uuid] = [
        {id: 'attack', action: 'attackMod', value: 2},
        {id: 'weaken', action: 'traitSteps', trigger: 'hit', trait: 'strength', value: -1},
        {id: 'native', action: 'statModifier', trigger: 'passive', target: 'self', stat: 'armor', value: 2}
    ];
    for (const extra of [{isAoe: true}, {isAoE: true}, {aoe: true}, {attackType: 'aoe'}]) {
        const result = evaluatePropertyModifiers({actor: f.actor, item: f.item, ...extra}, f.runtime);
        assert.equal(result.enabled, false); assert.equal(result.totals.attackMod, 0);
    }
    const result = evaluatePropertyModifiers({actor: f.actor, item: f.item}, f.runtime);
    assert.equal(result.totals.attackMod, 2); assert.equal(result.ignored.length, 2);
    assert.match(result.ignored[0].reason, /preview does not execute/); assert.match(result.ignored[1].reason, /not added again/);
    assert.equal(Object.values(result.totals).every(Number.isFinite), true);
});
