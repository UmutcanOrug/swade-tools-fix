const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesEffects.js')).href);
const rules = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesRules.js')).href);
const chatService = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesChat.js')).href);
const clone = value => JSON.parse(JSON.stringify(value));

const setPath = (object, path, value) => {
    const keys = path.split('.'); let current = object;
    for (const key of keys.slice(0, -1)) current = current[key] ??= {};
    current[keys.at(-1)] = value;
};
const fixture = async (overrides = {}) => {
    const api = await service, core = await rules, calls = {create: [], delete: [], updates: [], rolls: 0, cards: 0};
    const actor = {id: 'attacker', uuid: 'Actor.attacker', name: 'Attacker', type: 'character',
        ownership: {player: 3}, items: new Map(), effects: new Map(), statuses: new Set(),
        system: {attributes: {vigor: {die: {sides: 6, modifier: 0}}}}};
    const victim = {id: 'victim', uuid: 'Scene.scene.Token.target.Actor.victim', name: 'Victim', type: 'character',
        items: new Map(), effects: new Map(), statuses: new Set(), isWildcard: true,
        system: {attributes: {vigor: {die: {sides: 6, modifier: 0}}, strength: {die: {sides: 8, modifier: 0}}}}};
    const item = {id: 'weapon', uuid: 'Actor.attacker.Item.weapon', name: 'Test Weapon', type: 'weapon', actor,
        system: {equipStatus: 3}}; actor.items.set(item.id, item);
    let effectId = 0;
    for (const owner of [actor, victim]) {
        owner.createEmbeddedDocuments = async (type, data) => {
            assert.equal(type, 'ActiveEffect'); calls.create.push([owner.uuid, clone(data)]);
            return data.map(raw => {
                const effect = {...clone(raw), id: `effect${++effectId}`, active: true, parent: owner,
                    async update(update) {calls.updates.push(clone(update));
                        for (const [key, value] of Object.entries(update)) key.includes('.') ? setPath(this, key, clone(value)) : this[key] = clone(value);
                        this.active = !this.disabled;}};
                owner.effects.set(effect.id, effect); return effect;
            });
        };
        owner.updateEmbeddedDocuments = async (type, updates) => {
            assert.equal(type, 'ActiveEffect');
            for (const update of updates) await owner.effects.get(update._id).update(update);
        };
        owner.deleteEmbeddedDocuments = async (type, ids) => {
            assert.equal(type, 'ActiveEffect'); calls.delete.push([owner.uuid, ids]);
            ids.forEach(id => owner.effects.delete(id));
        };
    }
    const target = {id: 'target', uuid: 'Scene.scene.Token.target', name: 'Victim Token', actor: victim};
    const token = {id: target.id, document: target, actor: victim};
    const scene = {id: 'scene', tokens: new Map([[target.id, target]])};
    const gm = {id: 'gm', isGM: true, active: true}, player = {id: 'player', isGM: false, active: true};
    const rule = core.normalizeRule({id: 'weakening', name: 'Weakening', action: 'traitSteps', trigger: 'hit',
        trait: 'strength', value: -1, stack: 'unique', duration: {rounds: 2, expiry: 'turnEnd'}, ...overrides});
    const settings = {propertiesEnabled: true, propertiesLibrary: {version: 1, assignments: {[item.uuid]: [rule]}},
        propertiesEventLedger: {version: 1, candidates: {}, events: {}}};
    const message = {id: 'attack', timestamp: 100, user: 'player', flags: {'swade-tools': {itemroll: item.id}}, isContentVisible: true,
        rolls: [{total: 8, formula: '1d8x+2', _evaluated: true, terms: [{total: 8}]}],
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    const game = {user: gm, users: new Map([[gm.id, gm], [player.id, player]]),
        settings: {get: (_scope, key) => settings[key], set: async (_scope, key, value) => {settings[key] = clone(value);}},
        actors: new Map([[actor.id, actor]]), scenes: new Map([[scene.id, scene]]), messages: new Map([[message.id, message]]),
        time: {worldTime: 100}, combat: {id: 'combat', round: 2, turn: 0}};
    const documents = new Map([[actor.uuid, actor], [item.uuid, item], [victim.uuid, victim], [target.uuid, target]]);
    class CharRoll {
        constructor(owner) {this.actor = owner;}
        addModifier(value) {this.modifier = value;}
        async rollAtt() {calls.rolls++; assert.equal(this.dontDisplay, true); return {total: calls.resistanceTotal ?? 2,
            dice: [{results: [{result: 2}]}, {results: [{result: 4}]}], toJSON() {return {total: this.total};}};}
        display() {calls.cards++; throw new Error('No resistance chat spam.');}
    }
    const runtime = {gameRef: game, canvasRef: {scene, tokens: new Map([[target.id, token]])},
        fromUuid: async uuid => documents.get(uuid), CharRollClass: CharRoll,
        statusEffects: [{id: 'distracted', name: 'Distracted', img: 'icons/distracted.svg',
            changes: [{key: 'system.status.isDistracted', mode: 5, value: 'true'}]}]};
    const input = {message, actor, item, target: token, outcome: 'Hit', hitKey: 'shot-1', trigger: 'hit', attackType: 'ranged', range: 10};
    return {api, core, calls, actor, victim, item, target, token, scene, game, gm, player, rule,
        settings, message, runtime, input, documents};
};

const automaticFixture = async (overrides = {}) => {
    const f = await fixture({automaticAccept: true, automaticAcceptSince: 1, ...overrides});
    f.calls.resolutions = 0;
    f.runtime.resolvePropertyCandidate = async ({entry}) => {
        f.calls.resolutions++; return {outcome: entry.outcome};
    };
    return f;
};

test('Automatic Accept applies only an approved eligible rule on primary GM staging without another click or card', async () => {
    const f = await automaticFixture();
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(candidate.status, 'applied'); assert.equal(f.calls.create.length, 1);
    assert.equal(f.calls.resolutions, 1); assert.equal(f.calls.rolls, 0); assert.equal(f.calls.cards, 0);
    const record = Object.values(f.settings.propertiesEventLedger.events)[0];
    assert.equal(record.acceptance, 'automatic'); assert.equal(record.actorUuid, f.victim.uuid);
    assert.match(f.api.renderPropertyCandidates(f.message, f.runtime), /Undo Created Effects/);
    assert.doesNotMatch(f.api.renderPropertyCandidates(f.message, f.runtime), /Apply Effects/);
});

test('mixed Automatic Accept and manual rules keep pending Apply and Undo together, then resolve only remaining effects', async () => {
    const f = await automaticFixture({stack: 'sum'});
    const manual = f.core.normalizeRule({...f.rule, id: 'manual', name: 'Manual Armor', action: 'statModifier', stat: 'armor',
        value: -2, automaticAccept: false});
    f.settings.propertiesLibrary.assignments[f.item.uuid].push(manual);
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(candidate.status, 'pending'); assert.equal(f.calls.create.length, 1);
    assert.match(candidate.result, /Manual Armor: pending GM approval/);
    const html = f.api.renderPropertyCandidates(f.message, f.runtime);
    assert.match(html, /Apply Effects/); assert.match(html, /Undo Created Effects/);
    await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(f.calls.create.length, 1, 'render replay does not auto-approve the manual rule');
    const result = await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(result.status, 'applied'); assert.equal(f.calls.create.length, 2);
    assert.deepEqual(Object.values(f.settings.propertiesEventLedger.events).map(event => event.acceptance), ['automatic', 'manual']);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.create.length, 2);
});

