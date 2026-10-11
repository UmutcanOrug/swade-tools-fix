const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeActorConfig.js')).href);

class Element {
    constructor(tag) {
        this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = [];
        this.dataset = {}; this.attributes = {}; this.className = ''; this.listeners = new Map();
    }
    append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
    prepend(...children) { for (const child of children) child.parentElement = this; this.children.unshift(...children); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    matches(selector) {
        const tag = selector.match(/^[a-z]+/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const [, key, expected] of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
            const value = key.startsWith('data-')
                ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())]
                : this.attributes[key] ?? this[key];
            if (value === undefined || (expected !== undefined && value !== expected)) return false;
        }
        return true;
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const makeActor = (extra = {}) => ({
    documentName: 'Actor', type: 'character', id: 'actor', uuid: 'Actor.actor', isOwner: true,
    flags: {'swade-tools': {}}, updates: [],
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async update(patch) { this.updates.push(patch); this.flags['swade-tools'].aoeFlammability = patch.flags['swade-tools'].aoeFlammability; },
    ...extra
});
const fixture = (actor = makeActor(), extra = {}) => {
    const form = new Element('form'), first = new Element('input'), traits = new Element('section');
    const nav = new Element('nav'), traitsLink = new Element('a'), aurasLink = new Element('a');
    const footer = new Element('footer'), auras = new Element('section');
    nav.className = 'sheet-tabs tabs';
    traitsLink.dataset = {action: 'tab', group: 'sheet', tab: 'traits'};
    aurasLink.dataset = {action: 'tab', group: 'sheet', tab: 'auras'};
    traitsLink.textContent = 'Traits'; aurasLink.textContent = 'Auramancer';
    nav.append(traitsLink, aurasLink);
    traits.className = 'tab active'; traits.dataset = {group: 'sheet', tab: 'traits'};
    auras.className = 'tab'; auras.dataset = {group: 'sheet', tab: 'auras'};
    form[0] = first; form.append(first, nav, traits, auras, footer);
    return {form, first, nav, traitsLink, aurasLink, footer, traits, auras, actor, sheet: {document: actor, isEditable: true, ...extra},
        runtime: {document: {createElement: tag => new Element(tag)}}};
};

test('actor flammability defaults to Flammable (6) without writing or changing actor data', async () => {
    const {getAoeActorFlammability, AOE_ACTOR_FLAMMABILITY} = await load();
    for (const value of [undefined, null, '', 'unknown', 6, {}, '__proto__']) {
        const actor = makeActor({flags: {'swade-tools': {aoeFlammability: value}}});
        assert.equal(getAoeActorFlammability(actor), 'flammable');
        assert.equal(actor.updates.length, 0);
        assert.equal(actor.flags['swade-tools'].aoeFlammability, value);
    }
    assert.equal(getAoeActorFlammability(null), 'flammable');
    assert.equal(AOE_ACTOR_FLAMMABILITY.flammable, 6);
    assert.equal(Object.isFrozen(AOE_ACTOR_FLAMMABILITY), true);
});

test('known actor settings preserve existing flammability values and plain flag fixtures', async () => {
    const {getAoeActorFlammability} = await load();
    for (const value of ['none', 'flammable', 'very', 'volatile']) {
        const flags = {'swade-tools': {aoeFlammability: value}};
        assert.equal(getAoeActorFlammability(makeActor({flags})), value);
        assert.equal(getAoeActorFlammability({flags}), value);
    }
});

test('native V13 indexed form gets one English field in Traits, not the indexed control or other tabs', async () => {
    const {bindAoeActorTweaksControl} = await load();
    const s = fixture();
    bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
    bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
    assert.equal(s.traits.querySelectorAll('[data-swade-tools-aoe-flammability]').length, 1);
    assert.equal(s.first.children.length, 0); assert.equal(s.auras.children.length, 0);
    const select = s.traits.querySelector('select'), label = s.traits.querySelector('label');
    assert.equal(label.textContent, 'Flammability'); assert.equal(label.htmlFor, select.id);
    assert.equal(select.name, 'flags.swade-tools.aoeFlammability');
    assert.equal(select.value, 'flammable'); assert.equal(select.disabled, false);
    assert.deepEqual(select.children.map(option => [option.value, option.textContent]), [
        ['none', 'Not Flammable'], ['flammable', 'Flammable (6)'],
        ['very', 'Very Flammable (4–6)'], ['volatile', 'Volatile (2–6)']
    ]);
    assert.equal(s.actor.updates.length, 0);
});

test('legacy wrapper, part-only render, and app element fallback use the same native field', async () => {
    const {bindAoeActorTweaksControl} = await load();
    for (const wrap of [s => ({jquery: 'test', 0: s.form}), s => [s.form], s => s.traits, () => undefined]) {
        const s = fixture(makeActor({flags: {'swade-tools': {aoeFlammability: 'very'}}}));
        s.sheet.element = s.form;
        bindAoeActorTweaksControl(s.sheet, wrap(s), s.runtime);
        assert.equal(s.traits.querySelector('select').value, 'very');
    }
});

test('native navigation before Traits is never mistaken for the scrollable content panel', async () => {
    const {bindAoeActorTweaksControl} = await load();
    const s = fixture(), category = new Element('section');
    s.traits.append(category);
    // This ordering mirrors Foundry's tab-navigation.hbs followed by SWADE's
    // tab-traits.hbs. The broad selector previously selected this anchor.
    assert.equal(s.form.querySelector('[data-tab="traits"]'), s.traitsLink);
    bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
    const group = s.form.querySelector('[data-swade-tools-aoe-flammability]');
    assert.equal(group.parentElement, s.traits);
    assert.equal(s.traits.children[0], group);
    assert.equal(s.traits.children[1], category);
    assert.equal(s.nav.querySelectorAll('[data-swade-tools-aoe-flammability]').length, 0);
    assert.equal(s.traitsLink.textContent, 'Traits');
    assert.equal(s.aurasLink.textContent, 'Auramancer');
    assert.equal(s.footer.children.length, 0);
});

test('Flammability shares the native Traits scrolling and tab visibility instead of an independent fixed area', async () => {
    const {bindAoeActorTweaksControl} = await load();
    const s = fixture();
    s.traits.setAttribute('data-application-part', 'traits');
    s.traits.style = {overflowY: 'auto', position: 'relative'};
    s.traits.scrollTop = 120;
    bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
    const group = s.traits.querySelector('[data-swade-tools-aoe-flammability]');
    assert.equal(group.parentElement, s.traits);
    assert.equal(group.style, undefined);
    assert.deepEqual(s.traits.style, {overflowY: 'auto', position: 'relative'});
    assert.equal(s.traits.scrollTop, 120);
    assert.equal(s.traits.attributes['data-application-part'], 'traits');
    s.traits.className = 'tab'; s.auras.className = 'tab active';
    bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
    assert.equal(group.parentElement, s.traits);
    assert.equal(s.traits.className, 'tab');
    assert.equal(s.auras.children.length, 0);
    assert.equal(s.form.querySelectorAll('[data-swade-tools-aoe-flammability]').length, 1);
});

test('a navigation-only partial render cannot create a control in its Traits link', async () => {
    const {bindAoeActorTweaksControl} = await load();
    for (const part of [s => s.nav, s => s.traitsLink]) {
        const s = fixture();
        bindAoeActorTweaksControl(s.sheet, part(s), s.runtime);
        assert.equal(s.form.querySelectorAll('[data-swade-tools-aoe-flammability]').length, 0);
    }
});

test('owner/GM native permissions are respected and read-only fields do not become editable', async () => {
    const {bindAoeActorTweaksControl} = await load();
    for (const [isOwner, isEditable, disabled] of [[true,true,false], [false,true,true], [true,false,true], [false,false,true]]) {
        const s = fixture(makeActor({isOwner}), {isEditable});
        bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
        assert.equal(s.traits.querySelector('select').disabled, disabled);
        assert.equal(s.actor.updates.length, 0);
    }
});

test('native Save Changes field submits to the actual unlinked token actor; cancel/change performs no write', async () => {
    const {bindAoeActorTweaksControl} = await load();
    const worldActor = makeActor({flags: {'swade-tools': {aoeFlammability: 'none'}}});
    const tokenActor = makeActor({uuid: 'Scene.scene.Token.token.Actor.actor', isToken: true,
        flags: {'swade-tools': {aoeFlammability: 'volatile'}}, parent: {baseActor: worldActor}});
    const s = fixture(tokenActor);
    bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
    const select = s.traits.querySelector('select'); assert.equal(select.value, 'volatile');
    select.value = 'very'; assert.equal(tokenActor.updates.length, 0);
    // Native SWADE Tweaks expands FormDataExtended.object, preserving flags,
    // then DocumentSheetV2 submits that data to this.document.update.
    const expanded = {};
    const keys = select.name.split('.');
    keys.slice(0, -1).reduce((parent, key) => parent[key] ??= {}, expanded)[keys.at(-1)] = select.value;
    await s.sheet.document.update(expanded);
    assert.deepEqual(tokenActor.updates, [{flags: {'swade-tools': {aoeFlammability: 'very'}}}]);
    assert.equal(worldActor.flags['swade-tools'].aoeFlammability, 'none');
    assert.equal(worldActor.updates.length, 0);
    assert.equal(select.listeners.size, 0);
});

test('non-Actor, group, and panels without the native Traits tab are left untouched', async () => {
    const {bindAoeActorTweaksControl} = await load();
    for (const actor of [makeActor({documentName: 'Item'}), makeActor({type: 'group'})]) {
        const s = fixture(actor); bindAoeActorTweaksControl(s.sheet, s.form, s.runtime);
        assert.equal(s.traits.children.length, 0);
    }
    const s = fixture();
    bindAoeActorTweaksControl(s.sheet, s.auras, s.runtime);
    assert.equal(s.auras.children.length, 0);
    assert.doesNotThrow(() => bindAoeActorTweaksControl(null, null, {}));
});

test('native actor Tweaks hook registers once per Hooks instance without patching sheet prototypes', async () => {
    const {registerAoeActorControls} = await load();
    const s = fixture(), hooks = new Map();
    s.runtime.Hooks = {on(name, callback) { (hooks.get(name) ?? hooks.set(name, []).get(name)).push(callback); }};
    registerAoeActorControls(s.runtime); registerAoeActorControls(s.runtime);
    assert.deepEqual([...hooks.keys()], ['renderSwadeActorTweaks']);
    assert.equal(hooks.get('renderSwadeActorTweaks').length, 1);
    hooks.get('renderSwadeActorTweaks')[0](s.sheet, s.form);
    assert.equal(s.traits.querySelector('select').value, 'flammable');
    const second = new Map();
    registerAoeActorControls({Hooks: {on(name, callback) { second.set(name, callback); }}, document: s.runtime.document});
    assert.equal(second.size, 1);
    assert.doesNotThrow(() => registerAoeActorControls({Hooks: {}}));
});
