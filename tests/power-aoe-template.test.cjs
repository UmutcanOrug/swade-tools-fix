const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.join(__dirname, '../scripts/services/PowerAoeTemplate.js')).href);

const fixture = ({shape = 'medium', customShape, point = {x: 250, y: 50}, range = '8', distance = 1,
    origin = 'caster', cancel = false, createError = null, onShow = null} = {}) => {
    const calls = [], previews = [];
    const actor = {id: 'caster', uuid: 'Actor.caster', isOwner: true};
    const item = {id: 'burst', uuid: 'Actor.caster.Item.burst', actor, isOwner: true,
        type: 'power', name: 'Burst', system: {range}, flags: {'swade-tools': {aoePowerOrigin: origin,
            ...(customShape ? {aoeCustomShape: structuredClone(customShape)} : {})}}};
    const scene = {id: 'scene', grid: {size: 100, distance},
        async createEmbeddedDocuments(type, data) {
            calls.push(['create', type, structuredClone(data)]);
            if (createError) throw new Error(createError);
            const document = new Document(data[0], {parent: this}); document.id = 'area';
            return [document];
        }};
    const makeToken = (id, x, y, options = {}) => ({id, actor: {id: `actor-${id}`}, center: {x, y},
        document: {id, parent: scene, hidden: false},
        setTarget() { throw new Error('Power AoE must not change target rings'); }, ...options});
    const source = makeToken('source', 50, 50, {actor});
    const tokens = [source, makeToken('inside', 250, 50), makeToken('outside', 650, 650),
        makeToken('hidden', 250, 50, {document: {id: 'hidden', parent: scene, hidden: true}}),
        makeToken('not-visible', 250, 50, {isVisible: false}), makeToken('no-actor', 250, 50, {actor: null})];
    const oldPreview = {id: 'unrelated-preview'};
    class Document {
        constructor(data, {parent} = {}) { Object.assign(this, structuredClone(data)); this.parent = parent; }
        updateSource(changes) { Object.assign(this, structuredClone(changes)); }
    }
    class CoreTemplate {
        destroy() { this.destroyed = true; calls.push(['destroy', this]); }
        static getConeShape(length, direction, angle) {
            calls.push(['core-cone', length, direction, angle]);
            const radius = length / distance * 100;
            return {contains(x, y) {
                const offset = ((Math.atan2(y, x) * 180 / Math.PI - direction + 540) % 360) - 180;
                return x * x + y * y <= radius * radius && Math.abs(offset) <= angle / 2;
            }};
        }
    }
    class Template extends CoreTemplate {
        constructor(document) { super(); this.document = document; this.controlIcon = {}; previews.push(this); }
        async draw() { calls.push(['draw', this]); this._refreshShape(); }
        _refreshPosition() {}
        _refreshShape() {
            this.shape = this._computeShape();
        }
        _computeShape() {
            const doc = this.document;
            const pixels = 100 / distance;
            // This fake follows the native contract: direction is already baked into the shape's contains().
            return {contains(x, y) {
                if (doc.t === 'circle') return x * x + y * y <= (doc.distance * pixels) ** 2;
                const radians = doc.direction * Math.PI / 180;
                const forward = x * Math.cos(radians) + y * Math.sin(radians);
                const lateral = -x * Math.sin(radians) + y * Math.cos(radians);
                const length = doc.distance * pixels;
                const width = doc.t === 'cone' ? doc.width * 100 : doc.width * pixels;
                return forward >= 0 && forward <= length && Math.abs(lateral) <=
                    (doc.t === 'cone' ? width / 2 * forward / length : width / 2);
            }};
        }
        refresh() { calls.push(['refresh', this.document.direction]); }
        destroy() { throw new Error('SWADE preview mouse cleanup must not run'); }
    }
    const previewLayer = {children: [], addChild(child) { this.children.push(child); child.parent = this; },
        removeChild(child) { this.children = this.children.filter(entry => entry !== child); child.parent = null; }};
    const wheelListeners = new Set();
    const wheelTarget = {
        addEventListener(type, listener, options) {
            assert.equal(type, 'wheel'); assert.deepEqual(options, {capture: true, passive: false});
            wheelListeners.add(listener); calls.push(['wheel-add']);
        },
        removeEventListener(type, listener, options) {
            assert.equal(type, 'wheel'); assert.deepEqual(options, {capture: true});
            wheelListeners.delete(listener); calls.push(['wheel-remove']);
        },
        rotate(deltaY, shiftKey = false) {
            const event = {deltaY, shiftKey, preventDefault() { this.defaultPrevented = true; },
                stopImmediatePropagation() { this.stopped = true; }};
            for (const listener of wheelListeners) listener(event);
            return event;
        }
    };
    const canvasRef = {ready: true, scene, grid: {size: 100,
        measurePath(points) { return {distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / 100 * distance}; }},
        tokens: {controlled: [source], placeables: tokens}, templates: {preview: previewLayer}};
    const selectedTargets = new Set([tokens[2]]);
    const gameRef = {user: {id: 'user', color: '#abcdef', isGM: false, targets: selectedTargets},
        modules: new Map([['sequencer', {active: true}]])};
    const configRef = {MeasuredTemplate: {documentClass: Document, objectClass: Template},
        SWADE: {activeMeasuredTemplatePreview: oldPreview}};
    const sequencerRef = {Crosshair: {CALLBACKS: {SHOW: 'show', MOUSE_MOVE: 'move', CANCEL: 'cancel'},
        PLACEMENT_RESTRICTIONS: {ANYWHERE: 'anywhere'},
        async show(config, callbacks) {
            calls.push(['crosshair', config, callbacks]);
            callbacks.show({document: {x: 150, y: 50}});
            callbacks.move({document: point});
            await onShow?.({canvasRef, callbacks, config, previews, wheelTarget});
            if (cancel) { callbacks.cancel(); return false; }
            return {x: point.x, y: point.y};
        }}};
    const notifications = {warn(message) { calls.push(['warn', message]); }};
    return {input: {actor, item, token: source, shape, ...(customShape ? {customShape} : {})}, runtime: {canvasRef, gameRef, configRef, sequencerRef,
        constRef: {GRID_SNAPPING_MODES: {CENTER: 1, VERTEX: 2}, GRID_TYPES: {SQUARE: 1}},
        baseTemplateClass: CoreTemplate, notifications, wheelTarget},
        calls, previews, tokens, source, oldPreview, selectedTargets, wheelTarget, wheelListeners};
};

