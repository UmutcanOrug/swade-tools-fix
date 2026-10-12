const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesRollIntegration.js')).href);
const fixture = () => {
    const gm = {id: 'a-gm', isGM: true, active: true}, player = {id: 'player', isGM: false, active: true};
    const actor = {uuid: 'Actor.attacker', items: [], update() {throw new Error('Actor must not be written during staging.');}};
    const targetActor = {uuid: 'Actor.target', update() {throw new Error('Target must not be written during staging.');}};
    const item = {uuid: 'Actor.attacker.Item.rifle', actor, type: 'weapon', name: 'Rifle', system: {actions: {trait: 'Shooting'}}};
    const token = (id, actor) => ({id, actor, document: {uuid: `Scene.scene.Token.${id}`, actor}});
    const source = token('source', actor), target = token('target', targetActor), other = token('other', {uuid: 'Actor.other'});
    const calls = [], lookups = [];
    const runtime = {
        game: {user: gm, users: new Map([[gm.id, gm], [player.id, player]]), settings: {get: (_scope, key) => key === 'propertiesEnabled'}},
        canvas: {scene: {id: 'scene'}, tokens: new Map([[source.id, source], [target.id, target], [other.id, other]])},
        async fromUuid(uuid) {lookups.push(uuid); return uuid === actor.uuid ? actor : uuid === item.uuid ? item : null;},
        async registerPropertyCandidate(input) {calls.push(input);}
    };
    const assignment = (hitKey, total = 5, targetToken = target) => ({
        hitKey, total, modifier: 0, outcome: total >= 8 ? 'raise' : total >= 4 ? 'hit' : 'miss', attackType: 'ranged', range: 12,
        targetUuid: targetToken.document.uuid, targetActorUuid: targetToken.actor.uuid
    });
    const message = {id: 'attack', author: player, rolls: [{total: 5}], flags: {'swade-tools': {propertiesPool: {
        version: 1, actorUuid: actor.uuid, itemUuid: item.uuid, sourceTokenUuid: source.document.uuid,
        assignments: [assignment('skill-0'), assignment('skill-1', 9), assignment('wild-die', 2, other)]
    }}}};
    return {gm, player, actor, targetActor, item, source, target, other, calls, lookups, runtime, message, assignment};
};

test('RoF staging uses distinct stable usable-die keys including multiple hits into the same target', async () => {
    const {stagePropertyPool} = await load(), f = fixture();
    await stagePropertyPool(f.message, f.runtime);
    assert.deepEqual(f.calls.map(input => input.hitKey), ['skill-0', 'skill-1', 'wild-die']);
    assert.deepEqual(f.calls.map(input => input.outcome), ['hit', 'raise', 'miss']);
    assert.equal(f.calls[0].target, f.target); assert.equal(f.calls[1].target, f.target); assert.equal(f.calls[2].target, f.other);
    assert.equal(f.calls[0].range, 12); assert.equal(f.calls[0].actor, f.actor); assert.equal(f.calls[0].item, f.item);
    assert.equal(f.calls[0].attackType, 'ranged');
});

test('only the primary active GM stages a RoF pool; players and other GMs cannot write candidates', async () => {
    const {stagePropertyPool} = await load(), f = fixture();
    f.runtime.game.user = f.player;
    await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
    const secondary = {id: 'z-gm', isGM: true, active: true};
    f.runtime.game.users.set(secondary.id, secondary); f.runtime.game.user = secondary;
    await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
    f.gm.active = false;
    await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 3);
});

test('staging rejects duplicate hit keys and oversized or unversioned pool metadata', async () => {
    const {stagePropertyPool} = await load();
    for (const mutation of [
        pool => {pool.assignments[1].hitKey = pool.assignments[0].hitKey;},
        pool => {pool.assignments[0].hitKey = '';},
        pool => {pool.version = 2;},
        pool => {pool.assignments = Array.from({length: 7}, (_, index) => ({hitKey: `skill-${index}`}));},
        pool => {pool.assignments = {};}
    ]) {
        const f = fixture(); mutation(f.message.flags['swade-tools'].propertiesPool);
        await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
    }
});

test('staging refuses wrong scenes, swapped source actors and replaced target actors', async () => {
    const {stagePropertyPool} = await load();
    for (const mutation of [
        f => {f.runtime.canvas.scene.id = 'different';},
        f => {f.source.actor = {uuid: 'Actor.replaced'};},
        f => {f.source.document.uuid = 'Scene.other.Token.source';}
    ]) {
        const f = fixture(); mutation(f); await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.target.actor = {uuid: 'Actor.replaced'};
    await stagePropertyPool(f.message, f.runtime);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].target, f.other);
});