test('old rules default to manual and forged Automatic Accept in player mirrors or item flags does not approve them', async () => {
    const f = await fixture();
    delete f.settings.propertiesLibrary.assignments[f.item.uuid][0].automaticAccept;
    f.message.flags['swade-tools'].automaticAccept = true;
    f.message.flags['swade-tools'].propertiesCandidates = [{automaticAccept: true, status: 'pending'}];
    f.item.flags = {'swade-tools': {properties: [{...f.rule, automaticAccept: true}]}};
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(candidate.status, 'pending'); assert.equal(f.calls.create.length, 0);
});

test('historical, simultaneous and missing-timestamp cards never auto-apply a newly activated assignment', async () => {
    for (const [activation, timestamp] of [[101, 100], [100, 100], [0, 100], [1, 0], [1, undefined]]) {
        const f = await automaticFixture({automaticAcceptSince: activation});
        f.message.timestamp = timestamp;
        const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
        assert.equal(candidate.status, 'pending'); assert.equal(f.calls.create.length, 0);
        assert.equal(f.calls.resolutions, 0, 'history remains manual without a fresh-resolution side effect');
        const manual = await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
        assert.equal(manual.status, 'applied'); assert.equal(f.calls.create.length, 1,
            'the activation boundary does not disable the GM manual approval fallback');
    }
    const fresh = await automaticFixture({automaticAcceptSince: 100});
    fresh.message.timestamp = 101;
    assert.equal((await fresh.api.registerPropertyCandidate(fresh.input, fresh.runtime)).status, 'applied');
    assert.equal(fresh.calls.create.length, 1);
});

test('newly assigned automatic effect cannot retroactively execute on a previously unstaged old attack', async () => {
    const f = await automaticFixture({automaticAcceptSince: 500});
    f.message.timestamp = 100;
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(candidate.status, 'pending'); assert.equal(f.calls.create.length, 0);
    await f.api.registerPropertyCandidate(f.input, {...f.runtime});
    assert.equal(f.calls.create.length, 0, 'reloading/rendering a historical unprocessed attack stays manual');
});

test('automatic approval requires a trusted fresh-outcome resolver and rejects changed outcomes or resolver-side target changes', async () => {
    for (const change of ['missing', 'miss', 'target', 'roll']) {
        const f = await automaticFixture();
        if (change === 'missing') delete f.runtime.resolvePropertyCandidate;
        else f.runtime.resolvePropertyCandidate = async () => {
            if (change === 'target') f.target.x = 123;
            if (change === 'roll') f.message.rolls[0].total = 1;
            return {outcome: change === 'miss' ? 'Miss' : 'Hit'};
        };
        const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
        assert.equal(candidate.status, 'pending'); assert.equal(f.calls.create.length, 0);
        assert.equal(Object.keys(f.settings.propertiesEventLedger.events).length, 0);
    }
});

test('a failing fresh resolver leaves a reviewable attack card without rejecting rendering or applying an effect', async () => {
    const f = await automaticFixture();
    f.runtime.resolvePropertyCandidate = async () => {throw new Error('Native lookup unavailable');};
    let candidate;
    await assert.doesNotReject(async () => {candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);});
    assert.equal(candidate.status, 'review'); assert.match(candidate.result, /could not be verified/);
    assert.match(f.api.renderPropertyCandidates(f.message, f.runtime), /GM review is required/);
    assert.equal(f.calls.create.length, 0); assert.equal(f.calls.updates.length, 0); assert.equal(f.calls.rolls, 0);
    assert.equal(Object.keys(f.settings.propertiesEventLedger.events).length, 0);
    await assert.doesNotReject(f.api.registerPropertyCandidate(f.input, f.runtime));
    assert.equal(f.calls.create.length, 0);
});

test('automatic and concurrent manual requests finish without serial-queue deadlock or duplicate native writes', async () => {
    const f = await automaticFixture({stack: 'sum'});
    let timer;
    const staged = await Promise.race([
        Promise.all(Array.from({length: 8}, () => f.api.registerPropertyCandidate(f.input, f.runtime))),
        new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Serial queue did not finish')), 1500);})
    ]).finally(() => clearTimeout(timer));
    await Promise.all(staged.map(candidate => f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime)));
    assert.equal(f.calls.create.length, 1); assert.equal(Object.keys(f.settings.propertiesEventLedger.events).length, 1);
});