test('Power template presets scale circles and streams but keep SWADE rounded-cone width in squares', async () => {
    const {buildPowerAoeTemplateData} = await service;
    const common = {actor: {uuid: 'Actor.a'}, item: {uuid: 'Actor.a.Item.p'}, source: {x: 50, y: 50},
        target: {x: 50, y: 450}, scene: {grid: {distance: 5}}, user: {id: 'u', color: '#f00'}};
    const expected = {small: ['circle', 5], medium: ['circle', 10], large: ['circle', 15],
        scone: ['cone', 20, 2], cone: ['cone', 45, 3], stream: ['ray', 60, 5]};
    for (const [shape, values] of Object.entries(expected)) {
        const data = buildPowerAoeTemplateData({...common, shape});
        assert.equal(data.t, values[0]); assert.equal(data.distance, values[1]); assert.equal(data.width, values[2]);
        assert.equal(data.direction, data.t === 'circle' ? 0 : 90);
        assert.equal(data.angle, data.t === 'cone' ? 0 : undefined);
        assert.equal(data.flags['swade-tools'].autoTarget, false);
        assert.equal(data.flags['swade-tools'].powerAoeTemplate, true);
        assert.equal(data.flags.swade, undefined);
    }
});

test('custom AoE dimensions scale once from grid squares and rectangular areas retain exact rotatable dimensions', async () => {
    const {buildPowerAoeTemplateData, buildWeaponAoeTemplateData, resolveAoeTemplateShape} = await service;
    const common = {actor: {uuid: 'Actor.a'}, item: {uuid: 'Actor.a.Item.p'}, shape: 'custom',
        source: {x: 50, y: 50}, target: {x: 50, y: 450}, scene: {grid: {distance: 5}}, user: {id: 'u'}};
    for (const [type, t] of [['circle', 'circle'], ['cone', 'cone'], ['ray', 'ray'], ['rect', 'ray']]) {
        const customShape = {type, distance: 6.5, width: 2.25, angle: 75};
        const data = buildPowerAoeTemplateData({...common, customShape});
        assert.equal(data.t, t); assert.equal(data.distance, 32.5);
        assert.equal(data.direction, type === 'circle' ? 0 : 90);
        assert.equal(data.width, ['ray', 'rect'].includes(type) ? 11.25 : undefined);
        assert.equal(data.angle, type === 'cone' ? 75 : undefined);
        assert.equal(data.flags['swade-tools'].customShapeType, type);
        assert.deepEqual(data.flags['swade-tools'].customShape, customShape);
        assert.equal(data.flags['swade-tools'].templateType, 'custom');
        const resolved = resolveAoeTemplateShape('custom', customShape);
        assert.equal(resolved.directional, type !== 'circle'); assert.equal(resolved.customType, type);
        const weapon = buildWeaponAoeTemplateData({...common, customShape, origin: 'free', direction: 350});
        assert.equal(weapon.direction, type === 'circle' ? 0 : 350);
        assert.equal(weapon.flags['swade-tools'].weaponAoeTemplate, true);
        assert.equal(weapon.flags['swade-tools'].powerAoeTemplate, undefined);
        assert.deepEqual(weapon.flags['swade-tools'].customShape, customShape);
        customShape.distance = 999;
        assert.equal(data.flags['swade-tools'].customShape.distance, 6.5); // Never retain mutable item/form data.
    }
});

