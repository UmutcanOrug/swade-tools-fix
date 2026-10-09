const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const scripts = path.resolve(__dirname, '../scripts');
const service = import(pathToFileURL(path.join(scripts, 'services/LastWeaponSettings.js')).href);

const owner = (uuid = 'Actor.shooter', type = 'character') => ({ uuid, type });
const weapon = uuid => ({ uuid: uuid ?? 'Actor.shooter.Item.rifle' });
const token = (id, actor, scene = 'alpha') => ({
    actor, document: { id, uuid: `Scene.${scene}.Token.${id}`, parent: { id: scene } }
});
const platform = userId => {
    global.game = { user: { id: userId ?? 'player-one' },
        settings: { set() { throw new Error('No persistent writes'); } },
        socket: { emit() { throw new Error('No network writes'); } }
    };
    global.canvas = { tokens: { controlled: [] } };
};

test('manual settings are isolated by user, weapon owner, firing token, weapon and operator', async () => {
    const api = await service; api.clearLastWeaponSettings(); platform();
    const actor = owner(), item = weapon(), gunner = owner('Actor.gunner');
    const raw = { weaponOwner: actor, item, operator: gunner, token: token('tank', actor) };
    const first = api.resolveWeaponSettingsContext(raw);
    api.saveLastWeaponSettings(first, { modifier: '@skills.gunnery + 2', cover: 'Medium' });
    assert.equal(api.getLastWeaponSettings(first).cover, 'Medium');
    for (const change of [
        { userId: 'player-two' }, { weaponOwner: owner('Actor.other') },
        { token: token('other-tank', actor) }, { token: token('tank', actor, 'beta') },
        { item: weapon('Actor.shooter.Item.other') }, { operator: owner('Actor.other-gunner') }
    ]) {
        assert.equal(api.getLastWeaponSettings(api.resolveWeaponSettingsContext({ ...raw, ...change })), null);
    }
    assert.equal(first.tokenUuid, 'Scene.alpha.Token.tank');
    assert.equal(first.operatorUuid, gunner.uuid); assert.equal(Object.isFrozen(first), true);
    assert.equal(api.resolveWeaponSettingsContext(raw).key, first.key);
});

test('synthetic actors and scene-qualified firing tokens never collide with another copy', async () => {
    const api = await service; api.clearLastWeaponSettings(); platform();
    const one = owner('Scene.alpha.Token.one.Actor.base'), two = owner('Scene.alpha.Token.two.Actor.base');
    one.isToken = true; two.isToken = true;
    one.parent = { id: 'one', uuid: 'Scene.alpha.Token.one', parent: { id: 'alpha' } };
    two.parent = { id: 'two', uuid: 'Scene.alpha.Token.two', parent: { id: 'alpha' } };
    const first = api.resolveWeaponSettingsContext({ weaponOwner: one, item: weapon(`${one.uuid}.Item.gun`) });
    const second = api.resolveWeaponSettingsContext({ weaponOwner: two, item: weapon(`${two.uuid}.Item.gun`) });
    api.saveLastWeaponSettings(first, { modifier: '-4' });
    assert.equal(first.tokenUuid, 'Scene.alpha.Token.one');
    assert.equal(second.tokenUuid, 'Scene.alpha.Token.two');
    assert.equal(api.getLastWeaponSettings(second), null);
});

test('firing token preference is explicit, then own synthetic, unique controlled, unique active, else none', async () => {
    const api = await service; platform();
    const actor = owner(), item = weapon(), first = token('one', actor), second = token('two', actor);
    actor.getActiveTokens = () => [first, second];
    const context = extra => api.resolveWeaponSettingsContext({ weaponOwner: actor, item, ...extra });
    assert.equal(context({ token: second }).tokenUuid, second.document.uuid);
    assert.equal(context().tokenUuid, '');
    canvas.tokens.controlled = [first];
    assert.equal(context().tokenUuid, first.document.uuid);
    canvas.tokens.controlled = [first, second];
    assert.equal(context().tokenUuid, '');
    canvas.tokens.controlled = [token('other', owner('Actor.someone-else'))];
    actor.getActiveTokens = () => [second];
    assert.equal(context().tokenUuid, second.document.uuid);
    actor.getActiveTokens = () => [];
    assert.equal(context().tokenUuid, '');
    assert.equal(context({ token: 'Scene.beta.Token.one' }).tokenUuid, 'Scene.beta.Token.one');
    assert.equal(context({ token: { id: 'one' } }).tokenUuid, '');
});