test('stored outcomes must match finite pool arithmetic; invalid rows cannot stage effects', async () => {
    const {stagePropertyPool} = await load(), f = fixture();
    f.message.flags['swade-tools'].propertiesPool.assignments[0].outcome = 'raise';
    f.message.flags['swade-tools'].propertiesPool.assignments[1].modifier = NaN;
    f.message.flags['swade-tools'].propertiesPool.assignments[2].total = Infinity;
    await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 0);
});

test('feature-disabled and AoE/Flame pools stage no candidates and never touch actors', async () => {
    const {stagePropertyPool} = await load();
    for (const mutation of [
        f => {f.runtime.game.settings.get = () => false;},
        f => {f.item.flags = {'swade-tools': {aoeEnabled: true}};},
        f => {f.message.flags['swade-tools'].aoeFireDamage = {version: 1};},
        f => {f.message.flags['swade-tools'].powerAoe = true;}
    ]) {
        const f = fixture(); mutation(f); await stagePropertyPool(f.message, f.runtime); assert.equal(f.calls.length, 0);
    }
});

test('fresh native outcome adapter recalculates GM corrections rather than trusting the staged outcome', async () => {
    const {resolveCurrentPropertyCandidate} = await load(), f = fixture();
    const flags = f.message.flags['swade-tools']; delete flags.propertiesPool; flags.rolltype = 'skill'; flags.userof = 1; flags.gmmod = 4;
    f.message.rolls[0].total = 3;
    const entry = {targetUuid: f.target.document.uuid, targetActorUuid: f.targetActor.uuid, hitKey: '1', outcome: 'miss'};
    const constructions = [], calculations = [];
    class Control {
        constructor(message, html, author) {constructions.push({message, html, author}); this.propertiesInputs = [];}
        isCritical() {return false;}
        attackTarget(target, total, hitKey) {
            calculations.push({target, total, hitKey, gmmod: this.gmmod});
            this.propertiesInputs.push({target, outcome: total + this.gmmod >= 8 ? 'raise' : total + this.gmmod >= 4 ? 'hit' : 'miss'});
        }
    }
    const input = {message: f.message, actor: f.actor, item: f.item, target: f.target.document, entry};
    f.target.document.object = f.target;
    assert.deepEqual(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), {outcome: 'hit'});
    flags.gmmod = 8;
    assert.deepEqual(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), {outcome: 'raise'});
    flags.gmmod = 0;
    assert.deepEqual(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), {outcome: 'miss'});
    assert.equal(constructions[0].html, null); assert.equal(constructions[0].author, f.player);
    assert.deepEqual(calculations[0], {target: f.target, total: 3, hitKey: 1, gmmod: 4});
});

test('native outcome preview rejects criticals, wrong target identity, multi-RoF legacy and non-skill cards', async () => {
    const {resolveCurrentPropertyCandidate} = await load(), f = fixture();
    const flags = f.message.flags['swade-tools']; delete flags.propertiesPool; flags.rolltype = 'skill'; flags.userof = 1;
    const entry = {targetUuid: f.target.document.uuid, targetActorUuid: f.targetActor.uuid, hitKey: '1'};
    const input = {message: f.message, actor: f.actor, item: f.item, target: f.target.document, entry};
    let attacks = 0;
    class Control {constructor() {this.propertiesInputs = [];} isCritical() {return true;} attackTarget() {attacks++;}}
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), null);
    flags.userof = 3;
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), null);
    flags.userof = 1; flags.rolltype = 'damage';
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), null);
    flags.rolltype = 'skill'; input.entry = {...entry, targetActorUuid: 'Actor.replaced'};
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), null);
    input.entry = entry; f.message.rolls = [];
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Control}), null);
    assert.equal(attacks, 0);
});