test('custom template builder reads saved item configuration when no explicit snapshot is passed', async () => {
    const {buildPowerAoeTemplateData} = await service;
    const customShape = {type: 'circle', distance: 2.5, width: 1, angle: 60};
    const data = buildPowerAoeTemplateData({shape: 'custom', item: {flags: {'swade-tools': {aoeCustomShape: customShape}}},
        source: {x: 10, y: 20}, target: {x: 30, y: 40}, scene: {grid: {distance: 2}}});
    assert.equal(data.t, 'circle'); assert.equal(data.distance, 5);
    assert.deepEqual(data.flags['swade-tools'].customShape, customShape);
});

test('custom cone core compatibility patch is narrow, validates dimensions and registers idempotently', async () => {
    const {registerCustomAoeTemplateGeometry} = await service;
    const calls = [];
    class Base {
        static getConeShape(...args) { calls.push(['core', ...args]); return {custom: args}; }
    }
    class Swade extends Base {
        _computeShape(...args) { calls.push(['original', this.document, ...args]); return 'original'; }
    }
    const runtime = {configRef: {MeasuredTemplate: {objectClass: Swade}}, baseTemplateClass: Base};
    assert.equal(registerCustomAoeTemplateGeometry(runtime), true);
    const patched = Swade.prototype._computeShape;
    assert.equal(registerCustomAoeTemplateGeometry(runtime), true);
    assert.equal(Swade.prototype._computeShape, patched);
    const custom = {t: 'cone', distance: 30, direction: 125, angle: 60,
        flags: {'swade-tools': {templateType: 'custom', customShapeType: 'cone', powerAoeTemplate: true}}};
    const instance = new Swade(); instance.document = custom;
    assert.deepEqual(instance._computeShape(), {custom: [30, 125, 60]});
    assert.deepEqual(calls, [['core', 30, 125, 60]]);
    for (const document of [{...custom, flags: {}}, {...custom, angle: 0}, {...custom, angle: 361},
        {...custom, distance: NaN}, {...custom, direction: Infinity}, {...custom, t: 'ray'},
        {...custom, flags: {'swade-tools': {templateType: 'cone', weaponAoeTemplate: true}}},
        {...custom, flags: {'swade-tools': {templateType: 'custom', customShapeType: 'cone'}}}]) {
        instance.document = document;
        assert.equal(instance._computeShape('sentinel'), 'original');
        assert.equal(calls.at(-1)[0], 'original'); assert.equal(calls.at(-1)[2], 'sentinel');
    }
    assert.equal(registerCustomAoeTemplateGeometry({configRef: {}, baseTemplateClass: Base}), false);
});

test('custom cone preview targets the configured native angle, not SWADE rounded-cone defaults', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'custom', customShape: {type: 'cone', distance: 4, width: 1, angle: 90}});
    f.tokens.push({id: 'diagonal', actor: {}, center: {x: 250, y: 200}, document: {id: 'diagonal'}});
    f.tokens.push({id: 'too-wide', actor: {}, center: {x: 150, y: 250}, document: {id: 'too-wide'}});
    const result = await placePowerAoeTemplate(f.input, f.runtime);
    assert.deepEqual(result.geometry, {t: 'cone', x: 50, y: 50, direction: 0, distance: 4, angle: 90});
    assert.deepEqual(result.targetIds, ['inside', 'diagonal']);
    assert.ok(f.calls.some(call => call[0] === 'core-cone' && call[1] === 4 && call[2] === 0 && call[3] === 90));
    assert.equal(f.previews[0].destroyed, true);
});

