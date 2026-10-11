const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.resolve(__dirname,
    '../scripts/services/AoeFireVisuals.js')).href);

function fixture() {
    const events = [], warnings = [], assetChecks = [], hooks = new Map();
    const actor = {uuid: 'Actor.victim', effects: []};
    const effect = {id: 'burn', uuid: 'Actor.victim.ActiveEffect.burn', parent: actor,
        disabled: false, flags: {'swade-tools': {aoeBurning: {version: 1, intensity: 3, maxIntensity: 3}}}};
    actor.effects.push(effect);
    const token = {actor, visible: true, isVisible: true, document: {uuid: 'Scene.one.Token.victim',
        parent: {id: 'one'}, hidden: false}};
    const canvasRef = {ready: true, scene: {id: 'one'}, tokens: {placeables: [token]}};
    const gameRef = {user: {isGM: false}, modules: new Map([['sequencer', {active: true}]])};
    class SequenceClass {
        constructor() {events.push(['new']);}
        effect() {events.push(['effect']); return this;}
        file(value) {events.push(['file', value]); return this;}
        attachTo(value, options) {events.push(['attachTo', value, options]); return this;}
        scaleToObject(value) {events.push(['scaleToObject', value]); return this;}
        persist() {events.push(['persist']); return this;}
        temporary() {events.push(['temporary']); return this;}
        locally() {events.push(['locally']); return this;}
        name(value) {events.push(['name', value]); return this;}
        async play() {events.push(['play']); if (setup.onPlay) await setup.onPlay();}
    }
    const runtime = {gameRef, canvasRef, SequenceClass,
        sequencerRef: {Database: {entryExists(file) {assetChecks.push(file); return true;}},
            EffectManager: {async endEffects(...args) {events.push(['end', ...args]);}}},
        logger: {warn: (...args) => warnings.push(args)},
        hooksRef: {on(name, callback) {const list = hooks.get(name) ?? [];
            list.push(callback); hooks.set(name, list);}}};
    const setup = {runtime, actor, effect, token, events, warnings, assetChecks,
        async call(name, ...args) {await Promise.all((hooks.get(name) ?? []).map(callback => callback(...args)));}};
    return setup;
}
const plays = setup => setup.events.filter(event => event[0] === 'play');
const ends = setup => setup.events.filter(event => event[0] === 'end');

function enableNative(setup) {
    const graphics = [], callbacks = new Set();
    class Graphics {
        constructor() {this.calls = []; graphics.push(this);}
        clear() {this.calls.push(['clear']); return this;}
        beginFill(...args) {this.calls.push(['fill', ...args]); return this;}
        moveTo(...args) {this.calls.push(['move', ...args]); return this;}
        bezierCurveTo(...args) {this.calls.push(['curve', ...args]); return this;}
        quadraticCurveTo(...args) {this.calls.push(['quadratic', ...args]); return this;}
        endFill() {return this;}
        destroy() {this.destroyed = true;}
    }
    setup.runtime.PIXIRef = {Graphics};
    setup.runtime.canvasRef.app = {ticker: {deltaMS: 60,
        add(callback) {callbacks.add(callback);}, remove(callback) {callbacks.delete(callback);}}};
    setup.token.w = setup.token.h = 100;
    setup.token.children = [];
    setup.token.addChild = function(child) {this.children.push(child); child.parent = this; return child;};
    setup.token.removeChild = function(child) {this.children.splice(this.children.indexOf(child), 1); child.parent = null;};
    return {graphics, callbacks, tick() {for (const callback of [...callbacks]) callback();}};
}

test('On Fire payload has a standard visible status without an invented expiration', async () => {
    const api = await service, state = {version: 1, intensity: 3, maxIntensity: 3};
    const data = api.getAoeOnFireEffectData(state);
    assert.equal(data.name, 'On Fire');
    assert.equal(data.img, api.AOE_ON_FIRE_ICON);
    assert.equal(data.img, 'modules/swade-tools/assets/on-fire.svg');
    assert.deepEqual(data.statuses, [api.AOE_ON_FIRE_STATUS]);
    assert.equal(data.flags['swade-tools'].aoeBurning, state);
    assert.deepEqual(data.changes, []);
    assert.equal(data.disabled, false); assert.equal(data.transfer, false);
    assert.equal(data.duration, undefined);
    // Foundry V13 ActiveEffect.isTemporary uses duration > 0 || statuses.size > 0.
    assert.ok(new Set(data.statuses).size > 0);
});

