const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeFire.js')).href);
const targetResults = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeTargetResults.js')).href);

async function fixture({dice = [], flammability, gmId = 'a-gm', autoEvade = false, evaded, enabled = true} = {}) {
    const api = await service;
    const resultApi = await targetResults;
    const calls = [], cards = [], warnings = [], documents = new Map();
    const game = {user: {id: gmId, isGM: gmId !== 'player', active: true},
        users: new Map([['a-gm', {id: 'a-gm', isGM: true, active: true}],
            ['b-gm', {id: 'b-gm', isGM: true, active: true}],
            ['player', {id: 'player', isGM: false, active: true}]]), messages: new Map()};
    const actor = {uuid: 'Scene.scene.Token.target.Actor.victim', name: 'Victim', effects: new Map(),
        flags: {'swade-tools': flammability ? {aoeFlammability: flammability} : {}},
        async update(change) {
            for (const [key, value] of Object.entries(change)) this.flags['swade-tools'][key.split('.').at(-1)] = value;
            calls.push(['actor-update', change]);
        },
        async createEmbeddedDocuments(type, data) {
            assert.equal(type, 'ActiveEffect');
            const effect = {id: `effect-${this.effects.size}`, uuid: `${this.uuid}.ActiveEffect.effect-${this.effects.size}`,
                ...data[0], parent: this,
                async update(change) {
                    calls.push(['effect-update', change]);
                    for (const [key, value] of Object.entries(change)) this.flags['swade-tools'][key.split('.').at(-1)] = value;
                },
                async delete() {calls.push(['effect-delete', this.uuid]); this.deleted = true; this.parent.effects.delete(this.id); documents.delete(this.uuid);}};
            this.effects.set(effect.id, effect); documents.set(effect.uuid, effect);
            calls.push(['create-effect', data[0]]); return [effect];
        }};
    const target = {id: 'target', uuid: 'Scene.scene.Token.target', actor, name: 'Target'};
    const item = {uuid: 'Actor.source.Item.flamethrower', flags: {'swade-tools': {aoeFireEnabled: enabled}}};
    const state = {version: 1, baseTotal: 4, gmModifier: 0, sceneId: 'scene', autoEvade,
        itemUuid: item.uuid, operatorActorUuid: 'Actor.source', targets: [{uuid: target.uuid}],
        fire: {enabled, initialIntensity: 3, maxIntensity: 3}};
    const message = {id: 'attack', flags: {world: {aoeAttack: state,
        ...(evaded !== undefined ? {aoeEvadeResults: {[target.uuid]: {evaded}}} : {})}},
        async update(change) {
            calls.push(['attack-update', change]);
            for (const [key, value] of Object.entries(change)) this.flags.world[key.split('.').at(-1)] = value;
        }};
    game.messages.set(message.id, message);
    documents.set(target.uuid, target); documents.set(actor.uuid, actor); documents.set(item.uuid, item);
    const runtime = {gameRef: game, fromUuid: async uuid => documents.get(uuid),
        notifications: {warn: text => warnings.push(text)},
        RollClass: class {
            constructor(formula) {this.formula = formula;}
            async evaluate() {
                calls.push(['roll', this.formula]);
                assert.ok(dice.length, `No test roll available for ${this.formula}`);
                this.total = dice.shift(); return this;
            }
            async render() {return `<div class="dice-roll">${this.formula}: ${this.total}</div>`;}
        },
        ChatMessageClass: {async create(data) {
            const card = {id: `card-${cards.length}`, ...data,
                async update(change) {Object.assign(this, change);}};
            cards.push(card); game.messages.set(card.id, card); return card;
        }}};
    const context = {message, target, actor, item};
    return {api, resultApi, game, actor, target, item, state, message, runtime, context, dice, calls, cards, warnings, documents};
}
const fireState = effect => effect.flags['swade-tools'].aoeBurning;
const fireResult = (s, uuid = s.target.uuid) => s.resultApi.getAoeTargetResult(s.message.flags.world.aoeFireResults, uuid);
const rolls = s => s.calls.filter(call => call[0] === 'roll').map(call => call[1]);
const addEffect = s => s.api.applyAoeBurning(s.actor, {intensity: 3, maxIntensity: 3,
    tokenUuid: s.target.uuid, sourceActorUuid: 'Actor.source', sourceItemUuid: s.item.uuid}, s.runtime);
