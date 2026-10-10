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
    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, fn, options = false) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push({ fn, capture: options === true || options?.capture === true });
        this.listeners.set(type, listeners);
    }
    async emit(type, properties = {}) {
        const event = {
            target: this, currentTarget: this, defaultPrevented: false,
            propagationStopped: false, immediatePropagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            stopImmediatePropagation() {
                this.immediatePropagationStopped = true; this.propagationStopped = true;
            },
            ...properties
        };
        const path = [];
        for (let element = this; element; element = element.parentElement) path.push(element);
        const invoke = async (element, capture) => {
            event.currentTarget = element;
            for (const handler of element.listeners?.get(type) ?? []) {
                if (handler.capture !== capture) continue;
                await handler.fn(event);
                if (event.immediatePropagationStopped) break;
            }
        };
        for (const element of [...path].reverse()) {
            await invoke(element, true);
            if (event.propagationStopped) return event;
        }
        for (const element of path) {
            await invoke(element, false);
            if (event.propagationStopped) break;
        }
        return event;
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
    assert.equal(canEnableAoe({ type: 'power' }), true);
    assert.equal(canEnableAoe({ type: 'skill' }), false);
    item.isOwner = false;
    await assert.rejects(setAoeEnabled(item, true), /own/);
});

test('powers require explicit AoE opt-in and never inherit grenade resource behavior', async () => {
    const { isAoeItem, isPowerAoeItem, setAoeEnabled, getAoeConsumptionMode } = await load('AoeItemFlags.js');
    const item = makeItem(makeActor('caster'), {
        type: 'power', name: 'Grenade Burst',
        system: { actions: { trait: 'Aetherics' }, templates: { cone: true }, quantity: 4, pp: 2 },
        flags: { 'swade-tools': { aoeConsumeMode: 'item', aoeConsume: true, aoeAmmoCost: 3 } }
    });
    assert.equal(isAoeItem(item), false);
    assert.equal(isPowerAoeItem(item), false);
    assert.equal(getAoeConsumptionMode(item), 'none');
    await setAoeEnabled(item, true);
    assert.equal(isAoeItem(item), true);
    assert.equal(isPowerAoeItem(item), true);
    assert.equal(isPowerAoeItem(makeItem(makeActor('rifle'), {
        flags: { 'swade-tools': { aoeEnabled: true } }
    })), false);
    await setAoeEnabled(item, false);
    assert.equal(isPowerAoeItem(item), false);
    assert.equal(item.system.quantity, 4);
    assert.equal(item.system.pp, 2);
});

test('Power AoE shapes use native templates by default and save only validated shape flags', async () => {
    const { getPowerAoeSettings, savePowerAoeSettings, saveAoeItemSettings, POWER_AOE_SHAPES } = await load('AoeItemFlags.js');
    const item = makeItem(makeActor('caster'), {
        type: 'power', name: 'Burst', system: { actions: { trait: 'Aetherics' }, templates: { cone: true }, pp: 2 }
    });
    assert.deepEqual(getPowerAoeSettings(item), { shape: 'cone' });
    for (const shape of POWER_AOE_SHAPES) {
        assert.deepEqual(await savePowerAoeSettings(item, { shape, consumeMode: 'ammo', skill: 'Shooting' }), { shape });
        assert.deepEqual(getPowerAoeSettings(item), { shape });
        assert.deepEqual(item.updates.at(-1), { 'flags.swade-tools.aoePowerShape': shape });
    }
    assert.equal(item.system.actions.trait, 'Aetherics');
    assert.equal(item.system.pp, 2);
    const changes = item.updates.length;
    await assert.rejects(savePowerAoeSettings(item, { shape: 'ray' }), /valid power template/);
    await assert.rejects(saveAoeItemSettings(item, { blastSize: 'small' }), /Power AoE Settings/);
    item.isOwner = false;
    await assert.rejects(savePowerAoeSettings(item, { shape: 'small' }), /own/);
    assert.equal(item.updates.length, changes);
    item.flags['swade-tools'].aoePowerShape = 'invalid-imported-shape';
    assert.deepEqual(getPowerAoeSettings(item), { shape: 'cone' });
    item.system.templates = {};
    assert.deepEqual(getPowerAoeSettings(item), { shape: 'medium' });
    item.system.templates = { scone: true };
    assert.deepEqual(getPowerAoeSettings(item), { shape: 'scone' });
    item.system.templates = { stream: true };
    assert.deepEqual(getPowerAoeSettings(item), { shape: 'stream' });
    await assert.rejects(savePowerAoeSettings(makeItem(makeActor('weapon')), { shape: 'small' }), /eligible AoE power/);
});

