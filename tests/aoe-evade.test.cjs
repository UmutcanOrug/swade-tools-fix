const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const authority = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeAuthority.js')).href);
const service = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeEvade.js')).href);
const resultsService = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeTargetResults.js')).href);

async function fixture({wild = true, total = 5, faces = [7, 2], modifier = -2,
    autoEvade = true, improvedDodge = false, activeGm = true} = {}) {
    const api = await service;
    const auth = await authority;
    const results = await resultsService;
    const gm = {id: 'gm', isGM: true, active: activeGm};
    const player = {id: 'player', isGM: false, active: true};
    const owner = {uuid: 'Actor.owner', ownership: {player: 3}, type: 'character'};
    const item = {uuid: 'Actor.owner.Item.weapon', type: 'weapon', actor: owner};
    const actor = {uuid: 'Actor.victim', name: 'Victim <one>', isWildcard: wild,
        system: {attributes: {agility: {die: {sides: 6}}}},
        items: improvedDodge ? [{type: 'edge', name: 'Improved Dodge'}] : []};
    const target = {uuid: 'Scene.scene.Token.victim', actor, parent: {id: 'scene'}};
    const state = {version: 1, sceneId: 'scene', weaponActorUuid: owner.uuid,
        operatorActorUuid: owner.uuid, itemUuid: item.uuid, damageItemUuid: item.uuid,
        baseTotal: 5, gmModifier: 0, targets: [{uuid: target.uuid}], autoEvade, evadeModifier: modifier};
    const updates = [], chat = [], calls = [], warnings = [];
    const message = {id: `attack-${Math.random()}`, user: player,
        flags: {world: {aoeAttack: state}},
        async update(change) {
            updates.push(change);
            for (const [key, value] of Object.entries(change)) {
                if (key.startsWith('flags.world.')) this.flags.world[key.slice('flags.world.'.length)] = value;
            }
        }};
    const documents = new Map([owner, item, target].map(value => [value.uuid, value]));
    const gameRef = {user: gm, users: new Map([[gm.id, gm], [player.id, player]]),
        messages: new Map([[message.id, message]])};
    class CharRoll {
        constructor(actor) { calls.push(['actor', actor]); }
        addModifier(...args) { calls.push(['modifier', ...args]); }
        async rollAtt(attribute) { calls.push(['roll', attribute]);
            const data = {class: 'Roll', formula: '1d6x', total,
                dice: faces.map(face => ({results: [{result: face}], total: face}))};
            return {...data, toJSON() { return structuredClone(data); },
                async render() { return `<div class="dice-roll"><div class="dice-total">${total}</div></div>`; }}; }
    }
    class ChatMessage {
        static getSpeaker(data) { return data; }
        static async create(data) { chat.push(data); return data; }
    }
    const runtime = {gameRef, canvasRef: {scene: {id: 'scene'}},
        fromUuid: async uuid => documents.get(uuid), CharRollClass: CharRoll, ChatMessageClass: ChatMessage,
        refreshAoeChatCard: async message => calls.push(['refresh', message.id]),
        notifications: {warn: text => warnings.push(text)}};
    api.registerAoeEvadeAuthority();
    return {api, auth, runtime, gameRef, message, state, owner, item, target, actor,
        player, gm, documents, calls, chat, warnings, updates, results};
}

const legacyDefense = s => ({flags: {world: {aoeEvadeCheck:
    {attackId: s.message.id, targetUuid: s.target.uuid}}},
async update(change) { Object.assign(this, change); }});

test('AoE with automatic Evade disabled needs no Foundry runtime or GM', async () => {
    const {resolveAoeEvade} = await service;
    assert.deepEqual(await resolveAoeEvade({flags: {world: {aoeAttack: {autoEvade: false}}}}, 'uuid'),
        {allowed: true, evaded: false, pending: false});
});

test('automatic Evade uses native Agility once per target and keeps its roll audit on the attack without new cards', async () => {
    const s = await fixture();
    const first = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    const second = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(first.evaded, true);
    assert.equal(first.allowed, false);
    assert.deepEqual(first, second);
    assert.deepEqual(s.calls.filter(call => call[0] === 'roll'), [['roll', 'agility']]);
    assert.deepEqual(s.calls.filter(call => call[0] === 'modifier'), [['modifier', -2, 'Evade']]);
    assert.equal(s.chat.length, 0);
    const saved = s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid);
    assert.equal(saved.evaded, true);
    assert.deepEqual(saved.rollData, {class: 'Roll', formula: '1d6x', total: 5,
        dice: [{results: [{result: 7}], total: 7}, {results: [{result: 2}], total: 2}]});
    assert.match(saved.rollHtml, /class="dice-total">5/);
    assert.equal(s.calls.filter(call => call[0] === 'refresh').length, 1);
    assert.equal(s.state.autoEvade, true);
    assert.equal(s.updates.some(update => 'flags.world.aoeAttack' in update), false);
});

