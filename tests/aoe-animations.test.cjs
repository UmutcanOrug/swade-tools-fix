const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const service = import(pathToFileURL(path.resolve(__dirname,
    '../scripts/services/AoeAnimationService.js')).href);

const context = overrides => ({
    sourceToken: { id: 'tank-token' },
    item: { uuid: 'Actor.tank.Item.he', flags: { autoanimations: { killAnim: false } } },
    templateDocument: { id: 'blast', x: 200, y: 300, flags: {}, object: { id: 'template-object' } },
    targets: [{ id: 'victim-one' }, { id: 'victim-two' }],
    success: true, throwProjectile: false, blastDiameter: 4,
    projectileEffect: 'jb2a.throwable.throw.grenade.01.green',
    impactEffect: 'jb2a.explosion.01.orange',
    ...overrides
});

function fixture(aaActive = false) {
    const events = [], warnings = [], aaCalls = [], assetChecks = [];
    const gameRef = { modules: new Map([['autoanimations', { active: aaActive }]]) };
    // Animation must use the explicit blast targets, never the player's
    // current target set (or create/remove persistent target rings).
    Object.defineProperty(gameRef, 'user', { get() {
        throw new Error('Animation must not access game.user.targets');
    } });
    class SequenceClass {
        constructor() { events.push(['new-sequence']); }
        effect() { events.push(['effect']); return this; }
        file(value) { events.push(['file', value]); return this; }
        atLocation(value) { events.push(['atLocation', value]); return this; }
        stretchTo(value) { events.push(['stretchTo', value]); return this; }
        waitUntilFinished(value) { events.push(['waitUntilFinished', value]); return this; }
        size(value, options) { events.push(['size', value, options]); return this; }
        async play() { events.push(['play']); }
    }
    const runtime = {
        gameRef, SequenceClass,
        sequencerRef: { Database: { entryExists(path) { assetChecks.push(path); return true; } } },
        automatedAnimations: { async playAnimation(...args) { aaCalls.push(args); return { item: args[1] }; } },
        logger: { warn: (...args) => warnings.push(args) }
    };
    return { runtime, events, warnings, aaCalls, assetChecks };
}

function hooksFixture() {
    const listeners = new Map(), operations = [];
    let nextId = 0;
    return {
        listeners, operations,
        on(name, callback) {
            const id = ++nextId; listeners.set(id, { name, callback });
            operations.push(['on', name, id]); return id;
        },
        off(name, id) {
            operations.push(['off', name, id]);
            assert.equal(listeners.get(id)?.name, name);
            listeners.delete(id);
        },
        call(name, ...args) {
            for (const listener of listeners.values()) {
                if (listener.name === name) listener.callback(...args);
            }
        },
        emit(data) {
            for (const { name, callback } of listeners.values()) {
                if (name === 'aa.getRequiredData') callback(data);
            }
            return data;
        }
    };
}

test('AA receives exact source/item/template and separate explicit success target arrays', async () => {
    const { playAoeAnimation } = await service;
    const setup = fixture(true), attack = context();
    Object.freeze(attack.targets);
    const flagsBefore = JSON.stringify(attack.templateDocument.flags);
    const result = await playAoeAnimation(attack, setup.runtime);
    assert.deepEqual(result, { engine: 'automated-animations', ok: true });
    assert.equal(setup.aaCalls.length, 1);
    const [source, item, options] = setup.aaCalls[0];
    assert.equal(source, attack.sourceToken); assert.equal(item, attack.item);
    assert.deepEqual(options, {
        templateData: attack.templateDocument, isTemplate: true,
        targets: [...attack.targets], hitTargets: [...attack.targets], playOnMiss: false
    });
    assert.equal(options.templateData, attack.templateDocument);
    assert.notEqual(options.targets, attack.targets);
    assert.notEqual(options.targets, options.hitTargets);
    options.targets.pop(); options.hitTargets.pop();
    assert.equal(attack.targets.length, 2);
    assert.equal(JSON.stringify(attack.templateDocument.flags), flagsBefore);
    assert.equal(attack.templateDocument.flags.swade?.origin, undefined);
    assert.equal(setup.events.length, 0); assert.equal(setup.assetChecks.length, 0);
});