test('saved AoE settings default from item and update flags without changing its native Trait', async () => {
    const { getAoeItemSettings, saveAoeItemSettings } = await load('AoeItemFlags.js');
    const item = makeItem(makeActor('owner'));
    assert.deepEqual(getAoeItemSettings(item), {
        skill: 'Gunnery', blastSize: 'large', consume: true, consumeMode: 'ammo', damageAction: '', ammoCost: 1
    });
    await saveAoeItemSettings(item, {
        skill: ' Siege Weapons ', blastSize: 'small', consume: false, damageAction: 'he', ammoCost: 2
    });
    assert.equal(item.system.actions.trait, 'Gunnery');
    assert.deepEqual(getAoeItemSettings(item), {
        skill: 'Gunnery', blastSize: 'small', consume: false, consumeMode: 'none', damageAction: 'he', ammoCost: 2
    });
    assert.ok(!item.updates.some(change => Object.hasOwn(change,'flags.swade-tools.aoeSkill')));
    item.flags['swade-tools'].aoeSkill='Old Shooting Override';
    assert.equal(getAoeItemSettings(item).skill,'Gunnery');
    item.system.actions.trait=' Siege Weapons ';
    assert.equal(getAoeItemSettings(item).skill,'Siege Weapons');
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

test('inventory shows only one explosion shortcut for enabled items and no row options', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner);
    const root = new Element('form'), row = makeRow(root, item), sheet = { actor: owner, isEditable: true };
    bindAoeInventoryControls(sheet, { jquery: 'test', 0: root });
    bindAoeInventoryControls(sheet, root);
    assert.equal(row.querySelector('[data-swade-tools-aoe-controls]'), null);
    await item.setFlag('swade-tools', 'aoeEnabled', true);
    bindAoeInventoryControls(sheet, root); bindAoeInventoryControls(sheet, root);
    assert.equal(row.querySelectorAll('[data-swade-tools-aoe-controls]').length, 1);
    assert.equal(row.querySelector('[data-swade-tools-aoe-enabled]'), null);
    assert.equal(row.querySelector('[data-swade-tools-aoe-settings]'), null);
    const attack = row.querySelector('[data-swade-tools-aoe]');
    assert.equal(attack.querySelector('i').className, 'fa-solid fa-explosion');
    item.isOwner = false; bindAoeInventoryControls(sheet, root);
    assert.equal(attack.disabled, true);
    item.isOwner = true; await item.setFlag('swade-tools', 'aoeEnabled', false);
    bindAoeInventoryControls(sheet, root);
    assert.equal(row.querySelector('[data-swade-tools-aoe-controls]'), null);
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
    let captured, callbackResult;
    foundry.applications.api.DialogV2.prompt = async options => {
        captured = options;
        callbackResult = options.ok.callback(null, { form: { elements: {
            aoeBlastSize: { value: 'large' },
            aoeDamageAction: { value: 'he' }, aoeConsumeAmmo: { checked: false },
            aoeConsumeItem: { checked: false }, aoeAmmoCost: { valueAsNumber: 1 }
        } } });
        return callbackResult;
    };
    await showAoeItemSettings(owner, item);
    assert.match(captured.window.title, /AoE Settings/);
    assert.match(captured.content, /native Trait: Gunnery/);
    assert.doesNotMatch(captured.content, /name="aoeSkill"|<datalist|Attack Skill/);
    assert.equal(Object.hasOwn(callbackResult, 'skill'), false);
    assert.equal(callbackResult.consumeMode, 'none');
    assert.match(captured.content, /Uses per Attack/);
    assert.match(captured.content, /name="aoeConsumeAmmo"/);
    assert.match(captured.content, /name="aoeConsumeItem"/);
    assert.doesNotMatch(captured.content, /name="aoeConsume"/);
    assert.match(captured.content, /HE Round/);
    assert.doesNotMatch(captured.content, /<option value="smoke"/);
    assert.equal(captured.ok.label, 'Save Settings');
    assert.equal(item.getFlag('swade-tools', 'aoeConsume'), false);
    assert.equal(item.system.actions.trait, 'Gunnery');
    assert.equal(item.updates.length, 1); assert.deepEqual(messages, [['info', 'AoE settings saved.']]);
    foundry.applications.api.DialogV2.prompt = async () => null;
    await showAoeItemSettings(owner, item); assert.equal(item.updates.length, 1);
});