test('custom cone placement fails closed if the native core geometry cannot be registered', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'custom', customShape: {type: 'cone', distance: 4, width: 1, angle: 90}});
    f.runtime.baseTemplateClass = class {};
    await assert.rejects(placePowerAoeTemplate(f.input, f.runtime), /custom cone geometry is unavailable/);
    assert.equal(f.calls.length, 0); assert.equal(f.previews.length, 0);
});

test('custom rectangle preview preserves size and wheel rotation, source filtering and immutable placement snapshot', async () => {
    const {placeWeaponAoeTemplatePoint} = await service;
    const customShape = {type: 'rect', distance: 4, width: 2, angle: 60};
    const f = fixture({shape: 'custom', customShape, point: {x: 250, y: 50}, distance: 5,
        onShow({callbacks, wheelTarget}) {
            customShape.distance = 99;
            wheelTarget.rotate(1, true);
            callbacks.move({document: {x: 250, y: 50}});
        }});
    f.input.item.type = 'weapon';
    const result = await placeWeaponAoeTemplatePoint({...f.input, origin: 'free'}, f.runtime);
    assert.deepEqual(result.geometry, {t: 'ray', x: 250, y: 50, direction: 15, distance: 20, width: 10});
    assert.equal(f.previews[0].document.flags['swade-tools'].customShapeType, 'rect');
    assert.equal(f.previews[0].document.flags['swade-tools'].customShape.distance, 4);
    assert.equal(f.wheelListeners.size, 0); assert.equal(f.previews[0].destroyed, true);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    const anchored = fixture({shape: 'custom', customShape: {...customShape, distance: 4}});
    anchored.input.item.type = 'weapon';
    const tokenResult = await placeWeaponAoeTemplatePoint({...anchored.input, origin: 'token'}, anchored.runtime);
    assert.deepEqual(tokenResult.targetIds, ['inside']);
    assert.equal(tokenResult.geometry.x, 50); assert.equal(tokenResult.geometry.y, 50);
});

test('custom circle placement uses configured radius while free directional placement still checks range and cleans up cancellation', async () => {
    const {placePowerAoeTemplate, placeWeaponAoeTemplatePoint} = await service;
    const circle = fixture({shape: 'custom', customShape: {type: 'circle', distance: 1.25, width: 1, angle: 60}});
    circle.input.item.type = 'weapon';
    const point = await placeWeaponAoeTemplatePoint(circle.input, circle.runtime);
    assert.deepEqual(point.geometry, {t: 'circle', x: 250, y: 50, direction: 0, distance: 1.25});
    assert.equal(circle.calls.find(call => call[0] === 'crosshair')[1].distance, 1.25);
    for (const type of ['cone', 'ray', 'rect']) {
        const customShape = {type, distance: 4, width: 2, angle: 70};
        const canceled = fixture({shape: 'custom', customShape, origin: 'free', cancel: true});
        assert.equal(await placePowerAoeTemplate(canceled.input, canceled.runtime), null);
        assert.equal(canceled.wheelListeners.size, 0); assert.equal(canceled.previews[0].destroyed, true);
        const outOfRange = fixture({shape: 'custom', customShape, origin: 'free', range: '1'});
        assert.equal(await placePowerAoeTemplate(outOfRange.input, outOfRange.runtime), null);
        assert.equal(outOfRange.wheelListeners.size, 0); assert.equal(outOfRange.previews[0].destroyed, true);
        assert.equal(outOfRange.calls.some(call => call[0] === 'create'), false);
    }
});

test('malformed explicit custom geometry fails before creating a preview or requesting a placement', async () => {
    const {placePowerAoeTemplate, buildPowerAoeTemplateData} = await service;
    for (const customShape of [{type: 'polygon', distance: 4, width: 1, angle: 60},
        {type: 'circle', distance: 0, width: 1, angle: 60}, {type: 'ray', distance: 4, width: 0, angle: 60},
        {type: 'cone', distance: 4, width: 1, angle: 361}, {type: 'rect', distance: Infinity, width: 2, angle: 60}]) {
        const f = fixture({shape: 'custom', customShape});
        await assert.rejects(placePowerAoeTemplate(f.input, f.runtime), /custom|shape|distance|width|angle|size/i);
        assert.equal(f.calls.length, 0);
        assert.throws(() => buildPowerAoeTemplateData({...f.input, source: {x: 0, y: 0}, target: {x: 0, y: 0},
            scene: {grid: {distance: 1}}}), /custom|shape|distance|width|angle|size/i);
    }
});