test('cache stores only raw manual fields, never Raise, dynamic combat state, targets or nested data', async () => {
    const api = await service; api.clearLastWeaponSettings(); platform();
    const context = api.resolveWeaponSettingsContext({ weaponOwner: owner(), item: weapon() });
    const data = {
        modifier: ' @attributes.agility.die.sides - 2 ', multiaction: '-2',
        cover: 'Light', illumination: 'Dark', calledshots: 'Head', rof: 3,
        recoil: '-2', drop: true, vulnerable: false, damageModifier: '+1d6',
        consumeAmmo: true, shotgunMode: 'shot', bothBarrels: true, raise: true, raiseDamage: true,
        wounds: 2, fatigue: 1, range: 30, hp: 10, quantity: 5, currentShots: 20,
        targets: ['victim'], extras: { dangerous: true }
    };
    const saved = api.saveLastWeaponSettings(context, data);
    assert.deepEqual(Object.keys(saved), [...api.LAST_WEAPON_SETTING_FIELDS]);
    assert.equal(saved.modifier, data.modifier);
    assert.equal(saved.damageModifier, '+1d6');
    assert.equal(saved.raise, undefined); assert.equal(saved.targets, undefined);
    api.saveLastWeaponSettings(context, { modifier: {}, rof: Infinity, recoil: NaN, drop: null });
    assert.deepEqual(api.getLastWeaponSettings(context), {});
});

test('save and read snapshots cannot mutate each other and clearing is client-local', async () => {
    const api = await service; api.clearLastWeaponSettings(); platform();
    const first = api.resolveWeaponSettingsContext({ weaponOwner: owner(), item: weapon() });
    const second = api.resolveWeaponSettingsContext({ weaponOwner: owner(), item: weapon('Actor.shooter.Item.second') });
    const input = { modifier: '-2', consumeAmmo: true };
    const returned = api.saveLastWeaponSettings(first, input);
    input.modifier = '+99'; returned.consumeAmmo = false;
    const read = api.getLastWeaponSettings(first); read.modifier = '+100';
    assert.deepEqual(api.getLastWeaponSettings(first), { modifier: '-2', consumeAmmo: true });
    api.saveLastWeaponSettings(second, { modifier: '+1' });
    api.clearLastWeaponSettings(first);
    assert.equal(api.getLastWeaponSettings(first), null);
    assert.equal(api.getLastWeaponSettings(second).modifier, '+1');
    api.clearLastWeaponSettings(); assert.equal(api.getLastWeaponSettings(second), null);
});

test('missing user/document identity does not create a shared anonymous settings cache', async () => {
    const api = await service; platform();
    assert.equal(api.resolveWeaponSettingsContext({ item: weapon() }), null);
    assert.equal(api.resolveWeaponSettingsContext({ weaponOwner: owner(), item: { id: 'gun' } }), null);
    assert.equal(api.resolveWeaponSettingsContext({ weaponOwner: owner(), item: weapon(), userId: '' }), null);
    assert.equal(api.getLastWeaponSettings(null), null); assert.equal(api.saveLastWeaponSettings(null, { modifier: '+3' }), null);
});

test('Shift click options preserve sheet firing token and do not infer another actor token', async () => {
    const api = await service;
    const actor = owner(), source = token('one', actor), sheet = { actor, token: source.document };
    assert.deepEqual(api.getWeaponSettingsClickOptions({ shiftKey: true }, sheet), { restoreLast: true, token: source.document });
    assert.deepEqual(api.getWeaponSettingsClickOptions({ shiftKey: false }, sheet), { restoreLast: false, token: source.document });
    assert.equal(api.getWeaponSettingsClickOptions({}, { actor }).token, undefined);
});