test('an unavailable dice renderer leaves the native Evade audit and defense outcome intact', async t => {
    const s = await fixture();
    t.mock.method(console, 'warn', () => {});
    const NativeMock = s.runtime.CharRollClass;
    s.runtime.CharRollClass = class extends NativeMock {
        async rollAtt(attribute) {
            const roll = await super.rollAtt(attribute);
            roll.render = async () => { throw new Error('Dice renderer unavailable'); };
            return roll;
        }
    };
    const outcome = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(outcome.evaded, true);
    assert.equal(outcome.pending, false);
    const result = s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid);
    assert.equal(result.rollData.total, 5);
    assert.equal(result.rollHtml, undefined);
    assert.equal(s.chat.length, 0);
    assert.equal(s.calls.filter(call => call[0] === 'refresh').length, 1);
});

test('failed Evade allows damage and Improved Dodge is added once rather than ordinary Dodge', async () => {
    const s = await fixture({total: 3, improvedDodge: true});
    const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, true);
    assert.equal(result.evaded, false);
    assert.deepEqual(s.calls.filter(call => call[0] === 'modifier'),
        [['modifier', -2, 'Evade'], ['modifier', 2, 'Improved Dodge']]);
    const ordinary = await fixture({total: 3});
    ordinary.actor.items = [{type: 'edge', name: 'Dodge'}];
    await ordinary.api.resolveAoeEvade(ordinary.message, ordinary.target.uuid, ordinary.runtime);
    assert.equal(ordinary.calls.filter(call => call[0] === 'modifier').length, 1);
});

test('natural ones cannot become an Evade success through modifiers', async () => {
    const wild = await fixture({total: 9, faces: [1, 1]});
    assert.equal((await wild.api.resolveAoeEvade(wild.message, wild.target.uuid, wild.runtime)).criticalFailure, true);
    assert.equal(wild.results.getAoeTargetResult(wild.message.flags.world.aoeEvadeResults, wild.target.uuid).evaded, false);
    const extra = await fixture({wild: false, total: 9, faces: [1]});
    const result = await extra.api.resolveAoeEvade(extra.message, extra.target.uuid, extra.runtime);
    assert.equal(result.allowed, true);
    assert.equal(result.naturalOneFailure, true);
});

test('automatic Evade without active GM is pending and cannot silently damage a target', async () => {
    const s = await fixture({activeGm: false});
    s.gameRef.user = s.player;
    const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, false);
    assert.equal(result.pending, true);
    assert.equal(s.calls.length, 0);
    assert.equal(s.chat.length, 0);
    assert.match(s.warnings[0], /active GM/);
});

test('authority elects one active GM and refuses arbitrary action names and payload keys', async () => {
    const s = await fixture();
    s.gameRef.users.set('aa-gm', {id: 'aa-gm', active: true, isGM: true});
    assert.equal(s.auth.getPrimaryAoeGm(s.gameRef).id, 'aa-gm');
    assert.equal(s.auth.isPrimaryAoeGm(s.gameRef), false);
    assert.throws(() => s.auth.registerAoeAuthorityHandler('executeScript', () => true), /Unsupported/);
    s.gameRef.users.delete('aa-gm');
    assert.equal((await s.auth.requestAoeAuthority('executeScript', {messageId: s.message.id,
        targetUuid: s.target.uuid}, s.runtime)).allowed, false);
    assert.equal((await s.auth.requestAoeAuthority('evade', {messageId: s.message.id,
        targetUuid: s.target.uuid, actorUuid: s.actor.uuid, formula: '1d100'}, s.runtime)).allowed, false);
    assert.equal(s.calls.length, 0);
});

