const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.join(__dirname, '../scripts/services/AoeGeometry.js')).href);
const token = (id, x, y, width = 100, height = 100) => ({id, x, y, w: width, h: height,
    actor: {id}, center: {x: x + width / 2, y: y + height / 2},
    document: {id, uuid: `Scene.scene.Token.${id}`},
    setTarget() { throw new Error('AoE geometry must not change target rings'); }});
const cone = {t: 'cone', x: 0, y: 0, distance: 9, width: 3, angle: 0, direction: 0};

test('circle AoE includes partial rectangle overlap, including an edge touch, not only token centers', async () => {
    const {tokenOverlapsAoeTemplate} = await service;
    const area = {t: 'circle', x: 0, y: 0, distance: 2};
    assert.equal(tokenOverlapsAoeTemplate(area, token('partial', 180, -50)), true);
    assert.equal(tokenOverlapsAoeTemplate(area, token('touch', 200, -20)), true);
    assert.equal(tokenOverlapsAoeTemplate(area, token('outside', 201, -50)), false);
    assert.equal(tokenOverlapsAoeTemplate(area, token('diagonal-outside', 150, 150)), false);
});

test('native rounded cone reproduces the SWADE 3-degree endcap polygon and scales length, not width', async () => {
    const {getAoeTemplatePolygon} = await service;
    const points = getAoeTemplatePolygon(cone);
    assert.equal(points.length, 62);
    assert.deepEqual(points[0], {x: 0, y: 0});
    assert.ok(Math.abs(points[31].x - 900) < 0.00001);
    assert.ok(Math.abs(points[31].y) < 0.00001);
    const scaled = getAoeTemplatePolygon({...cone, distance: 45}, {gridSize: 100, sceneDistance: 5});
    assert.deepEqual(scaled, points);
});

test('cone partial-overlap catches a token whose center misses without affecting tokens behind it', async () => {
    const {collectAoeTemplateTargets} = await service;
    const targets = [token('inside', 350, -20, 40, 40), token('partial', 500, 90, 100, 100),
        token('outside', 500, 140, 100, 100), token('behind', -110, -20, 100, 40), token('cap', 890, -20, 50, 40)];
    assert.deepEqual(collectAoeTemplateTargets(cone, targets).map(value => value.id), ['inside', 'partial', 'cap']);
});

test('cone rotation and translated native polygon points are applied only once', async () => {
    const {collectAoeTemplateTargets} = await service;
    const area = {...cone, x: 100, y: 100, direction: 90};
    assert.deepEqual(collectAoeTemplateTargets(area, [token('north', 80, 500, 40, 40), token('east', 500, 80, 40, 40)])
        .map(value => value.id), ['north']);
    const native = {document: area, shape: {points: [0, 0, -100, 800, 100, 800]}};
    assert.deepEqual(collectAoeTemplateTargets(native, [token('north', 80, 500, 40, 40), token('east', 500, 80, 40, 40)])
        .map(value => value.id), ['north']);
});

test('thin stream crossing a large token detects edge intersections even with no contained corners', async () => {
    const {tokenOverlapsAoeTemplate} = await service;
    const area = {t: 'ray', x: 0, y: 0, direction: 0, distance: 12, width: 0.2};
    assert.equal(tokenOverlapsAoeTemplate(area, token('crossing', 500, -100, 200, 200)), true);
    assert.equal(tokenOverlapsAoeTemplate(area, token('outside', 500, 11, 200, 200)), false);
});

test('AoE targeting filters invisible tokens, excludes only explicit source, and reads document-sized bounds', async () => {
    const {collectAoeTemplateTargets} = await service;
    const visible = token('visible', 100, -50), source = token('source', 0, 0), hidden = token('hidden', 100, 0);
    hidden.document.hidden = true;
    const notVisible = {...token('invisible', 100, 0), visible: false};
    const documentSized = {actor: {}, id: 'document-size', document: {id: 'document-size',
        uuid: 'Scene.scene.Token.document-size', x: 180, y: -50, width: 1, height: 1}};
    const options = {excludeSource: true, sourceTokenUuid: source.document.uuid};
    assert.deepEqual(collectAoeTemplateTargets({t: 'circle', x: 0, y: 0, distance: 2},
        [visible, source, hidden, notVisible, documentSized, {...visible, actor: null}], options).map(value => value.id),
    ['visible', 'document-size']);
    assert.ok(collectAoeTemplateTargets({...cone, x: -50}, [source], {excludeSource: false}).length);
});

test('unsupported or invalid AoE geometry never guesses a target area', async () => {
    const {tokenOverlapsAoeTemplate} = await service;
    assert.equal(tokenOverlapsAoeTemplate({t: 'unknown'}, token('test', 0, 0)), false);
    assert.equal(tokenOverlapsAoeTemplate(cone, token('test', 0, 0), {sceneDistance: 0}), false);
    assert.equal(tokenOverlapsAoeTemplate(cone, {actor: {}}), false);
});

