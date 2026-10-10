const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.join(__dirname, '../scripts/services/PowerAoeTemplate.js')).href);

const fixture = ({shape = 'medium', point = {x: 250, y: 50}, range = '8', distance = 1,
    cancel = false, createError = null, onShow = null} = {}) => {
    const calls = [], previews = [];
    const actor = {id: 'caster', uuid: 'Actor.caster', isOwner: true};
    const item = {id: 'burst', uuid: 'Actor.caster.Item.burst', actor, isOwner: true,
        type: 'power', name: 'Burst', system: {range}};
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
    }
    class Template extends CoreTemplate {
        constructor(document) { super(); this.document = document; this.controlIcon = {}; previews.push(this); }
        async draw() { calls.push(['draw', this]); this._refreshShape(); }
        _refreshPosition() {}
        _refreshShape() {
            const doc = this.document;
            const pixels = 100 / distance;
            // This fake follows the native contract: direction is already baked into the shape's contains().
            this.shape = {contains(x, y) {
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
            await onShow?.({canvasRef, callbacks, config, previews});
            if (cancel) { callbacks.cancel(); return false; }
            return {x: point.x, y: point.y};
        }}};
    const notifications = {warn(message) { calls.push(['warn', message]); }};
    return {input: {actor, item, token: source, shape}, runtime: {canvasRef, gameRef, configRef, sequencerRef,
        constRef: {GRID_SNAPPING_MODES: {CENTER: 1, VERTEX: 2}}, baseTemplateClass: CoreTemplate, notifications},
        calls, previews, tokens, source, oldPreview, selectedTargets};
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