test('flames use only entries confirmed by the optional Sequencer database', async () => {
    const {getAoeFireVisualFile} = await service;
    assert.equal(getAoeFireVisualFile({}), null);
    assert.equal(getAoeFireVisualFile({Database: {entryExists() {return false;}}}), null);
    assert.equal(getAoeFireVisualFile({Database: {entryExists() {throw Error('missing');}}}), null);
    assert.equal(getAoeFireVisualFile({Database: {entryExists(file) {
        return file === 'jb2a.flames.01.orange';
    }}}), 'jb2a.flames.01.orange');
});

test('missing Sequencer or JB2A leaves On Fire data unchanged without throwing', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    setup.runtime.gameRef.modules.clear();
    assert.deepEqual(await syncAoeFireVisual(setup.effect, setup.runtime),
        {ok: true, count: 0});
    assert.equal(plays(setup).length, 0);
    assert.equal(setup.effect.flags['swade-tools'].aoeBurning.intensity, 3);
});

test('one local temporary persistent loop is attached to the burning token', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 1);
    const attached = setup.events.find(event => event[0] === 'attachTo');
    assert.equal(attached[1], setup.token);
    assert.deepEqual(attached[2], {bindVisibility: true, bindAlpha: true, bindRotation: false});
    for (const name of ['persist', 'temporary', 'locally']) {
        assert.equal(setup.events.filter(event => event[0] === name).length, 1);
    }
    assert.match(setup.events.find(event => event[0] === 'name')[1],
        /Actor\.victim\.ActiveEffect\.burn:Scene\.one\.Token\.victim/);
});

test('simultaneous and repeated document hooks never duplicate a flame loop', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    let finish;
    setup.onPlay = () => new Promise(resolve => {finish = resolve;});
    const first = syncAoeFireVisual(setup.effect, setup.runtime);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 1);
    finish(); await first;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 1);
});

test('linked actor tokens get distinct loops but unrelated and synthetic actors do not', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    const second = {...setup.token, document: {...setup.token.document, uuid: 'Scene.one.Token.second'}};
    const unrelated = {...setup.token, actor: {uuid: 'Actor.other'},
        document: {...setup.token.document, uuid: 'Scene.one.Token.other'}};
    const synthetic = {...setup.token, actor: {uuid: 'Scene.one.Token.synthetic.Actor.victim'},
        document: {...setup.token.document, uuid: 'Scene.one.Token.synthetic'}};
    setup.runtime.canvasRef.tokens.placeables.push(second, unrelated, synthetic);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 2);
    assert.deepEqual(setup.events.filter(event => event[0] === 'attachTo').map(event => event[1]),
        [setup.token, second]);
    assert.equal(new Set(setup.events.filter(event => event[0] === 'name').map(event => event[1])).size, 2);
});

test('foreign scenes and hidden or non-visible tokens never expose player flames', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    setup.token.document.hidden = true;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    setup.token.document.hidden = false;
    setup.token.isVisible = false;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    setup.token.isVisible = true;
    setup.token.document.parent.id = 'other';
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 0);
});

test('hidden tokens may show the local fire animation to a GM who can see them', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    setup.runtime.gameRef.user.isGM = true;
    setup.token.document.hidden = true;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 1);
});

test('disable or suppression removes only this local flame and re-enable restores it', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    await syncAoeFireVisual(setup.effect, setup.runtime);
    setup.effect.disabled = true;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(ends(setup).length, 1);
    assert.equal(ends(setup)[0][2], false);
    assert.equal(Object.hasOwn(ends(setup)[0][1], 'name'), true);
    setup.effect.disabled = false;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    setup.effect.isSuppressed = true;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 2);
    assert.equal(ends(setup).length, 2);
});

test('deleted effects and removed Burning flags remove their owned visuals', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    await syncAoeFireVisual(setup.effect, setup.runtime);
    await syncAoeFireVisual(setup.effect, {...setup.runtime, deleted: true});
    assert.equal(ends(setup).length, 1);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    delete setup.effect.flags['swade-tools'].aoeBurning;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(ends(setup).length, 2);
});

