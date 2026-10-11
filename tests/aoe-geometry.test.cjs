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
