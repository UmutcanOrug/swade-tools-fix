const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const launcher = import(pathToFileURL(path.resolve(__dirname,
    '../scripts/services/AoeMacroLauncher.js')).href);
const {runAttack} = require('./aoe-attack.test.cjs');

const rawRoll = (total = 7, initial = total) => ({
    total, formula: '1d10x', dice: [{results: [{result: initial}]}],
    toJSON() { return {formula: this.formula, total: this.total}; },
});

function fixture({points = [{x: 100, y: 100}, {x: 200, y: 100}], vehicle = false} = {}) {
    const notices = [], crosshairs = [], mutations = [];
    const operator = {id: 'gunner', uuid: 'Actor.gunner', type: 'character', isOwner: true,
        items: [], system: {wildcard: true}};
    const owner = vehicle ? {id: 'tank', uuid: 'Actor.tank', type: 'vehicle', isOwner: true,
        items: [], system: {getCrewMemberForWeapon: () => operator}} : operator;
    const item = {id: 'launcher', uuid: `${owner.uuid}.Item.launcher`, name: 'Grenade Launcher',
        type: 'weapon', actor: owner, parent: owner, isOwner: true,
        flags: {'swade-tools': {aoeEnabled: true, aoeBlastSize: 'medium'}},
        system: {range: '10/20/40', rof: 3, currentShots: 0, quantity: 1,
            actions: {trait: 'Shooting'}, templates: {medium: true}},
        consume() { mutations.push('consume'); throw new Error('Placement must never consume'); },
        update() { mutations.push('update'); throw new Error('Placement must never update'); },
    };
    owner.items.push(item);
    const token = {id: 'tank-token', actor: owner, x: 0, y: 0, w: 100, h: 100,
        center: {x: 50, y: 50}, document: {uuid: 'Scene.scene.Token.source'}};
    const globals = {
        game: {user: {id: 'player', isGM: false}},
        canvas: {scene: {grid: {distance: 1, size: 100}}, grid: {size: 100},
            tokens: {controlled: [token]},
            createEmbeddedDocuments() { mutations.push('template'); throw new Error('No premature templates'); }},
        Sequencer: {Crosshair: {CALLBACKS: {CANCEL: 'cancel'},
            PLACEMENT_RESTRICTIONS: {ANYWHERE: 'anywhere'},
            async show(config, callbacks) {
                crosshairs.push(config);
                const point = points[crosshairs.length - 1];
                if (point?.cancel) callbacks.cancel();
                return point;
            }}},
        CONST: {GRID_SNAPPING_MODES: {CENTER: 1, VERTEX: 2}},
        ui: {notifications: {warn: message => notices.push(message)}},
        Roll: class {constructor() {throw new Error('Placement must not roll');}},
    };
    const candidates = [0, 1].map(index => ({id: `skill-${index}`, label: `Shooting ${index + 1}`,
        source: 'skill', roll: rawRoll(7 + index), rawTotal: 7 + index, modifier: -2, total: 5 + index}));
    const poolAttack = overrides => ({rawRoll: rawRoll(), baseModifier: -2, source: 'skill',
        candidateIndex: 0, poolId: 'pool-attack', weaponUuid: item.uuid,
        weaponActorUuid: owner.uuid, operatorActorUuid: operator.uuid, disableBenny: true,
        ...overrides});
    return {owner, operator, item, token, candidates, poolAttack, globals, notices, crosshairs, mutations};
}