test('canvas reconciliation removes effects for deleted or replaced token actors', async () => {
    const {syncAoeFireCanvas} = await service, setup = fixture();
    await syncAoeFireCanvas(setup.runtime);
    setup.token.actor = {uuid: 'Actor.replacement', effects: []};
    await syncAoeFireCanvas(setup.runtime);
    assert.equal(plays(setup).length, 1);
    assert.equal(ends(setup).length, 1);
});

test('scene teardown cleans local loops and canvas reload restores persisted Burning effects', async () => {
    const {syncAoeFireCanvas, clearAoeFireVisuals} = await service, setup = fixture();
    await syncAoeFireCanvas(setup.runtime);
    await clearAoeFireVisuals(setup.runtime);
    await syncAoeFireCanvas(setup.runtime);
    assert.equal(plays(setup).length, 2);
    assert.equal(ends(setup).length, 1);
    const names = setup.events.filter(event => event[0] === 'name').map(event => event[1]);
    assert.notEqual(names[0], names[1]);
    assert.equal(ends(setup)[0][1].name, names[0]);
});

test('late-loading old-scene animation cannot remove a new-scene replacement loop', async () => {
    const {syncAoeFireVisual, clearAoeFireVisuals} = await service, setup = fixture();
    let finish;
    setup.onPlay = () => new Promise(resolve => {finish = resolve;});
    const old = syncAoeFireVisual(setup.effect, setup.runtime);
    await clearAoeFireVisuals(setup.runtime);
    setup.onPlay = null;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    finish(); await old;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 2);
    const names = setup.events.filter(event => event[0] === 'name').map(event => event[1]);
    assert.ok(ends(setup).every(event => event[1].name === names[0]));
});

test('late-loading hidden-token loop cannot remove its same-scene visible replacement', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    let finish;
    setup.onPlay = () => new Promise(resolve => {finish = resolve;});
    const old = syncAoeFireVisual(setup.effect, setup.runtime);
    setup.token.visible = false;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    setup.token.visible = true;
    setup.onPlay = null;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    finish(); await old;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    const names = setup.events.filter(event => event[0] === 'name').map(event => event[1]);
    assert.equal(plays(setup).length, 2);
    assert.notEqual(names[0], names[1]);
    assert.ok(ends(setup).every(event => event[1].name === names[0]));
});

test('late-loading replaced-placeable loop cannot stop the new placeable with the same UUID', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    let finish;
    setup.onPlay = () => new Promise(resolve => {finish = resolve;});
    const old = syncAoeFireVisual(setup.effect, setup.runtime);
    const replacement = {...setup.token};
    setup.runtime.canvasRef.tokens.placeables = [replacement];
    setup.onPlay = null;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    finish(); await old;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    const names = setup.events.filter(event => event[0] === 'name').map(event => event[1]);
    assert.equal(plays(setup).length, 2);
    assert.notEqual(names[0], names[1]);
    assert.ok(ends(setup).every(event => event[1].name === names[0]));
    assert.equal(setup.events.filter(event => event[0] === 'attachTo').at(-1)[1], replacement);
});

test('concurrent replacement hooks keep one loop while old-loop cleanup is awaited', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    await syncAoeFireVisual(setup.effect, setup.runtime);
    const replacement = {...setup.token};
    setup.runtime.canvasRef.tokens.placeables = [replacement];
    let finish;
    setup.runtime.sequencerRef.EffectManager.endEffects = async (...args) => {
        setup.events.push(['end', ...args]);
        await new Promise(resolve => {finish = resolve;});
    };
    const first = syncAoeFireVisual(setup.effect, setup.runtime);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    finish(); await first;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 2);
    assert.equal(ends(setup).length, 1);
    assert.equal(setup.events.filter(event => event[0] === 'attachTo').at(-1)[1], replacement);
});

test('optional animation errors do not change or delete gameplay effects', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    const originalFlags = structuredClone(setup.effect.flags);
    setup.onPlay = async () => {throw Error('missing media');};
    await assert.doesNotReject(syncAoeFireVisual(setup.effect, setup.runtime));
    assert.deepEqual(setup.effect.flags, originalFlags);
    assert.equal(setup.actor.effects[0], setup.effect);
    assert.equal(setup.warnings.length, 1);
});

