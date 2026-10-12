const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesLibrary.js')).href);
const fixture = (isGM = true) => {
    let state = {version: 1, presets: [], assignments: {}, favorites: [], hiddenPresets: []};
    const writes = [];
    return {runtime: {game: {user: {isGM}, settings: {
        get(scope, key) { assert.equal(scope, 'swade-tools'); assert.equal(key, 'propertiesLibrary'); return state; },
        async set(scope, key, data) { assert.equal(scope, 'swade-tools'); assert.equal(key, 'propertiesLibrary'); state = structuredClone(data); writes.push(data); }
    }}}, writes, get state() { return state; }};
};

test('library contains broad supported searchable examples with English and Turkish aliases', async () => {
    const {getPropertyLibrary, searchPropertyPresets} = await load();
    const f = fixture(), library = getPropertyLibrary(f.runtime);
    assert.equal(library.version, 1); assert.ok(library.presets.length >= 35);
    assert.ok(new Set(library.presets.map(entry => entry.category)).size >= 7);
    assert.ok(searchPropertyPresets('zırh', 'all', f.runtime).length >= 3);
    assert.equal(searchPropertyPresets('kaçınma', 'Defense', f.runtime).some(entry => entry.id === 'builtin.dodge'), true);
    assert.equal(searchPropertyPresets('zehir', 'all', f.runtime)[0].id, 'builtin.poison-wound');
    assert.equal(searchPropertyPresets('shooting', 'Skills', f.runtime).some(entry => entry.id === 'builtin.shooting-buff'), true);
    assert.equal(searchPropertyPresets('ignore', 'Defense', f.runtime).some(entry => entry.id === 'builtin.ignore-gangup'), true);
    assert.equal(searchPropertyPresets('IGNORE', 'Defense', f.runtime).some(entry => entry.id === 'builtin.ignore-gangup'), true);
    assert.equal(f.writes.length, 0);
    library.presets[0].rules[0].value = -9;
    assert.notEqual(getPropertyLibrary(f.runtime).presets[0].rules[0].value, -9);
});

test('players cannot approve assignments or change presets/favorites/imports', async () => {
    const api = await load(), f = fixture(false), item = {uuid: 'Actor.actor.Item.weapon'};
    for (const action of [
        () => api.savePropertyLibrary(api.getPropertyLibrary(f.runtime), f.runtime),
        () => api.saveItemPropertyRules(item, [{id: 'a'}], f.runtime),
        () => api.savePropertyPreset({id: 'custom', rules: []}, f.runtime),
        () => api.removePropertyPreset('builtin.dodge', f.runtime),
        () => api.setPropertyFavorite('builtin.dodge', true, f.runtime),
        () => api.importPropertyLibrary('{}', {}, f.runtime)
    ]) await assert.rejects(async () => action(), /Only the GM/);
    assert.equal(f.writes.length, 0);
});

test('custom presets can be edited, favorited and removed without changing approved assignments', async () => {
    const api = await load(), f = fixture(), item = {uuid: 'Actor.actor.Item.weapon'};
    await api.saveItemPropertyRules(item, [{id: 'approved', action: 'attackMod', value: 1}], f.runtime);
    await api.savePropertyPreset({id: 'custom.weakening', name: 'My Weakening', category: 'Campaign', aliases: ['benim'], rules: [{id: 'weaken', action: 'traitSteps', value: -1}]}, f.runtime);
    assert.equal(api.searchPropertyPresets('benim', 'Campaign', f.runtime).length, 1);
    await api.setPropertyFavorite('custom.weakening', true, f.runtime);
    assert.equal(api.searchPropertyPresets('', 'all', f.runtime)[0].id, 'custom.weakening');
    await api.savePropertyPreset({id: 'custom.weakening', name: 'Edited', rules: [{id: 'weaken', action: 'traitSteps', value: -2}]}, f.runtime);
    assert.equal(api.getPropertyLibrary(f.runtime).presets.find(entry => entry.id === 'custom.weakening').rules[0].value, -2);
    assert.equal(api.getItemPropertyRules(item, f.runtime)[0].value, 1);
    await api.removePropertyPreset('custom.weakening', f.runtime);
    assert.equal(api.getPropertyLibrary(f.runtime).presets.some(entry => entry.id === 'custom.weakening'), false);
    assert.equal(api.getItemPropertyRules(item, f.runtime).length, 1);
});

