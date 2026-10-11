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
    const template = {id: 'template', t: 'circle', x: 200, y: 200, distance: 2,
        async update(change) { changes.push(change); Object.assign(this, change); }};
    const state = {version: 1, sceneId: 'scene', baseTotal: total, gmModifier: 0,
        weaponActorUuid: owner.uuid, operatorActorUuid: operator.uuid,
        itemUuid: item.uuid, damageItemUuid: item.uuid, templateId: 'template',
        originalPoint: {x: 100, y: 100}, targets: [{id: target.id, uuid: target.uuid, name: target.name}],
        damageModifier: '+4', damageActionId: '', criticalFailure, naturalOneFailure,
        damageWorkflowStarted: false, ...api.getAoeAttackOutcome({baseTotal: total, criticalFailure, naturalOneFailure})};
    const content = `<span data-aoe-result style="color:red;font-weight:bold">Failure</span><div class="dice-total" style="color:red">${total}</div><div data-grenade-targets>${api.renderAoeAttackTargets(state.targets, state)}</div><div data-aoe-gm-modifier></div><div data-aoe-deviation><div style="font-size:11px;margin:4px 0"><strong>Deviation:</strong> GM: move the red template to resolve.</div></div><div data-aoe-review></div><button data-aoe-gm-mod></button>`;
    const message = {id: 'message', flags: {world: {aoeAttack: state}}, content,
        async update(change) {
            for (const [key, value] of Object.entries(change)) {
                if (key.startsWith('flags.world.')) this.flags.world[key.slice('flags.world.'.length)] = value;
            }
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

// Foundry's persisted HTML fields strip comments. Reproduce that boundary on
// both the initial player-authored card and every subsequent GM update, rather
// than letting a mock keep update markers that the real server removes.
function persistSanitizedCard(s, {durableRegions = false} = {}) {
    const clean = html => String(html).replace(/<!--[\s\S]*?-->/g, '');
    const region = (attribute, html) => durableRegions
        ? `<div ${attribute}>${html}</div>` : html;
    s.message.content = clean(`<article class="swadetools-aoe-card">
        <header><strong>Imperial Fragmentation Grenade</strong></header>
        <div><strong>Athletics:</strong> <span data-aoe-result style="color:red;font-weight:bold">Failure</span></div>
        ${region('data-aoe-gm-modifier', '<!--aoe-gm-mod-start--><!--aoe-gm-mod-end-->')}
        <div class="dice-roll"><div class="dice-total" style="color:red">${s.state.baseTotal}</div><button data-aoe-gm-mod></button></div>
        <div data-grenade-targets>${s.api.renderAoeAttackTargets(s.state.targets, s.state)}</div>
        ${region('data-aoe-deviation', '<!--aoe-deviation-start--><div style="font-size:11px;margin:4px 0"><strong>Deviation:</strong> GM: move the red template to resolve.</div><!--aoe-deviation-end-->')}
        ${region('data-aoe-review', '<!--aoe-review-start--><!--aoe-review-end-->')}
        <button data-grenade-benny="actor">Benny Reroll (3)</button>
        <details class="swadetools-aoe-details"><summary>Details</summary><div>Range -2</div></details>
    </article>`);
    const update = s.message.update.bind(s.message);
    s.message.update = change => update({...change,
        ...(change.content !== undefined ? {content: clean(change.content)} : {})});
}

function withDeviationPicker(s, result = {x: 100, y: 100, cancelled: false}) {
    const picks = [];
    s.runtime.sequencerRef = {Crosshair: {async show(config) {
        picks.push(config);
        return result;
    }}};
    return picks;
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

test('a sanitized legacy grenade card corrects total zero plus GM four into a clickable Hit', async () => {
    const s = await fixture({total: 0});
    persistSanitizedCard(s);
    assert.doesNotMatch(s.message.content, /<!--/);
    assert.match(s.message.content, /Victim: Miss/);
    assert.equal(await s.api.applyAoeGmModifier(s.message, '+4', s.runtime), true);
    assert.equal(s.message.flags.world.aoeAttack.total, 4);
    assert.equal(s.message.flags.world.aoeAttack.success, true);
    assert.match(s.message.content, /data-aoe-result[^>]*>Success</);
    assert.match(s.message.content, /class="dice-total"[^>]*>4</);
    assert.match(s.message.content, /Victim: Hit/);
    assert.match(s.message.content, /data-aoe-damage-target="Scene.scene.Token.victim"/);
    assert.match(s.message.content, /GM Modifier: \+4/);
    assert.doesNotMatch(s.message.content, /Victim: Miss|Deviation:|<!--/);
    assert.match(s.message.content, /Benny Reroll \(3\)/, 'Keep existing Benny controls');
    assert.match(s.message.content, /<summary>Details<\/summary>/, 'Keep the compact card details');
    assert.equal(s.calls.length, 0, 'The correction alone must not attack or roll damage');
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
    assert.equal(s.calls.filter(value => value[0] === 'display').length, 1);
    assert.ok(!s.calls.some(value => value[0] === 'raise'), 'A total of four is not a Raise');
});

test('comment-free durable and legacy cards keep targets, deviation and review in sync on repeated GM corrections', async () => {
    for (const durableRegions of [false, true]) {
        const s = await fixture({total: 0});
        persistSanitizedCard(s, {durableRegions});
        s.item.system.currentShots = 3;
        s.item.system.quantity = 4;
        for (const [modifier, total, status] of [['+4', 4, 'Hit'], ['+8', 8, 'Raise'], ['-1', -1, 'Miss'], ['+4', 4, 'Hit']]) {
            const before = s.calls.length;
            assert.equal(await s.api.applyAoeGmModifier(s.message, modifier, s.runtime), true);
            const state = s.message.flags.world.aoeAttack;
            assert.equal(state.baseTotal, 0, 'The original attack total remains unchanged');
            assert.equal(state.total, total, 'Each GM value replaces the previous value, never stacking');
            assert.equal(state.success, status !== 'Miss');
            assert.equal(state.raise, status === 'Raise');
            assert.match(s.message.content, new RegExp(`Victim: ${status}`));
            assert.equal((s.message.content.match(/Victim: /g) ?? []).length, 1, 'Only one current target row');
            assert.equal((s.message.content.match(/GM Modifier:/g) ?? []).length, 1, 'Only one current GM modifier line');
            assert.doesNotMatch(s.message.content, /<!--/);
            assert.equal(s.calls.length, before, 'A correction never repeats damage or resource use');
            if (status === 'Miss') {
                assert.doesNotMatch(s.message.content, /data-aoe-damage-target=/);
                if (state.damageWorkflowStarted) {
                    assert.match(s.message.content, /review existing damage and blast location/);
                    assert.doesNotMatch(s.message.content, /data-aoe-resolve-deviation/);
                } else {
                    assert.equal((s.message.content.match(/Deviation:/g) ?? []).length, 1);
                }
                assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false);
                assert.equal(s.calls.length, before);
            } else {
                assert.doesNotMatch(s.message.content, /Deviation:/);
                assert.match(s.message.content, /data-aoe-damage-target="Scene.scene.Token.victim"/);
            }
            if (total === 8) {
                // Damage is deliberately requested only after the explicit
                // target click, and uses the corrected Raise result.
                assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
                assert.ok(s.calls.some(value => value[0] === 'raise'));
                assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
            }
            if (state.reviewExistingDamage) {
                assert.equal((s.message.content.match(/GM: review existing damage\./g) ?? []).length, 1);
            }
            assert.equal(s.item.system.currentShots, 3, 'Native damage-only rolls do not consume ammunition');
            assert.equal(s.item.system.quantity, 4, 'Native damage-only rolls do not consume another grenade');
            if (durableRegions) {
                for (const attribute of ['data-aoe-gm-modifier', 'data-aoe-deviation', 'data-aoe-review']) {
                    assert.equal((s.message.content.match(new RegExp(attribute, 'g')) ?? []).length, 1);
                }
            }
        }
        assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
        assert.equal(s.calls.filter(value => value[0] === 'display').length, 1);
    }
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

test('both flat and expanded GM template corrections skip the pending deviation hook before chat synchronization', async () => {
    for (const correction of [{'flags.world.aoeGmCorrection': true},
        {flags: {world: {aoeGmCorrection: true}}}]) {
        const s = await runAttack({dice: [2, 3]});
        const original = s.cards[0].content;
        assert.equal(s.cards[0].flags.world.aoeAttack.success, false);
        await s.emitHook('updateMeasuredTemplate', s.scene.templates.get('template'), {x: 150, ...correction});
        assert.equal(s.nativeCards.length, 0);
        assert.equal(s.cards[0].content, original, 'The GM correction owns the eventual target/card update');
        assert.equal(s.weapon.system.currentShots, 3);
    }
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

test('failed AoE cards expose a GM-only Resolve Deviation control until the blast is resolved', async () => {
    const api = await service;
    const failed = {baseTotal: 3, gmModifier: 0};
    assert.match(api.renderAoeDeviationControls(failed), /data-aoe-resolve-deviation/);
    assert.match(api.renderAoeDeviationControls(failed), /Resolve Deviation/);
    for (const state of [{...failed, baseTotal: 4}, {...failed, gmModifier: 1},
        {...failed, deviationResolved: true}, {...failed, damageWorkflowStarted: true}]) {
        assert.doesNotMatch(api.renderAoeDeviationControls(state), /data-aoe-resolve-deviation/);
    }
    assert.match(api.renderAoeDeviationControls({...failed, criticalFailure: true}), /data-aoe-resolve-deviation/,
        'A failed throw can still have its actual blast location resolved without changing its attack outcome');
});

test('GM Resolve Deviation chooses the actual blast point and rolls native damage without changing the failed attack', async () => {
    const s = await fixture({total: 3});
    persistSanitizedCard(s, {durableRegions: true});
    const picks = withDeviationPicker(s);
    const originalTargets = new Set(['previous target']);
    s.runtime.gameRef.user.targets = originalTargets;
    s.runtime.gameRef.user.updateTokenTargets = () => { throw Error('Deviation never changes target rings'); };
    s.item.system.currentShots = 3;
    s.item.system.quantity = 4;
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false,
        'An unresolved failed attack must not roll damage');
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].distance, 2, 'Crosshair uses the existing template radius');
    assert.equal(s.changes.length, 1, 'Move the original template, do not throw another grenade');
    assert.equal(s.changes[0].x, 100);
    assert.equal(s.changes[0].y, 100);
    assert.equal(s.changes[0]['flags.world.aoeGmCorrection'], true,
        'The original firing-client deviation hook must not also roll damage');
    assert.equal(s.changes[0]['flags.world.pendingDeviation'], false);
    assert.equal(s.template.x, 100);
    assert.equal(s.template.y, 100);
    const state = s.message.flags.world.aoeAttack;
    assert.equal(state.deviationResolved, true);
    assert.deepEqual(state.resolvedPoint, {x: 100, y: 100});
    assert.equal(state.total, 3);
    assert.equal(state.success, false);
    assert.equal(state.raise, false);
    assert.equal(state.damageWorkflowStarted, true);
    assert.match(s.message.content, /data-aoe-result[^>]*>Failure</);
    assert.match(s.message.content, /Victim: Blast/);
    assert.doesNotMatch(s.message.content, /Victim: Hit|Victim: Raise|Victim: Miss|data-aoe-resolve-deviation/);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
    assert.equal(s.calls.filter(value => value[0] === 'display').length, 1);
    assert.deepEqual(s.calls.find(value => value[0] === 'target'), ['target', s.target.id]);
    assert.ok(!s.calls.some(value => value[0] === 'raise'));
    assert.equal(s.item.system.currentShots, 3);
    assert.equal(s.item.system.quantity, 4);
    assert.equal(s.runtime.gameRef.user.targets, originalTargets);
    const callsBefore = s.calls.length;
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false,
        'A second Resolve Deviation click must not repeat damage');
    assert.equal(s.calls.length, callsBefore);
    assert.equal(s.changes.length, 1);
    assert.equal(picks.length, 1);
});

test('Resolve Deviation damages only visible actors inside the GM-selected blast, one native card per target', async () => {
    const s = await fixture({total: 1});
    withDeviationPicker(s);
    const addTarget = (id, x, y, overrides = {}) => {
        const document = {id, uuid: `Scene.scene.Token.${id}`, name: id, actor: {name: id}, hidden: false};
        const token = {id, name: id, actor: document.actor, document,
            isVisible: true, visible: true, center: {x, y}, ...overrides};
        s.documents.set(document.uuid, document);
        s.runtime.canvasRef.tokens.placeables.push(token);
        return token;
    };
    addTarget('second', 250, 100);
    addTarget('outside', 600, 600);
    const hidden = addTarget('hidden', 100, 100);
    hidden.document.hidden = true;
    addTarget('invisible', 100, 100, {isVisible: false});
    addTarget('not-drawn', 100, 100, {visible: false});
    addTarget('no-actor', 100, 100, {actor: null});
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.deepEqual(s.message.flags.world.aoeAttack.targets.map(value => value.uuid),
        [s.target.uuid, 'Scene.scene.Token.second']);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 2);
    assert.equal(s.calls.filter(value => value[0] === 'display').length, 2);
    assert.deepEqual(s.calls.filter(value => value[0] === 'target').map(value => value[1]), ['victim', 'second']);
    assert.match(s.message.content, /Victim: Blast/);
    assert.match(s.message.content, /second: Blast/);
    assert.doesNotMatch(s.message.content, /outside:|hidden:|invisible:|not-drawn:|no-actor:/);
});

test('cancelled or invalid GM deviation placement leaves the existing template, card and damage untouched', async () => {
    for (const placement of [null, false, undefined, {cancelled: true, x: 100, y: 100},
        {x: NaN, y: 100}, {x: 100, y: Infinity}]) {
        const s = await fixture();
        const picks = withDeviationPicker(s, placement);
        // Explicitly keep undefined as a cancellation rather than the helper's
        // default successful placement.
        if (placement === undefined) s.runtime.sequencerRef.Crosshair.show = async config => {
            picks.push(config); return undefined;
        };
        const previousContent = s.message.content;
        const previousState = JSON.stringify(s.message.flags.world.aoeAttack);
        assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
        assert.equal(picks.length, 1);
        assert.equal(s.template.x, 200);
        assert.equal(s.template.y, 200);
        assert.equal(s.changes.length, 0);
        assert.equal(s.calls.length, 0);
        assert.equal(s.message.content, previousContent);
        assert.equal(JSON.stringify(s.message.flags.world.aoeAttack), previousState);
    }
});

test('Resolve Deviation requires GM authority and the original active scene/template and module', async () => {
    for (const alter of [
        s => { s.runtime.gameRef.user.isGM = false; },
        s => { s.runtime.canvasRef.scene.id = 'other'; },
        s => { s.runtime.canvasRef.scene.templates.delete(s.template.id); },
        s => { s.runtime.sequencerRef = {}; },
        s => { s.message.flags.world.aoeSuperseded = true; },
        s => { s.message.flags.world.aoeAttack = null; },
        s => { s.state.damageWorkflowStarted = true; },
        s => { s.state.deviationResolved = true; },
        s => { s.state.baseTotal = 4; },
        s => { s.runtime.canvasRef.ready = false; },
        s => { s.runtime.canvasRef.tokens = {}; },
        s => { s.runtime.canvasRef.scene.grid.distance = 0; },
    ]) {
        const s = await fixture();
        const picks = withDeviationPicker(s);
        alter(s);
        assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
        assert.equal(picks.length, 0);
        assert.equal(s.changes.length, 0);
        assert.equal(s.calls.length, 0);
    }
});

test('Resolve Deviation preflights the native damage source before allowing template movement', async () => {
    for (const alter of [
        s => { s.documents.delete(s.owner.uuid); },
        s => { s.documents.delete(s.operator.uuid); },
        s => { s.documents.delete(s.item.uuid); },
        s => { s.item.actor = s.item.parent = {uuid: 'Actor.other'}; },
        s => { s.state.damageActionId = 'deleted-action'; },
        s => { s.state.damageModifier = '@missing'; },
    ]) {
        const s = await fixture({vehicle: true});
        const picks = withDeviationPicker(s);
        alter(s);
        assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
        assert.equal(picks.length, 0, 'Do not let the GM relocate a blast whose damage context is invalid');
        assert.equal(s.changes.length, 0);
        assert.equal(s.calls.length, 0);
        assert.notEqual(s.message.flags.world.aoeAttack.deviationResolved, true);
    }
});

test('a GM cannot open simultaneous deviation placements for one card and cancelling unlocks a retry', async () => {
    const s = await fixture();
    let finishPlacement;
    let pickerCount = 0;
    s.runtime.sequencerRef = {Crosshair: {show() {
        pickerCount += 1;
        return new Promise(resolve => { finishPlacement = resolve; });
    }}};
    const pending = s.api.resolveAoeChatDeviation(s.message, s.runtime);
    // Preflight resolves several UUIDs before the Crosshair is opened.
    for (let turn = 0; turn < 20 && !finishPlacement; turn += 1) await Promise.resolve();
    assert.equal(typeof finishPlacement, 'function');
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
    assert.equal(pickerCount, 1);
    finishPlacement(null);
    assert.equal(await pending, false);
    assert.equal(s.changes.length, 0);
    assert.equal(s.calls.length, 0);
    const picks = withDeviationPicker(s);
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(picks.length, 1);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
});

test('a persisted resolved deviation allows target damage even when the failed attack remains failed', async () => {
    const s = await fixture({total: 2, naturalOneFailure: true});
    s.state.deviationResolved = true;
    s.state.resolvedPoint = {x: 100, y: 100};
    assert.equal(s.api.getAoeAttackOutcome(s.state).success, false);
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
    assert.equal(s.calls.filter(value => value[0] === 'display').length, 1);
    assert.ok(!s.calls.some(value => value[0] === 'raise'));
});

test('critical and natural-one failures may resolve their actual blast but never gain Hit or Raise damage', async () => {
    for (const failure of [{criticalFailure: true}, {naturalOneFailure: true}]) {
        const s = await fixture({total: 1, ...failure});
        withDeviationPicker(s);
        s.state.gmModifier = 20;
        assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
        assert.equal(s.message.flags.world.aoeAttack.success, false);
        assert.equal(s.message.flags.world.aoeAttack.raise, false);
        assert.match(s.message.content, /Victim: Blast/);
        assert.doesNotMatch(s.message.content, /Victim: Hit|Victim: Raise/);
        assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
        assert.ok(!s.calls.some(value => value[0] === 'raise'));
    }
});

test('an empty resolved blast completes without rolling damage for old targets or current target rings', async () => {
    const s = await fixture();
    withDeviationPicker(s, {x: 1000, y: 1000});
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(s.message.flags.world.aoeAttack.deviationResolved, true);
    assert.deepEqual(s.message.flags.world.aoeAttack.targets, []);
    assert.equal(s.calls.length, 0);
    assert.doesNotMatch(s.message.content, /Victim:|data-aoe-damage-target=|data-aoe-resolve-deviation/);
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
    assert.equal(s.calls.length, 0);
});

test('the delegated Resolve Deviation chat button runs the GM placement workflow instead of target damage', async () => {
    const s = await fixture(), listeners = [];
    const picks = withDeviationPicker(s);
    s.api.registerAoeChatControls({...s.runtime,
        documentRef: {addEventListener: (_name, callback) => listeners.push(callback)}, hooksRef: {on() {}}});
    const button = {disabled: false,
        hasAttribute: name => name === 'data-aoe-resolve-deviation',
        closest: () => ({dataset: {messageId: s.message.id}})};
    await listeners[0]({target: {closest: () => button}, preventDefault() {}});
    assert.equal(picks.length, 1);
    assert.equal(s.message.flags.world.aoeAttack.deviationResolved, true);
    assert.equal(s.calls.filter(value => value[0] === 'damage').length, 1);
});

test('scene changes, removed templates, corrected attacks and superseded cards abort an open deviation placement', async () => {
    for (const change of [
        s => { s.runtime.canvasRef.scene.id = 'different'; },
        s => { s.runtime.canvasRef.scene.templates.delete(s.template.id); },
        s => { s.message.flags.world.aoeAttack = {...s.state, gmModifier: 4}; },
        s => { s.message.flags.world.aoeSuperseded = true; },
        s => { s.message.flags.world.aoeAttack = {...s.state, damageWorkflowStarted: true}; },
    ]) {
        const s = await fixture();
        s.runtime.sequencerRef = {Crosshair: {async show() {
            change(s); return {x: 100, y: 100};
        }}};
        assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
        assert.equal(s.changes.length, 0);
        assert.equal(s.calls.length, 0);
    }
});

test('a later GM attack correction never moves a resolved deviated blast back or rolls extra damage', async () => {
    const s = await fixture({total: 3});
    withDeviationPicker(s, {x: 250, y: 100});
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    const before = s.calls.length;
    assert.equal(await s.api.applyAoeGmModifier(s.message, 5, s.runtime), true);
    assert.equal(s.template.x, 250); assert.equal(s.template.y, 100);
    assert.deepEqual(s.message.flags.world.aoeAttack.resolvedPoint, {x: 250, y: 100});
    assert.equal(s.message.flags.world.aoeAttack.raise, true);
    assert.equal(s.calls.length, before);
    assert.match(s.message.content, /GM: review existing damage/);
});

test('a failed per-target damage roll can be retried explicitly without relocating or repeating resource use', async () => {
    const s = await fixture();
    withDeviationPicker(s);
    const NormalRoll = s.runtime.ItemRollClass;
    s.runtime.logger = {error() {}};
    s.runtime.ItemRollClass = class extends NormalRoll { async rollBaseDamage() { throw Error('optional roll failure'); } };
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(s.message.flags.world.aoeAttack.deviationResolved, true);
    assert.equal(s.message.flags.world.aoeAttack.damageWorkflowStarted, true);
    assert.match(s.message.content, /Victim: Blast/);
    assert.ok(s.warnings.some(warning => /0\/1.*retry/.test(warning)));
    s.runtime.ItemRollClass = NormalRoll;
    assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), true);
    assert.equal(s.calls.filter(call => call[0] === 'damage').length, 1);
    assert.equal(s.calls.filter(call => call[0] === 'display').length, 1);
    assert.equal(s.changes.length, 1);
});