const combat = (s, round = 1, turn = 0, actor = s.actor) => ({id: 'combat', uuid: 'Combat.combat', started: true,
    active: true, round, turn, combatant: {id: actor === s.actor ? 'victim-combatant' : 'other-combatant', actor}});

// Foundry 13 expandObject recursively expands dotted keys even inside the
// nested value of a flags.world update. Reproduce that document boundary,
// rather than retaining UUID-keyed objects unchanged in the test double.
function expandFoundryUpdate(value) {
    if (Array.isArray(value)) return value.map(expandFoundryUpdate);
    if (!value || value.constructor !== Object) return value;
    const expanded = {};
    for (const [key, child] of Object.entries(value)) {
        const parts = key.split('.');
        const leaf = parts.pop();
        const parent = parts.reduce((object, part) => object[part] ??= {}, expanded);
        parent[leaf] = expandFoundryUpdate(child);
    }
    return expanded;
}
function useFoundryPersistence(s) {
    const merge = (target, source) => {
        for (const [key, value] of Object.entries(source)) {
            if (value?.constructor === Object) {
                if (target[key]?.constructor !== Object) target[key] = {};
                merge(target[key], value);
            } else target[key] = value;
        }
    };
    s.message.update = async change => {s.calls.push(['attack-update', change]); merge(s.message, expandFoundryUpdate(change));};
}

test('fire is opt-in; disabled items do not roll, prompt, or create effects', async () => {
    const s = await fixture({enabled: false});
    assert.deepEqual(await s.api.recordAoeFireHitAsGm(s.context, s.runtime), {allowed: true, status: 'disabled'});
    assert.equal(s.calls.length, 0); assert.equal(s.cards.length, 0); assert.equal(s.actor.effects.size, 0);
});

test('only the elected active GM can initiate fire and edit effects', async () => {
    for (const gmId of ['b-gm', 'player']) {
        const s = await fixture({gmId, flammability: 'flammable', dice: [6, 12]});
        assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).allowed, false);
        assert.equal(await addEffect(s), null); assert.equal(s.cards.length, 0); assert.equal(s.calls.length, 0);
    }
});

test('misses and evaded targets never ignite; auto-Evade requires a settled failed check', async () => {
    for (const options of [{autoEvade: true}, {autoEvade: true, evaded: true}, {}]) {
        const s = await fixture({...options, flammability: 'flammable'});
        if (!options.autoEvade) s.state.baseTotal = 3;
        assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).allowed, false);
        assert.equal(s.calls.length, 0);
    }
    const s = await fixture({autoEvade: true, evaded: false, flammability: 'none'});
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).allowed, true);
});

test('failed cones cannot use a forged deviation flag to ignite victims', async () => {
    const s = await fixture({flammability: 'flammable'});
    s.state.baseTotal = 2; s.state.shape = 'cone'; s.state.deviationResolved = true;
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).allowed, false);
    assert.equal(s.calls.length, 0);
});

test('unknown flammability creates one compact GM decision; it does not assume every target burns', async () => {
    const s = await fixture();
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'pending');
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'pending');
    assert.equal(s.cards.length, 1); assert.equal(s.actor.effects.size, 0); assert.deepEqual(rolls(s), []);
    assert.match(s.cards[0].content, /data-aoe-fire-check hidden/);
    assert.ok(s.cards[0].content.length < 550);
});

test('GM can choose nonflammable and remember the decision on the actual unlinked-token actor', async () => {
    const s = await fixture();
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'none', true, s.runtime), true);
    assert.equal(s.actor.flags['swade-tools'].aoeFlammability, 'none');
    assert.equal(fireResult(s).status, 'nonflammable');
    assert.match(s.cards[0].content, /Not flammable/); assert.deepEqual(rolls(s), []);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'volatile', true, s.runtime), false);
});

test('ordinary, very flammable, and volatile targets use 6, 4–6, and 2–6 plain-d6 ignition thresholds', async () => {
    for (const [flammability, value, caught] of [['flammable', 5, false], ['flammable', 6, true],
        ['very', 3, false], ['very', 4, true], ['volatile', 1, false], ['volatile', 2, true]]) {
        const s = await fixture({flammability, dice: caught ? [value, 12] : [value]});
        const result = await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
        assert.equal(result.status, caught ? 'burning' : 'not-ignited');
        assert.deepEqual(rolls(s), caught ? ['1d6', '3d6x'] : ['1d6']);
        assert.equal(s.actor.effects.size, caught ? 1 : 0);
        if (caught) {assert.match(s.cards[0].content, /Armor applies/); assert.match(s.cards[0].content, /GM applies damage manually/);}
    }
});

