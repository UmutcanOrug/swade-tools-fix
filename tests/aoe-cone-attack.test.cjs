const assert = require('node:assert/strict');
const {test} = require('node:test');
const {runAttack} = require('./aoe-attack.test.cjs');
const victims = () => ['one', 'two'].map((id, i) => ({id, name: `Target ${id}`, isVisible: true,
    x: 400 + i * 100, y: 20, w: 50, h: 50, center: {x: 425 + i * 100, y: 45}, actor: {name: id},
    document: {id, uuid: `Scene.scene.Token.${id}`}}));
const coneFlags = {aoeTemplateShape: 'cone'};
const services = extra => ({placeWeaponAoeTemplatePoint: async () => ({x: 1000, y: 50, direction: 0}), ...extra});
const reroll = async s => {
    const card = s.cards.at(-1);
    await s.platform.__swadeGrenadeBennyRuntime.handlers.get(card.flags.world.grenadeBennySession)('actor', card.id);
};

test('flamethrower cone uses native weapon Trait, emits from firing token and never guesses range bands', async () => {
    let placement;
    const s = await runAttack({name: 'Flamethrower', trait: 'Shooting', range: 'Cone Template', dice: [4, 2],
        flags: coneFlags, targetTokens: victims(), serviceOverrides: services({placeWeaponAoeTemplatePoint: async input => {
            placement = input; return {x: 1000, y: 50, direction: 0};
        }})});
    assert.equal(placement.actor, s.owner); assert.equal(placement.shape, 'cone'); assert.equal(placement.origin, 'token');
    assert.equal(s.cards[0].flags.world.aoeAttack.total, 4);
    assert.equal(s.cards[0].flags.world.aoeAttack.success, true);
    assert.match(s.cards[0].content, /Template \(0\)/);
    assert.match(s.cards[0].content, /Cone Template/);
    const template = s.scene.templates.get('template');
    assert.equal(template.t, 'cone'); assert.equal(template.distance, 9); assert.equal(template.width, 3); assert.equal(template.angle, 0);
    assert.equal(template.x, 50); assert.equal(template.y, 50); assert.equal(template.direction, 0);
    assert.equal(template.flags.world.pendingDeviation, false);
    assert.equal(template.flags['swade-tools'].autoTarget, false);
    assert.equal(s.nativeCards.length, 2); assert.equal(s.weapon.system.currentShots, 3);
    assert.equal(s.crosshairCalls, 0);
});

test('failed cone has no scatter, ignores manual template movement, and Benny success damages once without extra ammo', async () => {
    const s = await runAttack({flags: coneFlags, range: 'Cone Template', dice: [2, 3, 6, 4],
        targetTokens: victims(), serviceOverrides: services()});
    const template = s.scene.templates.get('template');
    assert.equal(s.nativeCards.length, 0);
    assert.equal(template.flags.world.pendingDeviation, false);
    assert.doesNotMatch(s.cards[0].content, /data-aoe-resolve-deviation|Resolve Deviation/);
    assert.match(s.cards[0].content, /No Effect/);
    template.x = 5000; template.y = 5000;
    await s.emitHook('updateMeasuredTemplate', template, {x: 5000, y: 5000}, {}, 'gm');
    assert.equal(s.nativeCards.length, 0);
    assert.equal(s.cards[0].flags.world.aoeAttack.deviationResolved, false);
    await reroll(s);
    assert.equal(s.nativeCards.length, 2);
    assert.equal(template.x, 50); assert.equal(template.y, 50);
    assert.equal(s.cards.at(-1).flags.world.aoeAttack.success, true);
    assert.equal(s.events.filter(event => event === 'ammo').length, 1);
    assert.equal(s.events.filter(event => event === 'template').length, 1);
});

