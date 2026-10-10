const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.resolve(__dirname,
    '../scripts/services/AoeChatControl.js')).href);
const {runAttack} = require('./aoe-attack.test.cjs');

async function fixture({gm = true, vehicle = false, total = 3,
    criticalFailure = false, naturalOneFailure = false} = {}) {
    const api = await service;
    const changes = [], calls = [], warnings = [];
    const operator = {uuid: 'Actor.operator', id: 'operator', isOwner: true,
        getRollData: () => ({}), type: 'character'};
    const owner = vehicle ? {uuid: 'Actor.vehicle', id: 'vehicle', type: 'vehicle', isOwner: true} : operator;
    const item = {id: 'item', uuid: `${owner.uuid}.Item.item`, actor: owner, parent: owner,
        type: 'weapon', isOwner: true, system: {damage: '3d6', actions: {additional: {}}}};
    const target = {id: 'victim', uuid: 'Scene.scene.Token.victim', name: 'Victim',
        actor: {name: 'Victim'}, object: null};
    const template = {id: 'template', x: 200, y: 200, distance: 2,
        async update(change) { changes.push(change); Object.assign(this, change); }};
    const state = {version: 1, sceneId: 'scene', baseTotal: total, gmModifier: 0,
        weaponActorUuid: owner.uuid, operatorActorUuid: operator.uuid,
        itemUuid: item.uuid, damageItemUuid: item.uuid, templateId: 'template',
        originalPoint: {x: 100, y: 100}, targets: [{id: target.id, uuid: target.uuid, name: target.name}],
        damageModifier: '+4', damageActionId: '', criticalFailure, naturalOneFailure,
        damageWorkflowStarted: false, ...api.getAoeAttackOutcome({baseTotal: total, criticalFailure, naturalOneFailure})};
    const content = `<span data-aoe-result style="color:red;font-weight:bold">Failure</span><div class="dice-total" style="color:red">${total}</div><div data-grenade-targets>${api.renderAoeAttackTargets(state.targets, state)}</div><!--aoe-gm-mod-start--><!--aoe-gm-mod-end--><!--aoe-deviation-start-->Deviation<!--aoe-deviation-end--><!--aoe-review-start--><!--aoe-review-end--><button data-aoe-gm-mod></button>`;
    const message = {id: 'message', flags: {world: {aoeAttack: state}}, content,
        async update(change) {
            if (change['flags.world.aoeAttack']) this.flags.world.aoeAttack = change['flags.world.aoeAttack'];
            if (change.content !== undefined) this.content = change.content;
        }};
    class ItemRoll {
        constructor(actor, item) { calls.push(['create', actor, item]); this.actor = actor; this.item = item; }
        usingVehicle(value) { calls.push(['vehicle', value]); }
        useTarget(value) { calls.push(['target', value]); }
        addFlag(...value) { calls.push(['flag', ...value]); }
        setWeaponDamageModifier(value) { calls.push(['damageMod', value]); }
        raiseDmg() { calls.push(['raise']); }
        async rollBaseDamage() { assert.equal(this.manageshots, false); calls.push(['damage']); }
        async rollAction(value) { assert.equal(this.manageshots, false); calls.push(['action', value]); }
        async display() { calls.push(['display']); }
        async rollBaseSkill() { throw Error('Damage must never attack or consume ammunition'); }
        usePP() { throw Error('Damage must never spend PP'); }
    }
    const documents = new Map([owner, operator, item, target].map(value => [value.uuid, value]));
    const runtime = {gameRef: {user: {id: gm ? 'gm-other-client' : 'player', isGM: gm},
        messages: new Map([[message.id, message]])},
        canvasRef: {scene: {id: 'scene', grid: {distance: 1, size: 100}, templates: new Map([[template.id, template]])},
            grid: {size: 100}, tokens: {placeables: [{...target, isVisible: true, center: {x: 100, y: 100}, document: target}]}},
        fromUuid: async uuid => documents.get(uuid), ItemRollClass: ItemRoll,
        RollClass: class {static validate(value) { return /^[-+\d dx]+$/.test(value); }
            constructor(formula) { this.formula = formula; }
            async evaluate() { calls.push(['rollModifier', this.formula]); this.total = 5; return this; }},
        notifications: {warn: text => warnings.push(text)},
        withSuppressedAoeAutomation: async (_items, callback) => { calls.push(['suppress']); return callback(); }};
    return {api, state, message, runtime, owner, operator, item, target, template, changes, calls, warnings, documents};
}

