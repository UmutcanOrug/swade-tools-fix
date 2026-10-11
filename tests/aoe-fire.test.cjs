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
                    for (const [key, value] of Object.entries(change)) {
                        if (key.startsWith('flags.swade-tools.')) this.flags['swade-tools'][key.split('.').at(-1)] = value;
                        else this[key] = value;
                    }
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
            for (const [key, value] of Object.entries(change)) {
                if (key.startsWith('flags.world.')) this.flags.world[key.split('.').at(-1)] = value;
                else this[key] = value;
            }
        }};
    game.messages.set(message.id, message);
    documents.set(target.uuid, target); documents.set(actor.uuid, actor); documents.set(item.uuid, item);
    const runtime = {gameRef: game, fromUuid: async uuid => documents.get(uuid),
        notifications: {warn: text => warnings.push(text)},
        refreshAoeChatCard: async message => calls.push(['refresh-attack', message.id]),
        RollClass: class {
            constructor(formula) {this.formula = formula;}
            async evaluate() {
                calls.push(['roll', this.formula]);
                assert.ok(dice.length, `No test roll available for ${this.formula}`);
                this.total = dice.shift(); return this;
            }
            async render() {return `<div class="dice-roll">${this.formula}: ${this.total}</div>`;}
            toJSON() {return {class: 'Roll', formula: this.formula, total: this.total, evaluated: true};}
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
const legacyFireCheck = s => {
    s.message.flags.world.aoeFireResults = s.resultApi.withAoeTargetResult(s.message.flags.world.aoeFireResults,
        s.target.uuid, {status: 'pending', settings: {enabled: true, initialIntensity: 3, maxIntensity: 3}});
    const card = {id: `legacy-card-${s.cards.length}`,
        content: '<section><div>GM: choose target flammability.</div><button data-aoe-fire-check hidden>Fire Check</button></section>',
        flags: {'swade-tools': {aoeFireCheck: {attackMessageId: s.message.id, targetUuid: s.target.uuid},
            aoeFire: {actorUuid: s.actor.uuid, effectUuid: null}}},
        async update(change) {Object.assign(this, change);}};
    s.cards.push(card); s.game.messages.set(card.id, card); return card;
};

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

test('unconfigured flammability defaults to Flammable and automatically saves its check on the attack with no prompt or card', async () => {
    const s = await fixture({dice: [5]});
    s.runtime.DialogClass = {prompt() {assert.fail('Automatic ignition must not prompt the GM');}};
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'not-ignited');
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'not-ignited');
    assert.equal(s.cards.length, 0); assert.equal(s.actor.effects.size, 0); assert.deepEqual(rolls(s), ['1d6']);
    const result = fireResult(s);
    assert.equal(result.flammability, 'flammable'); assert.equal(result.threshold, 6); assert.equal(result.check, 5);
    assert.deepEqual(result.checkRoll, {class: 'Roll', formula: '1d6', total: 5, evaluated: true});
    assert.equal(result.damageRoll, null); assert.equal(result.damageTotal, null);
    assert.match(result.rollHtml, /1d6: 5/); assert.equal(result.actorUuid, s.actor.uuid);
    assert.ok(s.calls.some(call => call[0] === 'refresh-attack'));
    assert.equal(s.actor.flags['swade-tools'].aoeFlammability, undefined);
});

