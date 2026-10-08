const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const services = path.resolve(__dirname, '../scripts/services');
const load = name => import(pathToFileURL(path.join(services, name)).href);

// A small DOM fixture exercises actual module UI code without connecting to
// the user's Foundry session or depending on a browser installation.
class Element {
    constructor(tag) {
        this.nodeType = 1;
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
        this.attributes = {}; this.style = {}; this.listeners = new Map();
        this.className = ''; this.parentElement = null; this.textContent = '';
    }
    append(...children) {
        for (const child of children) {
            child.parentElement = this; this.children.push(child);
        }
    }
    prepend(...children) {
        for (const child of children) child.parentElement = this;
        this.children.unshift(...children);
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, fn) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(fn); this.listeners.set(type, listeners);
    }
    async emit(type, properties = {}) {
        await Promise.all((this.listeners.get(type) ?? []).map(fn => fn({
            currentTarget: this, preventDefault() {}, stopPropagation() {}, ...properties
        })));
    }
    matches(selector) {
        return selector.split(',').some(part => {
            const simple = part.trim();
            const tag = simple.match(/^[a-z]+/i)?.[0];
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            for (const match of simple.matchAll(/\.([\w-]+)/g)) {
                if (!this.className.split(/\s+/).includes(match[1])) return false;
            }
            for (const match of simple.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
                const key = match[1];
                const value = key.startsWith('data-')
                    ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
                    : this.attributes[key];
                if (value === undefined || (match[2] !== undefined && match[2] !== value)) return false;
            }
            return true;
        });
    }
    closest(selector) {
        if (this.matches(selector)) return this;
        return this.parentElement?.closest(selector) ?? null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(child.matches?.(selector) ? [child] : []),
            ...(child.querySelectorAll?.(selector) ?? [])
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const collection = items => Object.assign(items, {
    get(id) { return this.find(item => item.id === id); },
    getName(name) { return this.find(item => item.name === name); }
});
const makeActor = (id, type = 'character') => ({
    id, uuid: `Actor.${id}`, name: id, type, isOwner: true,
    documentName: 'Actor', system: {}, items: collection([]),
    getActiveTokens() { return this.activeTokens ?? []; }
});
const makeItem = (owner, extra = {}) => {
    const item = {
        id: 'weapon', uuid: `Actor.${owner.id}.Item.weapon`, name: 'Tank HE',
        type: 'weapon', actor: owner, parent: owner, documentName: 'Item',
        isOwner: true, flags: {}, system: { actions: { trait: 'Gunnery', additional: {
            he: { type: 'damage', name: 'HE Round' }, smoke: { type: 'skill', name: 'Smoke' }
        } }, templates: { large: true } }, updates: [],
        getFlag(scope, key) { return this.flags[scope]?.[key]; },
        async setFlag(scope, key, value) {
            (this.flags[scope] ??= {})[key] = value;
            this.updates.push({ scope, key, value }); return this;
        },
        async update(changes) {
            for (const [key, value] of Object.entries(changes)) {
                if (key.startsWith('flags.swade-tools.')) {
                    (this.flags['swade-tools'] ??= {})[key.slice('flags.swade-tools.'.length)] = value;
                }
            }
            this.updates.push(changes); return this;
        }, ...extra
    };
    owner.items.push(item); return item;
};
const makeRow = (root, item) => {
    const row = new Element('li'); row.className = 'item weapon'; row.dataset.itemId = item.id;
    const controls = new Element('div'); controls.className = 'item-controls';
    row.append(controls); root.append(row); return row;
};
const escape = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function platform() {
    const hooks = new Map(), messages = [];
    global.document = {
        createElement: tag => new Element(tag),
        createTextNode: value => ({ textContent: value })
    };
    global.Hooks = { on(name, callback) {
        const entries = hooks.get(name) ?? []; entries.push(callback); hooks.set(name, entries);
    } };
    global.ui = { notifications: {
        warn: value => messages.push(['warn', value]),
        info: value => messages.push(['info', value]),
        error: value => messages.push(['error', value])
    } };
    global.canvas = { tokens: { controlled: [] } };
    global.game = { modules: new Map([['swade-tools', { version: 'test' }]]), actors: new Map() };
    global.foundry = { utils: {
        escapeHTML: escape, getRoute: route => route,
        AsyncFunction: Object.getPrototypeOf(async function() {}).constructor
    }, applications: { api: { DialogV2: {} } } };
    global.fromUuid = async uuid => game.actors.get(uuid.split('.')[1]) ?? null;
    return { hooks, messages };
}

test('AoE requires opt-in for HE weapons, supports legacy grenades, and honors explicit opt-out', async () => {
    const { isAoeItem, canEnableAoe, setAoeEnabled } = await load('AoeItemFlags.js');
    const owner = makeActor('owner'); const item = makeItem(owner);
    assert.equal(isAoeItem(item), false);
    await setAoeEnabled(item, true); assert.equal(isAoeItem(item), true);
    item.name = 'Throw Grenade'; await setAoeEnabled(item, false);
    assert.equal(isAoeItem(item), false);
    delete item.flags['swade-tools'].aoeEnabled;
    assert.equal(isAoeItem(item), true);
    assert.equal(canEnableAoe({ type: 'power' }), false);
    assert.equal(canEnableAoe({ type: 'skill' }), false);
    item.isOwner = false;
    await assert.rejects(setAoeEnabled(item, true), /own/);
});

test('saved AoE settings default from item and update flags without changing its native Trait', async () => {
    const { getAoeItemSettings, saveAoeItemSettings } = await load('AoeItemFlags.js');
    const item = makeItem(makeActor('owner'));
    assert.deepEqual(getAoeItemSettings(item), {
        skill: 'Gunnery', blastSize: 'large', consume: true, damageAction: '', ammoCost: 1
    });
    await saveAoeItemSettings(item, {
        skill: ' Siege Weapons ', blastSize: 'small', consume: false, damageAction: 'he', ammoCost: 2
    });
    assert.equal(item.system.actions.trait, 'Gunnery');
    assert.deepEqual(getAoeItemSettings(item), {
        skill: 'Siege Weapons', blastSize: 'small', consume: false, damageAction: 'he', ammoCost: 2
    });
    const savedUpdates = item.updates.length;
    await assert.rejects(saveAoeItemSettings(item, { blastSize: 'cone' }), /blast/);
    await assert.rejects(saveAoeItemSettings(item, { blastSize: 'medium', damageAction: 'smoke' }), /damage action/);
    await assert.rejects(saveAoeItemSettings(item, { blastSize: 'medium', ammoCost: 0 }), /positive/);
    assert.equal(item.updates.length, savedUpdates);
});

test('launcher uses vehicle token and inventory owner but assigned gunner for trait rolls', async () => {
    platform();
    const { resolveAoeLaunchScope, findAoeActorToken } = await load('AoeMacroLauncher.js');
    const tank = makeActor('tank', 'vehicle'), gunner = makeActor('gunner');
    const item = makeItem(tank); const token = { actor: tank, id: 'tank-token' };
    tank.activeTokens = [token];
    tank.system.getCrewMemberForWeapon = weapon => weapon === item ? gunner : null;
    const scope = await resolveAoeLaunchScope(tank, item);
    assert.equal(scope.actor, gunner); assert.equal(scope.operatorActor, gunner);
    assert.equal(scope.weaponActor, tank); assert.equal(scope.vehicleActor, tank);
    assert.equal(scope.token, token); assert.equal(findAoeActorToken(tank), token);
    assert.equal(scope.promptAoeSetup, false);
    assert.equal((await resolveAoeLaunchScope(tank, item, { promptAoeSetup: true })).promptAoeSetup, true);
    assert.equal(typeof scope.aoeServices.resolveAoeSkill, 'function');
    assert.equal(typeof scope.aoeServices.aoeResource.spend, 'function');
    delete tank.system.getCrewMemberForWeapon;
    tank.system.operator = gunner;
    assert.equal((await resolveAoeLaunchScope(tank, item)).actor, gunner);
    delete tank.system.operator;
    tank.system.driver = { id: gunner.uuid }; game.actors.set(gunner.id, gunner);
    assert.equal((await resolveAoeLaunchScope(tank, item)).actor, gunner);
    delete tank.system.driver;
    const unassigned = await resolveAoeLaunchScope(tank, item);
    assert.equal(unassigned.actor, tank); assert.equal(unassigned.operatorActor, null);
    const clone = { ...tank, uuid: 'Scene.scene.Token.other.Actor.tank' };
    canvas.tokens.controlled = [{ actor: clone, id: 'other-tank-token' }];
    assert.equal(findAoeActorToken(tank), token);
});

test('normal inventory checkbox persists and reveals one explosion action without duplicate handlers', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner);
    const root = new Element('form'), row = makeRow(root, item), sheet = { actor: owner, isEditable: true };
    bindAoeInventoryControls(sheet, { jquery: 'test', 0: root });
    bindAoeInventoryControls(sheet, root);
    assert.equal(row.querySelectorAll('[data-swade-tools-aoe-controls]').length, 1);
    const input = row.querySelector('[data-swade-tools-aoe-enabled]');
    const attack = row.querySelector('[data-swade-tools-aoe]');
    assert.equal(input.checked, false); assert.equal(attack.hidden, true);
    assert.equal(attack.querySelector('i').className, 'fa-solid fa-explosion');
    assert.equal(row.querySelector('[data-swade-tools-aoe-settings]').title, 'AoE Settings');
    input.checked = true; await input.emit('change');
    assert.equal(item.getFlag('swade-tools', 'aoeEnabled'), true);
    assert.equal(attack.hidden, false); assert.equal(item.updates.length, 1);
    input.checked = false; await input.emit('change');
    assert.equal(attack.hidden, true); assert.equal(item.updates.length, 2);
    item.isOwner = false; bindAoeInventoryControls(sheet, root);
    assert.equal(input.disabled, true); assert.equal(attack.disabled, true);
});

