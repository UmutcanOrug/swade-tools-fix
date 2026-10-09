const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const services = path.resolve(__dirname, '../scripts/services');
const load = name => import(pathToFileURL(path.join(services, name)).href);

// Native-shaped fixture includes indexed form controls, so it catches the V13
// HTMLFormElement[0] pitfall without connecting to a running Foundry session.
class Element {
    constructor(tag) {
        this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = [];
        this.dataset = {}; this.attributes = {}; this.style = {}; this.listeners = new Map();
        this.className = ''; this.parentElement = null; this.textContent = '';
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    prepend(...children) { for (const child of children) child.parentElement = this; this.children.unshift(...children); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, handler) {
        const handlers = this.listeners.get(type) ?? []; handlers.push(handler); this.listeners.set(type, handlers);
    }
    async emit(type) {
        const event = { prevented: false, stopped: false,
            preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
        for (const handler of this.listeners.get(type) ?? []) await handler(event);
        return event;
    }
    matches(selector) {
        return selector.split(',').some(part => {
            const simple = part.trim(), tag = simple.match(/^[a-z]+/i)?.[0];
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            for (const match of simple.matchAll(/\.([\w-]+)/g)) {
                if (!this.className.split(/\s+/).includes(match[1])) return false;
            }
            for (const match of simple.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
                const key = match[1];
                const value = key.startsWith('data-')
                    ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())]
                    : this.attributes[key];
                if (value === undefined || (match[2] !== undefined && match[2] !== value)) return false;
            }
            return true;
        });
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const makeItem = (extra = {}) => ({
    type: 'weapon', name: 'Scattergun', documentName: 'Item', isOwner: true,
    flags: { 'swade-tools': {} }, updates: [],
    system: { damage: '2d8', actions: { trait: 'Shooting', traitMod: '+1' } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) {
        (this.flags[scope] ??= {})[key] = value; this.updates.push({ scope, key, value });
    },
    async update(patch) {
        this.updates.push(patch);
        for (const [key, value] of Object.entries(patch)) {
            if (key.startsWith('flags.swade-tools.')) this.flags['swade-tools'][key.slice(18)] = value;
        }
    }, ...extra
});
const platform = () => {
    const hooks = new Map(), messages = [];
    global.document = { createElement: tag => new Element(tag) };
    global.Hooks = { on(name, callback) {
        const callbacks = hooks.get(name) ?? []; callbacks.push(callback); hooks.set(name, callbacks);
    } };
    global.ui = { notifications: {
        info: message => messages.push(['info', message]), error: message => messages.push(['error', message])
    } };
    global.foundry = { applications: { api: { DialogV2: {} } } };
    return { hooks, messages };
};
const propertiesForm = () => {
    const form = new Element('form'), first = new Element('input'), properties = new Element('section');
    form[0] = first; form.append(first); properties.className = 'tab'; properties.dataset.tab = 'properties';
    form.append(properties); return { form, first, properties };
};

test('V13 native indexed form gets one English Shotgun opt-in and gear in Properties', async () => {
    platform();
    const { bindShotgunItemSheetControl } = await load('ShotgunItemConfig.js');
    const item = makeItem(), { form, first, properties } = propertiesForm();
    const sheet = { document: item, isEditable: true };
    bindShotgunItemSheetControl(sheet, form); bindShotgunItemSheetControl(sheet, form);
    assert.equal(properties.querySelectorAll('[data-swade-tools-shotgun-item-option]').length, 1);
    assert.equal(first.querySelector('[data-swade-tools-shotgun-item-option]'), null);
    assert.equal(properties.querySelector('label').textContent, 'Enable Shotgun Rules');
    assert.equal(properties.querySelector('[data-swade-tools-shotgun-enabled]').checked, false);
    const gear = properties.querySelector('[data-swade-tools-shotgun-settings]');
    assert.equal(gear.type, 'button'); assert.equal(gear.title, 'Shotgun Settings');
    assert.equal(gear.querySelector('i').className, 'fa-solid fa-gear');
    assert.equal(item.updates.length, 0);
});

test('legacy jQuery and array wrapper roots preserve support and ineligible items receive no controls', async () => {
    platform();
    const { bindShotgunItemSheetControl } = await load('ShotgunItemConfig.js');
    for (const wrapper of [form => ({ jquery: 'test', 0: form }), form => [form]]) {
        const item = makeItem(), { form } = propertiesForm();
        bindShotgunItemSheetControl({ item }, wrapper(form));
        assert.ok(form.querySelector('[data-swade-tools-shotgun-item-option]'));
    }
    const form = new Element('form');
    bindShotgunItemSheetControl({ item: makeItem({ type: 'gear' }) }, form);
    assert.equal(form.children.length, 0);
});

test('Properties checkbox persists only sgEnabled and never edits native Trait or Damage', async () => {
    platform();
    const { bindShotgunItemSheetControl } = await load('ShotgunItemConfig.js');
    const item = makeItem(), originalSystem = structuredClone(item.system), { form } = propertiesForm();
    bindShotgunItemSheetControl({ item }, form);
    const checkbox = form.querySelector('[data-swade-tools-shotgun-enabled]');
    assert.equal(checkbox.listeners.get('change').length, 1);
    checkbox.checked = true; await checkbox.emit('change');
    checkbox.checked = false; await checkbox.emit('change');
    assert.deepEqual(item.updates, [
        { scope: 'swade-tools', key: 'sgEnabled', value: true },
        { scope: 'swade-tools', key: 'sgEnabled', value: false }
    ]);
    assert.deepEqual(item.system, originalSystem);
});

test('nonowners and read-only sheets cannot toggle or open Settings, even via synthetic events', async () => {
    platform();
    const { bindShotgunItemSheetControl, showShotgunItemSettings } = await load('ShotgunItemConfig.js');
    let prompts = 0; foundry.applications.api.DialogV2.prompt = async () => { prompts++; return null; };
    for (const [isOwner, isEditable] of [[false, true], [true, false]]) {
        const item = makeItem({ isOwner }), { form } = propertiesForm();
        bindShotgunItemSheetControl({ item, isEditable }, form);
        const checkbox = form.querySelector('[data-swade-tools-shotgun-enabled]');
        const gear = form.querySelector('[data-swade-tools-shotgun-settings]');
        assert.equal(checkbox.disabled, true); assert.equal(gear.disabled, true);
        checkbox.checked = true; await checkbox.emit('change'); await gear.emit('click');
        assert.equal(item.updates.length, 0);
        if (!isOwner) await showShotgunItemSettings(item);
    }
    assert.equal(prompts, 0);
});

test('Shotgun Settings saves both capability flags without enabling rules or changing system data', async () => {
    const { messages } = platform();
    const { showShotgunItemSettings } = await load('ShotgunItemConfig.js');
    const item = makeItem(), originalSystem = structuredClone(item.system);
    let options;
    foundry.applications.api.DialogV2.prompt = async config => {
        options = config;
        return config.ok.callback(null, { form: { elements: {
            sgDoubleBarrel: { checked: true }, sgBonusIncluded: { checked: true }
        } } });
    };
    await showShotgunItemSettings(item);
    assert.equal(options.window.title, 'Scattergun - Shotgun Settings');
    assert.match(options.content, /Double-barrel weapon/);
    assert.match(options.content, /Shot \+2 already included in Trait Modifier/);
    assert.match(options.content, /Rate of Fire 1/);
    assert.equal(options.ok.label, 'Save Settings');
    assert.deepEqual(item.updates, [{ 'flags.swade-tools.sgDoubleBarrel': true, 'flags.swade-tools.sgBonusIncluded': true }]);
    assert.equal(item.getFlag('swade-tools', 'sgEnabled'), undefined);
    assert.deepEqual(item.system, originalSystem);
    assert.deepEqual(messages, [['info', 'Shotgun settings saved.']]);
});

test('canceled Settings has no writes and reopening reflects saved flags', async () => {
    platform();
    const { showShotgunItemSettings } = await load('ShotgunItemConfig.js');
    const item = makeItem({ flags: { 'swade-tools': { sgDoubleBarrel: true, sgBonusIncluded: true } } });
    let options; foundry.applications.api.DialogV2.prompt = async config => { options = config; return null; };
    await showShotgunItemSettings(item);
    assert.match(options.content, /name="sgDoubleBarrel" type="checkbox" checked/);
    assert.match(options.content, /name="sgBonusIncluded" type="checkbox" checked/);
    assert.equal(item.updates.length, 0);
});

test('failed toggle restores the persisted value and re-enables the control', async () => {
    const { messages } = platform();
    const { bindShotgunItemSheetControl } = await load('ShotgunItemConfig.js');
    const item = makeItem({ setFlag: async () => { throw new Error('Simulated denied update'); } });
    const { form } = propertiesForm(); bindShotgunItemSheetControl({ item }, form);
    const checkbox = form.querySelector('[data-swade-tools-shotgun-enabled]');
    const originalError = console.error; console.error = () => {};
    try { checkbox.checked = true; await checkbox.emit('change'); }
    finally { console.error = originalError; }
    assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
    assert.match(messages[0][1], /could not be saved/);
});

test('Shotgun and AoE Properties settings coexist without changing each other or inventory UI', async () => {
    platform();
    const { bindShotgunItemSheetControl } = await load('ShotgunItemConfig.js');
    const { bindAoeItemSheetControl } = await load('AoeItemConfig.js');
    const item = makeItem(), { form, properties } = propertiesForm(), sheet = { item };
    bindAoeItemSheetControl(sheet, form); bindShotgunItemSheetControl(sheet, form);
    bindAoeItemSheetControl(sheet, form); bindShotgunItemSheetControl(sheet, form);
    assert.equal(properties.querySelectorAll('[data-swade-tools-aoe-item-option]').length, 1);
    assert.equal(properties.querySelectorAll('[data-swade-tools-shotgun-item-option]').length, 1);
    assert.equal(properties.querySelector('[data-swade-tools-aoe-controls]'), null);
    assert.equal(item.updates.length, 0);
});

test('Shotgun hooks register once for item sheets and V2, never add actor inventory hooks', async () => {
    const { hooks } = platform();
    const { registerShotgunItemControls } = await load('ShotgunItemConfig.js');
    registerShotgunItemControls(); registerShotgunItemControls();
    assert.equal(hooks.get('renderItemSheet').length, 1);
    assert.equal(hooks.get('renderApplicationV2').length, 1);
    assert.equal(hooks.has('renderActorSheet'), false);
    const { form } = propertiesForm(), item = makeItem();
    hooks.get('renderApplicationV2')[0]({ document: item }, form);
    assert.ok(form.querySelector('[data-swade-tools-shotgun-enabled]'));
    const actorForm = new Element('form');
    hooks.get('renderApplicationV2')[0]({ document: { documentName: 'Actor' } }, actorForm);
    assert.equal(actorForm.children.length, 0);
});