test('claimed GM sender cannot authorize a player-authored attack with an unowned source', async () => {
    const s = await fixture();
    const payload = {messageId: s.message.id, targetUuid: s.target.uuid};
    // Legitimate GM assistance on a player-owned attack remains supported.
    assert.ok(await s.auth.validateAoeAuthorityContext(payload, s.gm.id, s.runtime));
    s.owner.ownership.player = 0;
    assert.equal(await s.auth.validateAoeAuthorityContext(payload, s.gm.id, s.runtime), null);
    // A real persisted GM-authored NPC attack remains legitimate.
    s.message.user = s.gm;
    assert.ok(await s.auth.validateAoeAuthorityContext(payload, s.gm.id, s.runtime));
    s.message.user = {id: 'deleted-author', isGM: true};
    assert.equal(await s.auth.validateAoeAuthorityContext(payload, s.gm.id, s.runtime), null);
});

test('authority rejects unowned/unrelated/superseded/missed/inactive-scene targets before rolling', async () => {
    for (const mutation of [
        s => { s.message.flags.world.aoeSuperseded = true; },
        s => { s.state.baseTotal = 3; },
        s => { s.state.criticalFailure = true; },
        s => { s.state.targets = []; },
        s => { s.runtime.canvasRef.scene.id = 'another'; },
        s => { s.item.actor = {uuid: 'Actor.unrelated'}; },
        s => { s.message.user = {id: 'another-player'}; },
        s => { s.owner.ownership.player = 0; },
    ]) {
        const s = await fixture();
        mutation(s);
        const context = await s.auth.validateAoeAuthorityContext({messageId: s.message.id,
            targetUuid: s.target.uuid}, s.player.id, s.runtime);
        assert.equal(context, null);
        assert.equal(s.calls.length, 0);
    }
});

test('a resolved deviation permits Evade even when the original blast attack missed', async () => {
    const s = await fixture({total: 3});
    s.state.baseTotal = 3;
    s.state.deviationResolved = true;
    assert.equal((await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime)).allowed, true);
    assert.equal(s.chat.length, 0);
});

test('GM authority resolves stored-scene documents while the GM views a different scene', async () => {
    const s = await fixture();
    s.gameRef.scenes = new Map([['scene', {id: 'scene'}]]);
    s.runtime.canvasRef.scene.id = 'gm-another-scene';
    assert.equal((await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime)).evaded, true);
    const payload = {messageId: s.message.id, targetUuid: s.target.uuid};
    s.gameRef.scenes.delete('scene');
    assert.equal(await s.auth.validateAoeAuthorityContext(payload, s.player.id, s.runtime), null);
    s.gameRef.scenes.set('scene', {id: 'scene'});
    s.target.parent.id = 'wrong-scene';
    assert.equal(await s.auth.validateAoeAuthorityContext(payload, s.player.id, s.runtime), null);
});

test('a failed cone cannot gain a damage or defense workflow from a stale deviation flag', async () => {
    for (const settings of [
        {shape: 'cone'},
        ...['cone', 'ray', 'rect'].map(type => ({shape: 'custom',
            customShape: {type, distance: 6, width: 2, angle: 60}})),
    ]) {
        const s = await fixture();
        Object.assign(s.state, settings, {baseTotal: 3, deviationResolved: true});
        const payload = {messageId: s.message.id, targetUuid: s.target.uuid};
        assert.equal(await s.auth.validateAoeAuthorityContext(payload, s.player.id, s.runtime), null);
        const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
        assert.equal(result.allowed, false);
        assert.equal(s.calls.length, 0);
    }
});

test('custom circle authority allows a missed blast only after explicit GM deviation, without duplicate Evade', async () => {
    const s = await fixture({total: 3});
    Object.assign(s.state, {baseTotal: 3, shape: 'custom',
        customShape: {type: 'circle', distance: 4.5, width: 2, angle: 60}});
    const payload = {messageId: s.message.id, targetUuid: s.target.uuid};
    assert.equal(await s.auth.validateAoeAuthorityContext(payload, s.player.id, s.runtime), null);
    s.state.deviationResolved = true;
    assert.ok(await s.auth.validateAoeAuthorityContext(payload, s.player.id, s.runtime));
    assert.equal((await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime)).allowed, true);
    assert.equal((await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime)).allowed, true);
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 1);
    assert.equal(s.chat.length, 0);
});

test('targets without Agility keep a pending GM decision on the original attack without an extra card', async () => {
    const s = await fixture();
    delete s.actor.system.attributes.agility;
    assert.equal((await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime)).pending, true);
    assert.equal((await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime)).pending, true);
    assert.equal(s.chat.length, 0);
    assert.match(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid).reason,
        /no Agility die.*AoE attack card/);
    assert.equal(s.calls.filter(call => call[0] === 'refresh').length, 1);
    assert.equal(await s.api.setAoeAttackEvadeOutcome(s.message, s.target.uuid, false, s.runtime), true);
    const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, true);
    assert.equal(result.pending, false);
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 0);
});