test('automatic replay and same-root Benny card preserve durable per-target event identity after a simulated reload', async () => {
    const f = await automaticFixture({stack: 'sum'});
    await f.api.registerPropertyCandidate(f.input, f.runtime);
    const ledger = clone(f.settings.propertiesEventLedger);
    f.settings.propertiesEventLedger = ledger;
    await f.api.registerPropertyCandidate(f.input, {...f.runtime});
    const reroll = {...f.message, id: 'reroll', timestamp: 200,
        flags: {'swade-tools': {itemroll: f.item.id, propertiesRootId: f.message.id}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    f.game.messages.set(reroll.id, reroll);
    const candidate = await f.api.registerPropertyCandidate({...f.input, message: reroll}, f.runtime);
    assert.equal(candidate.status, 'applied'); assert.equal(f.calls.create.length, 1);
    assert.equal(Object.keys(f.settings.propertiesEventLedger.events).length, 1);
});

test('automatic RoF-style per-hit and per-target frequencies deduplicate without dropping distinct targets', async () => {
    for (const [frequency, expected] of [['hit', 3], ['target', 2]]) {
        const f = await automaticFixture({frequency, stack: 'sum'});
        const otherActor = {...f.victim, uuid: 'Scene.scene.Token.other.Actor.other', effects: new Map()};
        // Test actor creation is bound to its own fixture owner; count calls
        // while still checking the authoritative recipient provenance.
        otherActor.createEmbeddedDocuments = async (_type, data) => {
            f.calls.create.push([otherActor.uuid, clone(data)]); return [{...data[0], id: 'other-effect'}];
        };
        const other = {id: 'other', uuid: 'Scene.scene.Token.other', actor: otherActor};
        f.scene.tokens.set(other.id, other); f.runtime.canvasRef.tokens.set(other.id, {document: other, actor: otherActor});
        f.documents.set(otherActor.uuid, otherActor);
        for (const [target, hitKey] of [[f.token, 'skill-1'], [f.token, 'skill-2'], [other, 'wild-die']]) {
            await f.api.registerPropertyCandidate({...f.input, target, hitKey}, f.runtime);
            await f.api.registerPropertyCandidate({...f.input, target, hitKey}, f.runtime);
        }
        assert.equal(f.calls.create.length, expected);
        assert.equal(new Set(f.calls.create.map(call => call[0])).size, 2);
    }
});

test('automatic resistance rolls once, posts no extra card and retains its outcome under re-render and manual Apply', async () => {
    for (const [resistanceTotal, expectedStatus, creates] of [[6, 'resisted', 0], [2, 'applied', 1]]) {
        const f = await automaticFixture({resist: {enabled: true, trait: 'vigor', modifier: -2, tn: 4}});
        f.calls.resistanceTotal = resistanceTotal;
        const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
        await f.api.registerPropertyCandidate(f.input, f.runtime);
        await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
        assert.equal(candidate.status, expectedStatus); assert.equal(f.calls.rolls, 1);
        assert.equal(f.calls.cards, 0); assert.equal(f.calls.create.length, creates);
    }
});

test('automatic source/target/rule revalidation after resistance prevents changed authority from creating effects', async () => {
    for (const change of ['rule', 'target', 'ownership', 'actor']) {
        const f = await automaticFixture({resist: {enabled: true, trait: 'vigor', modifier: 0, tn: 4}});
        f.runtime.CharRollClass = class {
            addModifier() {}
            async rollAtt() {
                if (change === 'rule') f.settings.propertiesLibrary.assignments[f.item.uuid][0].automaticAccept = false;
                if (change === 'target') f.target.x = 600;
                if (change === 'ownership') f.actor.ownership.player = 0;
                if (change === 'actor') f.scene.tokens.set('target', {...f.target, actor: {uuid: 'Actor.replaced'}});
                return {total: 2, dice: [{results: [{result: 2}]}]};
            }
        };
        const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
        assert.equal(candidate.status, 'review'); assert.equal(f.calls.create.length, 0);
        assert.equal(Object.values(f.settings.propertiesEventLedger.events)[0].status, 'stale');
    }
});

test('automatic acceptance never runs for player, secondary GM, disabled system, AoE, Fire or replaced scene target', async () => {
    for (const mutate of [f => {f.game.user = f.player;},
        f => {f.game.users.set('aaa', {id: 'aaa', isGM: true, active: true});},
        f => {f.settings.propertiesEnabled = false;}, f => {f.message.flags.world = {aoeAttack: {}};},
        f => {f.message.flags['swade-tools'].aoeFireDamage = {};},
        f => {f.runtime.canvasRef.scene = {id: 'elsewhere'};},
        f => {f.scene.tokens.set('target', {...f.target, actor: {uuid: 'Actor.wrong'}});}]) {
        const f = await automaticFixture(); mutate(f);
        assert.equal(await f.api.registerPropertyCandidate(f.input, f.runtime), null);
        assert.equal(f.calls.create.length, 0); assert.equal(f.calls.rolls, 0);
    }
});

test('automatic Raise effects do not execute on a Hit or Miss, but run once after a trusted Raise correction', async () => {
    const f = await automaticFixture({trigger: 'raise', stack: 'sum'});
    assert.equal((await f.api.registerPropertyCandidate(f.input, f.runtime)).status, 'ineligible');
    assert.equal(f.calls.create.length, 0);
    f.message.rolls[0].total = 12;
    assert.equal((await f.api.registerPropertyCandidate({...f.input, outcome: 'Raise'}, f.runtime)).status, 'applied');
    assert.equal(f.calls.create.length, 1);
    f.message.rolls[0].total = 1;
    assert.equal((await f.api.registerPropertyCandidate({...f.input, outcome: 'Miss'}, f.runtime)).status, 'review');
    assert.equal(f.calls.create.length, 1, 'correction never silently deletes or repeats a managed effect');
});

test('pending manual remainder rejects outside target changes but does not recalculate its own automatic defense debuff', async () => {
    const f = await automaticFixture({action: 'statModifier', stat: 'parry', value: -2, stack: 'sum'});
    const manual = f.core.normalizeRule({...f.rule, id: 'manual', action: 'traitSteps', value: -1, automaticAccept: false});
    f.settings.propertiesLibrary.assignments[f.item.uuid].push(manual);
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    f.runtime.resolvePropertyCandidate = async () => {throw new Error('Own managed effects do not retroactively change a resolved hit.');};
    assert.equal((await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime)).status, 'applied');
    assert.equal(f.calls.create.length, 2);

    const shifted = await automaticFixture({stack: 'sum'});
    shifted.settings.propertiesLibrary.assignments[shifted.item.uuid].push(shifted.core.normalizeRule({...shifted.rule,
        id: 'manual', action: 'statModifier', stat: 'armor', value: -2, automaticAccept: false}));
    const pending = await shifted.api.registerPropertyCandidate(shifted.input, shifted.runtime);
    shifted.target.x = 500;
    assert.equal((await shifted.api.applyRegisteredPropertyCandidate(shifted.message, pending.id, shifted.runtime)).status, 'stale');
    assert.equal(shifted.calls.create.length, 1);
});

test('Undo of automatically created effects keeps the manual remainder pending without re-igniting removed effects', async () => {
    const f = await automaticFixture({stack: 'sum'});
    f.settings.propertiesLibrary.assignments[f.item.uuid].push(f.core.normalizeRule({...f.rule,
        id: 'manual', name: 'Manual Armor', action: 'statModifier', stat: 'armor', value: -2, automaticAccept: false}));
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(await f.api.undoPropertyCandidate(f.message, candidate.id, f.runtime), true);
    assert.equal(f.victim.effects.size, 0);
    assert.equal(f.message.flags['swade-tools'].propertiesCandidates[0].status, 'pending');
    await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(f.calls.create.length, 1, 'automatic event is durably undone and never repeated');
    const html = f.api.renderPropertyCandidates(f.message, f.runtime);
    assert.match(html, /Apply Effects/);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.create.length, 2); assert.equal(f.victim.effects.size, 1);
    assert.equal([...f.victim.effects.values()][0].name, 'Manual Armor');
});