test('weapon cone placement uses native previews and source origin without creating documents or guessing range', async () => {
    const {placeWeaponAoeTemplatePoint} = await service;
    const f = fixture({shape: 'cone', range: 'Cone Template', point: {x: 1000, y: 50}});
    f.input.item.type = 'weapon';
    const result = await placeWeaponAoeTemplatePoint({...f.input, origin: 'token'}, f.runtime);
    assert.deepEqual({x: result.x, y: result.y, direction: result.direction}, {x: 1000, y: 50, direction: 0});
    assert.deepEqual(result.geometry, {t: 'cone', x: 50, y: 50, direction: 0, distance: 9, width: 3, angle: 0});
    assert.deepEqual(result.targetIds, ['inside']);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    assert.equal(f.previews[0].document.flags['swade-tools'].powerAoeTemplate, undefined);
    assert.equal(f.previews[0].document.flags['swade-tools'].weaponAoeTemplate, true);
    assert.equal(f.previews[0].destroyed, true);
    assert.equal(f.runtime.canvasRef.templates.preview.children.length, 0);
    const config = f.calls.find(call => call[0] === 'crosshair')[1];
    assert.equal(config.location.limitMaxRange, undefined); assert.equal(config.location.showRange, false);
});

test('free weapon cones retain wheel rotation and clean up on cancellation without a persistent template', async () => {
    const {placeWeaponAoeTemplatePoint} = await service;
    const f = fixture({shape: 'scone', point: {x: 300, y: 400},
        onShow({wheelTarget}) { wheelTarget.rotate(1); wheelTarget.rotate(1, true); }});
    f.input.item.type = 'weapon';
    const result = await placeWeaponAoeTemplatePoint({...f.input, origin: 'free'}, f.runtime);
    assert.equal(result.x, 300); assert.equal(result.y, 400); assert.equal(result.direction, 20);
    assert.equal(result.geometry.x, 300); assert.equal(result.geometry.y, 400);
    assert.equal(f.wheelListeners.size, 0); assert.equal(f.previews[0].destroyed, true);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    const canceled = fixture({shape: 'cone', cancel: true}); canceled.input.item.type = 'weapon';
    assert.equal(await placeWeaponAoeTemplatePoint({...canceled.input, origin: 'free'}, canceled.runtime), null);
    assert.equal(canceled.wheelListeners.size, 0); assert.equal(canceled.previews[0].destroyed, true);
    assert.equal(canceled.calls.some(call => call[0] === 'create'), false);
});

test('weapon preview rejects invalid ownership, shape and origin before placement', async () => {
    const {placeWeaponAoeTemplatePoint} = await service;
    const f = fixture({shape: 'cone'}); f.input.item.type = 'weapon';
    await assert.rejects(placeWeaponAoeTemplatePoint({...f.input, origin: 'invalid'}, f.runtime), /origin/);
    await assert.rejects(placeWeaponAoeTemplatePoint({...f.input, shape: 'medium'}, f.runtime), /directional/);
    f.input.item.isOwner = false;
    await assert.rejects(placeWeaponAoeTemplatePoint(f.input, f.runtime), /do not own/);
    assert.equal(f.calls.some(call => call[0] === 'crosshair'), false);
});

test('moving the source during AoE placement rejects confirmation before any persistent document or resource use', async () => {
    const {placeWeaponAoeTemplatePoint, placePowerAoeTemplate} = await service;
    for (const [weapon, shape, origin] of [[true, 'cone', 'token'], [true, 'cone', 'free'],
        [false, 'cone', 'caster'], [false, 'medium', 'caster']]) {
        const f = fixture({shape, onShow({canvasRef}) {
            canvasRef.tokens.controlled[0].center = {x: 150, y: 50};
        }});
        if (weapon) f.input.item.type = 'weapon';
        await assert.rejects(weapon
            ? placeWeaponAoeTemplatePoint({...f.input, origin}, f.runtime)
            : placePowerAoeTemplate(f.input, f.runtime), /token moved/);
        assert.equal(f.calls.some(call => call[0] === 'create'), false);
        assert.equal(f.wheelListeners.size, 0);
        assert.equal(f.runtime.canvasRef.templates.preview.children.length, 0);
        assert.ok(f.previews.every(preview => preview.destroyed));
    }
});