test('concurrent Evade requests share a single GM roll and result without extra chat cards', async () => {
    const s = await fixture();
    let resolveRoll;
    s.runtime.CharRollClass = class {
        addModifier() {}
        async rollAtt() { s.calls.push(['roll']); return new Promise(resolve => resolveRoll = resolve); }
    };
    const first = s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    const second = s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 1);
    resolveRoll({total: 4, dice: [{total: 6}, {total: 2}]});
    assert.deepEqual(await first, await second);
    assert.equal(s.chat.length, 0);
});

test('a Benny superseding the card during the Evade roll prevents persisted defense or damage', async () => {
    const s = await fixture();
    s.runtime.CharRollClass = class {
        addModifier() {}
        async rollAtt() { s.message.flags.world.aoeSuperseded = true;
            return {total: 4, dice: [{total: 6}, {total: 2}]}; }
    };
    const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, false);
    assert.equal(result.pending, true);
    assert.equal(s.message.flags.world.aoeEvadeResults, undefined);
    assert.equal(s.chat.length, 0);
});

test('different targets on the same attack serialize their persisted result maps', async () => {
    const s = await fixture();
    const second = {...s.target, uuid: 'Scene.scene.Token.second'};
    s.documents.set(second.uuid, second);
    s.state.targets.push({uuid: second.uuid});
    const originalUpdate = s.message.update.bind(s.message);
    s.message.update = async change => { await new Promise(resolve => setImmediate(resolve));
        return originalUpdate(change); };
    await Promise.all([s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime),
        s.api.resolveAoeEvade(s.message, second.uuid, s.runtime)]);
    assert.equal(Object.keys(s.message.flags.world.aoeEvadeResults).length, 2);
    assert.equal(s.chat.length, 0);
});

test('GM can adjudicate Hit/Evaded without rerolling or silently reversing existing damage', async () => {
    const s = await fixture();
    await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    const defense = legacyDefense(s);
    s.state.damageWorkflowStarted = true;
    assert.equal(await s.api.setAoeEvadeOutcome(defense, false, s.runtime), true);
    assert.equal(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid).evaded, false);
    assert.equal(s.message.flags.world.aoeAttack.reviewExistingDamage, true);
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 1);
    s.gameRef.user = s.player;
    assert.equal(await s.api.setAoeEvadeOutcome(defense, true, s.runtime), false);
});

test('inline GM adjudication preserves the native roll, never rerolls, and rejects player or unrelated targets', async () => {
    const s = await fixture();
    await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    const previous = structuredClone(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid));
    assert.equal(await s.api.setAoeAttackEvadeOutcome(s.message, s.target.uuid, false, s.runtime), true);
    const updated = s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid);
    assert.equal(updated.evaded, false);
    assert.equal(updated.gmOverride, true);
    assert.deepEqual(updated.rollData, previous.rollData);
    assert.equal(updated.rollHtml, previous.rollHtml);
    assert.equal(s.message.flags.world.aoeAttack.reviewExistingDamage, undefined);
    assert.equal(await s.api.setAoeAttackEvadeOutcome(s.message, 'Scene.scene.Token.unrelated', true, s.runtime), false);
    assert.equal(await s.api.setAoeAttackEvadeOutcome(s.message, s.target.uuid, 'evaded', s.runtime), false);
    s.gameRef.user = s.player;
    assert.equal(await s.api.setAoeAttackEvadeOutcome(s.message, s.target.uuid, true, s.runtime), false);
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 1);
    assert.equal(s.chat.length, 0);
    assert.ok(s.updates.every(update => Object.keys(update).every(key => key.startsWith('flags.world.'))));
});

test('legacy standalone Evade cards remain readable and adjudicable after new attacks stop creating them', async () => {
    const s = await fixture();
    delete s.actor.system.attributes.agility;
    await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    const defense = legacyDefense(s);
    assert.equal(await s.api.setAoeEvadeOutcome(defense, false, s.runtime), true);
    assert.match(defense.content, /GM adjudication \(no Agility die\)/);
    assert.match(defense.content, /Hit \(GM\)/);
    assert.doesNotMatch(defense.content, /undefined|NaN/);
    assert.equal(await s.api.setAoeEvadeOutcome(defense, true, s.runtime), true);
    assert.match(defense.content, /Evaded \(GM\)/);
    assert.equal(s.chat.length, 0);
});