test('AA failure receives no hit targets; even an empty blast passes explicit empty arrays', async () => {
    const { playAoeAnimation } = await service;
    const setup = fixture(true), attack = context({ success: false });
    await playAoeAnimation(attack, setup.runtime);
    assert.deepEqual(setup.aaCalls[0][2].hitTargets, []);
    assert.deepEqual(setup.aaCalls[0][2].targets, attack.targets);
    await playAoeAnimation(context({ targets: [], success: true }), setup.runtime);
    assert.deepEqual(setup.aaCalls[1][2].targets, []);
    assert.deepEqual(setup.aaCalls[1][2].hitTargets, []);
});

test('AA false/undefined/disabled outcomes never invoke a Sequencer fallback', async () => {
    const { playAoeAnimation } = await service;
    for (const value of [false, undefined]) {
        const setup = fixture(true);
        setup.runtime.automatedAnimations.playAnimation = async () => value;
        assert.deepEqual(await playAoeAnimation(context(), setup.runtime), {
            engine: 'automated-animations', ok: false
        });
        assert.equal(setup.events.length, 0);
    }
    for (const disabledVia of ['item-killAnim', 'item-isEnabled', 'source-killAnim']) {
        const setup = fixture(true), attack = context();
        if (disabledVia === 'item-killAnim') attack.item.flags.autoanimations.killAnim = true;
        if (disabledVia === 'item-isEnabled') attack.item.flags.autoanimations.isEnabled = false;
        if (disabledVia === 'source-killAnim') attack.sourceToken.document = { flags: { autoanimations: { killAnim: true } } };
        setup.runtime.automatedAnimations.playAnimation = async (source, item) => {
            assert.equal(source, attack.sourceToken); assert.equal(item, attack.item);
            return false;
        };
        const before = JSON.stringify([attack.sourceToken, attack.item.flags]);
        const result = await playAoeAnimation(attack, setup.runtime);
        assert.equal(result.engine, 'automated-animations'); assert.equal(result.ok, false);
        assert.equal(setup.events.length, 0);
        assert.equal(JSON.stringify([attack.sourceToken, attack.item.flags]), before);
    }
});

test('AA missing API and rejected call are nonfatal and do not switch engines', async () => {
    const { playAoeAnimation } = await service;
    const missing = fixture(true); missing.runtime.automatedAnimations = {};
    assert.deepEqual(await playAoeAnimation(context(), missing.runtime), {
        engine: 'automated-animations', ok: false, reason: 'missing-api'
    });
    assert.equal(missing.events.length, 0); assert.equal(missing.warnings.length, 1);
    const failed = fixture(true);
    failed.runtime.automatedAnimations.playAnimation = async () => { throw new Error('AA unavailable'); };
    assert.deepEqual(await playAoeAnimation(context(), failed.runtime), {
        engine: 'automated-animations', ok: false, reason: 'api-error'
    });
    assert.equal(failed.events.length, 0); assert.equal(failed.warnings.length, 1);
});

test('without AA a hand grenade plays one projectile followed by one impact', async () => {
    const { playAoeAnimation } = await service;
    const setup = fixture(false), attack = context({ throwProjectile: true });
    const result = await playAoeAnimation(attack, setup.runtime);
    assert.deepEqual(result, { engine: 'sequencer', ok: true });
    assert.deepEqual(setup.events.filter(([type]) => type === 'file'), [
        ['file', attack.projectileEffect], ['file', attack.impactEffect]
    ]);
    assert.deepEqual(setup.events.filter(([type]) => type === 'stretchTo'), [
        ['stretchTo', attack.templateDocument.object]
    ]);
    assert.deepEqual(setup.events.find(([type]) => type === 'size'), ['size', 4, { gridUnits: true }]);
    assert.equal(setup.events.filter(([type]) => type === 'play').length, 1);
    assert.equal(setup.aaCalls.length, 0);
});