test('circular Power area captures only visible actor-backed token centers and never touches target rings', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture();
    const result = await placePowerAoeTemplate(f.input, f.runtime);
    assert.deepEqual(result.targetIds, ['source', 'inside']);
    assert.equal(result.sceneId, 'scene'); assert.equal(result.templateDocument.id, 'area');
    assert.equal(result.sourceToken, f.source);
    assert.deepEqual(result.geometry, {t: 'circle', x: 250, y: 50, direction: 0, distance: 2});
    assert.equal(f.runtime.gameRef.user.targets, f.selectedTargets);
    assert.deepEqual([...f.selectedTargets].map(token => token.id), ['outside']);
    const crosshair = f.calls.find(call => call[0] === 'crosshair')[1];
    assert.equal(crosshair.distance, 2); assert.equal(crosshair.location.limitMaxRange, 8);
    assert.equal(crosshair.lockDrag, true); assert.equal(crosshair.snap.position, 3);
    assert.equal(f.runtime.configRef.SWADE.activeMeasuredTemplatePreview, f.oldPreview);
    assert.equal(f.previews[0].destroyed, true);
});

test('cone live preview is caster-anchored, follows cursor direction and does not rotate target coordinates twice', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'cone', point: {x: 50, y: 450}, onShow({previews}) {
        assert.equal(previews.length, 1);
        assert.equal(previews[0].document.x, 50); assert.equal(previews[0].document.y, 50);
        assert.equal(previews[0].document.direction, 90);
        assert.equal(previews[0].controlIcon.renderable, false);
        assert.equal(previews[0].eventMode, 'none');
    }});
    f.tokens.push({id: 'north', actor: {id: 'north'}, center: {x: 50, y: 450}, document: {id: 'north'}});
    const result = await placePowerAoeTemplate(f.input, f.runtime);
    assert.deepEqual(result.targetIds, ['north']);
    assert.deepEqual(result.geometry, {t: 'cone', x: 50, y: 50, direction: 90, distance: 9, width: 3, angle: 0});
    assert.equal(f.runtime.canvasRef.templates.preview.children.length, 0);
    assert.equal(f.calls.filter(call => call[0] === 'destroy').length, 1);
    const crosshair = f.calls.find(call => call[0] === 'crosshair')[1];
    assert.equal(crosshair.distance, 0.05); assert.equal(crosshair.gridHighlight, false);
    assert.equal(crosshair.location.limitMaxRange, undefined); // Power's range is not cone aim range.
});

test('stream is anchored, uses scene-scaled width, and excludes only the caster token', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'stream', point: {x: -350, y: 50}, distance: 5});
    f.tokens.push({id: 'west', actor: f.input.actor, center: {x: -350, y: 50}, document: {id: 'west'}});
    const result = await placePowerAoeTemplate(f.input, f.runtime);
    assert.deepEqual(result.targetIds, ['west']);
    assert.equal(result.geometry.direction, 180); assert.equal(result.geometry.distance, 60);
    assert.equal(result.geometry.width, 5);
});

test('free-origin cone follows its own placement point and preserves native mouse-wheel rotation while moving', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'cone', origin: 'free', point: {x: 50, y: 50},
        onShow({previews, callbacks, wheelTarget, config}) {
            const preview = previews[0];
            assert.equal(preview.document.x, 50); assert.equal(preview.document.y, 50);
            assert.equal(config.location.showRange, true); assert.equal(config.location.limitMaxRange, 8);
            assert.equal(config.snap.position, 3);
            assert.match(config.label.text, /Mouse Wheel: Rotate/);
            const event = wheelTarget.rotate(1);
            assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
            assert.equal(preview.document.direction, 5);
            wheelTarget.rotate(1, true);
            assert.equal(preview.document.direction, 20);
            callbacks.move({document: {x: 250, y: 50}});
            assert.equal(preview.document.x, 250); assert.equal(preview.document.y, 50);
            assert.equal(preview.document.direction, 20);
            wheelTarget.rotate(-1, true); wheelTarget.rotate(-1);
            callbacks.move({document: {x: 50, y: 50}});
        }});
    const result = await placePowerAoeTemplate(f.input, f.runtime);
    assert.deepEqual(result.geometry, {t: 'cone', x: 50, y: 50, direction: 0, distance: 9, width: 3, angle: 0});
    assert.deepEqual(result.targetIds, ['source', 'inside']); // A remote origin does not grant caster immunity.
    assert.equal(result.templateDocument.flags['swade-tools'].originMode, 'free');
    assert.equal(f.runtime.gameRef.user.targets, f.selectedTargets);
    assert.equal(f.wheelListeners.size, 0);
    assert.equal(f.calls.filter(call => call[0] === 'wheel-add').length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'wheel-remove').length, 1);
    assert.equal(f.previews[0].destroyed, true);
});