test('Power AoE Properties controls open compact shape settings without ammo or casting overrides', async () => {
    const { messages } = platform();
    const { bindAoeItemSheetControl, showAoeItemSettings } = await load('AoeItemConfig.js');
    const owner = makeActor('caster');
    const item = makeItem(owner, {
        type: 'power', name: 'Burst',
        system: { actions: { trait: 'Aetherics' }, templates: { cone: true }, pp: 2 }
    });
    const root = new Element('form'), tab = new Element('section');
    tab.className = 'tab'; tab.dataset.tab = 'properties'; root.append(tab);
    bindAoeItemSheetControl({ document: item, isEditable: true }, root);
    assert.equal(tab.querySelector('label').textContent, 'Enable AoE');
    assert.ok(tab.querySelector('[data-swade-tools-aoe-settings]'));
    let captured;
    foundry.applications.api.DialogV2.prompt = async options => {
        captured = options;
        return options.ok.callback(null, { form: { elements: { aoePowerShape: { value: 'scone' } } } });
    };
    await showAoeItemSettings(owner, item);
    assert.equal(captured.window.title, 'Burst - Power AoE Settings');
    assert.equal(captured.position.width, 420);
    assert.match(captured.content, /<option value="cone" selected>/);
    assert.match(captured.content, /Small Cone Template/);
    assert.match(captured.content, /Stream Template/);
    assert.doesNotMatch(captured.content, /aoeConsume|aoeAmmoCost|Consume Ammunition|Consume Item|Attack Skill|name="aoeSkill"/);
    assert.deepEqual(item.updates, [{ 'flags.swade-tools.aoePowerShape': 'scone' }]);
    assert.equal(item.system.actions.trait, 'Aetherics');
    assert.equal(item.system.pp, 2);
    assert.deepEqual(messages, [['info', 'Power AoE settings saved.']]);
    foundry.applications.api.DialogV2.prompt = async () => null;
    await showAoeItemSettings(owner, item);
    assert.equal(item.updates.length, 1);
    item.isOwner = false;
    foundry.applications.api.DialogV2.prompt = async () => { throw Error('Unowned Power must not open settings'); };
    await showAoeItemSettings(owner, item);
    assert.equal(item.updates.length, 1);
});

test('AoE Settings consumption checkboxes are mutually exclusive and both off saves None', async () => {
    platform();
    const { showAoeItemSettings } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), weapon = makeItem(owner);
    let dialogOptions;
    foundry.applications.api.DialogV2.prompt = async options => { dialogOptions = options; return null; };
    await showAoeItemSettings(owner, weapon);
    const form = new Element('form');
    const ammo = new Element('input'), item = new Element('input');
    ammo.setAttribute('name', 'aoeConsumeAmmo'); item.setAttribute('name', 'aoeConsumeItem');
    form.append(ammo, item); form[0] = ammo;
    dialogOptions.render(null, { element: form }); dialogOptions.render(null, { element: form });
    assert.equal(ammo.listeners.get('change').length, 1);
    assert.equal(item.listeners.get('change').length, 1);
    const settingsFor = () => dialogOptions.ok.callback(null, { form: { elements: {
        aoeBlastSize: { value: 'large' }, aoeDamageAction: { value: '' },
        aoeConsumeAmmo: ammo, aoeConsumeItem: item, aoeAmmoCost: { valueAsNumber: 2 }
    } } });
    item.checked = true; ammo.checked = true; await ammo.emit('change');
    assert.equal(item.checked, false); assert.equal(settingsFor().consumeMode, 'ammo');
    item.checked = true; await item.emit('change');
    assert.equal(ammo.checked, false); assert.equal(settingsFor().consumeMode, 'item');
    item.checked = false; await item.emit('change');
    assert.equal(settingsFor().consumeMode, 'none');
    assert.equal(settingsFor().ammoCost, 2);
    assert.equal(weapon.updates.length, 0);
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
    assert.equal(global.__aoeLaunchTest.promptAoeSetup, true);
    await row.querySelector('[data-swade-tools-aoe]').emit('click');
    assert.equal(global.__aoeLaunchTest.promptAoeSetup, true);
    assert.equal(row.querySelector('[data-swade-tools-aoe]').title, 'Open AoE Attack');
    assert.equal(row.querySelector('[data-swade-tools-aoe-enabled]'), null);
    assert.equal(row.querySelector('[data-swade-tools-aoe-settings]'), null);
    delete global.__aoeLaunchTest;
});

