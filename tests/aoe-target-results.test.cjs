const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const api = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeTargetResults.js')).href);

// Match Foundry's recursive document-update expansion, including nested flag maps.
const expandObject = object => {
    if (Array.isArray(object)) return object.map(expandObject);
    if (!object || typeof object !== 'object') return object;
    const expanded = {};
    for (const [key, value] of Object.entries(object)) {
        const parts = key.split('.');
        let target = expanded;
        for (const part of parts.slice(0, -1)) target = target[part] ??= {};
        target[parts.at(-1)] = expandObject(value);
    }
    return expanded;
};

test('AoE target results survive Foundry recursive expansion on create and update', async () => {
    const {aoeTargetResultKey, getAoeTargetResult, withAoeTargetResult} = await api;
    const uuid = 'Scene.scene.Token.victim';
    const results = withAoeTargetResult({}, uuid, {evaded: false, total: 3});
    assert.equal(aoeTargetResultKey(uuid), 'Scene%2Escene%2EToken%2Evictim');
    assert.ok(Object.keys(results).every(key => !key.includes('.')));
    const created = expandObject({flags: {world: {aoeEvadeResults: results}}});
    const updated = expandObject({'flags.world.aoeEvadeResults': results});
    assert.deepEqual(getAoeTargetResult(created.flags.world.aoeEvadeResults, uuid), {evaded: false, total: 3});
    assert.deepEqual(getAoeTargetResult(updated.flags.world.aoeEvadeResults, uuid), {evaded: false, total: 3});
});

test('legacy expanded Evade and Fire results remain readable and normalize without losing other targets', async () => {
    const {getAoeTargetResult, withAoeTargetResult} = await api;
    const first = 'Scene.scene.Token.first';
    const second = 'Scene.scene.Token.second';
    const old = expandObject({[first]: {evaded: true}, [second]: {status: 'pending'}});
    assert.deepEqual(getAoeTargetResult(old, first), {evaded: true});
    const saved = withAoeTargetResult(old, second, {status: 'burning'});
    assert.ok(Object.keys(saved).every(key => !key.includes('.') && key !== 'Scene'));
    const updated = expandObject(saved);
    assert.deepEqual(getAoeTargetResult(updated, first), {evaded: true});
    assert.deepEqual(getAoeTargetResult(updated, second), {status: 'burning'});
    assert.deepEqual(getAoeTargetResult(old, second), {status: 'pending'});
});

test('safe keys take precedence over stale legacy results', async () => {
    const {aoeTargetResultKey, getAoeTargetResult, withAoeTargetResult} = await api;
    const uuid = 'Scene.scene.Token.victim';
    const old = {[uuid]: {evaded: true}, Scene: {scene: {Token: {victim: {evaded: true}}}},
        [aoeTargetResultKey(uuid)]: {evaded: false}};
    const saved = withAoeTargetResult(old, 'Scene.scene.Token.other', {evaded: true});
    assert.deepEqual(getAoeTargetResult(saved, uuid), {evaded: false});
    assert.equal(getAoeTargetResult({}, uuid), undefined);
});