test('an unknown target can catch fire after a GM Fire Check, without changing item settings', async () => {
    const s = await fixture({dice: [4, 15]});
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'very', false, s.runtime), true);
    assert.equal(s.actor.flags['swade-tools'].aoeFlammability, undefined);
    assert.equal(s.item.flags['swade-tools'].aoeFireEnabled, true);
    assert.equal(s.actor.effects.size, 1); assert.equal(s.cards.length, 2);
});

test('repeated hits from the same card and reroll-chain cards cannot make duplicate fire rolls', async () => {
    const s = await fixture({flammability: 'flammable', dice: [6, 12]});
    await Promise.all([s.api.recordAoeFireHitAsGm(s.context, s.runtime), s.api.recordAoeFireHitAsGm(s.context, s.runtime)]);
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    const next = {...s.message, id: 'reroll', flags: {world: {aoeAttack: s.state, aoePreviousMessage: s.message.id}}};
    assert.equal((await s.api.recordAoeFireHitAsGm({...s.context, message: next}, s.runtime)).status, 'burning');
    assert.deepEqual(rolls(s), ['1d6', '3d6x']); assert.equal(s.actor.effects.size, 1);
});

test('different attacks can cause immediate fire damage again but merge into a single Burning effect', async () => {
    const s = await fixture({flammability: 'flammable', dice: [6, 12, 6, 8]});
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    const next = {...s.message, id: 'next-attack', flags: {world: {aoeAttack: {...s.state,
        fire: {enabled: true, initialIntensity: 2, maxIntensity: 5}}}}};
    await s.api.recordAoeFireHitAsGm({...s.context, message: next}, s.runtime);
    assert.equal(s.actor.effects.size, 1);
    const effect = s.api.getAoeBurningEffect(s.actor);
    assert.equal(fireState(effect).intensity, 3); assert.equal(fireState(effect).maxIntensity, 5);
    assert.deepEqual(rolls(s), ['1d6', '3d6x', '1d6', '2d6x']);
});

test('start-of-turn fire rolls current damage before the nonexploding intensity check', async () => {
    const s = await fixture({dice: [14, 6]});
    const effect = await s.api.applyAoeBurning(s.actor, {intensity: 2, maxIntensity: 3}, s.runtime);
    assert.equal(await s.api.handleAoeFireCombatTurn(combat(s), {turn: 0}, s.runtime), true);
    assert.deepEqual(rolls(s), ['2d6x', '1d6']); assert.equal(fireState(effect).intensity, 3);
    assert.match(s.cards[0].content, /Fire grows to 3d6/); assert.match(s.cards[0].content, /Fire Damage: 2d6/);
});

test('a fire-check six stays at the configured maximum; 2–5 keeps intensity unchanged', async () => {
    for (const check of [2, 3, 4, 5, 6]) {
        const s = await fixture({dice: [9, check]});
        const effect = await addEffect(s);
        await s.api.rollAoeFireTurn(effect, 'Combat.combat:1:victim', s.runtime);
        assert.equal(fireState(effect).intensity, 3); assert.match(s.cards[0].content, /continues at 3d6/);
    }
});

test('a fire-check one reduces intensity after damage, and extinguishes below one die', async () => {
    const s = await fixture({dice: [9, 1, 5, 1]});
    const effect = await s.api.applyAoeBurning(s.actor, {intensity: 2, maxIntensity: 3}, s.runtime);
    await s.api.rollAoeFireTurn(effect, 'turn-one', s.runtime);
    assert.equal(fireState(effect).intensity, 1); assert.match(s.cards[0].content, /drops to 1d6/);
    await s.api.rollAoeFireTurn(effect, 'turn-two', s.runtime);
    assert.equal(effect.deleted, true); assert.equal(s.actor.effects.size, 0);
    assert.match(s.cards[1].content, /Extinguished/); assert.doesNotMatch(s.cards[1].content, /data-aoe-fire-tick/);
    assert.deepEqual(rolls(s), ['2d6x', '1d6', '1d6x', '1d6']);
});