test('four AoE victims keep checks on one attack and create native damage cards only for the two actual ignitions', async () => {
    const s = await fixture({dice: [6, 12, 2, 4, 6, 9]});
    const contexts = [s.context];
    s.runtime.DialogClass = {prompt() {assert.fail('Multi-target fire must not require per-target GM prompts');}};
    for (let index = 2; index <= 4; index++) {
        const actor = {...s.actor, uuid: `Scene.scene.Token.target-${index}.Actor.victim-${index}`,
            name: `Victim ${index}`, effects: new Map(), flags: {'swade-tools': {}}};
        const target = {...s.target, id: `target-${index}`, uuid: `Scene.scene.Token.target-${index}`, actor};
        s.documents.set(actor.uuid, actor); s.documents.set(target.uuid, target);
        s.state.targets.push({uuid: target.uuid}); contexts.push({...s.context, actor, target});
    }
    for (const context of contexts) assert.equal((await s.api.recordAoeFireHitAsGm(context, s.runtime)).allowed, true);
    const results = contexts.map(context => fireResult(s, context.target.uuid));
    assert.deepEqual(results.map(result => result.status), ['burning', 'not-ignited', 'not-ignited', 'burning']);
    assert.deepEqual(results.map(result => result.check), [6, 2, 4, 6]);
    assert.deepEqual(results.map(result => result.damageTotal), [12, null, null, 9]);
    assert.ok(results.every(result => result.threshold === 6 && result.flammability === 'flammable'));
    assert.deepEqual(results.map(result => result.actorUuid), contexts.map(context => context.actor.uuid));
    assert.ok(results.every(result => result.checkRoll.class === 'Roll' && /1d6:/.test(result.rollHtml)));
    assert.equal(Object.keys(s.message.flags.world.aoeFireResults).length, 4);
    assert.equal(contexts.reduce((count, context) => count + context.actor.effects.size, 0), 2);
    assert.deepEqual(rolls(s), ['1d6', '3d6x', '1d6', '1d6', '1d6', '3d6x']);
    assert.equal(s.cards.length, 2); assert.equal(s.warnings.length, 0); assert.equal(s.dice.length, 0);
    assert.ok(s.cards.every(card => card.flags['swade-tools'].aoeFireDamage.version === 1));
    assert.deepEqual(s.cards.map(card => card.rolls[0].total), [12, 9]);
    assert.ok(s.cards.every(card => card.rolls.length === 1));
});

test('an explicit Not Flammable actor setting skips automatic ignition without a prompt or extra card', async () => {
    const s = await fixture({flammability: 'none'});
    assert.deepEqual(await s.api.recordAoeFireHitAsGm(s.context, s.runtime), {allowed: true, status: 'nonflammable'});
    assert.equal(fireResult(s).actorUuid, s.actor.uuid);
    assert.equal(fireResult(s).flammability, 'none');
    assert.equal(s.cards.length, 0); assert.equal(s.actor.effects.size, 0); assert.deepEqual(rolls(s), []);
});

test('a legacy pending Fire Check still lets the GM choose nonflammable and remember the actual unlinked-token actor', async () => {
    const s = await fixture();
    legacyFireCheck(s);
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
        assert.equal(s.cards.length, caught ? 1 : 0);
        const saved = fireResult(s);
        assert.equal(saved.threshold, {flammable: 6, very: 4, volatile: 2}[flammability]);
        assert.equal(saved.check, value); assert.equal(saved.damageTotal, caught ? 12 : null);
        if (caught) {
            assert.deepEqual(saved.damageRoll, {class: 'Roll', formula: '3d6x', total: 12, evaluated: true});
            assert.match(saved.rollHtml, /1d6: [1-6].*3d6x: 12/);
            assert.equal(s.api.getAoeBurningEffect(s.actor).name, 'On Fire');
            assert.deepEqual(s.api.getAoeBurningEffect(s.actor).statuses, ['swade-tools-on-fire']);
        }
    }
});

test('a legacy pending target can still catch fire after GM adjudication without changing item settings or adding an ignition card', async () => {
    const s = await fixture({dice: [4, 15]});
    legacyFireCheck(s);
    assert.equal(await s.api.resolveAoeFireCheck(s.cards[0], 'very', false, s.runtime), true);
    assert.equal(s.actor.flags['swade-tools'].aoeFlammability, undefined);
    assert.equal(s.item.flags['swade-tools'].aoeFireEnabled, true);
    assert.equal(s.actor.effects.size, 1); assert.equal(s.cards.length, 2);
    assert.equal(fireResult(s).damageTotal, 15); assert.equal(fireResult(s).threshold, 4);
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
    assert.match(s.cards[0].content, /Fire Continues to Burn/); assert.match(s.cards[0].content, /Intensity grows to 3d6/);
    assert.match(s.cards[0].flavor, /Fire Damage: 2d6/);
});