test('free weapon cones preserve selected origin and rotation, while canceled placement spends nothing', async () => {
    const s = await runAttack({flags: {...coneFlags, aoeTemplateOrigin: 'free'},
        targetTokens: [{...victims()[0], x: 180, y: 500, center: {x: 205, y: 525}}],
        serviceOverrides: services({placeWeaponAoeTemplatePoint: async input => {
            assert.equal(input.origin, 'free'); return {x: 200, y: 200, direction: 90};
        }})});
    const template = s.scene.templates.get('template');
    assert.equal(template.x, 200); assert.equal(template.y, 200); assert.equal(template.direction, 90);
    assert.equal(s.nativeCards.length, 1);
    assert.equal(s.cards[0].flags.world.aoeAttack.origin, 'free');
    const cancelled = await runAttack({flags: coneFlags,
        serviceOverrides: services({placeWeaponAoeTemplatePoint: async () => null})});
    assert.equal(cancelled.cards.length, 0); assert.equal(cancelled.nativeCards.length, 0);
    assert.equal(cancelled.weapon.system.currentShots, 4); assert.equal(cancelled.scene.templates.size, 0);
});

test('Evade gates native cone damage and fire; same-attack results survive Benny replacement cards', async () => {
    const calls = [];
    const s = await runAttack({flags: {...coneFlags, aoeAutoEvade: true, aoeFireEnabled: true},
        dice: [6, 4, 8, 3], targetTokens: victims(), serviceOverrides: services({
            async resolveAoeEvade(message, uuid) {
                calls.push(`evade:${uuid}`);
                const evaded = uuid.endsWith('.one');
                const result = {evaded, total: evaded ? 5 : 2};
                await message.update({'flags.world.aoeEvadeResults': {...message.flags.world.aoeEvadeResults, [uuid]: result}});
                return {allowed: !evaded, evaded};
            },
            async recordAoeFireHit(message, uuid) {
                calls.push(`fire:${uuid}`);
                await message.update({'flags.world.aoeFireResults': {[uuid]: {ignited: true, roll: 6}}});
                return {ignited: true};
            }
        })});
    assert.deepEqual(calls, ['evade:Scene.scene.Token.one', 'evade:Scene.scene.Token.two', 'fire:Scene.scene.Token.two']);
    assert.equal(s.nativeCards.length, 1); assert.equal(s.nativeCards[0].targets, 'two');
    const first = s.cards[0], beforeEvade = structuredClone(first.flags.world.aoeEvadeResults), beforeFire = structuredClone(first.flags.world.aoeFireResults);
    await reroll(s);
    const current = s.cards.at(-1);
    assert.deepEqual(current.flags.world.aoeEvadeResults, beforeEvade);
    assert.deepEqual(current.flags.world.aoeFireResults, beforeFire);
    assert.notEqual(current.flags.world.aoeEvadeResults, first.flags.world.aoeEvadeResults);
    assert.equal(calls.length, 3); assert.equal(s.nativeCards.length, 1);
    assert.equal(current.flags.world.aoeAttack.autoEvade, true);
    assert.equal(current.flags.world.aoeAttack.fire.enabled, true);
});

test('no active GM / pending Evade never rolls damage or ignition and ordinary blast settings remain opt-in', async () => {
    let ignition = 0;
    const s = await runAttack({flags: {aoeAutoEvade: true, aoeFireEnabled: true},
        serviceOverrides: {resolveAoeEvade: async () => ({allowed: false, pending: true}), recordAoeFireHit: async () => ignition++}});
    assert.equal(s.nativeCards.length, 0); assert.equal(ignition, 0);
    const normal = await runAttack();
    assert.equal(normal.cards[0].flags.world.aoeAttack.autoEvade, false);
    assert.equal(normal.cards[0].flags.world.aoeAttack.fire.enabled, false);
    assert.equal(normal.nativeCards.length, 2);
});

test('GM correction or superseding a card during pending Evade prevents late native damage and ignition', async () => {
    for (const mutation of ['miss', 'superseded']) {
        let ignition = 0;
        const s = await runAttack({flags: {...coneFlags, aoeAutoEvade: true, aoeFireEnabled: true},
            targetTokens: victims(), serviceOverrides: services({async resolveAoeEvade(message) {
                if (mutation === 'superseded') await message.update({'flags.world.aoeSuperseded': true});
                else await message.update({'flags.world.aoeAttack': {...message.flags.world.aoeAttack,
                    gmModifier: -10, total: -4, success: false}});
                return {allowed: true, evaded: false};
            }, async recordAoeFireHit() { ignition++; }})});
        assert.equal(s.nativeCards.length, 0); assert.equal(ignition, 0);
        assert.equal(s.events.filter(event => event === 'ammo').length, 1);
    }
});