test('V13 item sheet gets English opt-in plus settings control and saves all config fields', async () => {
    const { messages } = platform();
    const { bindAoeItemSheetControl, showAoeItemSettings } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner);
    owner.items.push({ id: 'gunnery', name: 'Gunnery', type: 'skill' });
    const root = new Element('form'), tab = new Element('section');
    tab.className = 'tab'; tab.dataset.tab = 'properties'; root.append(tab);
    const sheet = { document: item, isEditable: true };
    bindAoeItemSheetControl(sheet, root); bindAoeItemSheetControl(sheet, root);
    assert.equal(tab.querySelectorAll('[data-swade-tools-aoe-item-option]').length, 1);
    assert.equal(tab.querySelector('label').textContent, 'Enable AoE');
    assert.ok(tab.querySelector('[data-swade-tools-aoe-settings]'));
    let captured;
    foundry.applications.api.DialogV2.prompt = async options => {
        captured = options;
        return options.ok.callback(null, { form: { elements: {
            aoeSkill: { value: 'Custom Gunnery' }, aoeBlastSize: { value: 'large' },
            aoeDamageAction: { value: 'he' }, aoeConsume: { checked: false }, aoeAmmoCost: { valueAsNumber: 1 }
        } } });
    };
    await showAoeItemSettings(owner, item);
    assert.match(captured.window.title, /AoE Settings/);
    assert.match(captured.content, /<option value="Gunnery">/);
    assert.match(captured.content, /HE Round/);
    assert.doesNotMatch(captured.content, /<option value="smoke"/);
    assert.equal(captured.ok.label, 'Save Settings');
    assert.equal(item.getFlag('swade-tools', 'aoeSkill'), 'Custom Gunnery');
    assert.equal(item.getFlag('swade-tools', 'aoeConsume'), false);
    assert.equal(item.system.actions.trait, 'Gunnery');
    assert.equal(item.updates.length, 1); assert.deepEqual(messages, [['info', 'AoE settings saved.']]);
    foundry.applications.api.DialogV2.prompt = async () => null;
    await showAoeItemSettings(owner, item); assert.equal(item.updates.length, 1);
});