test('pending Evade adjudication follows a valid Benny successor without changing superseded defense data', async () => {
    const s = await fixture();
    delete s.actor.system.attributes.agility;
    await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    const defense = legacyDefense(s);
    const next = {id: `${s.message.id}-reroll`, user: s.player,
        flags: {world: {aoeAttack: structuredClone(s.state),
            aoePreviousMessage: s.message.id, aoeEvadeResults: structuredClone(s.message.flags.world.aoeEvadeResults)}},
        async update(change) { for (const [key, value] of Object.entries(change)) {
            if (key.startsWith('flags.world.')) this.flags.world[key.slice('flags.world.'.length)] = value;
        } }};
    s.message.flags.world.aoeSuperseded = true;
    s.message.flags.world.aoeSupersededBy = next.id;
    s.gameRef.messages.set(next.id, next);
    assert.equal(await s.api.setAoeEvadeOutcome(defense, false, s.runtime), true);
    assert.equal(s.results.getAoeTargetResult(next.flags.world.aoeEvadeResults, s.target.uuid).evaded, false);
    assert.equal(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid).evaded, null);
    assert.equal(defense.flags.world.aoeEvadeCheck.attackId, s.message.id);
    // Inline controls on an old attack follow the same validated successor.
    assert.equal(await s.api.setAoeAttackEvadeOutcome(s.message, s.target.uuid, true, s.runtime), true);
    assert.equal(s.results.getAoeTargetResult(next.flags.world.aoeEvadeResults, s.target.uuid).evaded, true);
    assert.equal(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid).evaded, null);
    for (const mutate of [
        () => { next.flags.world.aoeAttack.itemUuid = 'Actor.other.Item.other'; },
        () => { next.flags.world.aoeAttack.itemUuid = s.item.uuid; next.flags.world.aoePreviousMessage = 'unrelated'; },
        () => { next.flags.world.aoePreviousMessage = s.message.id; next.flags.world.aoeAttack.targets = []; },
    ]) {
        mutate();
        assert.equal(await s.api.setAoeEvadeOutcome(defense, true, s.runtime), false);
    }
});

test('player request is routed to the elected GM; non-author requests and malformed responses fail closed', async () => {
    const s = await fixture({total: 3});
    const listeners = [];
    // Foundry V13's server forwards (payload, authenticatedSenderId), and can
    // route to explicit recipients. Each mock client has its own connection.
    const socketFor = userId => ({on(channel, listener) { listeners.push({userId, listener}); },
        emit(channel, envelope, options = {}) {
            for (const entry of listeners) {
                if (options.recipients && !options.recipients.includes(entry.userId)) continue;
                if (entry.userId !== userId) void entry.listener(envelope, userId);
            }
        }});
    s.gameRef.socket = socketFor(s.gm.id);
    const playerGame = {...s.gameRef, user: s.player, socket: socketFor(s.player.id)};
    s.auth.registerAoeAuthority(s.runtime);
    const playerRuntime = {...s.runtime, gameRef: playerGame, timeoutMs: 50};
    const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, playerRuntime);
    assert.equal(result.allowed, true);
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 1);
    const other = {id: 'other', active: true, isGM: false};
    s.gameRef.users.set(other.id, other);
    const denied = await s.auth.requestAoeAuthority('evade', {messageId: s.message.id,
        targetUuid: s.target.uuid}, {...playerRuntime, gameRef: {...playerGame, user: other, socket: socketFor(other.id)}});
    assert.equal(denied.allowed, false);
    assert.equal(denied.pending, false);
    const noReplyGame = {...playerGame, socket: {on() {}, emit() {}}};
    const expired = await s.auth.requestAoeAuthority('evade', {messageId: s.message.id,
        targetUuid: s.target.uuid}, {...playerRuntime, gameRef: noReplyGame, timeoutMs: 10});
    assert.equal(expired.allowed, false);
    assert.equal(expired.pending, true);
});