test('free-origin stream rotates with native hex-grid steps and keeps fixed scene-scaled dimensions', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'stream', origin: 'free', distance: 5, range: '30',
        point: {x: 250, y: 50}, onShow({canvasRef, previews, wheelTarget}) {
            canvasRef.grid.type = 2;
            wheelTarget.rotate(-1, true);
            assert.equal(previews[0].document.direction, 330);
        }});
    const result = await placePowerAoeTemplate(f.input, f.runtime);
    assert.equal(result.geometry.x, 250); assert.equal(result.geometry.direction, 330);
    assert.equal(result.geometry.distance, 60); assert.equal(result.geometry.width, 5);
    assert.equal(f.wheelListeners.size, 0);
});

test('free directional origin observes numeric range and leaves no preview or wheel listener on rejection', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'scone', origin: 'free', range: '1', point: {x: 350, y: 50}});
    assert.equal(await placePowerAoeTemplate(f.input, f.runtime), null);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    assert.match(f.calls.find(call => call[0] === 'warn')[1], /outside.*range \(1\)/);
    assert.equal(f.wheelListeners.size, 0); assert.equal(f.previews[0].destroyed, true);
});

test('free-origin cancellation, scene change and document errors always remove scoped rotation controls', async () => {
    const {placePowerAoeTemplate} = await service;
    const cancelled = fixture({shape: 'cone', origin: 'free', cancel: true});
    assert.equal(await placePowerAoeTemplate(cancelled.input, cancelled.runtime), null);
    const changed = fixture({shape: 'cone', origin: 'free', onShow({canvasRef}) { canvasRef.scene = {id: 'other'}; }});
    await assert.rejects(placePowerAoeTemplate(changed.input, changed.runtime), /active scene changed/);
    const rejected = fixture({shape: 'cone', origin: 'free', createError: 'permission denied'});
    await assert.rejects(placePowerAoeTemplate(rejected.input, rejected.runtime), /permission denied/);
    for (const f of [cancelled, changed, rejected]) {
        assert.equal(f.wheelListeners.size, 0); assert.equal(f.previews[0].destroyed, true);
        assert.equal(f.runtime.canvasRef.templates.preview.children.length, 0);
        assert.equal(f.runtime.configRef.SWADE.activeMeasuredTemplatePreview, f.oldPreview);
    }
});

test('caster-origin and circle placement never install directional rotation handlers', async () => {
    const {placePowerAoeTemplate} = await service;
    for (const options of [{shape: 'cone'}, {shape: 'stream'}, {shape: 'medium', origin: 'free'},
        {shape: 'cone', origin: 'invalid-imported-origin'}]) {
        const f = fixture(options);
        await placePowerAoeTemplate(f.input, f.runtime);
        assert.equal(f.calls.some(call => call[0] === 'wheel-add'), false);
    }
});

test('free-origin directional placement fails safely if canvas wheel controls are unavailable', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({shape: 'cone', origin: 'free'}); delete f.runtime.wheelTarget;
    await assert.rejects(placePowerAoeTemplate(f.input, f.runtime), /rotation controls are unavailable/);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    assert.equal(f.previews[0].destroyed, true);
});

test('right-click cancellation creates no document and always removes directional preview', async () => {
    const {placePowerAoeTemplate} = await service;
    for (const shape of ['small', 'cone', 'stream']) {
        const f = fixture({shape, cancel: true});
        assert.equal(await placePowerAoeTemplate(f.input, f.runtime), null);
        assert.equal(f.calls.some(call => call[0] === 'create'), false);
        assert.equal(f.runtime.canvasRef.templates.preview.children.length, 0);
        assert.equal(f.previews.length, shape === 'small' ? 0 : 1);
        assert.ok(f.previews.every(preview => preview.destroyed));
    }
});

test('rejected numeric Power range does not create an area or use weapon range bands', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture({range: '1', point: {x: 350, y: 50}});
    assert.equal(await placePowerAoeTemplate(f.input, f.runtime), null);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    assert.match(f.calls.find(call => call[0] === 'warn')[1], /outside.*range \(1\)/);
});