test('serialized AoE card exposes native-style + and click damage controls, without runtime closure requirements', async () => {
    const s = await runAttack({dice: [2, 3]});
    const card = s.cards[0], state = card.flags.world.aoeAttack;
    assert.equal(state.version, 1); assert.equal(state.sceneId, 'scene');
    assert.equal(state.baseTotal, 3); assert.equal(state.gmModifier, 0);
    assert.equal(state.weaponActorUuid, s.owner.uuid);
    assert.equal(state.operatorActorUuid, s.gunner.uuid);
    assert.equal(state.damageItemUuid, s.weapon.uuid);
    assert.deepEqual(state.targets.map(value => value.uuid), s.victims.map(value => value.document.uuid));
    assert.match(card.content, /data-aoe-gm-mod/);
    assert.match(card.content, /swadetools-term-miss/);
    assert.doesNotMatch(card.content, /data-aoe-damage-target=/);
});

test('a separate GM client can correct failure to Raise without damage, ammo or another throw', async () => {
    const s = await fixture();
    assert.equal(await s.api.applyAoeGmModifier(s.message, '+5', s.runtime), true);
    const state = s.message.flags.world.aoeAttack;
    assert.equal(state.total, 8); assert.equal(state.success, true); assert.equal(state.raise, true);
    assert.match(s.message.content, /Victim: Raise/);
    assert.match(s.message.content, /data-aoe-damage-target="Scene.scene.Token.victim"/);
    assert.match(s.message.content, /GM Modifier: \+5/);
    assert.doesNotMatch(s.message.content, />Deviation</);
    assert.equal(s.calls.length, 0, 'Modifier correction itself must never roll damage');
    assert.equal(s.changes[0]['flags.world.pendingDeviation'], false);
    assert.equal(s.template.x, 100); assert.equal(s.template.y, 100);
    assert.equal(s.changes[0]['flags.world.aoeGmCorrection'], true);
    await s.api.applyAoeGmModifier(s.message, '-1', s.runtime);
    assert.equal(s.message.flags.world.aoeAttack.total, 2, 'GM modifier replaces instead of stacking');
    assert.doesNotMatch(s.message.content, /data-aoe-damage-target=/);
});

test('corrected target click creates one native damage-only card with Raise and frozen damage modifier', async () => {
    const s = await fixture({vehicle: true});
    await s.api.applyAoeGmModifier(s.message, 5, s.runtime);
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
    assert.equal(s.calls.filter(value => value[0] === 'display').length, 1);
    assert.deepEqual(s.calls.find(value => value[0] === 'create'), ['create', s.operator, s.item]);
    assert.deepEqual(s.calls.find(value => value[0] === 'vehicle'), ['vehicle', s.owner]);
    assert.deepEqual(s.calls.find(value => value[0] === 'target'), ['target', s.target.id]);
    assert.deepEqual(s.calls.find(value => value[0] === 'flag'), ['flag', 'aoeArea', {sceneId: 'scene', targets: [s.target.uuid]}]);
    assert.deepEqual(s.calls.find(value => value[0] === 'damageMod'), ['damageMod', '+4']);
    assert.ok(s.calls.some(value => value[0] === 'raise'));
    assert.equal(s.message.flags.world.aoeAttack.damageWorkflowStarted, true);
});

test('additional damage actions use native rollAction, not the main damage formula', async () => {
    const s = await fixture({total: 5});
    s.item.system.actions.additional.blast = {type: 'damage', override: '4d6'};
    s.state.damageActionId = 'blast';
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
    assert.deepEqual(s.calls.find(value => value[0] === 'action'), ['action', 'blast']);
    assert.ok(!s.calls.some(value => value[0] === 'damage'));
    assert.ok(!s.calls.some(value => value[0] === 'raise'));
});

test('non-GM cannot adjust, while owner can click a successful native damage row', async () => {
    const s = await fixture({gm: false, total: 5});
    assert.equal(await s.api.applyAoeGmModifier(s.message, 5, s.runtime), false);
    assert.equal(s.state.gmModifier, 0);
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
    s.owner.isOwner = false;
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false);
});

test('natural-one or critical failures cannot be converted to hits by a numeric GM modifier', async () => {
    for (const failure of [{criticalFailure: true}, {naturalOneFailure: true}]) {
        const s = await fixture(failure);
        await s.api.applyAoeGmModifier(s.message, 20, s.runtime);
        assert.equal(s.message.flags.world.aoeAttack.success, false);
        assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false);
        assert.equal(s.calls.length, 0);
    }
});