test('editing remaining manual property configuration after an automatic application cannot silently approve the edited rule', async () => {
    const f = await automaticFixture({stack: 'sum'});
    f.settings.propertiesLibrary.assignments[f.item.uuid].push(f.core.normalizeRule({...f.rule,
        id: 'manual', action: 'statModifier', stat: 'armor', value: -2, automaticAccept: false}));
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    f.settings.propertiesLibrary.assignments[f.item.uuid][1].automaticAccept = true;
    const replay = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(replay.status, 'stale'); assert.equal(f.calls.create.length, 1);
    assert.equal((await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime)).status, 'stale');
    assert.equal(f.calls.create.length, 1);
});

test('resolved-outcome getter freezes the trusted original hit after its own debuff without writes and also works for players', async () => {
    const f = await automaticFixture({action: 'statModifier', stat: 'parry', value: -2});
    assert.equal(f.api.getResolvedPropertyOutcome(f.input, f.runtime), null, 'an unprocessed attack has no frozen approval');
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    f.victim.system.stats = {parry: {value: 2}};
    f.victim.statuses.add('vulnerable');
    const saved = clone(f.settings.propertiesEventLedger), created = f.calls.create.length;
    for (const user of [f.gm, f.player]) {
        f.game.user = user;
        assert.deepEqual(f.api.getResolvedPropertyOutcome(f.input, f.runtime), {hit: true, raise: false});
    }
    assert.deepEqual(f.settings.propertiesEventLedger, saved); assert.equal(f.calls.create.length, created);
    f.game.user = f.gm;
    assert.equal(await f.api.undoPropertyCandidate(f.message, candidate.id, f.runtime), true);
    assert.equal(f.api.getResolvedPropertyOutcome(f.input, f.runtime), null, 'Undo removes the freeze once no resolved event remains');
});