test('hooks register once and effect deletion and canvas teardown clean up', async () => {
    const {registerAoeFireVisuals} = await service, setup = fixture();
    setup.runtime.canvasRef.ready = false;
    assert.equal(registerAoeFireVisuals(setup.runtime), true);
    assert.equal(registerAoeFireVisuals(setup.runtime), false);
    setup.runtime.canvasRef.ready = true;
    await setup.call('createActiveEffect', setup.effect);
    assert.equal(plays(setup).length, 1);
    await setup.call('updateActiveEffect', setup.effect);
    await setup.call('drawToken', setup.token);
    assert.equal(plays(setup).length, 1);
    await setup.call('deleteActiveEffect', setup.effect);
    assert.equal(ends(setup).length, 1);
    await setup.call('canvasReady');
    assert.equal(plays(setup).length, 2);
    await setup.call('canvasTearDown');
    assert.equal(ends(setup).length, 2);
});

test('unrelated non-burning effect hooks cannot create flames', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture();
    setup.effect.flags = {};
    assert.deepEqual(await syncAoeFireVisual(setup.effect, setup.runtime), {ok: true, count: 0});
    assert.equal(plays(setup).length, 0);
});

test('bursts of token movement hooks coalesce to one bounded canvas refresh', async () => {
    const {registerAoeFireVisuals} = await service, setup = fixture();
    setup.runtime.canvasRef.ready = false;
    const timers = [];
    setup.runtime.setTimeout = (callback, delay) => {timers.push({callback, delay}); return timers.length;};
    setup.runtime.clearTimeout = () => {};
    registerAoeFireVisuals(setup.runtime);
    setup.runtime.canvasRef.ready = true;
    const first = setup.call('refreshToken', setup.token);
    const second = setup.call('drawToken', setup.token);
    const third = setup.call('updateToken', setup.token.document);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 50);
    await timers[0].callback();
    await Promise.all([first, second, third]);
    assert.equal(plays(setup).length, 1);
    assert.equal(setup.assetChecks.length, 1);
});

test('missing optional modules still draw animated colored flames without document writes', async () => {
    const {syncAoeFireVisual, clearAoeFireVisuals} = await service, setup = fixture();
    const native = enableNative(setup), flags = structuredClone(setup.effect.flags);
    setup.runtime.gameRef.modules.clear();
    assert.deepEqual(await syncAoeFireVisual(setup.effect, setup.runtime), {ok: true, count: 1});
    assert.equal(plays(setup).length, 0);
    assert.equal(native.graphics.length, 1); assert.equal(native.callbacks.size, 1);
    const flame = native.graphics[0], initial = flame.calls.length;
    assert.equal(flame.parent, setup.token); assert.equal(flame.eventMode, 'none');
    assert.equal(flame.interactive, false);
    assert.ok(flame.calls.some(call => call[0] === 'fill' && call[1] === 0xe84b12));
    native.tick(); assert.ok(flame.calls.length > initial);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(native.graphics.length, 1); assert.equal(native.callbacks.size, 1);
    assert.deepEqual(setup.effect.flags, flags);
    await clearAoeFireVisuals(setup.runtime);
    assert.equal(native.callbacks.size, 0); assert.equal(setup.token.children.length, 0);
    assert.equal(flame.destroyed, true); assert.equal(ends(setup).length, 0);
});

test('native flame hides immediately when visibility changes and is removed on reconciliation', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    setup.runtime.sequencerRef.Database.entryExists = () => false;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    setup.token.document.hidden = true;
    native.tick(); assert.equal(native.graphics[0].visible, false);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(native.callbacks.size, 0); assert.equal(native.graphics[0].destroyed, true);
    setup.token.document.hidden = false;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(native.callbacks.size, 1); assert.equal(native.graphics.length, 2);
    setup.effect.disabled = true;
    native.tick(); assert.equal(native.graphics[1].visible, false);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(native.callbacks.size, 0);
});