test('superseded cards, wrong scenes, missing targets/items and foreign target UUIDs are inert', async () => {
    for (const alter of [
        s => { s.message.flags.world.aoeSuperseded = true; },
        s => { s.runtime.canvasRef.scene.id = 'other-scene'; },
        s => { s.documents.delete(s.target.uuid); },
        s => { s.documents.delete(s.item.uuid); },
        s => { s.state.targets = [{...s.state.targets[0], uuid: 'Scene.other.Token.victim'}]; },
    ]) {
        const s = await fixture({total: 8});
        alter(s);
        assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false);
        assert.equal(s.calls.length, 0);
    }
});

test('invalid damage action or damage modifier does not fall back to a different damage source', async () => {
    for (const alter of [s => { s.state.damageActionId = 'deleted'; },
        s => { s.state.damageModifier = '@missing'; }]) {
        const s = await fixture({total: 5}); alter(s);
        assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false);
        assert.equal(s.calls.length, 0);
    }
});

test('dice GM modifiers are evaluated once; invalid data references are rejected', async () => {
    const s = await fixture();
    assert.equal(await s.api.applyAoeGmModifier(s.message, '1d6', s.runtime), true);
    assert.equal(s.message.flags.world.aoeAttack.total, 8);
    assert.deepEqual(s.calls, [['rollModifier', '1d6']]);
    assert.equal(await s.api.applyAoeGmModifier(s.message, '@secret', s.runtime), false);
    assert.equal(s.message.flags.world.aoeAttack.total, 8);
});

test('chat listeners register once per client and show the GM-only + on a player-authored card', async () => {
    const s = await fixture(), listeners = [], hooks = [];
    const documentRef = {addEventListener: (...args) => listeners.push(args)};
    const runtime = {...s.runtime, documentRef, hooksRef: {on: (...args) => hooks.push(args)}};
    s.api.registerAoeChatControls(runtime);
    s.api.registerAoeChatControls(runtime);
    assert.equal(listeners.length, 1); assert.equal(hooks.length, 1);
    assert.equal(hooks[0][0], 'renderChatMessageHTML', 'Foundry V13 native HTML hook');
    const button = {hidden: true};
    hooks[0][1](s.message, {querySelectorAll: () => [button]});
    assert.equal(button.hidden, false);
    runtime.gameRef.user.isGM = false;
    hooks[0][1](s.message, {querySelectorAll: () => [button]});
    assert.equal(button.hidden, true);
});

test('the delegated GM + click preserves native DialogV2 static method binding', async () => {
    const s = await fixture(), listeners = [];
    let promptConfig;
    class NativeDialog {
        static async prompt(config) { assert.equal(this, NativeDialog); promptConfig = config; return '5'; }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'foundry');
    try {
        globalThis.foundry = {applications: {api: {DialogV2: NativeDialog}}};
        s.api.registerAoeChatControls({...s.runtime,
            documentRef: {addEventListener: (_name, callback) => listeners.push(callback)},
            hooksRef: {on() {}}});
        const button = {disabled: false, hasAttribute: name => name === 'data-aoe-gm-mod',
            closest: () => ({dataset: {messageId: s.message.id}})};
        await listeners[0]({target: {closest: () => button}, preventDefault() {}});
        assert.equal(s.message.flags.world.aoeAttack.total, 8);
        assert.equal(promptConfig.window.title, 'Adjust AoE Attack');
        assert.ok(promptConfig.classes.includes('theme-light'));
    } finally {
        if (previous) Object.defineProperty(globalThis, 'foundry', previous);
        else delete globalThis.foundry;
    }
});

test('serialized target names are escaped in native-style target rows', async () => {
    const api = await service;
    const html = api.renderAoeAttackTargets([{uuid: 'Scene.scene.Token.target', name: '<img onerror=evil>'}], {baseTotal: 4});
    assert.ok(html.includes('&lt;img onerror=evil&gt;'));
    assert.ok(!html.includes('<img'));
});