test('zero Power range permits only caster-centered circular areas', async () => {
    const {placePowerAoeTemplate} = await service;
    const invalid = fixture({range: '0'});
    assert.equal(await placePowerAoeTemplate(invalid.input, invalid.runtime), null);
    const self = fixture({range: '0', point: {x: 50, y: 50}});
    assert.ok(await placePowerAoeTemplate(self.input, self.runtime));
});

test('non-numeric Power ranges are not misread as weapon ranges or guessed', async () => {
    const {getNumericPowerRange, placePowerAoeTemplate} = await service;
    for (const range of ['Smarts', 'Self', '12/24/48', '', '-1', '@attributes.spirit']) {
        assert.equal(getNumericPowerRange({system: {range}}), null);
    }
    assert.equal(getNumericPowerRange({system: {range: ' 12.5 '}}), 12.5);
    const f = fixture({range: 'Smarts', point: {x: 3050, y: 50}});
    assert.ok(await placePowerAoeTemplate(f.input, f.runtime));
    assert.equal(f.calls.find(call => call[0] === 'crosshair')[1].location.limitMaxRange, undefined);
});

test('invalid ownership, scene, shape and Sequencer fail before placement', async () => {
    const {placePowerAoeTemplate} = await service;
    for (const mutate of [
        f => { f.input.actor.isOwner = false; }, f => { f.input.item.type = 'weapon'; },
        f => { f.input.shape = 'unknown'; }, f => { f.runtime.canvasRef.scene = null; },
        f => { f.runtime.gameRef.modules.get('sequencer').active = false; },
    ]) {
        const f = fixture(); mutate(f);
        await assert.rejects(placePowerAoeTemplate(f.input, f.runtime), /Power|scene|Sequencer/);
        assert.equal(f.calls.length, 0);
    }
});

test('explicit mismatched or other-scene token never falls back to an unrelated selected token', async () => {
    const {placePowerAoeTemplate} = await service;
    for (const token of [{actor: {id: 'other'}, center: {x: 50, y: 50}},
        {actor: {id: 'caster'}, center: {x: 50, y: 50}, document: {parent: {id: 'elsewhere'}}}]) {
        const f = fixture(); f.input.token = token;
        await assert.rejects(placePowerAoeTemplate(f.input, f.runtime), /Select the token casting/);
        assert.equal(f.calls.length, 0);
    }
});

test('synthetic Power actor cannot use a different token copy sharing the base actor id', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture(); f.input.actor.isToken = true; f.input.actor.token = {id: 'real-copy'};
    await assert.rejects(placePowerAoeTemplate(f.input, f.runtime), /Select the token casting/);
});

test('token resolution uses one matching selected token, otherwise requires an unambiguous active token', async () => {
    const {placePowerAoeTemplate} = await service;
    const f = fixture(); delete f.input.token;
    assert.equal((await placePowerAoeTemplate(f.input, f.runtime)).sourceToken, f.source);
    const ambiguous = fixture(); delete ambiguous.input.token;
    ambiguous.runtime.canvasRef.tokens.controlled = [];
    ambiguous.tokens.push({...ambiguous.source, id: 'other-copy', document: {id: 'other-copy'}});
    await assert.rejects(placePowerAoeTemplate(ambiguous.input, ambiguous.runtime), /Select the token casting/);
});

test('scene changes and rejected document creation always clean up native previews', async () => {
    const {placePowerAoeTemplate} = await service;
    const changed = fixture({shape: 'cone', onShow({canvasRef}) { canvasRef.scene = {id: 'other'}; }});
    await assert.rejects(placePowerAoeTemplate(changed.input, changed.runtime), /active scene changed/);
    assert.equal(changed.calls.some(call => call[0] === 'create'), false);
    assert.equal(changed.previews[0].destroyed, true);
    const rejected = fixture({shape: 'cone', createError: 'permission denied'});
    await assert.rejects(placePowerAoeTemplate(rejected.input, rejected.runtime), /could not be created: permission denied/);
    assert.equal(rejected.previews[0].destroyed, true);
});

test('geometry rejects invalid grids and missing shapes rather than guessing area targets', async () => {
    const {buildPowerAoeTemplateData, getPowerAoeTargetIds} = await service;
    assert.throws(() => buildPowerAoeTemplateData({shape: 'small', source: {x: 0, y: 0},
        target: {x: 0, y: 0}, scene: {grid: {distance: 0}}}), /grid distance/);
    assert.throws(() => getPowerAoeTargetIds({document: {x: 0, y: 0}}, []), /shape could not be read/);
});