test('explosion button executes bundled AoE script with injected services and no native item click', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner, { flags: { 'swade-tools': { aoeEnabled: true } } });
    owner.activeTokens = [{ actor: owner, id: 'owner-token' }];
    let fetches = 0;
    global.fetch = async (url, options) => {
        fetches++; assert.match(url, /grenade-attack\.js\?v=test/);
        assert.equal(options.cache, 'no-store');
        return { ok: true, text: async () => '// SWADE AoE Attack\nglobalThis.__aoeLaunchTest = scope;' };
    };
    const root = new Element('form'), row = makeRow(root, item);
    bindAoeInventoryControls({ actor: owner, isEditable: true }, root);
    await row.querySelector('[data-swade-tools-aoe]').emit('click');
    assert.equal(fetches, 1); assert.equal(global.__aoeLaunchTest.item, item);
    assert.equal(global.__aoeLaunchTest.actor, owner);
    assert.equal(global.__aoeLaunchTest.token.id, 'owner-token');
    assert.equal(global.__aoeLaunchTest.weaponActor, owner);
    assert.equal(global.__aoeLaunchTest.promptAoeSetup, false);
    await row.querySelector('[data-swade-tools-aoe]').emit('click', { shiftKey: true });
    assert.equal(global.__aoeLaunchTest.promptAoeSetup, true);
    assert.match(row.querySelector('[data-swade-tools-aoe]').title, /Shift-click/);
    delete global.__aoeLaunchTest;
});