test('without AA a cannon plays only impact and can use document coordinates without an object', async () => {
    const { playAoeAnimation } = await service;
    const setup = fixture(false), attack = context();
    delete attack.templateDocument.object;
    assert.equal((await playAoeAnimation(attack, setup.runtime)).ok, true);
    assert.deepEqual(setup.events.filter(([type]) => type === 'file'), [['file', attack.impactEffect]]);
    assert.equal(setup.events.filter(([type]) => type === 'stretchTo').length, 0);
    assert.deepEqual(setup.events.find(([type]) => type === 'atLocation'), ['atLocation', { x: 200, y: 300 }]);
    assert.deepEqual(setup.assetChecks, [attack.impactEffect]);
});

test('Sequencer missing assets or engine and playback errors do not throw or access user targets', async () => {
    const { playAoeAnimation } = await service;
    for (const assetResult of [false, 'throw']) {
        const setup = fixture(false);
        setup.runtime.sequencerRef.Database.entryExists = () => {
            if (assetResult === 'throw') throw new Error('Missing database');
            return false;
        };
        assert.deepEqual(await playAoeAnimation(context(), setup.runtime), {
            engine: 'sequencer', ok: false, reason: 'missing-assets'
        });
        assert.equal(setup.events.length, 0);
    }
    const missing = fixture(false); missing.runtime.SequenceClass = {};
    assert.equal((await playAoeAnimation(context(), missing.runtime)).reason, 'missing-assets');
    const failed = fixture(false);
    failed.runtime.SequenceClass = class { constructor() { throw new Error('Renderer failed'); } };
    assert.deepEqual(await playAoeAnimation(context(), failed.runtime), {
        engine: 'sequencer', ok: false, reason: 'play-error'
    });
    assert.equal(failed.warnings.length, 1);
});

test('missing animation context resolves safely before invoking either engine', async () => {
    const { playAoeAnimation } = await service;
    for (const key of ['sourceToken', 'item', 'templateDocument']) {
        const setup = fixture(true);
        assert.deepEqual(await playAoeAnimation(context({ [key]: null }), setup.runtime), {
            engine: 'none', ok: false, reason: 'missing-context'
        });
        assert.equal(setup.aaCalls.length, 0); assert.equal(setup.events.length, 0);
    }
});

test('native guard stamps only matching source/damage item UUID and cleans up once', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true);
    const source = { uuid: 'Actor.tank.Item.he' }, damage = { uuid: 'Actor.tank.Item.damage-profile' };
    const runtime = { ...setup.runtime, hooksRef: hooks };
    const result = await withSuppressedAoeAutomation([source, damage, source, null], async () => {
        assert.equal(hooks.listeners.size, 1);
        assert.equal(hooks.emit({ item: { uuid: source.uuid } }).stopWorkflow, true);
        assert.equal(hooks.emit({ itemUuid: damage.uuid }).stopWorkflow, true);
        assert.equal(hooks.emit({ item: { uuid: 'Actor.other.Item.normal' } }).stopWorkflow, undefined);
        return 'native-complete';
    }, runtime);
    assert.equal(result, 'native-complete'); assert.equal(hooks.listeners.size, 0);
    assert.equal(hooks.operations.filter(([operation]) => operation === 'on').length, 1);
    assert.equal(hooks.operations.filter(([operation]) => operation === 'off').length, 1);
    assert.equal(hooks.emit({ item: source }).stopWorkflow, undefined);
});

test('nested same-item guard keeps the outer suppression active until its own completion', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true), item = { uuid: 'Actor.actor.Item.weapon' };
    const runtime = { ...setup.runtime, hooksRef: hooks };
    await withSuppressedAoeAutomation([item], async () => {
        await withSuppressedAoeAutomation([{ uuid: item.uuid }], async () => {
            assert.equal(hooks.emit({ item }).stopWorkflow, true);
        }, runtime);
        assert.equal(hooks.emit({ item }).stopWorkflow, true);
        assert.equal(hooks.listeners.size, 1);
    }, runtime);
    assert.equal(hooks.listeners.size, 0);
    assert.equal(hooks.operations.filter(([operation]) => operation === 'off').length, 1);
});