test('superseding an attack during the template update cannot roll damage from its obsolete card', async () => {
    const s = await fixture();
    withDeviationPicker(s);
    const update = s.template.update.bind(s.template);
    s.template.update = async (change, options) => {
        assert.equal(options.aoeGmCorrection, true, 'Hook options survive when an unchanged persisted flag is omitted from the diff');
        await update(change);
        s.message.flags.world.aoeSuperseded = true;
    };
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
    assert.notEqual(s.message.flags.world.aoeAttack.deviationResolved, true);
    assert.equal(s.calls.length, 0);
    assert.equal(s.message.flags.world.aoeResolving, null);
});

test('a separate player client cannot click resolved targets while the GM is rolling automatic blast damage', async () => {
    const otherApi = await import(pathToFileURL(path.resolve(__dirname,
        '../scripts/services/AoeChatControl.js')).href + '?separate-player-client');
    const s = await fixture();
    withDeviationPicker(s);
    const NormalRoll = s.runtime.ItemRollClass;
    let otherClick;
    s.runtime.ItemRollClass = class extends NormalRoll {
        async rollBaseDamage() {
            otherClick = await otherApi.rollAoeChatTargetDamage(s.message, s.target.uuid,
                {...s.runtime, gameRef: {user: {isGM: false}}});
            await super.rollBaseDamage();
        }
    };
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(otherClick, false, 'The persisted lock applies across independent module instances');
    assert.equal(s.calls.filter(call => call[0] === 'damage').length, 1);
    assert.equal(s.message.flags.world.aoeResolving, null);
});