test('combat update dedup persists across module instances, repeated refreshes, and rewinds', async () => {
    const s = await fixture({dice: [9, 3, 11, 4]});
    const effect = await addEffect(s);
    await Promise.all([s.api.handleAoeFireCombatTurn(combat(s), {round: 1}, s.runtime),
        s.api.handleAoeFireCombatTurn(combat(s), {turn: 0}, s.runtime)]);
    const another = await import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeFire.js')).href + '?second-client');
    await another.handleAoeFireCombatTurn(combat(s), {round: 1}, s.runtime);
    await s.api.handleAoeFireCombatTurn(combat(s, 2), {round: 2}, s.runtime);
    await s.api.handleAoeFireCombatTurn(combat(s), {round: 1}, s.runtime);
    assert.deepEqual(rolls(s), ['3d6x', '1d6', '3d6x', '1d6']);
    assert.equal(fireState(effect).turnKeys.length, 2);
});

test('fire applied during the victim’s existing turn cannot tick again on a combat refresh', async () => {
    const s = await fixture(); s.game.combat = combat(s, 4);
    const effect = await addEffect(s);
    assert.deepEqual(fireState(effect).turnKeys, ['Combat.combat:4:victim-combatant']);
    await s.api.handleAoeFireCombatTurn(s.game.combat, {turn: 0}, s.runtime);
    assert.deepEqual(rolls(s), []);
});

test('only the actual combatant actor ticks; unrelated combat updates and inactive combat do nothing', async () => {
    const s = await fixture(); await addEffect(s);
    const worldActor = {uuid: 'Actor.world-victim', effects: new Map()};
    await s.api.handleAoeFireCombatTurn(combat(s, 1, 0, worldActor), {round: 1}, s.runtime);
    await s.api.handleAoeFireCombatTurn(combat(s), {flags: {anything: true}}, s.runtime);
    await s.api.handleAoeFireCombatTurn({...combat(s), active: false}, {round: 1}, s.runtime);
    await s.api.handleAoeFireCombatTurn({...combat(s), started: false}, {round: 1}, s.runtime);
    assert.deepEqual(rolls(s), []);
});

test('secondary GMs and player clients cannot duplicate a primary-GM combat fire tick', async () => {
    const s = await fixture({dice: [9, 3]}); const effect = await addEffect(s);
    for (const user of ['b-gm', 'player']) {
        s.game.user = s.game.users.get(user);
        assert.equal(await s.api.rollAoeFireTurn(effect, 'combat:1', s.runtime), false);
    }
    s.game.user = s.game.users.get('a-gm');
    assert.equal(await s.api.rollAoeFireTurn(effect, 'combat:1', s.runtime), true);
    assert.deepEqual(rolls(s), ['3d6x', '1d6']);
});

test('GM fire controls validate bounds and remove only this module’s effect', async () => {
    const s = await fixture(); const effect = await addEffect(s);
    const unrelated = {id: 'other', flags: {'another-module': {burning: true}}};
    s.actor.effects.set(unrelated.id, unrelated);
    assert.equal(await s.api.adjustAoeBurning(effect, 4, 3, s.runtime), false);
    assert.equal(await s.api.adjustAoeBurning(effect, 1.5, 3, s.runtime), false);
    assert.equal(await s.api.adjustAoeBurning(effect, 2, 6, s.runtime), true);
    assert.equal(fireState(effect).intensity, 2);
    assert.equal(await s.api.extinguishAoeBurning(effect, s.runtime), true);
    assert.equal(s.actor.effects.size, 1); assert.equal(s.actor.effects.get('other'), unrelated);
    assert.equal(await s.api.extinguishAoeBurning(unrelated, s.runtime), false);
});

test('failed damage roll keeps the persisted turn claim to prevent a duplicate retry', async () => {
    const s = await fixture(); const effect = await addEffect(s);
    assert.equal(await s.api.rollAoeFireTurn(effect, 'failed-turn', s.runtime), false);
    assert.equal(await s.api.rollAoeFireTurn(effect, 'failed-turn', s.runtime), false);
    assert.equal(rolls(s).length, 1); assert.equal(s.warnings.length, 1);
    assert.ok(fireState(effect).turnKeys.includes('failed-turn'));
});

test('invalid flammability choices and foreign/deleted target references cannot roll fire', async () => {
    const s = await fixture(); await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'everybody', true, s.runtime), false);
    s.documents.delete(s.target.uuid);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'volatile', true, s.runtime), false);
    assert.deepEqual(rolls(s), []); assert.equal(s.actor.effects.size, 0);
});