test('flagged custom cones use fresh native flat/grid cone geometry without changing SWADE presets', async () => {
    const {getAoeTemplatePolygon, collectAoeTemplateTargets} = await service;
    const oldFoundry = globalThis.foundry;
    const calls = [];
    globalThis.foundry = {canvas: {placeables: {MeasuredTemplate: class {
        static getConeShape(distance, direction, angle) {
            calls.push([distance, direction, angle]);
            // A flat native 90-degree cone has end corners beyond the round cone's radius.
            return {points: [0, 0, 400, -400, 400, 400, 0, 0]};
        }
    }}}};
    try {
        const area = {t: 'cone', x: 100, y: 100, direction: 0, distance: 20, angle: 90,
            flags: {'swade-tools': {templateType: 'custom', customShapeType: 'cone', weaponAoeTemplate: true}},
            object: {shape: {points: [0, 0, -50, -10, -50, 10]}}}; // Stale native render must not override the fresh document.
        const options = {gridSize: 100, sceneDistance: 5};
        assert.deepEqual(getAoeTemplatePolygon(area, options), [
            {x: 100, y: 100}, {x: 500, y: -300}, {x: 500, y: 500}, {x: 100, y: 100}]);
        assert.deepEqual(collectAoeTemplateTargets(area, [token('flat-corner', 480, 450, 10, 10),
            token('behind', 0, 80, 20, 20), token('past-end', 510, 90, 10, 10)], options).map(value => value.id),
        ['flat-corner']);
        assert.ok(calls.length > 0);
        for (const args of calls) assert.deepEqual(args, [20, 0, 90]);
        calls.length = 0;
        assert.equal(getAoeTemplatePolygon(cone).length, 62);
        assert.deepEqual(calls, []);
    } finally {
        if (oldFoundry === undefined) delete globalThis.foundry;
        else globalThis.foundry = oldFoundry;
    }
});

test('full-angle custom cones preserve exact native circular overlap, including edge touches', async () => {
    const {tokenOverlapsAoeTemplate, getAoeTemplatePolygon} = await service;
    const oldFoundry = globalThis.foundry;
    globalThis.foundry = {canvas: {placeables: {MeasuredTemplate: class {
        static getConeShape(distance, direction, angle) {
            assert.equal(distance, 4); assert.equal(direction, 270); assert.equal(angle, 360);
            return {x: 0, y: 0, radius: 400};
        }
    }}}};
    try {
        const area = {t: 'cone', x: 100, y: 100, direction: 270, distance: 4, angle: 360,
            flags: {'swade-tools': {templateType: 'custom', customShapeType: 'cone', powerAoeTemplate: true}}};
        assert.equal(tokenOverlapsAoeTemplate(area, token('edge', 500, 90, 20, 20)), true);
        assert.equal(tokenOverlapsAoeTemplate(area, token('outside', 501, 90, 20, 20)), false);
        assert.equal(tokenOverlapsAoeTemplate(area, token('behind-origin', -200, 80, 20, 20)), true);
        assert.equal(getAoeTemplatePolygon(area).length, 120);
    } finally {
        if (oldFoundry === undefined) delete globalThis.foundry;
        else globalThis.foundry = oldFoundry;
    }
});

test('custom rectangle ray geometry preserves exact length and width while rotating for partial-overlap targets', async () => {
    const {collectAoeTemplateTargets} = await service;
    const area = {t: 'ray', x: 100, y: 100, direction: 90, distance: 20, width: 10,
        flags: {'swade-tools': {templateType: 'custom', customShapeType: 'rect', weaponAoeTemplate: true}}};
    const options = {gridSize: 100, sceneDistance: 5};
    assert.deepEqual(collectAoeTemplateTargets(area, [token('partial-edge', 190, 300, 40, 40),
        token('past-length', 90, 501, 20, 20), token('too-wide', 201, 300, 20, 20),
        token('inside', 90, 300, 20, 20)], options).map(value => value.id), ['partial-edge', 'inside']);
});

test('custom cone target geometry does not replace a failing live native scene calculation with a guessed sector', async () => {
    const {collectAoeTemplateTargets} = await service;
    const oldFoundry = globalThis.foundry, oldCanvas = globalThis.canvas;
    globalThis.foundry = {canvas: {placeables: {MeasuredTemplate: class {
        static getConeShape() { throw new Error('Native grid geometry failed'); }
    }}}};
    globalThis.canvas = {ready: true, scene: {id: 'scene'}};
    try {
        const area = {t: 'cone', x: 0, y: 0, direction: 0, distance: 4, angle: 90,
            flags: {'swade-tools': {templateType: 'custom', customShapeType: 'cone', weaponAoeTemplate: true}}};
        assert.throws(() => collectAoeTemplateTargets(area, [token('inside', 100, 0)]), /Native grid geometry failed/);
    } finally {
        if (oldFoundry === undefined) delete globalThis.foundry;
        else globalThis.foundry = oldFoundry;
        if (oldCanvas === undefined) delete globalThis.canvas;
        else globalThis.canvas = oldCanvas;
    }
});