test('builtin overrides and deletion persist but can be explicitly restored', async () => {
    const api = await load(), f = fixture();
    const dodge = api.getPropertyLibrary(f.runtime).presets.find(entry => entry.id === 'builtin.dodge');
    dodge.rules[0].value = -3;
    await api.savePropertyPreset(dodge, f.runtime);
    assert.equal(api.searchPropertyPresets('Dodge-like', 'all', f.runtime)[0].rules[0].value, -3);
    await api.removePropertyPreset('builtin.dodge', f.runtime);
    assert.equal(api.getPropertyLibrary(f.runtime).presets.some(entry => entry.id === 'builtin.dodge'), false);
    await api.savePropertyPreset(dodge, f.runtime);
    assert.equal(api.getPropertyLibrary(f.runtime).presets.find(entry => entry.id === 'builtin.dodge').rules[0].value, -3);
});

test('assignments are exact UUID-bound, serialized and cannot be spoofed by editable flags', async () => {
    const api = await load(), f = fixture();
    const a = {uuid: 'Actor.actor.Item.weapon'}, b = {uuid: 'Scene.scene.Token.token.Actor.actor.Item.edge'};
    await Promise.all([
        api.saveItemPropertyRules(a, [{id: 'a', action: 'attackMod', value: 2}], f.runtime),
        api.saveItemPropertyRules(b, [{id: 'b', action: 'cover', value: -2}], f.runtime)
    ]);
    assert.equal(api.getItemPropertyRules(a, f.runtime).length, 1); assert.equal(api.getItemPropertyRules(b, f.runtime).length, 1);
    assert.deepEqual(api.getItemPropertyRules({uuid: 'Actor.other.Item.weapon', flags: {'swade-tools': {properties: [{id: 'a'}]}}}, f.runtime), []);
    await api.saveItemPropertyRules(a, [], f.runtime);
    assert.equal(Object.hasOwn(f.state.assignments, a.uuid), false);
    for (const uuid of ['*', 'Actor.actor', '__proto__', 'Scene.scene.Token.token', 'Actor.actor.Item.*', 'javascript:alert(1)']) {
        await assert.rejects(() => api.saveItemPropertyRules({uuid}, [{id: 'a'}], f.runtime), /saved item/);
    }
});

test('library import/export preserves valid rules and rejects unsafe, malformed or oversized data before writes', async () => {
    const api = await load(), f = fixture();
    await api.saveItemPropertyRules({uuid: 'Item.weapon'}, [{id: 'attack', action: 'damageMod', value: 3}], f.runtime);
    const exported = api.exportPropertyLibrary(f.runtime), fresh = fixture();
    await api.importPropertyLibrary(exported, {replace: true}, fresh.runtime);
    assert.equal(api.getItemPropertyRules('Item.weapon', fresh.runtime)[0].value, 3);
    const before = fresh.writes.length;
    for (const raw of [
        {version: 2}, {version: 1, script: 'alert(1)'},
        {version: 1, assignments: {'__proto__': []}, presets: [{id: 'custom', rules: [{action: 'grantEdge'}]}]},
        {version: 1, assignments: {'Actor.actor': []}},
        {version: 1, presets: [{id: 'x', rules: [{action: 'status', status: 'shaken', code: 'run()'}]}]}
    ]) await assert.rejects(() => api.importPropertyLibrary(JSON.stringify(raw), {}, fresh.runtime));
    await assert.rejects(() => api.importPropertyLibrary('{bad', {}, fresh.runtime));
    await assert.rejects(() => api.importPropertyLibrary(' '.repeat(2000001), {}, fresh.runtime), /2 MB/);
    assert.equal(fresh.writes.length, before);
});

test('merge import keeps existing assignments and combines custom catalogs', async () => {
    const api = await load(), f = fixture();
    await api.saveItemPropertyRules('Item.old', [{id: 'old', value: 1}], f.runtime);
    await api.importPropertyLibrary(JSON.stringify({version: 1, presets: [{id: 'imported', name: 'Imported', rules: [{id: 'new', value: 2}]}], assignments: {'Item.new': [{id: 'new', value: 3}]}, favorites: ['imported']}), {}, f.runtime);
    assert.equal(api.getItemPropertyRules('Item.old', f.runtime)[0].value, 1);
    assert.equal(api.getItemPropertyRules('Item.new', f.runtime)[0].value, 3);
    assert.equal(api.searchPropertyPresets('', 'all', f.runtime)[0].id, 'imported');
});