test('registration is idempotent and every client installs only passive hooks until elected GM', async () => {
    const s = await fixture(); const hooks = [], listeners = [];
    const runtime = {...s.runtime, Hooks: {on: (...args) => hooks.push(args)},
        document: {addEventListener: (...args) => listeners.push(args)}};
    s.api.registerAoeFire(runtime); s.api.registerAoeFire(runtime);
    assert.deepEqual(hooks.map(call => call[0]), ['updateCombat', 'renderChatMessageHTML']);
    assert.equal(listeners.length, 1); assert.deepEqual(rolls(s), []);
});

test('render hooks restore player-hidden controls even when Foundry sanitization removes hidden attributes', async () => {
    const s = await fixture(); const hooks = [];
    s.api.registerAoeFire({...s.runtime, Hooks: {on: (...args) => hooks.push(args)}});
    const render = hooks.find(([name]) => name === 'renderChatMessageHTML')[1];
    const controls = [{hidden: false}, {hidden: false}];
    const html = {querySelectorAll: () => controls};
    s.game.user = s.game.users.get('player'); render(null, html);
    assert.ok(controls.every(control => control.hidden));
    s.game.user = s.game.users.get('b-gm'); render(null, html);
    assert.ok(controls.every(control => control.hidden));
    s.game.user = s.game.users.get('a-gm'); render(null, [html]);
    assert.ok(controls.every(control => !control.hidden));
});

test('parallel target results cannot overwrite each other while message writes are awaiting the server', async () => {
    const s = await fixture({flammability: 'none'});
    const second = {...s.target, id: 'target-two', uuid: 'Scene.scene.Token.target-two'};
    s.state.targets.push({uuid: second.uuid});
    const original = s.message.update.bind(s.message);
    s.message.update = async change => {await Promise.resolve(); await original(change);};
    await Promise.all([s.api.recordAoeFireHitAsGm(s.context, s.runtime),
        s.api.recordAoeFireHitAsGm({...s.context, target: second}, s.runtime)]);
    assert.deepEqual(Object.keys(s.message.flags.world.aoeFireResults).sort(),
        [s.resultApi.aoeTargetResultKey(s.target.uuid), s.resultApi.aoeTargetResultKey(second.uuid)].sort());
    assert.equal(fireResult(s).status, 'nonflammable');
    assert.equal(fireResult(s, second.uuid).status, 'nonflammable');
});

test('parallel ignition requests for one actor cannot create stacked Burning effects', async () => {
    const s = await fixture();
    const original = s.actor.createEmbeddedDocuments.bind(s.actor);
    s.actor.createEmbeddedDocuments = async (...args) => {await Promise.resolve(); return original(...args);};
    const result = await Promise.all([
        s.api.applyAoeBurning(s.actor, {intensity: 2, maxIntensity: 3}, s.runtime),
        s.api.applyAoeBurning(s.actor, {intensity: 3, maxIntensity: 4}, s.runtime)]);
    assert.equal(result[0], result[1]); assert.equal(s.actor.effects.size, 1);
    assert.equal(fireState(result[0]).intensity, 3); assert.equal(fireState(result[0]).maxIntensity, 4);
});

test('private and blind attacks keep Fire Check, ignition, and subsequent fire turns private', async () => {
    const s = await fixture({dice: [6, 12, 8, 3]});
    s.message.whisper = ['a-gm']; s.message.blind = true;
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    assert.deepEqual(s.cards[0].whisper, ['a-gm']); assert.equal(s.cards[0].blind, true);
    await s.api.resolveAoeFireCheck(s.cards[0], 'flammable', false, s.runtime);
    assert.deepEqual(s.cards[1].whisper, ['a-gm']); assert.equal(s.cards[1].blind, true);
    const effect = s.api.getAoeBurningEffect(s.actor);
    assert.deepEqual(fireState(effect).whisper, ['a-gm']); assert.equal(fireState(effect).blind, true);
    await s.api.rollAoeFireTurn(effect, 'private-turn', s.runtime);
    assert.deepEqual(s.cards[2].whisper, ['a-gm']); assert.equal(s.cards[2].blind, true);
});

test('missing elected GM reports a pending fire check instead of silently discarding it', async () => {
    const s = await fixture(); s.game.users.clear();
    const result = await s.api.recordAoeFireHit(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, false); assert.equal(result.pending, true); assert.equal(s.warnings.length, 1);
    assert.deepEqual(rolls(s), []);
});