test('resolved-outcome getter rejects pending, forged mirrors, changed roll signatures and the superseded Benny root', async () => {
    const manual = await fixture();
    await manual.api.registerPropertyCandidate(manual.input, manual.runtime);
    assert.equal(manual.api.getResolvedPropertyOutcome(manual.input, manual.runtime), null);
    manual.message.flags['swade-tools'].propertiesCandidates = [{outcome: {raise: true}, status: 'applied'}];
    assert.equal(manual.api.getResolvedPropertyOutcome(manual.input, manual.runtime), null);

    const f = await automaticFixture();
    await f.api.registerPropertyCandidate(f.input, f.runtime);
    f.message.flags['swade-tools'].gmmod = 4;
    assert.equal(f.api.getResolvedPropertyOutcome(f.input, f.runtime), null, 'a GM-card correction unfreezes the real attack');
    delete f.message.flags['swade-tools'].gmmod;
    assert.deepEqual(f.api.getResolvedPropertyOutcome(f.input, f.runtime), {hit: true, raise: false});
    const reroll = {...f.message, id: 'reroll', timestamp: 200,
        flags: {'swade-tools': {itemroll: f.item.id, propertiesRootId: f.message.id}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    f.game.messages.set(reroll.id, reroll);
    await f.api.registerPropertyCandidate({...f.input, message: reroll, outcome: 'Miss'}, f.runtime);
    assert.equal(f.api.getResolvedPropertyOutcome(f.input, f.runtime), null, 'latest reroll supersedes the former message');
});

test('resolved-outcome getter requires exact scene token, actor, item and hit binding and never reads AoE or Fire outcomes', async () => {
    for (const alter of [input => {input.hitKey = 'other';}, input => {input.actor = {...input.actor, uuid: 'Actor.other'};},
        input => {input.item = {...input.item, uuid: 'Actor.attacker.Item.other'};},
        input => {input.target = {document: {...input.target.document, uuid: 'Scene.scene.Token.other'}, actor: input.target.actor};}]) {
        const f = await automaticFixture();
        await f.api.registerPropertyCandidate(f.input, f.runtime);
        const input = {...f.input}; alter(input);
        assert.equal(f.api.getResolvedPropertyOutcome(input, f.runtime), null);
    }
    for (const change of [f => {f.settings.propertiesEnabled = false;},
        f => {f.message.flags.world = {aoeAttack: {}};}, f => {f.message.flags['swade-tools'].aoeFireDamage = {};},
        f => {f.message.isContentVisible = false;}, f => {f.runtime.canvasRef.scene = {id: 'other'};},
        f => {f.scene.tokens.set('target', {...f.target, actor: {uuid: 'Actor.replaced'}});}]) {
        const f = await automaticFixture();
        await f.api.registerPropertyCandidate(f.input, f.runtime); change(f);
        assert.equal(f.api.getResolvedPropertyOutcome(f.input, f.runtime), null);
    }
});

test('GM confirmation applies one reversible native effect with exact source and duration', async () => {
    const f = await fixture();
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(candidate.status, 'pending'); assert.equal(f.calls.create.length, 0);
    const result = await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(result.status, 'applied'); assert.equal(f.calls.create.length, 1);
    const [owner, [effect]] = f.calls.create[0]; assert.equal(owner, f.victim.uuid);
    assert.deepEqual(effect.changes, [{key: 'system.attributes.strength.die.sides', mode: 0, value: '-1', priority: 60}]);
    assert.equal(effect.origin, f.item.uuid); assert.equal(effect.transfer, false);
    assert.deepEqual(effect.duration, {rounds: 2, startTime: 100, combat: 'combat', startRound: 2, startTurn: 0});
    assert.equal(effect.system.expiration, 2); assert.equal(effect.flags['swade-tools'].propertiesEffect.actorUuid, f.victim.uuid);
    assert.equal(f.victim.system.attributes.strength.die.sides, 8, 'base actor data is never edited');
});

test('concurrent clicks, chat refresh and same-root Benny cards never duplicate an effect', async () => {
    const f = await fixture({stack: 'sum'}), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await Promise.all(Array.from({length: 5}, () => f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime)));
    assert.equal(f.calls.create.length, 1);
    const reroll = {...f.message, id: 'reroll', timestamp: 200, flags: {'swade-tools': {itemroll: f.item.id, propertiesRootId: f.message.id}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    const next = await f.api.registerPropertyCandidate({...f.input, message: reroll}, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(reroll, next.id, f.runtime);
    assert.equal(f.calls.create.length, 1);
});

test('latest trusted reroll supersedes old candidates, and re-rendering an old card cannot reverse it', async () => {
    const f = await fixture({stack: 'sum'}), first = await f.api.registerPropertyCandidate(f.input, f.runtime);
    const latest = {...f.message, id: 'new-card', timestamp: 200,
        flags: {'swade-tools': {itemroll: f.item.id, propertiesRootId: f.message.id}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    f.game.messages.set(latest.id, latest);
    const next = await f.api.registerPropertyCandidate({...f.input, message: latest, outcome: 'Miss'}, f.runtime);
    assert.equal(next.status, 'ineligible');
    assert.equal((await f.api.applyRegisteredPropertyCandidate(f.message, first.id, f.runtime)).status, 'stale');
    assert.equal(await f.api.registerPropertyCandidate(f.input, f.runtime), null);
    assert.equal(f.calls.create.length, 0);
});

test('correction after application retains effect history and exposes a safe Undo instead of silently removing it', async () => {
    const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    f.message.rolls[0].total = 1;
    const corrected = await f.api.registerPropertyCandidate({...f.input, outcome: 'Miss'}, f.runtime);
    assert.equal(corrected.status, 'review'); assert.equal(f.victim.effects.size, 1);
    const html = f.api.renderPropertyCandidates(f.message);
    assert.match(html, /Undo Created Effects/); assert.doesNotMatch(html, /Apply Effects/);
    assert.equal(await f.api.undoPropertyCandidate(f.message, candidate.id, f.runtime), true);
    assert.equal(f.victim.effects.size, 0);
});

test('an applied defense debuff does not retroactively change the original hit on chat re-render', async () => {
    const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    const refreshed = await f.api.registerPropertyCandidate({...f.input, outcome: 'Raise'}, f.runtime);
    assert.equal(refreshed.status, 'applied'); assert.deepEqual(refreshed.outcome, {hit: true, raise: false});
    assert.equal(f.calls.create.length, 1);
});

test('target defenses or placement changed after staging require a fresh review', async () => {
    const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    f.target.x = 300;
    const result = await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(result.status, 'stale'); assert.equal(f.calls.create.length, 0);
    const current = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(current.status, 'pending');
});

test('world history bound refuses new work without forgetting live deduplication, and deleted roots are pruned', async () => {
    const f = await fixture({stack: 'sum'}); f.runtime.ledgerLimits = {candidates: 1, events: 1};
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(await f.api.registerPropertyCandidate({...f.input, hitKey: 'new-hit'}, f.runtime), null);
    assert.equal(Object.keys(f.settings.propertiesEventLedger.events).length, 1);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.create.length, 1);
    f.game.messages.clear();
    await f.api.cleanupPropertiesEventLedger(f.runtime);
    assert.equal(Object.keys(f.settings.propertiesEventLedger.candidates).length, 0);
    assert.equal(Object.keys(f.settings.propertiesEventLedger.events).length, 0);
});

test('best stacking suppresses only weaker managed effects and Undo restores them', async () => {
    const f = await fixture({stack: 'best', value: -1, group: 'weakening'});
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    const first = [...f.victim.effects.values()][0];
    const strongerRule = f.core.normalizeRule({...f.rule, value: -2});
    f.settings.propertiesLibrary.assignments[f.item.uuid] = [strongerRule];
    const nextMessage = {...f.message, id: 'next-attack', timestamp: 300, flags: {'swade-tools': {itemroll: f.item.id}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    f.game.messages.set(nextMessage.id, nextMessage);
    const next = await f.api.registerPropertyCandidate({...f.input, message: nextMessage}, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(nextMessage, next.id, f.runtime);
    assert.equal(first.disabled, true); assert.equal(f.victim.effects.size, 2);
    await f.api.undoPropertyCandidate(nextMessage, next.id, f.runtime);
    assert.equal(first.disabled, false); assert.equal(f.victim.effects.size, 1);
});

test('refresh stacking only extends its own managed duration and never creates duplicate effects', async () => {
    const f = await fixture({stack: 'refresh'});
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    const nextMessage = {...f.message, id: 'next-attack', timestamp: 300, flags: {'swade-tools': {itemroll: f.item.id}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    f.game.messages.set(nextMessage.id, nextMessage); f.game.combat.round = 5;
    const next = await f.api.registerPropertyCandidate({...f.input, message: nextMessage}, f.runtime);
    const result = await f.api.applyRegisteredPropertyCandidate(nextMessage, next.id, f.runtime);
    assert.equal(result.results[0].status, 'refreshed'); assert.equal(f.calls.create.length, 1);
    assert.equal([...f.victim.effects.values()][0].duration.startRound, 5);
    await f.api.undoPropertyCandidate(nextMessage, next.id, f.runtime);
    assert.equal(f.victim.effects.size, 1, 'refresh undo does not remove a previous attack effect');
});

test('player-editable chat mirrors never grant authority or effects', async () => {
    const f = await fixture();
    f.message.flags['swade-tools'].propertiesCandidates = [{id: 'forged', status: 'pending', rules: ['God Mode']}];
    assert.equal(await f.api.applyRegisteredPropertyCandidate(f.message, 'forged', f.runtime), null);
    f.game.user = f.player;
    assert.equal(await f.api.registerPropertyCandidate(f.input, f.runtime), null);
    assert.equal(f.calls.create.length, 0);
});

test('feature-off, nonprimary GM, unowned source, private cards and existing AoE are excluded', async () => {
    for (const mutate of [f => {f.settings.propertiesEnabled = false;},
        f => {f.game.users.set('aaa', {id: 'aaa', isGM: true, active: true});},
        f => {f.actor.ownership.player = 0;}, f => {f.message.isContentVisible = false;},
        f => {f.message.flags.world = {aoeAttack: {version: 1}};},
        f => {f.message.flags['swade-tools'].powerAoe = {};},
        f => {f.message.flags['swade-tools'].aoeFireDamage = {}; }]) {
        const f = await fixture(); mutate(f);
        assert.equal(await f.api.registerPropertyCandidate(f.input, f.runtime), null); assert.equal(f.calls.create.length, 0);
    }
});

test('stale corrections and scene/token actor replacement cannot apply a formerly eligible hit', async () => {
    for (const mutate of [f => {f.message.rolls[0].total = 1;},
        f => {f.runtime.canvasRef.scene = {id: 'other'};},
        f => {f.scene.tokens.set('target', {...f.target, actor: {uuid: 'Actor.replacement'}});}]) {
        const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
        mutate(f); const result = await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
        assert.ok(result === null || result.status === 'stale'); assert.equal(f.calls.create.length, 0);
    }
});

test('GM correction Hit to Miss removes pending eligibility; Raise rules require a Raise', async () => {
    const f = await fixture({trigger: 'raise'});
    let candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(candidate.status, 'ineligible');
    f.message.rolls[0].total = 10;
    candidate = await f.api.registerPropertyCandidate({...f.input, outcome: 'Raise'}, f.runtime);
    assert.equal(candidate.status, 'pending');
    f.message.rolls[0].total = 1;
    candidate = await f.api.registerPropertyCandidate({...f.input, outcome: 'Miss'}, f.runtime);
    assert.equal(candidate.status, 'ineligible');
    assert.equal(await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime), null);
});

test('resistance is rolled once without posting cards and stores a compact audit', async () => {
    const f = await fixture({resist: {enabled: true, trait: 'vigor', modifier: -2, tn: 4}});
    f.calls.resistanceTotal = 6;
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    const first = await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(first.status, 'resisted'); assert.equal(f.calls.rolls, 1); assert.equal(f.calls.cards, 0); assert.equal(f.calls.create.length, 0);
    assert.equal(Object.values(f.settings.propertiesEventLedger.events)[0].resistance.total, 6);
    assert.match(f.api.renderPropertyCandidates(f.message), /6 vs 4/);
});

test('failed resistance applies effect and is not repeated on duplicate requests', async () => {
    const f = await fixture({resist: {enabled: true, trait: 'vigor', modifier: 0, tn: 4}});
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.rolls, 1); assert.equal(f.calls.create.length, 1);
});

test('native status definition is used; preexisting unrelated statuses are never owned or undone', async () => {
    const f = await fixture({action: 'status', status: 'distracted', value: 1});
    f.victim.statuses.add('distracted');
    const candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.create.length, 0);
    await f.api.undoPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.delete.length, 0); assert.equal(f.victim.statuses.has('distracted'), true);
});

test('post-damage rules require an actual Apply action, and wound rules require remaining wounds', async () => {
    const f = await fixture({trigger: 'wound'});
    assert.equal(await f.api.applyPropertiesForEvent({...f.input, trigger: 'wound', wounds: 2}, f.runtime), null);
    assert.equal(await f.api.applyPropertiesForEvent({...f.input, trigger: 'wound', wounds: 0, damageApplied: true}, f.runtime), null);
    const result = await f.api.applyPropertiesForEvent({...f.input, trigger: 'wound', wounds: 1, damageApplied: true}, f.runtime);
    assert.equal(result.status, 'applied'); assert.equal(f.calls.create.length, 1);
});

test('player-owned Soak can resolve the original attacker effect only through exact GM-approved attack binding', async () => {
    const f = await fixture({trigger: 'wound'});
    const staged = await f.api.registerPropertyCandidate(f.input, f.runtime);
    assert.equal(staged.status, 'ineligible', 'wound-only rules stage authority but no on-hit Apply button');
    const owner = {id: 'defender', active: true, isGM: false};
    f.game.users.set(owner.id, owner); f.victim.ownership = {[owner.id]: 3};
    const source = {version: 1, attackMessageId: f.message.id, rootId: f.message.id, actorUuid: f.actor.uuid,
        itemUuid: f.item.uuid, targetUuid: f.target.uuid, targetActorUuid: f.victim.uuid,
        hitKey: f.input.hitKey, outcome: 'Raise', attackType: 'melee', range: 999};
    const soak = {...f.message, id: 'soak', timestamp: 300, user: owner.id,
        flags: {'swade-tools': {rolltype: 'soak', usetarget: f.target.id, propertiesRootId: f.message.id, propertiesSource: source}},
        async update(data) {for (const [key, value] of Object.entries(data)) setPath(this, key, clone(value));}};
    f.game.messages.set(soak.id, soak);
    const result = await f.api.applyPropertiesForEvent({...f.input, message: soak, trigger: 'wound', wounds: 1, damageApplied: true}, f.runtime);
    assert.equal(result.status, 'applied'); assert.equal(f.calls.create.length, 1);
    const candidate = Object.values(f.settings.propertiesEventLedger.candidates).find(entry => entry.messageId === soak.id);
    assert.deepEqual(candidate.outcome, {hit: true, raise: false}, 'client flags cannot manufacture a Raise');
    assert.deepEqual(candidate.context, {attackType: 'ranged', range: 10}, 'GM-staged original context is authoritative');
});

test('forged Soak source or mismatched current target cannot borrow a legitimate attack binding', async () => {
    for (const mutate of [source => {source.attackMessageId = 'foreign';}, source => {source.targetActorUuid = 'Actor.other';},
        source => {source.itemUuid = 'Actor.attacker.Item.other';}, source => {source.hitKey = 'foreign';}]) {
        const f = await fixture({trigger: 'wound'});
        await f.api.registerPropertyCandidate(f.input, f.runtime);
        const source = {version: 1, attackMessageId: f.message.id, rootId: f.message.id, actorUuid: f.actor.uuid,
            itemUuid: f.item.uuid, targetUuid: f.target.uuid, targetActorUuid: f.victim.uuid, hitKey: f.input.hitKey};
        mutate(source);
        const soak = {...f.message, id: 'soak', flags: {'swade-tools': {rolltype: 'soak', usetarget: f.target.id,
            propertiesRootId: f.message.id, propertiesSource: source}}};
        assert.equal(await f.api.applyPropertiesForEvent({...f.input, message: soak, trigger: 'wound', wounds: 1, damageApplied: true}, f.runtime), null);
        assert.equal(f.calls.create.length, 0);
    }
});

test('per-hit frequency allows distinct hits but per-target rules resolve once', async () => {
    for (const [frequency, expected] of [['hit', 2], ['target', 1]]) {
        const f = await fixture({frequency, stack: 'sum'});
        for (const hitKey of ['shot1', 'shot2']) {
            const candidate = await f.api.registerPropertyCandidate({...f.input, hitKey}, f.runtime);
            await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
        }
        assert.equal(f.calls.create.length, expected);
    }
});

test('undo removes only exact recorded managed effects and cannot cross scene or actor identity', async () => {
    const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    f.victim.effects.set('unrelated', {id: 'unrelated', flags: {}});
    assert.equal(await f.api.undoPropertyCandidate(f.message, candidate.id, f.runtime), true);
    assert.equal(f.victim.effects.size, 1); assert.equal(f.victim.effects.has('unrelated'), true);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    assert.equal(f.calls.create.length, 1, 'undo is not a repeat trigger');
});

test('die-step conversion handles d4 floor, d12+n and retains flat modifiers', async () => {
    const {stepPropertyDie} = await service;
    assert.deepEqual(stepPropertyDie({sides: 8, modifier: 0}, -1), {sides: 6, modifier: 0});
    assert.deepEqual(stepPropertyDie({sides: 4, modifier: 0}, -5), {sides: 4, modifier: 0});
    assert.deepEqual(stepPropertyDie({sides: 12, modifier: 2}, -1), {sides: 12, modifier: 1});
    assert.deepEqual(stepPropertyDie({sides: 12, modifier: 1}, -2), {sides: 10, modifier: 0});
    assert.deepEqual(stepPropertyDie({sides: 10, modifier: -1}, 3), {sides: 12, modifier: 1});
    assert.equal(stepPropertyDie({sides: 1}, 1), null);
});

test('native CUSTOM die-step hook aggregates signed changes once before derived data', async () => {
    const f = await fixture({stack: 'sum'});
    const positive = {...f.rule, id: 'boost', value: 2, sourceUuid: f.item.uuid};
    const negative = {...f.rule, id: 'debuff', value: -3, sourceUuid: f.item.uuid};
    for (const rule of [positive, negative]) await f.victim.createEmbeddedDocuments('ActiveEffect', [
        f.api.buildPropertyEffectData(rule, f.victim, {actorUuid: f.victim.uuid}, f.runtime)]);
    const effects = [...f.victim.effects.values()], changes = {};
    for (const effect of effects) f.api.applyPropertyDieStepChange(f.victim, {...effect.changes[0], effect}, 8, 0, changes);
    assert.deepEqual(f.victim.system.attributes.strength.die, {sides: 6, modifier: 0});
    assert.equal(changes['system.attributes.strength.die.sides'], 6);
});

test('passive native effects synchronize once and opt-out disables only managed effects', async () => {
    const f = await fixture({trigger: 'passive', target: 'self', action: 'statModifier', stat: 'armor', value: 2, duration: {rounds: 0}});
    f.actor.effects.set('native', {id: 'native', disabled: false, flags: {}});
    await f.api.synchronizePropertyEffects(f.runtime); await f.api.synchronizePropertyEffects(f.runtime);
    assert.equal(f.calls.create.length, 1);
    assert.equal(f.calls.create[0][1][0].changes[0].key, 'system.stats.toughness.armor');
    f.settings.propertiesEnabled = false;
    await f.api.synchronizePropertyEffects(f.runtime);
    assert.equal(f.actor.effects.get('native').disabled, false);
    assert.equal([...f.actor.effects.values()].find(effect => effect.id !== 'native').disabled, true);
});

test('compact chat presentation is escaped, closed by default and has GM-only controls', async () => {
    const f = await fixture({name: '<img src=x onerror=alert(1)>'});
    await f.api.registerPropertyCandidate(f.input, f.runtime);
    const html = f.api.renderPropertyCandidates(f.message);
    assert.match(html, /^<details /); assert.doesNotMatch(html, /<details[^>]*\sopen/);
    assert.match(html, /data-properties-gm hidden/); assert.match(html, /Apply Effects/);
    assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
});

test('missing or null range is never converted to zero for conditional effects', async () => {
    const f = await fixture({conditions: {maxRange: 5}});
    for (const range of [null, undefined, NaN]) {
        const candidate = await f.api.registerPropertyCandidate({...f.input, range}, f.runtime);
        assert.equal(candidate.status, 'ineligible'); assert.equal(Object.hasOwn(candidate.context, 'range'), false);
    }
});

test('chat role enforcement hides controls from players and secondary GMs after HTML sanitization', async () => {
    const {registerPropertiesChatControls} = await chatService;
    for (const secondary of [false, true]) {
        const f = await fixture(), handlers = {}, listeners = {};
        const documentRef = {addEventListener(name, callback) {listeners[name] = callback;}};
        const hooks = {on(name, callback) {handlers[name] = callback;}};
        f.game.user = secondary ? {id: 'secondary', isGM: true, active: true} : f.player;
        if (secondary) f.game.users.set('secondary', f.game.user);
        registerPropertiesChatControls({...f.runtime, hooks, documentRef});
        const control = {hidden: false};
        handlers.renderChatMessageHTML(f.message, {querySelectorAll: () => [control]});
        assert.equal(control.hidden, true);
        await listeners.click({target: {closest: () => ({dataset: {propertiesApply: 'forged'}})}});
        assert.equal(f.calls.create.length, 0);
    }
});

test('late-added pending sections expose Apply to the current primary GM only', async () => {
    const f = await fixture();
    await f.api.registerPropertyCandidate(f.input, f.runtime);
    const primary = f.api.renderPropertyCandidates(f.message, f.runtime);
    assert.match(primary, /<span data-properties-gm><button[^>]+data-properties-apply=/);
    assert.doesNotMatch(primary, /<details[^>]+\bopen\b/);
    for (const user of [f.player, {id: 'secondary', isGM: true, active: true}]) {
        f.game.user = user;
        if (user.isGM) f.game.users.set(user.id, user);
        const html = f.api.renderPropertyCandidates(f.message, f.runtime);
        assert.match(html, /<span data-properties-gm hidden>/);
        if (user.isGM) assert.match(html, /Approval GM: gm\./);
        else assert.doesNotMatch(html, /Approval GM:/);
    }
    f.game.user = f.gm;
    assert.equal(f.api.renderPropertyCandidates({...f.message, isContentVisible: false}, f.runtime), '');
    assert.equal(f.calls.create.length, 0, 'rendering never applies the pending effect');
});

test('late-added resolved sections expose Undo only to the current primary GM', async () => {
    const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    await f.api.applyRegisteredPropertyCandidate(f.message, candidate.id, f.runtime);
    const html = f.api.renderPropertyCandidates(f.message, f.runtime);
    assert.match(html, /<span data-properties-gm><button[^>]+data-properties-undo=/);
    assert.doesNotMatch(html, /data-properties-apply=/);
    f.game.user = f.player;
    assert.match(f.api.renderPropertyCandidates(f.message, f.runtime), /<span data-properties-gm hidden>/);
});

test('chat controls registered before game initialization use the current viewer at render and click time', async () => {
    const {registerPropertiesChatControls} = await chatService;
    const f = await fixture(), candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    const handlers = {}, listeners = {}, previous = globalThis.game;
    try {
        delete globalThis.game;
        registerPropertiesChatControls({...f.runtime, gameRef: undefined,
            hooks: {on(name, callback) {handlers[name] = callback;}},
            documentRef: {addEventListener(name, callback) {listeners[name] = callback;}}});
        globalThis.game = f.game;
        const span = {hidden: true};
        handlers.renderChatMessageHTML(f.message, {querySelectorAll: () => [span]});
        assert.equal(span.hidden, false);
        const control = {dataset: {propertiesApply: candidate.id},
            closest: () => ({dataset: {messageId: f.message.id}})};
        await listeners.click({preventDefault() {}, target: {closest: () => control}});
        assert.equal(f.calls.create.length, 1);
        f.game.user = f.player;
        handlers.renderChatMessageHTML(f.message, {querySelectorAll: () => [span]});
        assert.equal(span.hidden, true);
        await listeners.click({preventDefault() {}, target: {closest: () => control}});
        assert.equal(f.calls.create.length, 1);
    } finally {
        if (previous === undefined) delete globalThis.game;
        else globalThis.game = previous;
    }
});

test('primary-GM chat Apply and Undo reuse the same card and exact world-approved candidate', async () => {
    const {registerPropertiesChatControls} = await chatService;
    const f = await fixture(), handlers = {}, listeners = {}, candidate = await f.api.registerPropertyCandidate(f.input, f.runtime);
    const documentRef = {addEventListener(name, callback) {listeners[name] = callback;}};
    const hooks = {on(name, callback) {handlers[name] = callback;}};
    registerPropertiesChatControls({...f.runtime, hooks, documentRef});
    const control = {dataset: {propertiesApply: candidate.id}, disabled: false,
        closest: () => ({dataset: {messageId: f.message.id}})};
    await listeners.click({preventDefault() {}, target: {closest: () => control}});
    assert.equal(control.disabled, false); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.cards, 0);
    delete control.dataset.propertiesApply; control.dataset.propertiesUndo = candidate.id;
    await listeners.click({preventDefault() {}, target: {closest: () => control}});
    assert.equal(f.victim.effects.size, 0); assert.equal(f.calls.cards, 0);
});

test('stronger best effect expiry reactivates an unexpired weaker managed effect through native lifecycle', async () => {
    const f = await fixture({stack: 'best', value: -1, group: 'weakening'}), handlers = {};
    f.api.registerPropertiesEffects({...f.runtime, hooks: {on(name, callback) {handlers[name] = callback;}}});
    const first = (await f.victim.createEmbeddedDocuments('ActiveEffect', [f.api.buildPropertyEffectData(
        {...f.rule, sourceUuid: f.item.uuid}, f.victim, {actorUuid: f.victim.uuid}, f.runtime)]))[0];
    await first.update({disabled: true, 'flags.swade-tools.propertiesEffect.bestSuppressed': true});
    const strong = (await f.victim.createEmbeddedDocuments('ActiveEffect', [f.api.buildPropertyEffectData(
        {...f.rule, sourceUuid: f.item.uuid, value: -2}, f.victim, {actorUuid: f.victim.uuid}, f.runtime)]))[0];
    f.victim.effects.delete(strong.id);
    await handlers.deleteActiveEffect(strong);
    assert.equal(first.disabled, false);
});