test('per-item launch guard blocks duplicate attacks across a rerender and releases after completion', async () => {
    platform();
    const launcherUrl = pathToFileURL(path.join(services, 'AoeMacroLauncher.js')).href;
    const { launchAoeMacro } = await import(`${launcherUrl}?pending-guard-test`);
    const owner = makeActor('owner'), item = makeItem(owner, { flags: { 'swade-tools': { aoeEnabled: true } } });
    owner.activeTokens = [{ actor: owner, id: 'owner-token' }];
    let release, fetched, fetches = 0;
    global.__aoePendingGate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { fetched = resolve; });
    global.__aoePendingCount = 0;
    global.fetch = async () => {
        fetches++; fetched();
        return { ok: true, text: async () => '// SWADE AoE Attack\nawait globalThis.__aoePendingGate; globalThis.__aoePendingCount++;' };
    };
    const first = launchAoeMacro(owner, item);
    await started;
    assert.equal(await launchAoeMacro(owner, { ...item }), false);
    assert.equal(fetches, 1); assert.equal(global.__aoePendingCount, 0);
    release(); assert.equal(await first, true);
    assert.equal(global.__aoePendingCount, 1);
    assert.equal(await launchAoeMacro(owner, item), true);
    assert.equal(global.__aoePendingCount, 2); assert.equal(fetches, 1);
    delete global.__aoePendingGate; delete global.__aoePendingCount;
});

test('AoE hooks register once for legacy sheets and ApplicationV2', async () => {
    const { hooks } = platform();
    const { registerAoeItemControls } = await load('AoeItemConfig.js');
    registerAoeItemControls(); registerAoeItemControls();
    for (const name of ['renderActorSheet', 'renderItemSheet', 'renderApplicationV2']) {
        assert.equal(hooks.get(name)?.length, 1);
    }
    const owner = makeActor('owner'), item = makeItem(owner);
    const root = new Element('form'), row = makeRow(root, item);
    hooks.get('renderApplicationV2')[0]({ document: owner }, root);
    assert.ok(row.querySelector('[data-swade-tools-aoe-controls]'));
});

test('indexed native V13 form remains actor sheet root, not its first input', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner);
    const form = new Element('form'), firstInput = new Element('input');
    // Native HTMLFormElement[0] resolves its first named form control.
    form[0] = firstInput; form.append(firstInput);
    const row = makeRow(form, item);
    bindAoeInventoryControls({ document: owner, isEditable: true }, form);
    assert.ok(row.querySelector('[data-swade-tools-aoe-controls]'));
    assert.equal(firstInput.querySelector('[data-swade-tools-aoe-controls]'), null);
});

test('indexed native V13 item form places AoE settings in properties tab', async () => {
    platform();
    const { bindAoeItemSheetControl } = await load('AoeItemConfig.js');
    const item = makeItem(makeActor('owner'));
    const form = new Element('form'), firstInput = new Element('input');
    form[0] = firstInput; form.append(firstInput);
    const tab = new Element('section'); tab.className = 'tab'; tab.dataset.tab = 'properties';
    form.append(tab);
    bindAoeItemSheetControl({ document: item, isEditable: true }, form);
    assert.ok(tab.querySelector('[data-swade-tools-aoe-item-option]'));
    assert.ok(tab.querySelector('[data-swade-tools-aoe-settings]'));
    assert.equal(firstInput.querySelector('[data-swade-tools-aoe-item-option]'), null);
});