test('concurrent guards preserve refcounts while releasing unrelated items independently', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true);
    const first = { uuid: 'Actor.actor.Item.first' }, second = { uuid: 'Actor.actor.Item.second' };
    const runtime = { ...setup.runtime, hooksRef: hooks };
    let releaseFirst, releaseOverlap;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const overlapGate = new Promise(resolve => { releaseOverlap = resolve; });
    const runningFirst = withSuppressedAoeAutomation([first], () => firstGate, runtime);
    const runningOverlap = withSuppressedAoeAutomation([first, second], () => overlapGate, runtime);
    assert.equal(hooks.emit({ item: first }).stopWorkflow, true);
    assert.equal(hooks.emit({ item: second }).stopWorkflow, true);
    releaseOverlap(); await runningOverlap;
    assert.equal(hooks.emit({ item: first }).stopWorkflow, true);
    assert.equal(hooks.emit({ item: second }).stopWorkflow, undefined);
    assert.equal(hooks.listeners.size, 1);
    releaseFirst(); await runningFirst;
    assert.equal(hooks.listeners.size, 0);
    assert.equal(hooks.operations.filter(([operation]) => operation === 'on').length, 1);
});

test('guard finally releases on synchronous throw or promise rejection without leaking future attacks', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true), item = { uuid: 'Actor.actor.Item.weapon' };
    const runtime = { ...setup.runtime, hooksRef: hooks };
    for (const callback of [() => { throw new Error('native failed'); }, () => Promise.reject(new Error('native failed'))]) {
        await assert.rejects(withSuppressedAoeAutomation([item], callback, runtime), /native failed/);
        assert.equal(hooks.listeners.size, 0);
        assert.equal(hooks.emit({ item }).stopWorkflow, undefined);
    }
    await withSuppressedAoeAutomation([item], () => 'next attack', runtime);
    assert.equal(hooks.listeners.size, 0);
});

test('inactive AA or absent hooks skip suppression and still return the native callback result', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const item = { uuid: 'Actor.actor.Item.weapon' }, hooks = hooksFixture();
    const inactive = fixture(false);
    assert.equal(await withSuppressedAoeAutomation([item], () => 17, { ...inactive.runtime, hooksRef: hooks }), 17);
    assert.equal(hooks.operations.length, 0);
    const active = fixture(true);
    assert.equal(await withSuppressedAoeAutomation([item], () => 18, { ...active.runtime, hooksRef: {} }), 18);
    assert.equal(await withSuppressedAoeAutomation([], () => 19, { ...active.runtime, hooksRef: hooks }), 19);
    assert.equal(hooks.operations.length, 0);
});

test('tracked linked consumable remains suppressed after the parent consume callback returns', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true);
    const weapon = { uuid: 'Actor.tank.Item.cannon' }, ammo = { uuid: 'Actor.tank.Item.he-ammo' };
    const weaponUsage = { itemUpdates: { currentShots: 1 } }, ammoUsage = { itemUpdates: { charges: 2 } };
    const capturedData = [];
    // Mirror AA 6.8.5: its post-consume hook synchronously prepares data,
    // then the asynchronous handler receives this stamped workflow later.
    hooks.on('swadeConsumeItem', item => {
        const data = hooks.emit({ item });
        capturedData.push(data);
    });
    const runtime = { ...setup.runtime, hooksRef: hooks, trackConsumption: true };
    let settled = false;
    const running = withSuppressedAoeAutomation([weapon, ammo], () => {
        hooks.call('swadePreConsumeItem', ammo, 1, ammoUsage);
        hooks.call('swadePreConsumeItem', weapon, 1, weaponUsage);
        hooks.call('swadeConsumeItem', weapon, 1, weaponUsage);
        return 'resource-spent';
    }, runtime).then(value => { settled = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(hooks.emit({ item: ammo }).stopWorkflow, true);
    assert.equal(hooks.emit({ item: { uuid: 'Actor.other.Item.ammo' } }).stopWorkflow, undefined);
    hooks.call('swadeConsumeItem', ammo, 1, ammoUsage);
    assert.equal(await running, 'resource-spent');
    assert.equal(capturedData.length, 2);
    assert.ok(capturedData.every(data => data.stopWorkflow === true));
    // Only the simulated AA's own hook remains. Future native uses are free.
    assert.equal(hooks.listeners.size, 1);
    assert.equal(hooks.emit({ item: ammo }).stopWorkflow, undefined);
    assert.equal(setup.warnings.length, 0);
});