test('experimental AoE name, image and explosion clicks use one unified panel with Shift and sheet-token context',async()=>{
    platform();
    const {bindAoeInventoryControls}=await load('AoeItemConfig.js');
    const owner=makeActor('owner'),item=makeItem(owner,{flags:{'swade-tools':{aoeEnabled:true}}});
    item.system.range='12/24/48';
    const token={actor:owner,id:'sheet-source',document:{uuid:'Scene.scene.Token.sheet-source'}};
    const form=new Element('form'),row=makeRow(form,item);
    const name=new Element('a');name.className='item-name';
    const image=new Element('img');row.append(name,image);
    const calls=[];
    game.settings={get:()=>true};
    game.swadetools={item:async(...args)=>calls.push(args)};
    global.fetch=async()=>{throw Error('Unified inventory clicks must not load the old AoE panel');};
    bindAoeInventoryControls({actor:owner,isEditable:true,token},form);
    await name.emit('click',{shiftKey:true});
    await image.emit('click',{shiftKey:false});
    await row.querySelector('[data-swade-tools-aoe]').emit('click',{shiftKey:true});
    assert.equal(calls.length,3);
    for (const call of calls){assert.equal(call[0],owner);assert.equal(call[1],item.id);assert.equal(call[3].token,token);}
    assert.equal(calls[0][3].restoreLast,true);assert.equal(calls[1][3].restoreLast,false);assert.equal(calls[2][3].restoreLast,true);
});

test('AoE power name, image and explosion always use native casting panel without Experimental Unified RoF', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('caster');
    const item = makeItem(owner, {
        type: 'power', name: 'Burst',
        flags: { 'swade-tools': { aoeEnabled: true } },
        system: { actions: { trait: 'Aetherics' }, templates: { cone: true }, range: '8', pp: 2 }
    });
    const token = { actor: owner, id: 'caster-token', document: { uuid: 'Scene.scene.Token.caster-token' } };
    const root = new Element('form'), row = makeRow(root, item);
    const name = new Element('a'); name.className = 'item-name';
    const image = new Element('img'); row.append(name, image);
    const calls = [];
    game.settings = { get: () => false };
    game.swadetools = { item: async (...args) => calls.push(args) };
    global.fetch = async () => { throw Error('Power must never load weapon AoE engine'); };
    bindAoeInventoryControls({ actor: owner, isEditable: true, token }, root);
    await name.emit('click', { shiftKey: true });
    await image.emit('click');
    const explosion = row.querySelector('[data-swade-tools-aoe]');
    assert.equal(explosion.title, 'Open AoE Power');
    await explosion.emit('click');
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.equal(call[0], owner); assert.equal(call[1], item.id); assert.equal(call[2], null);
        assert.equal(call[3].token, token);
    }
    assert.equal(calls[0][3].restoreLast, true);
    assert.equal(calls[1][3].restoreLast, false);
    assert.equal(calls[2][3].restoreLast, false);
    assert.equal(item.updates.length, 0);
});

test('unavailable native Power panel and direct grenade API fail safely instead of consuming ammo', async () => {
    const { messages } = platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const { launchAoeMacro, resolveAoeLaunchScope, prepareAoePoolPoints } = await load('AoeMacroLauncher.js');
    const owner = makeActor('caster'), item = makeItem(owner, {
        type: 'power', flags: { 'swade-tools': { aoeEnabled: true } }
    });
    const root = new Element('form'), row = makeRow(root, item);
    global.fetch = async () => { throw Error('Power must never load weapon AoE engine'); };
    bindAoeInventoryControls({ actor: owner, isEditable: true }, root);
    const explosion = row.querySelector('[data-swade-tools-aoe]');
    await explosion.emit('click');
    assert.equal(explosion.disabled, false);
    assert.match(messages[0][1], /native power panel is not available/);
    assert.equal(await launchAoeMacro(owner, item), false);
    assert.match(messages[1][1], /native power casting panel/);
    await assert.rejects(resolveAoeLaunchScope(owner, item), /native power casting panel/);
    assert.deepEqual(await prepareAoePoolPoints({ actor: owner, item, candidates: [{}] }), []);
    assert.equal(item.updates.length, 0);
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
    const owner = makeActor('owner'), item = makeItem(owner, { flags: { 'swade-tools': { aoeEnabled: true } } });
    const root = new Element('form'), row = makeRow(root, item);
    hooks.get('renderApplicationV2')[0]({ document: owner }, root);
    assert.ok(row.querySelector('[data-swade-tools-aoe-controls]'));
});

test('indexed native V13 form remains actor sheet root, not its first input', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner, { flags: { 'swade-tools': { aoeEnabled: true } } });
    const form = new Element('form'), firstInput = new Element('input');
    // Native HTMLFormElement[0] resolves its first named form control.
    form[0] = firstInput; form.append(firstInput);
    const row = makeRow(form, item);
    bindAoeInventoryControls({ document: owner, isEditable: true }, form);
    assert.ok(row.querySelector('[data-swade-tools-aoe-controls]'));
    assert.equal(firstInput.querySelector('[data-swade-tools-aoe-controls]'), null);
});