test('a fire-check six stays at the configured maximum; 2–5 keeps intensity unchanged', async () => {
    for (const check of [2, 3, 4, 5, 6]) {
        const s = await fixture({dice: [9, check]});
        const effect = await addEffect(s);
        await s.api.rollAoeFireTurn(effect, 'Combat.combat:1:victim', s.runtime);
        assert.equal(fireState(effect).intensity, 3); assert.match(s.cards[0].content, /Fire Continues to Burn/);
        assert.match(s.cards[0].content, /Intensity: 3d6/);
    }
});

test('a fire-check one reduces intensity after damage, and extinguishes below one die', async () => {
    const s = await fixture({dice: [9, 1, 5, 1]});
    const effect = await s.api.applyAoeBurning(s.actor, {intensity: 2, maxIntensity: 3}, s.runtime);
    await s.api.rollAoeFireTurn(effect, 'turn-one', s.runtime);
    assert.equal(fireState(effect).intensity, 1); assert.match(s.cards[0].content, /drops to 1d6/);
    await s.api.rollAoeFireTurn(effect, 'turn-two', s.runtime);
    assert.equal(effect.deleted, true); assert.equal(s.actor.effects.size, 0);
    assert.match(s.cards[1].content, /Fire Extinguishes/); assert.doesNotMatch(s.cards[1].content, /data-aoe-fire-tick/);
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

test('only the primary GM normalizes legacy Burning icons once across linked and synthetic actors without touching duration or unrelated effects', async () => {
    const s = await fixture();
    const synthetic = await addEffect(s);
    const linkedActor = {...s.actor, uuid: 'Actor.linked-victim', effects: new Map(), flags: {'swade-tools': {}}};
    const linked = await s.api.applyAoeBurning(linkedActor, {intensity: 2, maxIntensity: 4}, s.runtime);
    for (const effect of [synthetic, linked]) {
        effect.name = 'Burning'; effect.img = 'legacy-fire.png'; effect.statuses = new Set(['existing-status']);
        effect.duration = {rounds: null, seconds: null};
    }
    synthetic.disabled = true;
    const previousStates = [synthetic, linked].map(effect => structuredClone(fireState(effect)));
    let unrelatedUpdates = 0;
    const unrelated = {id: 'foreign-effect', name: 'Foreign Fire', img: 'foreign.png', statuses: new Set(['burning']),
        flags: {'other-module': {burning: true}}, async update() {unrelatedUpdates++;}};
    linkedActor.effects.set(unrelated.id, unrelated);
    s.game.actors = new Map([[linkedActor.uuid, linkedActor]]);
    s.runtime.canvasRef = {tokens: {placeables: [{actor: linkedActor}, {actor: s.actor}, {actor: s.actor}]}};
    for (const id of ['player', 'b-gm']) {
        s.game.user = s.game.users.get(id);
        assert.equal(await s.api.normalizeAoeBurningEffects(s.runtime), 0);
        assert.equal(synthetic.name, 'Burning'); assert.equal(linked.name, 'Burning');
    }
    s.game.user = s.game.users.get('a-gm');
    assert.equal(await s.api.normalizeAoeBurningEffects(s.runtime), 2);
    assert.equal(await s.api.normalizeAoeBurningEffects(s.runtime), 0);
    for (const [index, effect] of [synthetic, linked].entries()) {
        assert.equal(effect.name, 'On Fire'); assert.equal(effect.img, 'modules/swade-tools/assets/on-fire.svg');
        assert.deepEqual(effect.statuses, ['existing-status', 'swade-tools-on-fire']);
        assert.deepEqual(effect.duration, {rounds: null, seconds: null});
        assert.deepEqual(fireState(effect), previousStates[index]);
    }
    assert.equal(synthetic.disabled, true, 'Migration adds a marker but does not activate disabled fire');
    assert.equal(unrelatedUpdates, 0); assert.equal(unrelated.name, 'Foreign Fire');
    assert.deepEqual([...unrelated.statuses], ['burning']);
    const updates = s.calls.filter(([name]) => name === 'effect-update');
    assert.equal(updates.length, 2, 'Linked and synthetic duplicates migrate once each');
    assert.ok(updates.every(([, change]) => Object.keys(change).sort().join(',') === 'img,name,statuses'));
    assert.equal(s.cards.length, 0); assert.deepEqual(rolls(s), []);
});

test('failed damage roll keeps the persisted turn claim to prevent a duplicate retry', async () => {
    const s = await fixture(); const effect = await addEffect(s);
    assert.equal(await s.api.rollAoeFireTurn(effect, 'failed-turn', s.runtime), false);
    assert.equal(await s.api.rollAoeFireTurn(effect, 'failed-turn', s.runtime), false);
    assert.equal(rolls(s).length, 1); assert.equal(s.warnings.length, 1);
    assert.ok(fireState(effect).turnKeys.includes('failed-turn'));
});

test('invalid flammability choices and foreign/deleted target references cannot roll fire', async () => {
    const s = await fixture(); legacyFireCheck(s);
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
    assert.deepEqual(hooks.map(call => call[0]), ['updateCombat', 'canvasReady', 'renderChatMessageHTML']);
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

test('private and blind attacks retain native ignition rolls on their private source and keep subsequent fire turns private', async () => {
    const s = await fixture({dice: [6, 12, 8, 3]});
    s.message.whisper = ['a-gm']; s.message.blind = true;
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    assert.equal(s.cards.length, 1);
    assert.deepEqual(s.message.whisper, ['a-gm']); assert.equal(s.message.blind, true);
    assert.deepEqual(fireResult(s).checkRoll, {class: 'Roll', formula: '1d6', total: 6, evaluated: true});
    assert.deepEqual(fireResult(s).damageRoll, {class: 'Roll', formula: '3d6x', total: 12, evaluated: true});
    const effect = s.api.getAoeBurningEffect(s.actor);
    assert.deepEqual(fireState(effect).whisper, ['a-gm']); assert.equal(fireState(effect).blind, true);
    await s.api.rollAoeFireTurn(effect, 'private-turn', s.runtime);
    assert.equal(s.cards.length, 2);
    assert.deepEqual(s.cards[0].whisper, ['a-gm']); assert.equal(s.cards[0].blind, true);
    assert.deepEqual(s.cards[1].whisper, ['a-gm']); assert.equal(s.cards[1].blind, true);
});

test('missing elected GM reports a pending fire check instead of silently discarding it', async () => {
    const s = await fixture(); s.game.users.clear();
    const result = await s.api.recordAoeFireHit(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, false); assert.equal(result.pending, true); assert.equal(s.warnings.length, 1);
    assert.deepEqual(rolls(s), []);
});

test('legacy Fire Check and future-Flammability controls keep themed DialogV2 content without nested forms', async () => {
    const s = await fixture(); legacyFireCheck(s);
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

const installFireClickHandler = s => {
    let click;
    s.api.registerAoeFire({...s.runtime,
        document: {addEventListener(_name, callback) {click = callback;}}});
    return (attribute, dataset = {}, messageId = s.message.id) => click({
        target: {closest() {return {dataset,
            closest() {return {dataset: {messageId}};}, hasAttribute(name) {return name === attribute;}};}},
        preventDefault() {}, stopPropagation() {}});
};

test('inline Extinguish requires the persisted attack, result, actual target actor, and effect binding', async () => {
    const mutations = [
        s => {s.state.targets = [];},
        (s, data) => {data.aoeFireTarget = 'Scene.scene.Token.foreign';},
        (s, data) => {data.aoeFireEffect = 'Actor.foreign.ActiveEffect.fire';},
        (s, data) => {data.aoeFireActor = 'Actor.foreign';},
        s => {fireResult(s).effectUuid = 'Actor.stale.ActiveEffect.fire';},
        s => {fireResult(s).actorUuid = 'Actor.stale';},
        s => {s.target.actor = {...s.actor, uuid: 'Actor.replacement'};},
        s => {s.documents.delete(s.target.uuid);},
        s => {s.game.user = s.game.users.get('player');},
        s => {s.game.user = s.game.users.get('b-gm');}
    ];
    for (const mutate of mutations) {
        const s = await fixture({dice: [6, 12]});
        await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
        const effect = s.api.getAoeBurningEffect(s.actor);
        const data = {aoeFireEffect: effect.uuid, aoeFireActor: s.actor.uuid, aoeFireTarget: s.target.uuid};
        mutate(s, data);
        const click = installFireClickHandler(s);
        await click('data-aoe-fire-extinguish', data);
        assert.equal(effect.deleted, undefined, 'Stale or forged button must not delete the existing fire');
        assert.equal(s.actor.effects.size, 1); assert.equal(s.cards.length, 1);
        assert.deepEqual(rolls(s), ['1d6', '3d6x']);
    }
    const s = await fixture({dice: [6, 12]});
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    const effect = s.api.getAoeBurningEffect(s.actor);
    await installFireClickHandler(s)('data-aoe-fire-extinguish', {
        aoeFireEffect: effect.uuid, aoeFireActor: s.actor.uuid, aoeFireTarget: s.target.uuid});
    assert.equal(effect.deleted, true); assert.equal(s.actor.effects.size, 0);
    assert.equal(fireResult(s).status, 'extinguished'); assert.equal(s.cards.length, 1);
});

test('legacy native fire-turn card controls still tick once and extinguish their own effect without inline bindings', async () => {
    const s = await fixture({dice: [9, 3, 10, 2]});
    const effect = await addEffect(s);
    await s.api.rollAoeFireTurn(effect, 'initial-turn', s.runtime);
    const oldCard = s.cards[0];
    const click = installFireClickHandler(s);
    await click('data-aoe-fire-tick', {}, oldCard.id);
    await click('data-aoe-fire-tick', {}, oldCard.id);
    assert.deepEqual(rolls(s), ['3d6x', '1d6', '3d6x', '1d6']);
    assert.equal(s.cards.length, 2); assert.match(s.warnings.at(-1), /already resolved/);
    await click('data-aoe-fire-extinguish', {}, oldCard.id);
    assert.equal(effect.deleted, true); assert.equal(s.actor.effects.size, 0);
    assert.match(oldCard.content, /Fire Extinguishes — GM/);
    assert.equal(oldCard.flags['swade-tools'].aoeFireDamage.version, 1);
    assert.equal(oldCard.rolls[0].total, 9, 'Extinguish must not erase the existing damage roll');
    assert.equal(s.cards.length, 2);
});

test('optional dice rendering failures preserve automatic ignition and its one native bound damage card', async () => {
    const s = await fixture({dice: [6, 12]});
    const NativeMock = s.runtime.RollClass;
    s.runtime.RollClass = class extends NativeMock {async render() {throw new Error('Optional renderer unavailable');}};
    assert.equal((await s.api.recordAoeFireHitAsGm(s.context, s.runtime)).status, 'burning');
    assert.equal(fireResult(s).damageTotal, 12); assert.equal(fireResult(s).check, 6);
    assert.equal(fireResult(s).checkRoll.total, 6); assert.equal(fireResult(s).damageRoll.total, 12);
    assert.equal(fireResult(s).rollHtml, ''); assert.equal(s.actor.effects.size, 1);
    assert.equal(s.cards.length, 1); assert.equal(s.warnings.length, 0);
    assert.equal(s.cards[0].rolls[0].total, 12);
    assert.equal(s.cards[0].flags['swade-tools'].aoeFireDamage.version, 1);
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

test('real fire authority plus Foundry persistence automatically resolves ignition with exactly one native fire damage card', async () => {
    const s = await fixture({autoEvade: true, evaded: false, dice: [6, 11]});
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
    assert.equal((await s.api.recordAoeFireHit(s.message, s.target.uuid, s.runtime)).status, 'burning');
    assert.equal((await s.api.recordAoeFireHit(s.message, s.target.uuid, s.runtime)).status, 'burning');
    assert.equal(s.cards.length, 1); assert.equal(s.actor.effects.size, 1);
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

test('colored fire status explicitly separates ignition, continuation, growth, reduction and extinction', async () => {
    const {renderAoeFireStatus} = await service;
    assert.match(renderAoeFireStatus(3, 3, true), /Target Catches Fire/);
    for (const [previous, next] of [[3, 3], [2, 3], [3, 2]]) {
        const html = renderAoeFireStatus(previous, next);
        assert.match(html, /Fire Continues to Burn/);
        assert.match(html, /data-aoe-fire-status="burning"/);
        assert.doesNotMatch(html, /Fire Extinguishes/);
    }
    assert.match(renderAoeFireStatus(2, 3), /color:#b5261e.*Intensity grows to 3d6/);
    assert.match(renderAoeFireStatus(3, 2), /Intensity drops to 2d6/);
    assert.match(renderAoeFireStatus(1, 0), /color:#23752b.*Fire Extinguishes/);
    assert.doesNotMatch(renderAoeFireStatus(1, 0), /Continues|Intensity/);
});

test('native fire damage keeps its primary result visible and all special GM controls in closed More Details', async () => {
    const s = await fixture({dice: [10, 1]});
    const effect = await addEffect(s);
    await s.api.rollAoeFireTurn(effect, 'compact-turn', s.runtime);
    const card = s.cards[0];
    const details = card.content.match(/<details\b[^>]*>[\s\S]*?<\/details>/)[0];
    assert.match(card.content.slice(0, card.content.indexOf('<details')), /Fire Continues to Burn/);
    assert.match(details, /<summary>More Details<\/summary>/);
    assert.doesNotMatch(details, /<details[^>]*\bopen\b/);
    for (const action of ['tick', 'adjust', 'extinguish']) assert.match(details, new RegExp(`data-aoe-fire-${action} hidden`));
    assert.doesNotMatch(card.content, /data-aoe-fire-flammability|applies damage manually/);
    assert.equal(card.rolls.length, 1, 'Only the actual damage roll is the native significant roll');
    assert.equal(card.rolls[0].total, 10);
    assert.equal(card.flags['swade-tools'].aoeFire.checkRoll.total, 1);
    assert.equal(card.flags['swade-tools'].aoeFireDamage.targetUuid, s.target.uuid);
    assert.match(card.flavor, /modules\/swade-tools\/assets\/on-fire.svg/);
});

test('an extinguishing turn retains its native last damage result but offers no future fire controls', async () => {
    const s = await fixture({dice: [7, 1]});
    const effect = await s.api.applyAoeBurning(s.actor, {intensity: 1, maxIntensity: 3, tokenUuid: s.target.uuid}, s.runtime);
    await s.api.rollAoeFireTurn(effect, 'final-turn', s.runtime);
    const card = s.cards[0];
    assert.equal(effect.deleted, true);
    assert.match(card.content, /Fire Extinguishes/);
    assert.match(card.content, /color:#23752b/);
    assert.doesNotMatch(card.content, /data-aoe-fire-(tick|adjust|extinguish)/);
    assert.equal(card.rolls[0].total, 7);
    assert.equal(card.flags['swade-tools'].rolltype, 'damage');
    assert.equal(card.flags['swade-tools'].aoeFireDamage.actorUuid, s.actor.uuid);
});

test('initial fire damage card is created exactly once with original target and no extra damage evaluation', async () => {
    const s = await fixture({dice: [6, 13]});
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    await s.api.recordAoeFireHitAsGm(s.context, s.runtime);
    assert.equal(s.cards.length, 1);
    assert.equal(fireResult(s).damageMessageId, s.cards[0].id);
    assert.equal(s.cards[0].rolls[0].total, 13);
    assert.match(s.cards[0].content, /Target Catches Fire/);
    assert.equal(s.cards[0].flags['swade-tools'].aoeFireDamage.targetUuid, s.target.uuid);
    assert.deepEqual(rolls(s), ['1d6', '3d6x']);
});