test('GM correction cannot add hidden or invisible token names to the public blast list', async () => {
    const s = await fixture();
    const secret = {id: 'secret', name: 'Hidden NPC', actor: {name: 'Hidden NPC'},
        isVisible: true, visible: true, center: {x: 100, y: 100},
        document: {uuid: 'Scene.scene.Token.secret', hidden: true}};
    s.runtime.canvasRef.tokens.placeables.push(secret,
        {...secret, id: 'invisible', name: 'Invisible NPC', visible: false,
            document: {uuid: 'Scene.scene.Token.invisible', hidden: false}});
    await s.api.applyAoeGmModifier(s.message, 2, s.runtime);
    assert.deepEqual(s.message.flags.world.aoeAttack.targets.map(value => value.name), ['Victim']);
    assert.doesNotMatch(s.message.content, /Hidden NPC|Invisible NPC/);
});

test('GM correction survives a subsequent skill Benny without stacking or consuming another grenade', async () => {
    const s = await runAttack({dice: [2, 3, 6, 4]});
    const api = await service;
    s.scene.id = 'scene';
    const runtime = {gameRef: {user: {isGM: true}},
        canvasRef: {scene: s.scene, grid: {size: 100}, tokens: {placeables: s.victims}}};
    const initial = s.cards[0];
    await api.applyAoeGmModifier(initial, 2, runtime);
    assert.equal(initial.flags.world.aoeAttack.total, 5);
    assert.equal(s.nativeCards.length, 0);
    const reroll = s.platform.__swadeGrenadeBennyRuntime.handlers.get(initial.flags.world.grenadeBennySession);
    await reroll('actor', initial.id);
    const current = s.cards.at(-1);
    assert.equal(current.flags.world.aoeAttack.baseTotal, 6);
    assert.equal(current.flags.world.aoeAttack.gmModifier, 2);
    assert.equal(current.flags.world.aoeAttack.total, 8);
    assert.equal(current.flags.world.aoeAttack.raise, true);
    assert.match(current.content, /Target one: Raise/);
    assert.match(current.content, /GM Modifier: \+2/);
    assert.equal(s.weapon.system.currentShots, 3);
    assert.equal(s.nativeCards.length, 2);
});

test('GM-corrected successful template cannot trigger the stale failed-throw deviation damage hook', async () => {
    const s = await runAttack({dice: [2, 3]});
    const api = await service;
    s.scene.id = 'scene';
    await api.applyAoeGmModifier(s.cards[0], 2, {gameRef: {user: {isGM: true}},
        canvasRef: {scene: s.scene, grid: {size: 100}, tokens: {placeables: s.victims}}});
    const template = s.scene.templates.get('template');
    await s.emitHook('updateMeasuredTemplate', template, {x: 150});
    assert.equal(s.nativeCards.length, 0);
    assert.equal(s.weapon.system.currentShots, 3);
});

test('a manual target-damage marker prevents later skill Bennies from duplicating the damage workflow', async () => {
    const s = await runAttack({dice: [2, 3, 8, 4]});
    const initial = s.cards[0];
    // A cross-client native damage click persists this marker on the source
    // message; the firing client's live closure must respect that marker.
    initial.flags.world.aoeAttack.gmModifier = 2;
    initial.flags.world.aoeAttack.success = true;
    initial.flags.world.aoeAttack.damageWorkflowStarted = true;
    const reroll = s.platform.__swadeGrenadeBennyRuntime.handlers.get(initial.flags.world.grenadeBennySession);
    await reroll('actor', initial.id);
    assert.equal(s.nativeCards.length, 0);
    assert.equal(s.cards.at(-1).flags.world.aoeAttack.total, 10);
    assert.equal(s.cards.at(-1).flags.world.aoeAttack.damageWorkflowStarted, true);
    assert.equal(s.weapon.system.currentShots, 3);
});

test('a GM correction gaining Raise after manual damage adds only a compact review notice and no extra damage', async () => {
    const s = await fixture({total: 5});
    await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime);
    const callsBefore = s.calls.length;
    await s.api.applyAoeGmModifier(s.message, 3, s.runtime);
    assert.equal(s.message.flags.world.aoeAttack.raise, true);
    assert.equal(s.message.flags.world.aoeAttack.reviewExistingDamage, true);
    assert.match(s.message.content, /GM: review existing damage\./);
    assert.equal(s.calls.length, callsBefore, 'GM correction must not repeat existing damage');
    const unchanged = await fixture({total: 5});
    unchanged.state.damageWorkflowStarted = true;
    await unchanged.api.applyAoeGmModifier(unchanged.message, 1, unchanged.runtime);
    assert.doesNotMatch(unchanged.message.content, /GM: review existing damage/);
});