test('active cross-client transactions block correction, damage and deviation, but expired locks recover', async () => {
    const s = await fixture();
    const picks = withDeviationPicker(s);
    for (const key of ['aoeResolving', 'aoeBennyInProgress']) {
        s.message.flags.world[key] = {expiresAt: Date.now() + 60000};
        assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), false);
        assert.equal(await s.api.applyAoeGmModifier(s.message, 4, s.runtime), false);
        s.state.deviationResolved = true;
        assert.equal(await s.api.rollAoeChatTargetDamage(s.message, s.target.uuid, s.runtime), false);
        s.state.deviationResolved = false;
        s.message.flags.world[key] = {expiresAt: Date.now() - 1};
    }
    assert.equal(picks.length, 0); assert.equal(s.calls.length, 0);
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(picks.length, 1);
});

test('a failed template update always releases the transaction and allows a clean retry', async () => {
    const s = await fixture();
    withDeviationPicker(s);
    const update = s.template.update.bind(s.template);
    s.template.update = async () => { throw Error('template unavailable'); };
    await assert.rejects(s.api.resolveAoeChatDeviation(s.message, s.runtime), /template unavailable/);
    assert.equal(s.message.flags.world.aoeResolving, null);
    assert.equal(s.calls.length, 0);
    s.template.update = update;
    assert.equal(await s.api.resolveAoeChatDeviation(s.message, s.runtime), true);
    assert.equal(s.calls.filter(call => call[0] === 'damage').length, 1);
});