test('Properties Enable AoE checkbox still persists and controls the inventory shortcut', async () => {
    platform();
    const { bindAoeItemSheetControl, bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const owner = makeActor('owner'), item = makeItem(owner);
    const properties = new Element('form'), inventory = new Element('form');
    const row = makeRow(inventory, item), actorSheet = { actor: owner, isEditable: true };
    const itemSheet = { document: item, isEditable: true };
    bindAoeItemSheetControl(itemSheet, properties);
    const checkbox = properties.querySelector('[data-swade-tools-aoe-enabled]');
    assert.equal(checkbox.checked, false);
    assert.ok(properties.querySelector('[data-swade-tools-aoe-settings]'));
    checkbox.checked = true; await checkbox.emit('change');
    assert.equal(item.getFlag('swade-tools', 'aoeEnabled'), true);
    bindAoeInventoryControls(actorSheet, inventory);
    assert.ok(row.querySelector('[data-swade-tools-aoe]'));
    checkbox.checked = false; await checkbox.emit('change');
    assert.equal(item.getFlag('swade-tools', 'aoeEnabled'), false);
    bindAoeInventoryControls(actorSheet, inventory);
    assert.equal(row.querySelector('[data-swade-tools-aoe-controls]'), null);
    item.isOwner = false; bindAoeItemSheetControl(itemSheet, properties);
    assert.equal(checkbox.disabled, true);
    assert.equal(properties.querySelector('[data-swade-tools-aoe-settings]').disabled, true);
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

test('native V2 weapon name/image capture opens one AoE panel, preserves edits and falls through when disabled', async () => {
    platform();
    const { bindAoeInventoryControls } = await load('AoeItemConfig.js');
    const tank = makeActor('tank', 'vehicle'), gunner = makeActor('gunner');
    const item = makeItem(tank, { flags: { 'swade-tools': { aoeEnabled: true } } });
    tank.activeTokens = [{ actor: tank, id: 'tank-token' }];
    let operatorLookups = 0, nativeNameClicks = 0, editClicks = 0;
    tank.system.getCrewMemberForWeapon = () => { operatorLookups++; return gunner; };
    const form = new Element('form'), row = new Element('li');
    row.className = 'flexrow'; row.dataset.itemId = item.id;
    const image = new Element('img');
    const name = new Element('a'); name.className = 'name'; name.dataset.action = 'showItem';
    const controls = new Element('span'); controls.className = 'controls';
    const edit = new Element('a'); edit.className = 'item-edit'; edit.dataset.action = 'editItem';
    controls.append(edit); row.append(image, name, controls); form.append(row);
    // Model native V2 showItem handling on the form and a legacy item-name
    // bubble callback. The capture handler must suppress both for enabled AoE.
    form.addEventListener('click', event => {
        if (event.target.closest('[data-action="showItem"]')) nativeNameClicks++;
    });
    name.addEventListener('click', () => nativeNameClicks++);
    edit.addEventListener('click', () => editClicks++);
    const sheet = { document: tank, isEditable: true };
    bindAoeInventoryControls(sheet, form); bindAoeInventoryControls(sheet, form);
    assert.equal(name.listeners.get('click').filter(handler => handler.capture).length, 1);
    assert.ok(controls.querySelector('[data-swade-tools-aoe]'));
    const clickedName = await name.emit('click');
    assert.equal(clickedName.defaultPrevented, true);
    assert.equal(clickedName.immediatePropagationStopped, true);
    assert.equal(operatorLookups, 1); assert.equal(nativeNameClicks, 0);
    assert.equal(global.__aoeLaunchTest.promptAoeSetup, true);
    const clickedImage = await image.emit('click');
    assert.equal(clickedImage.defaultPrevented, true); assert.equal(operatorLookups, 2);
    const clickedEdit = await edit.emit('click');
    assert.equal(clickedEdit.defaultPrevented, false); assert.equal(editClicks, 1);
    assert.equal(operatorLookups, 2);
    await item.setFlag('swade-tools', 'aoeEnabled', false);
    bindAoeInventoryControls(sheet, form);
    const disabledName = await name.emit('click');
    assert.equal(disabledName.defaultPrevented, false);
    assert.equal(disabledName.propagationStopped, false);
    assert.equal(nativeNameClicks, 2); assert.equal(operatorLookups, 2);
    assert.equal(controls.querySelector('[data-swade-tools-aoe]'), null);
    delete global.__aoeLaunchTest;
});