test('socket authority ignores forged envelope sender IDs and non-GM response senders', async () => {
    const s = await fixture();
    const other = {id: 'other', active: true, isGM: false};
    s.gameRef.users.set(other.id, other);
    const emitted = [], callbacks = [];
    const socket = {on(_channel, callback) { callbacks.push(callback); },
        emit(_channel, envelope) { emitted.push(envelope); }};
    s.gameRef.socket = socket;
    s.auth.registerAoeAuthority(s.runtime);
    const gmListener = callbacks[0];
    const envelope = {protocol: 'swade-tools.aoe-authority.v1', kind: 'request', id: 'forged',
        gmId: s.gm.id, requesterId: s.gm.id, action: 'evade',
        payload: {messageId: s.message.id, targetUuid: s.target.uuid}};
    await gmListener(envelope, other.id);
    assert.equal(emitted[0].result.allowed, false);
    assert.equal(emitted[0].to, other.id);
    assert.equal(s.calls.length, 0);
    const playerSocket = {on(_channel, callback) { callbacks.push(callback); },
        emit(_channel, envelope) { emitted.push(envelope); }};
    const playerGame = {...s.gameRef, user: s.player, socket: playerSocket};
    const waiting = s.auth.requestAoeAuthority('evade', envelope.payload,
        {...s.runtime, gameRef: playerGame, timeoutMs: 50});
    const request = emitted.at(-1), playerListener = callbacks.at(-1);
    const response = {protocol: request.protocol, kind: 'response', id: request.id,
        gmId: s.gm.id, to: s.player.id, result: {allowed: true}};
    await playerListener(response, other.id);
    let completed = false;
    waiting.then(() => completed = true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    await playerListener(response, s.gm.id);
    assert.equal((await waiting).allowed, true);
});

test('denied Evade authority gives a visible warning rather than silently withholding damage', async () => {
    const s = await fixture();
    s.state.targets = [];
    const result = await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    assert.equal(result.allowed, false);
    assert.equal(result.pending, false);
    assert.match(s.warnings[0], /no longer eligible/);
});

test('Evade render hook hides GM controls for players after persisted HTML strips hidden attributes', async () => {
    const s = await fixture();
    const sanitized = s.api.renderAoeEvadeCard('Target', {total: 4, modifier: -2, evaded: true})
        .replace(/\s+hidden(?=\s|>)/g, '');
    assert.doesNotMatch(sanitized, /\shidden(?:\s|>)/);
    const wrapper = {hidden: false};
    const callbacks = new Map();
    const hooks = {on(name, callback) { callbacks.set(name, callback); }};
    const documentRef = {addEventListener() {}};
    const html = {querySelectorAll(selector) { assert.equal(selector, '[data-aoe-evade-gm]');
        return [wrapper]; }};
    s.api.registerAoeEvadeControls({...s.runtime, hooks, documentRef});
    s.gameRef.user = s.player;
    callbacks.get('renderChatMessageHTML')({}, html);
    assert.equal(wrapper.hidden, true);
    s.gameRef.user = s.gm;
    callbacks.get('renderChatMessageHTML')({}, [html]);
    assert.equal(wrapper.hidden, false);
    s.gameRef.user = s.player;
    callbacks.get('renderChatMessageHTML')({}, html);
    assert.equal(wrapper.hidden, true);
});

test('delegated inline Evade buttons update the attack while legacy controls still use their original defense message', async () => {
    const s = await fixture();
    await s.api.resolveAoeEvade(s.message, s.target.uuid, s.runtime);
    let click;
    const documentRef = {addEventListener(name, callback) { assert.equal(name, 'click'); click = callback; }};
    const hooks = {on() {}};
    s.api.registerAoeEvadeControls({...s.runtime, documentRef, hooks});
    let prevented = 0;
    const inline = {dataset: {aoeEvadeOverride: 'hit', aoeEvadeTarget: s.target.uuid},
        closest() { return {dataset: {messageId: s.message.id}}; }};
    await click({target: {closest() { return inline; }}, preventDefault() { prevented++; }});
    assert.equal(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid).evaded, false);
    const defense = {...legacyDefense(s), id: 'legacy-defense'};
    s.gameRef.messages.set(defense.id, defense);
    const legacy = {dataset: {aoeEvadeOverride: 'evaded'},
        closest() { return {dataset: {messageId: defense.id}}; }};
    await click({target: {closest() { return legacy; }}, preventDefault() { prevented++; }});
    assert.equal(s.results.getAoeTargetResult(s.message.flags.world.aoeEvadeResults, s.target.uuid).evaded, true);
    assert.match(defense.content, /5 — Evaded/);
    assert.equal(prevented, 2);
    assert.equal(s.calls.filter(call => call[0] === 'roll').length, 1);
    assert.equal(s.chat.length, 0);
});