test('fresh RoF lookup binds exact target actor and usable-die identity without native single-shot calculation', async () => {
    const {resolveCurrentPropertyCandidate} = await load(), f = fixture();
    const entry = {targetUuid: f.target.document.uuid, targetActorUuid: f.targetActor.uuid, hitKey: 'skill-1'};
    const input = {message: f.message, actor: f.actor, item: f.item, target: f.target.document, entry};
    class Forbidden {constructor() {throw new Error('A multi-RoF pool cannot use the native single-shot calculator.');}}
    assert.deepEqual(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Forbidden}), {outcome: 'raise'});
    input.entry = {...entry, hitKey: 'wild-die'};
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Forbidden}), null);
    input.entry = entry; f.message.flags['swade-tools'].propertiesPool.assignments[1].outcome = 'hit';
    assert.equal(resolveCurrentPropertyCandidate(input, {...f.runtime, RollControlClass: Forbidden}), null);
});

test('RoF render hook is registered once and only stages review metadata, never actor effects', async () => {
    const {registerPropertiesPoolControls} = await load(), f = fixture();
    const handlers = [], runtime = {...f.runtime, Hooks: {on(name, callback) {handlers.push({name, callback});}}};
    registerPropertiesPoolControls(runtime); registerPropertiesPoolControls(runtime);
    assert.equal(handlers.length, 1); assert.equal(handlers[0].name, 'renderChatMessageHTML');
    const inserted = [], html = {querySelector() {return true;}, insertAdjacentHTML(...args) {inserted.push(args);}};
    handlers[0].callback(f.message, html);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 3); assert.equal(inserted.length, 0);
});

test('production RoF staging persists only trusted GM review metadata and no actor effects', async () => {
    const {stagePropertyPool} = await load(), f = fixture();
    delete f.runtime.registerPropertyCandidate;
    f.runtime.canvasRef = f.runtime.canvas;
    f.runtime.game.scenes = new Map([['scene', {tokens: new Map([[f.target.id, f.target.document], [f.other.id, f.other.document]])}]]);
    f.runtime.game.messages = new Map([[f.message.id, f.message]]);
    f.actor.ownership = {[f.player.id]: 3};
    const data = {
        propertiesEnabled: true,
        propertiesLibrary: {version: 1, presets: [], assignments: {[f.item.uuid]: [{id: 'distract', action: 'status', status: 'distracted', trigger: 'hit'}]}},
        propertiesEventLedger: {version: 1, candidates: {}, events: {}}
    };
    let writes = 0;
    f.runtime.game.settings = {get: (_scope, key) => data[key], async set(_scope, key, value) {assert.equal(key, 'propertiesEventLedger'); data[key] = structuredClone(value); writes++;}};
    f.message.update = async update => {if (update['flags.swade-tools.propertiesCandidates']) f.message.flags['swade-tools'].propertiesCandidates = update['flags.swade-tools.propertiesCandidates'];};
    await stagePropertyPool(f.message, f.runtime);
    assert.equal(Object.keys(data.propertiesEventLedger.candidates).length, 3);
    assert.equal(Object.keys(data.propertiesEventLedger.events).length, 0);
    assert.deepEqual(Object.values(data.propertiesEventLedger.candidates).map(entry => entry.status), ['pending', 'pending', 'ineligible']);
    const before = writes;
    await stagePropertyPool(f.message, f.runtime);
    assert.equal(writes, before, 'rendering the same pool does not repeatedly write or reroll');
});

test('pool serialization uses actual stable skill/wild IDs even when assigned order changes', async () => {
    const combat = await import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesCombat.js')).href);
    const f = fixture(), previous = globalThis.game;
    try {
        globalThis.game = f.runtime.game;
        const assignments = [
            {result: {id: 'wild-die', total: 8}, targetToken: f.target, targetProfile: {total: -2, distance: 12}, outcome: 'hit'},
            {result: {id: 'skill-0', total: 6}, targetToken: f.target, targetProfile: {total: -2, distance: 12}, outcome: 'hit'},
            {result: {id: 'skill-2', total: 10}, targetToken: f.other, targetProfile: {total: -2, distance: 15}, outcome: 'raise'}
        ];
        const pool = combat.propertyPoolData({actor: f.actor, item: f.item, token: f.source, assignments});
        assert.deepEqual(pool.assignments.map(entry => entry.hitKey), ['wild-die', 'skill-0', 'skill-2']);
        assert.equal(new Set(pool.assignments.map(entry => entry.hitKey)).size, 3);
        assert.equal(pool.assignments[0].targetUuid, pool.assignments[1].targetUuid);
        assert.equal(pool.assignments[2].range, 15); assert.equal(pool.assignments[2].modifier, -2);
    } finally {if (previous === undefined) delete globalThis.game; else globalThis.game = previous;}
});