test('consumption completion requires both the resource UUID and the exact usage object', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true), ammo = { uuid: 'Actor.tank.Item.ammo' };
    const usage = { resourceUpdates: [] };
    const runtime = { ...setup.runtime, hooksRef: hooks, trackConsumption: true };
    let settled = false;
    const running = withSuppressedAoeAutomation([ammo], () => {
        hooks.call('swadePreConsumeItem', ammo, 1, usage);
        // Unrelated resources, malformed pre-events and duplicate pre-events
        // do not add extra waiters or alter this usage's completion identity.
        hooks.call('swadePreConsumeItem', { uuid: 'Actor.other.Item.ammo' }, 1, {});
        hooks.call('swadePreConsumeItem', ammo, 1, undefined);
        hooks.call('swadePreConsumeItem', ammo, 1, usage);
        return 7;
    }, runtime).then(value => { settled = true; return value; });
    await Promise.resolve();
    hooks.call('swadeConsumeItem', ammo, 1, { resourceUpdates: [] });
    hooks.call('swadeConsumeItem', { uuid: 'Actor.other.Item.ammo' }, 1, usage);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    hooks.call('swadeConsumeItem', { uuid: ammo.uuid }, 1, usage);
    assert.equal(await running, 7);
    assert.equal(hooks.listeners.size, 0);
});

test('tracked consumption timeout is bounded and releases hooks without changing the native result', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true), item = { uuid: 'Actor.actor.Item.ammo' };
    const timers = new Map();
    let nextTimer = 0;
    const runtime = { ...setup.runtime, hooksRef: hooks, trackConsumption: true,
        consumptionTimeoutMs: 8000,
        setTimeout(callback, milliseconds) {
            const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id;
        },
        clearTimeout(id) { timers.delete(id); },
    };
    const usage = {};
    const running = withSuppressedAoeAutomation([item], () => {
        hooks.call('swadePreConsumeItem', item, 1, usage);
        return { ok: true, consumed: 1 };
    }, runtime);
    await Promise.resolve();
    assert.equal(timers.size, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.milliseconds, 8000);
    timer.callback();
    assert.deepEqual(await running, { ok: true, consumed: 1 });
    assert.equal(timers.size, 0);
    assert.equal(hooks.listeners.size, 0);
    assert.equal(setup.warnings.length, 1);
    hooks.call('swadeConsumeItem', item, 1, usage);
    assert.equal(hooks.emit({ item }).stopWorkflow, undefined);
});

test('tracked consumption failure cleans up pending records immediately without a timeout', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true), item = { uuid: 'Actor.actor.Item.ammo' };
    let scheduled = 0;
    const runtime = { ...setup.runtime, hooksRef: hooks, trackConsumption: true,
        setTimeout() { scheduled += 1; throw new Error('No timeout should be scheduled'); },
    };
    const usage = {};
    await assert.rejects(withSuppressedAoeAutomation([item], async () => {
        hooks.call('swadePreConsumeItem', item, 1, usage);
        throw new Error('native resource update failed');
    }, runtime), /native resource update failed/);
    assert.equal(scheduled, 0);
    assert.equal(hooks.listeners.size, 0);
    hooks.call('swadeConsumeItem', item, 1, usage);
    assert.equal(hooks.emit({ item }).stopWorkflow, undefined);
    assert.equal(setup.warnings.length, 0);
});

test('tracked consumption without a pending native usage needs no timer and preserves outer guards', async () => {
    const { withSuppressedAoeAutomation } = await service;
    const hooks = hooksFixture(), setup = fixture(true), item = { uuid: 'Actor.actor.Item.weapon' };
    const runtime = { ...setup.runtime, hooksRef: hooks };
    await withSuppressedAoeAutomation([item], async () => {
        const result = await withSuppressedAoeAutomation([item], () => 'quantity-update', {
            ...runtime, trackConsumption: true,
            setTimeout() { throw new Error('Quantity-only updates must not wait'); },
        });
        assert.equal(result, 'quantity-update');
        assert.equal(hooks.listeners.size, 1);
        assert.equal(hooks.emit({ item }).stopWorkflow, true);
    }, runtime);
    assert.equal(hooks.listeners.size, 0);
});