async function withGlobals(values, callback) {
    const previous = new Map(Object.keys(values).map(key => [key,
        Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
        Object.assign(globalThis, values);
        return await callback();
    } finally {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

async function signedPoolScope({vehicle = false, total = 7, modifier = 1,
    point = {x: 100, y: 100}, source = 'skill', initial = total, criticalFailure = false,
    setup = {aoe: true, otherModifierFormula: '0', consume: true}} = {}) {
    const module = await launcher;
    const s = fixture({vehicle});
    // The shared full-macro fixture owns these same synthetic UUIDs. Signing
    // is by immutable document identity, not by incidental JS object identity.
    s.item.id = 'weapon'; s.item.uuid = `${s.owner.uuid}.Item.weapon`;
    const scope = await withGlobals(s.globals, () => module.resolveAoeLaunchScope(s.operator, s.item, {
        operatorActor: s.operator, token: s.token, poolAttack: s.poolAttack({
            rawRoll: rawRoll(total, initial), baseModifier: modifier, source, criticalFailure,
        }), skipConsumption: true, attackPoint: point, attackSetup: setup,
    }));
    const services = path.resolve(__dirname, '../scripts/services');
    const aoeServices = {
        ...await import(pathToFileURL(path.join(services, 'AoeAttackProfile.js'))),
        ...await import(pathToFileURL(path.join(services, 'AoeResourceService.js'))),
        ...await import(pathToFileURL(path.join(services, 'AoeAnimationService.js'))),
        ...await import(pathToFileURL(path.join(services, 'WeaponDamageModifier.js'))),
        ...await import(pathToFileURL(path.join(services, 'AoeChatControl.js'))),
        isTrustedAoePoolAttack: module.isTrustedAoePoolAttack,
        showAoeAttackDialog() { throw new Error('A resolved pool must not open a second setup dialog'); },
    };
    return {poolAttack: scope.poolAttack, skipConsumption: true,
        attackPoint: scope.attackPoint, attackSetup: scope.attackSetup, aoeServices};
}

test('AoE preplacement accepts every pool point without rolls, resources, dialogs or templates', async () => {
    const {prepareAoePoolPoints} = await launcher;
    const s = fixture({vehicle: true});
    const result = await withGlobals(s.globals, () => prepareAoePoolPoints({actor: s.operator,
        item: s.item, weaponOwner: s.owner, token: s.token, candidates: s.candidates, setup: {aoe: true}}));
    assert.deepEqual(result, [{candidateIndex: 0, attackPoint: {x: 100, y: 100}},
        {candidateIndex: 1, attackPoint: {x: 200, y: 100}}]);
    assert.equal(s.crosshairs.length, 2);
    assert.equal(s.crosshairs[0].distance, 2);
    assert.equal(s.crosshairs[0].location.obj, s.token);
    assert.equal(s.crosshairs[0].location.limitMaxRange, 40);
    assert.match(s.crosshairs[1].label.text, /2\/2/);
    assert.deepEqual(s.mutations, []);
    assert.equal(s.item.system.currentShots, 0, 'Already paid pool is not revalidated by placement');
});

test('cancelling any AoE point discards all earlier points before the parent can spend ammunition', async () => {
    const {prepareAoePoolPoints} = await launcher;
    for (const points of [[null], [{x: 100, y: 100}, null],
        [{x: 100, y: 100}, {x: 200, y: 100, cancel: true}]]) {
        const s = fixture({points});
        const result = await withGlobals(s.globals, () => prepareAoePoolPoints({actor: s.operator,
            item: s.item, weaponOwner: s.owner, token: s.token, candidates: s.candidates}));
        assert.deepEqual(result, []);
        assert.deepEqual(s.mutations, []);
    }
});

test('AoE preplacement rejects disabled items, mismatched owner/operator permissions and invalid points/ranges', async () => {
    const {prepareAoePoolPoints} = await launcher;
    for (const mutate of [
        s => {s.item.flags['swade-tools'].aoeEnabled = false;},
        s => {s.owner.isOwner = false;},
        s => {s.operator.isOwner = false;},
        s => {s.token.actor = {uuid: 'Actor.other'};},
        s => {s.item.system.range = 'unknown';},
        s => {s.item.flags['swade-tools'].aoeDamageAction = 'deleted';},
        s => {s.candidates[0].modifier = NaN;},
    ]) {
        const s = fixture(); mutate(s);
        const result = await withGlobals(s.globals, () => prepareAoePoolPoints({actor: s.operator,
            item: s.item, weaponOwner: s.owner, token: s.token, candidates: s.candidates}));
        assert.deepEqual(result, []); assert.deepEqual(s.mutations, []);
    }
    for (const point of [{x: null, y: 100}, {x: Infinity, y: 100}, {x: 5000, y: 50}]) {
        const s = fixture({points: [point]});
        assert.deepEqual(await withGlobals(s.globals, () => prepareAoePoolPoints({actor: s.operator,
            item: s.item, weaponOwner: s.owner, token: s.token, candidates: s.candidates})), []);
        assert.deepEqual(s.mutations, []);
    }
});

test('AoE preplacement discards accepted points when damage settings change during placement', async () => {
    const {prepareAoePoolPoints} = await launcher;
    const s = fixture();
    const show = s.globals.Sequencer.Crosshair.show;
    s.globals.Sequencer.Crosshair.show = async (...args) => {
        const point = await show(...args);
        s.item.flags['swade-tools'].aoeBlastSize = 'large';
        return point;
    };
    const result = await withGlobals(s.globals, () => prepareAoePoolPoints({actor: s.operator,
        item: s.item, weaponOwner: s.owner, token: s.token, candidates: s.candidates}));
    assert.deepEqual(result, []);
    assert.match(s.notices.at(-1), /settings changed during placement/);
    assert.deepEqual(s.mutations, []);
});

test('launcher signs a matching pool context and preserves prefilled setup without opening a second dialog', async () => {
    const {resolveAoeLaunchScope, isTrustedAoePoolAttack} = await launcher;
    const s = fixture({vehicle: true});
    const attackPoint = {x: 100, y: 100}, attackSetup = {aoe: true, otherModifierFormula: '1d6', consume: true};
    const scope = await withGlobals(s.globals, () => resolveAoeLaunchScope(s.operator, s.item, {
        operatorActor: s.operator, token: s.token, poolAttack: s.poolAttack(),
        skipConsumption: true, attackPoint, attackSetup}));
    assert.equal(scope.skipConsumption, true);
    assert.deepEqual(scope.attackSetup, attackSetup);
    assert.notEqual(scope.attackSetup, attackSetup);
    assert.deepEqual(scope.attackPoint, attackPoint);
    assert.ok(Object.isFrozen(scope.poolAttack));
    const context = {item: s.item, weaponOwner: s.owner, operatorActor: s.operator,
        token: s.token, point: attackPoint};
    assert.equal(isTrustedAoePoolAttack(scope.poolAttack, context), true);
    assert.equal(scope.aoeServices.isTrustedAoePoolAttack(scope.poolAttack, context), true);
    assert.equal(isTrustedAoePoolAttack({...scope.poolAttack}, context), false, 'Copied scope cannot inherit authorization');
    assert.equal(isTrustedAoePoolAttack(scope.poolAttack, {...context, point: {x: 200, y: 100}}), false);
    assert.equal(isTrustedAoePoolAttack(scope.poolAttack, {...context, operatorActor: {uuid: 'Actor.other'}}), false);
    scope.poolAttack.rawRoll.total += 1;
    assert.equal(isTrustedAoePoolAttack(scope.poolAttack, context), false, 'Changed candidate cannot reuse a signed result');
});

test('launcher rejects forged skip-consumption flags and stale/invalid pool snapshots', async () => {
    const {resolveAoeLaunchScope} = await launcher;
    const s = fixture();
    const options = {operatorActor: s.operator, token: s.token, skipConsumption: true,
        attackPoint: {x: 100, y: 100}, attackSetup: {aoe: true}};
    await withGlobals(s.globals, async () => {
        await assert.rejects(resolveAoeLaunchScope(s.operator, s.item, options), /resolved RoF pool/);
        for (const override of [
            {weaponUuid: 'Actor.other.Item.weapon'}, {weaponActorUuid: 'Actor.other'},
            {operatorActorUuid: 'Actor.other'}, {baseModifier: NaN}, {rawRoll: rawRoll(NaN)},
            {rawRoll: {total: 7, toJSON() {return {};}}}, {disableBenny: false},
            {candidateIndex: -1}, {candidateIndex: 0.5}, {poolId: ''}, {source: 'unknown'},
        ]) {
            await assert.rejects(resolveAoeLaunchScope(s.operator, s.item,
                {...options, poolAttack: s.poolAttack(override)}), /AoE pool result/);
        }
        await assert.rejects(resolveAoeLaunchScope(s.operator, s.item,
            {...options, poolAttack: s.poolAttack(), attackSetup: undefined}), /incomplete/);
    });
});

test('normal prefilled AoE setup is forwarded but does not authorize a resource bypass', async () => {
    const {resolveAoeLaunchScope} = await launcher;
    const s = fixture();
    const scope = await withGlobals(s.globals, () => resolveAoeLaunchScope(s.operator, s.item,
        {token: s.token, attackSetup: {otherModifierFormula: '-2', consume: true}}));
    assert.deepEqual(scope.attackSetup, {otherModifierFormula: '-2', consume: true});
    assert.equal(scope.poolAttack, undefined);
    assert.equal(scope.skipConsumption, undefined);
});

test('AoE token lookup rejects ambiguous linked copies and prioritizes an explicit sheet token', async () => {
    const {findAoeActorToken, resolveAoeLaunchScope} = await launcher;
    const s = fixture(), copy = {...s.token, id: 'second-token',
        document: {uuid: 'Scene.scene.Token.second'}};
    s.owner.getActiveTokens = () => [s.token, copy];
    await withGlobals(s.globals, async () => {
        s.globals.canvas.tokens.controlled = [s.token, copy];
        assert.equal(findAoeActorToken(s.owner), null);
        assert.match(s.notices.at(-1), /exactly one firing token/);
        s.globals.canvas.tokens.controlled = [];
        assert.equal(findAoeActorToken(s.owner), null);
        s.owner.token = {object: copy};
        assert.equal(findAoeActorToken(s.owner), copy);
        assert.equal((await resolveAoeLaunchScope(s.operator, s.item, {token: s.token})).token, s.token);
        delete s.owner.token;
        s.globals.canvas.tokens.controlled = [copy];
        assert.equal(findAoeActorToken(s.owner), copy);
    });
});

test('AoE launcher rejects a wrong firing token and a non-owned operator before loading or executing its macro', async () => {
    const {launchAoeMacro} = await launcher;
    for (const mode of ['wrong-token', 'unowned-operator']) {
        const s = fixture({vehicle: true});
        if (mode === 'wrong-token') s.token.actor = {uuid: 'Actor.other', id: s.owner.id};
        else s.operator.isOwner = false;
        await withGlobals({...s.globals, fetch() {throw new Error('A rejected source must never load the macro');}}, async () => {
            assert.equal(await launchAoeMacro(s.operator, s.item,
                {operatorActor: s.operator, token: s.token, attackSetup: {aoe: true}}), false);
        });
        assert.match(s.notices.at(-1), /firing token does not own|own both/);
        assert.deepEqual(s.mutations, []);
    }
});

test('full AoE adapter reuses one resolved pool die and does not roll, consume, prompt or offer per-point Bennies', async () => {
    const poolScope = await signedPoolScope({total: 7, modifier: 1});
    const s = await runAttack({poolScope, dice: [], currentShots: 0, quantity: 0,
        name: 'Grenade Launcher', itemModifier: '@alreadyResolvedElsewhere',
        globalMods: {attack: [{label: 'Prepared pool effect', value: '1d6'}]},
        skillEffects: [{label: 'Pool effect', value: '1d6'}]});
    assert.equal(s.panelCalls, 0); assert.equal(s.setupDialogs, 0); assert.equal(s.crosshairCalls, 0);
    assert.equal(s.weapon.system.currentShots, 0); assert.equal(s.weapon.system.quantity, 0);
    assert.equal(s.quantityUpdates, 0);
    assert.ok(!s.events.some(event => event === 'ammo' || event.startsWith('roll:')));
    assert.equal(s.cards.length, 1); assert.equal(s.nativeCards.length, 2);
    assert.ok(s.nativeCards.every(card => card.raise === true));
    const card = s.cards[0];
    assert.match(card.content, /<div class="dice-total"[^>]*>8<\/div>/);
    assert.match(card.content, /Pool result 1/); assert.match(card.content, /Pool \+1/);
    assert.ok(!/data-grenade-benny|Prepared pool effect|Benny Reroll \(/.test(card.content));
    assert.equal(card.flags.world.aoePoolId, 'pool-attack');
    assert.equal(card.flags.world.grenadeBennySession, undefined);
    assert.equal(s.platform.__swadeGrenadeBennyRuntime.handlers.size, 0);
    assert.equal(card.rolls.length, 1);
    assert.deepEqual(card.rolls[0], poolScope.poolAttack.rawRoll.toJSON());
});

test('each preselected AoE point applies its own range exactly once to the shared pool modifier', async () => {
    for (const [x, penalty] of [[100, 0], [1550, -2], [2550, -4]]) {
        const poolScope = await signedPoolScope({total: 7, modifier: 1, point: {x, y: 50},
            setup: {aoe: true, otherModifierFormula: '1d6', situationalModifier: -10, consume: true}});
        const s = await runAttack({poolScope, dice: [], currentShots: 0});
        assert.match(s.cards[0].content, new RegExp(`<div class="dice-total"[^>]*>${8 + penalty}<\\/div>`));
        assert.ok(!s.events.some(event => event.startsWith('roll:')));
        assert.equal(s.crosshairCalls, 0); assert.equal(s.panelCalls, 0);
        assert.equal(s.weapon.system.currentShots, 0);
        if (penalty === -4) assert.equal(s.scene.templates.get('template').flags.world.pendingDeviation, false);
    }
});

test('pool AoE forwards the advanced damage modifier to each native target without overwriting existing Mod or item fields', async () => {
    const poolScope = await signedPoolScope({total: 8, modifier: 0,
        setup: {aoe: true, otherModifierFormula: '0', damageModifier: '+2', consume: true}});
    const nativeValues = [];
    const originalGuard = poolScope.aoeServices.withSuppressedAoeAutomation;
    poolScope.aoeServices.withSuppressedAoeAutomation = async (items, callback, runtime) => {
        const inputs = [];
        const hook = runtime.hooksRef.on('renderDialog', (_dialog, root) => {
            const input = {value: '1'};
            const original = root.querySelector.bind(root);
            root.querySelector = selector => selector === '#mod' ? input : original(selector);
            inputs.push(input);
        });
        try { return await originalGuard(items, callback, runtime); }
        finally {
            runtime.hooksRef.off('renderDialog', hook);
            nativeValues.push(...inputs.map(input => input.value));
        }
    };
    const s = await runAttack({poolScope, dice: [], itemModifier: '1'});
    assert.equal(s.nativeCards.length, 2);
    assert.deepEqual(nativeValues, ['(1)+(+2)', '(1)+(+2)']);
    assert.equal(s.weapon.system.actions.traitMod, '1');
    assert.ok(!s.events.some(event => event.startsWith('roll:')));
});

test('pool failure keeps normal deviation damage but never creates an extra confirmation or attack roll', async () => {
    const poolScope = await signedPoolScope({total: 3, modifier: 0});
    const s = await runAttack({poolScope, dice: [], currentShots: 0});
    assert.equal(s.nativeCards.length, 0);
    assert.equal(s.scene.templates.get('template').flags.world.pendingDeviation, true);
    await s.emitHook('updateMeasuredTemplate', s.scene.templates.get('template'), {x: 110});
    assert.equal(s.nativeCards.length, 2);
    await s.emitHook('updateMeasuredTemplate', s.scene.templates.get('template'), {x: 120});
    assert.equal(s.nativeCards.length, 2);
    assert.ok(!s.events.some(event => event.startsWith('roll:') || event === 'ammo'));
});

test('global pool critical failure and Extra natural one remain failures despite high shared modifiers', async () => {
    for (const [criticalFailure, wildcard] of [[true, true], [false, false]]) {
        const poolScope = await signedPoolScope({total: 1, initial: 1, modifier: 20, criticalFailure});
        const s = await runAttack({poolScope, wildcard, dice: [], currentShots: 0});
        assert.equal(s.nativeCards.length, 0);
        assert.equal(s.scene.templates.get('template').flags.world.throwSucceeded, false);
        assert.ok(!s.events.some(event => event.startsWith('roll:')));
        assert.ok(!s.cards[0].content.includes('data-grenade-benny'));
    }
});

test('wild candidate renders its own die and AA dispatches once while native per-target damage is suppressed', async () => {
    const poolScope = await signedPoolScope({source: 'wild', total: 8, modifier: 0});
    const s = await runAttack({poolScope, dice: [], currentShots: 0, automatedAnimations: true});
    assert.equal(s.animations.length, 1); assert.equal(s.nativeCards.length, 2);
    assert.deepEqual(s.automaticAnimationEvents.map(event => event.trigger), ['damage', 'damage']);
    assert.ok(s.automaticAnimationEvents.every(event => event.stopped));
    assert.match(s.cards[0].content, /Wild: 1d10x = 8/);
    assert.equal(s.cards[0].rolls.length, 1);
    assert.ok(!s.events.some(event => event.startsWith('roll:') || event === 'ammo'));
});

test('standalone macro rejects forged pool and skip-consumption scopes before dice, ammo, placement or cards', async () => {
    for (const poolScope of [{skipConsumption: true},
        {poolAttack: {rawRoll: rawRoll(), baseModifier: 2}, skipConsumption: true,
            attackPoint: {x: 100, y: 100}, attackSetup: {aoe: true}}]) {
        const s = await runAttack({poolScope, dice: []});
        assert.equal(s.cards.length, 0); assert.equal(s.nativeCards.length, 0);
        assert.equal(s.crosshairCalls, 0); assert.equal(s.panelCalls, 0);
        assert.ok(!s.events.some(event => event.startsWith('roll:') || event === 'ammo'));
        assert.ok(s.notices.some(notice => notice.kind === 'error' && /not authorized/.test(notice.text)));
    }
});

test('prefilled RoF1 AoE setup bypasses the second panel but retains its normal roll and resource debit', async () => {
    const s = await runAttack({poolScope: {attackSetup: {otherModifierFormula: '-2', consume: true}}, dice: [8, 5]});
    assert.equal(s.panelCalls, 0); assert.equal(s.crosshairCalls, 1);
    assert.equal(s.weapon.system.currentShots, 3);
    assert.equal(s.events.filter(event => event === 'ammo').length, 1);
    assert.equal(s.events.filter(event => event.startsWith('roll:')).length, 2);
    assert.match(s.cards[0].content, /<div class="dice-total"[^>]*>6<\/div>/);
    assert.equal(s.nativeCards.length, 2);
    assert.ok(s.cards[0].content.includes('data-grenade-benny'));
});

test('signed AoE pool keeps its existing Drop attack bonus and adds the separate damage bonus once per target', async () => {
    const poolScope=await signedPoolScope({total:6,modifier:4,
        setup:{aoe:true,otherModifierFormula:'0',damageModifier:'+2',theDrop:true,consume:true}});
    const s=await runAttack({poolScope,dice:[],currentShots:0});
    assert.match(s.cards[0].content,/<div class="dice-total"[^>]*>10<\/div>/);
    assert.equal(s.nativeCards.length,2);
    assert.deepEqual(s.nativeCards.map(card=>card.modifier),['(+2)+(4)','(+2)+(4)']);
    assert.equal(s.panelCalls,0);assert.equal(s.crosshairCalls,0);
    assert.ok(!s.events.some(event=>event==='ammo'||event.startsWith('roll:')));
    assert.equal(s.platform.__swadeGrenadeBennyRuntime.handlers.size,0);
});