test('Sequencer silently resolving without creating an effect activates fallback once', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    setup.runtime.sequencerRef.EffectManager.getEffects = () => [];
    assert.deepEqual(await syncAoeFireVisual(setup.effect, setup.runtime), {ok: true, count: 1});
    assert.equal(plays(setup).length, 1); assert.equal(ends(setup).length, 1);
    assert.equal(native.callbacks.size, 1); assert.equal(native.graphics.length, 1);
    assert.equal(setup.warnings.length, 1);
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 1); assert.equal(native.graphics.length, 1);
});

test('Sequencer thrown media failures preserve gameplay and create native flames', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    setup.onPlay = async () => {throw Error('media failed');};
    assert.deepEqual(await syncAoeFireVisual(setup.effect, setup.runtime), {ok: true, count: 1});
    assert.equal(native.callbacks.size, 1); assert.equal(setup.actor.effects[0], setup.effect);
    assert.equal(setup.effect.flags['swade-tools'].aoeBurning.intensity, 3);
    await syncAoeFireVisual(setup.effect, {...setup.runtime, deleted: true});
    assert.equal(native.callbacks.size, 0); assert.equal(native.graphics[0].destroyed, true);
});

test('successful Sequencer playback remains preferred over native fallback', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    setup.runtime.sequencerRef.EffectManager.getEffects = () => [{id: 'existing-flame'}];
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(plays(setup).length, 1); assert.equal(native.graphics.length, 0);
});

test('late JB2A database registration upgrades native fallback and removes its ticker', async () => {
    const {registerAoeFireVisuals} = await service, setup = fixture(), native = enableNative(setup);
    setup.runtime.canvasRef.ready = false;
    setup.runtime.sequencerRef.Database.entryExists = () => false;
    registerAoeFireVisuals(setup.runtime);
    setup.runtime.canvasRef.ready = true;
    await setup.call('createActiveEffect', setup.effect);
    assert.equal(native.callbacks.size, 1); assert.equal(plays(setup).length, 0);
    setup.runtime.sequencerRef.Database.entryExists = () => true;
    setup.runtime.sequencerRef.EffectManager.getEffects = () => [{id: 'loaded'}];
    await setup.call('registerSequencerDatabaseEntries', 'jb2a');
    assert.equal(native.callbacks.size, 0); assert.equal(native.graphics[0].destroyed, true);
    assert.equal(plays(setup).length, 1);
    await setup.call('canvasTearDown'); assert.equal(ends(setup).length, 1);
});

test('a deleted effect while Sequencer playback fails cannot resurrect fallback flames', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    let fail;
    setup.onPlay = () => new Promise((resolve, reject) => {fail = reject;});
    const starting = syncAoeFireVisual(setup.effect, setup.runtime);
    await syncAoeFireVisual(setup.effect, {...setup.runtime, deleted: true});
    // The deleted document's getter can still report active; the visual claim
    // must remember its removal instead of recreating from that stale object.
    fail(Error('late missing media')); await starting;
    assert.equal(native.graphics.length, 0); assert.equal(native.callbacks.size, 0);
});

test('native fallback throttles expensive redraws to at most twenty per second', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    setup.runtime.gameRef.modules.clear();
    setup.runtime.canvasRef.app.ticker.deltaMS = 10;
    await syncAoeFireVisual(setup.effect, setup.runtime);
    const initial = native.graphics[0].calls.length;
    for (let index = 0; index < 4; index++) native.tick();
    assert.equal(native.graphics[0].calls.length, initial);
    native.tick(); assert.ok(native.graphics[0].calls.length > initial);
});

test('Foundry token clear and redraw recreates a destroyed native child without leaking tickers', async () => {
    const {syncAoeFireVisual} = await service, setup = fixture(), native = enableNative(setup);
    setup.runtime.gameRef.modules.clear();
    await syncAoeFireVisual(setup.effect, setup.runtime);
    const old = native.graphics[0];
    setup.token.removeChild(old); old.destroy({children: true});
    await syncAoeFireVisual(setup.effect, setup.runtime);
    assert.equal(native.graphics.length, 2); assert.equal(native.callbacks.size, 1);
    assert.equal(native.graphics[1].parent, setup.token);
    assert.equal(setup.token.children.length, 1);
});