class Element {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this.listeners = []; this.className = ''; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    matches(selector) {
        return selector.split(',').some(part => {
            const simple = part.trim(), tag = simple.match(/^[a-z]+/i)?.[0];
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            for (const match of simple.matchAll(/\.([\w-]+)/g)) {
                if (!this.className.split(/\s+/).includes(match[1])) return false;
            }
            for (const match of simple.matchAll(/\[data-([^=\]]+)(?:="([^"]*)")?\]/g)) {
                const key = match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
                if (this.dataset[key] === undefined || (match[2] !== undefined && this.dataset[key] !== match[2])) return false;
            }
            return true;
        });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    addEventListener(type, callback, capture) { this.listeners.push({ type, callback, capture: capture === true }); }
    async click(extra = {}) {
        const event = { target: this, button: 0, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
            stopImmediatePropagation() { this.stopped = true; }, ...extra };
        const path = []; for (let element = this; element; element = element.parentElement) path.push(element);
        for (const [nodes, capture] of [[path.slice().reverse(), true], [path, false]]) {
            for (const element of nodes) {
                for (const listener of element.listeners) {
                    if (listener.type === 'click' && listener.capture === capture) await listener.callback(event);
                    if (event.stopped) return event;
                }
            }
        }
        return event;
    }
}

// Execute real SheetControl/st entry-point code with dependency fakes, keeping
// the test independent of Foundry, jQuery, browsers and a running server.
const withoutImports = source => source.replace(/^import[^\n]+;\r?\n/gm, '');
async function loadSheetControl(st, ItemDialog = class {}) {
    const { getWeaponSettingsClickOptions } = await service;
    const source = withoutImports(fs.readFileSync(path.join(scripts, 'class/SheetControl.js'), 'utf8'))
        .replace('export default class SheetControl', 'class SheetControl');
    return Function('st', 'isAoeItem', 'getWeaponSettingsClickOptions', 'ItemDialog', 'gb',
        `${source}\nreturn SheetControl;`)(st, item => item.aoe === true,
        getWeaponSettingsClickOptions, ItemDialog, { setting: () => false, getTemplatesHTML: () => '' });
}

test('native V2 Shift-left-click opens the same weapon panel once, normal/disabled/AoE/edit clicks remain untouched', async () => {
    const calls = [], Control = await loadSheetControl({ item: async (...args) => calls.push(args) });
    const actor = owner('Actor.tank', 'vehicle'), item = { id: 'gun', type: 'weapon', isOwner: true };
    actor.items = { get: id => id === item.id ? item : null };
    const form = new Element('form'), row = new Element('li'), name = new Element('a'), image = new Element('img');
    row.dataset.itemId = 'gun'; name.className = 'name'; name.dataset.action = 'showItem';
    const controls = new Element('span'), edit = new Element('a'); controls.className = 'controls'; edit.className = 'item-edit';
    controls.append(edit); row.append(image, name, controls); form.append(row); form[0] = image;
    const source = token('tank', actor), sheet = { document: { ...actor, documentName: 'Actor' }, token: source.document, isEditable: true };
    const control = new Control(sheet, form); control.bindNativeWeaponRecallClicks(); control.bindNativeWeaponRecallClicks();
    assert.equal(name.listeners.length, 1);
    assert.equal((await name.click()).defaultPrevented, false); assert.equal(calls.length, 0);
    assert.equal((await name.click({ shiftKey: true })).defaultPrevented, true);
    assert.equal(calls.length, 1); assert.equal(calls[0][1], 'gun');
    assert.deepEqual(calls[0][3], { restoreLast: true, token: source.document });
    await image.click({ shiftKey: true }); assert.equal(calls.length, 2);
    assert.equal((await edit.click({ shiftKey: true })).defaultPrevented, false);
    assert.equal(calls.length, 2);
    item.aoe = true; assert.equal((await name.click({ shiftKey: true })).defaultPrevented, false);
    item.aoe = false; item.isOwner = false;
    assert.equal((await name.click({ shiftKey: true })).defaultPrevented, false);
    item.isOwner = true; sheet.isEditable = false;
    assert.equal((await name.click({ shiftKey: true })).defaultPrevented, false);
    sheet.isEditable = true;
    assert.equal((await name.click({ shiftKey: true, button: 2 })).defaultPrevented, false);
    assert.equal(calls.length, 2);
});

test('legacy item click passes Shift recall and token to ItemDialog without auto-firing', async () => {
    const calls = [];
    class Dialog { constructor(...args) { calls.push(args); } showDialog() { return 'panel-open'; } }
    const Control = await loadSheetControl({}, Dialog);
    const actor = owner(), item = { id: 'gun', type: 'weapon', system: {} };
    actor.items = [item]; const source = token('shooter', actor);
    const parent = { data: () => 'gun', addClass() {} }; let callback;
    const target = {
        parents: () => parent, off() { return this; }, on(_type, listener) { callback = listener; return this; },
        closest: () => ({ find: () => ({ length: 0 }) })
    };
    new Control({ actor, token: source.document }, {}).doItem(target);
    assert.equal(callback({ shiftKey: true }), 'panel-open');
    assert.deepEqual(calls[0][3], { restoreLast: true, token: source.document });
    assert.equal(callback({ shiftKey: false }), 'panel-open'); assert.equal(calls[1][3].restoreLast, false);
});

test('st.item forwards normalized recall options and does not mutate the caller object', async () => {
    const calls = [];
    class Dialog { constructor(...args) { calls.push(args); } showDialog() { return 'panel-open'; } }
    const source = withoutImports(fs.readFileSync(path.join(scripts, 'st.js'), 'utf8')).replace(/export const /g, 'const ');
    const itemEntry = Function('ItemDialog', 'isAoeItem', `${source}\nreturn item;`)(Dialog, () => false);
    const actor = owner(), item = { id: 'gun', type: 'weapon' }, firingToken = token('shooter', actor);
    actor.items = { get: () => item };
    const options = Object.freeze({ restoreLast: true, token: firingToken.document, custom: 'kept' });
    assert.equal(await itemEntry(actor, 'gun', null, options), 'panel-open');
    assert.notEqual(calls[0][3], options); assert.equal(calls[0][3].token, firingToken.document);
    assert.equal(calls[0][3].restoreLast, true); assert.equal(calls[0][3].custom, 'kept');
    await itemEntry(actor, 'gun'); assert.equal(calls[1][3].restoreLast, false);
});