test('Fire Check and future-Flammability controls use themed DialogV2 content without nested forms', async () => {
    const s = await fixture(); await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    let click;
    const prompts = [];
    const runtime = {...s.runtime, document: {addEventListener: (_name, callback) => {click = callback;}},
        DialogClass: {async prompt(config) {
            prompts.push(config);
            assert.doesNotMatch(config.content, /<form[ >]/);
            assert.ok(config.classes.includes('theme-light'));
            return prompts.length === 1 ? {flammability: 'none', remember: true} : {flammability: 'volatile'};
        }}};
    s.api.registerAoeFire(runtime);
    const invoke = attribute => click({target: {closest: () => ({
        closest: () => ({dataset: {messageId: s.cards[0].id}}), hasAttribute: name => name === attribute})},
        preventDefault() {}, stopPropagation() {}});
    await invoke('data-aoe-fire-check');
    assert.match(s.cards[0].content, /data-aoe-fire-flammability/);
    await invoke('data-aoe-fire-flammability');
    assert.equal(s.actor.flags['swade-tools'].aoeFlammability, 'volatile');
    assert.match(s.cards[0].content, /Future fire checks: Volatile/);
    assert.equal(fireResult(s).status, 'nonflammable');
    assert.deepEqual(rolls(s), []);
});

test('Foundry-expanded legacy Evade results allow ignition and saved fire results remain readable without rerolling', async () => {
    const s = await fixture({autoEvade: true, evaded: false, flammability: 'flammable', dice: [6, 12]});
    s.message.flags.world.aoeEvadeResults = expandFoundryUpdate(s.message.flags.world.aoeEvadeResults);
    assert.equal(s.message.flags.world.aoeEvadeResults[s.target.uuid], undefined, 'The old raw UUID lookup is broken by Foundry');
    useFoundryPersistence(s);
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'burning');
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'burning');
    assert.equal(fireResult(s).status, 'burning');
    assert.ok(Object.keys(s.message.flags.world.aoeFireResults).every(key => !key.includes('.')));
    assert.deepEqual(rolls(s), ['1d6', '3d6x']); assert.equal(s.actor.effects.size, 1);
});

test('real fire authority plus Foundry persistence creates and resolves one GM Fire Check for a settled Evade hit', async () => {
    const s = await fixture({autoEvade: true, evaded: false, dice: [2, 11]});
    const owner = {uuid: 'Actor.source', type: 'character'};
    s.state.weaponActorUuid = owner.uuid;
    s.message.user = s.game.user;
    s.target.parent = {id: 'scene'};
    Object.assign(s.item, {type: 'weapon', actor: owner, parent: owner});
    s.game.scenes = new Map([['scene', {id: 'scene'}]]);
    s.runtime.canvasRef = {scene: {id: 'scene'}};
    s.documents.set(owner.uuid, owner); s.documents.set(s.item.uuid, s.item);
    s.message.flags.world.aoeEvadeResults = expandFoundryUpdate(s.message.flags.world.aoeEvadeResults);
    useFoundryPersistence(s);
    s.api.registerAoeFire(s.runtime);
    assert.equal((await s.api.recordAoeFireHit(s.message, s.target.uuid, s.runtime)).status, 'pending');
    assert.equal(s.cards.length, 1); assert.match(s.cards[0].content, /Fire Check/);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'volatile', false, s.runtime), true);
    assert.equal((await s.api.recordAoeFireHit(s.message, s.target.uuid, s.runtime)).status, 'burning');
    assert.equal(s.cards.length, 2); assert.equal(s.actor.effects.size, 1);
    assert.deepEqual(rolls(s), ['1d6', '3d6x']); assert.equal(s.warnings.length, 0);
    assert.equal(fireResult(s).status, 'burning');
});

test('an already expanded 2.1.17 pending Fire Check can resolve without creating a second check', async () => {
    const s = await fixture({dice: [6, 10]});
    const settings = {enabled: true, initialIntensity: 3, maxIntensity: 3};
    s.message.flags.world.aoeFireResults = expandFoundryUpdate({[s.target.uuid]: {status: 'pending', settings}});
    useFoundryPersistence(s);
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'pending');
    assert.equal(s.cards.length, 0);
    const oldCard = {flags: {'swade-tools': {aoeFireCheck: {attackMessageId: s.message.id, targetUuid: s.target.uuid}}},
        async update(change) {Object.assign(this, change);}};
    assert.equal(await s.api.resolveAoeFireCheck(oldCard, 'flammable', false, s.runtime), true);
    assert.equal(fireResult(s).status, 'burning'); assert.equal(s.actor.effects.size, 1);
    assert.deepEqual(rolls(s), ['1d6', '3d6x']);
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'burning');
});
