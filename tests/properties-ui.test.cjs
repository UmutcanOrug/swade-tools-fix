const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const uiModule = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesUI.js')).href);
const rulesModule = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/PropertiesRules.js')).href);

const fixture = ({enabled = true, gm = true, response = null, library} = {}) => {
    const values = {propertiesEnabled: enabled, propertiesLibrary: library ?? {version: 1, presets: [], assignments: {}, favorites: [], hiddenPresets: []}};
    const writes = [], dialogs = [], notices = [];
    const runtime = {game: {user: {isGM: gm}, settings: {
        get: (_scope, key) => values[key], set: async (scope, key, value) => { writes.push({scope, key, value}); values[key] = value; }
    }}, DialogV2: {async wait(config) { dialogs.push(config); return typeof response === 'function' ? response(config) : response; }},
    ui: {notifications: Object.fromEntries(['info', 'warn', 'error'].map(key => [key, message => notices.push([key, message])]))}};
    return {runtime, writes, dialogs, notices, values};
};
const item = (extra = {}) => ({documentName: 'Item', uuid: 'Actor.actor.Item.weapon', name: 'Rifle', type: 'weapon', isOwner: true, ...extra});

class Element {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = ''; }
    append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
    prepend(...children) { for (const child of children) child.parentElement = this; this.children.unshift(...children); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    matches(selector) {
        return selector.split(',').some(part => {
            const selected = part.trim(), tag = selected.match(/^[a-z]+/i)?.[0], css = selected.match(/\.([\w-]+)/)?.[1];
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            if (css && !this.className.split(' ').includes(css)) return false;
            for (const [, key, expected] of selected.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
                const value = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] : this.attributes[key] ?? this[key];
                if (value === undefined || (expected !== undefined && value !== expected)) return false;
            }
            return true;
        });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(name, callback) { const entries = this.listeners.get(name) ?? []; entries.push(callback); this.listeners.set(name, entries); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
}
const sheetFixture = (options = {}) => {
    const state = fixture(options), root = new Element('form'), nav = new Element('nav'), anchor = new Element('a'), panel = new Element('section'), field = new Element('input');
    anchor.dataset.tab = 'properties'; anchor.textContent = 'Properties'; nav.append(anchor);
    panel.dataset.tab = 'properties'; panel.append(field); root.append(nav, panel); root[0] = field;
    state.runtime.document = {createElement: tag => new Element(tag)};
    return {...state, root, nav, anchor, panel, field, sheet: {document: item(options.item), isEditable: options.editable !== false}};
};

test('PropertiesUI imports without Foundry globals and exposes lazy V13 settings menu', async () => {
    const ui = await uiModule();
    for (const name of ['registerPropertiesItemControls', 'showPropertiesLibrary', 'showItemProperties', 'PropertiesLibraryMenu']) assert.equal(typeof ui[name], 'function');
    assert.equal(typeof new ui.PropertiesLibraryMenu().render, 'function');
});

test('summary shows only action-specific qualifier, not default Vigor on every property', async () => {
    const {summarizePropertyRule} = await uiModule(), {normalizeRule} = await rulesModule();
    assert.equal(summarizePropertyRule(normalizeRule({action: 'attackMod', value: 2})), 'Passive → Attack Modifier +2');
    assert.equal(summarizePropertyRule(normalizeRule({action: 'traitSteps', trait: 'strength', value: -1, duration: {rounds: 2}})), 'Hit → Attribute Die Steps (Strength) -1 · 2 rounds');
    assert.match(summarizePropertyRule(normalizeRule({action: 'status', status: 'stunned'})), /Apply Condition \(Stunned\)$/);
});

test('library renders compact closed details with search, categories, favorites and safe descriptions', async () => {
    const {renderPropertyLibrary} = await uiModule();
    const data = {presets: [{id: 'safe', name: '<img src=x onerror=evil()>', category: 'Defense', aliases: ['kaçınma'], description: '<script>bad()</script>', rules: []}], favorites: [], hiddenPresets: []};
    const html = renderPropertyLibrary(data);
    assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;img/);
    assert.match(html, /data-property-command="edit-preset"/); assert.match(html, /data-property-command="favorite"/);
    assert.equal(renderPropertyLibrary(data, {query: 'kaybolan'}).includes('No matches'), true);
});

test('library search is multiword, Turkish-aware, categorized, favorite-first and hides hidden presets', async () => {
    const {renderPropertyLibrary} = await uiModule();
    const data = {presets: [
        {id: 'alpha', name: 'Alpha', category: 'Defense', aliases: ['kaçınma', 'menzilli'], rules: []},
        {id: 'zulu', name: 'Zulu', category: 'Skills', aliases: ['Shooting', 'atış'], rules: []},
        {id: 'hidden', name: 'Hidden', category: 'Defense', aliases: [], rules: []}
    ], favorites: ['zulu'], hiddenPresets: ['hidden']};
    const html = renderPropertyLibrary(data);
    assert.ok(html.indexOf('Zulu') < html.indexOf('Alpha')); assert.ok(!html.includes('Hidden'));
    assert.match(renderPropertyLibrary(data, {query: 'menzilli kaçınma'}), /Alpha/);
    assert.match(renderPropertyLibrary(data, {query: 'ATIŞ'}), /Zulu/);
    assert.ok(!renderPropertyLibrary(data, {category: 'Defense'}).includes('Zulu'));
    assert.ok(!renderPropertyLibrary(data, {favoritesOnly: true}).includes('Alpha'));
    const picker = renderPropertyLibrary(data, {picker: true});
    assert.match(picker, /data-property-command="choose-preset"/); assert.ok(!picker.includes('edit-preset'));
});

test('rule editor offers safe declarative actions and closed More Details, never script/path inputs', async () => {
    const {renderPropertyRuleEditor} = await uiModule(), {normalizeRule} = await rulesModule();
    const html = renderPropertyRuleEditor(normalizeRule({name: '"><script>evil()</script>', action: 'traitSteps', trait: 'strength', value: -1}));
    assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<details class="st-property-details"><summary>More Details/); assert.ok(!html.includes('<details open'));
    for (const name of ['duration', 'frequency', 'attackType', 'resistModifier', 'trait', 'stack']) assert.match(html, new RegExp(name === 'duration' ? 'name="rounds"' : `name="${name}"`));
    assert.ok(!html.includes('grantEdge')); assert.ok(!html.includes('name="script"')); assert.ok(!html.includes('name="dataPath"'));
});

test('library refuses non-GM edits before opening or writing; disabled world still lets GM configure dormant presets', async () => {
    const {showPropertiesLibrary} = await uiModule();
    const player = fixture({gm: false});
    assert.equal(await showPropertiesLibrary({}, player.runtime), null); assert.equal(player.dialogs.length, 0); assert.equal(player.writes.length, 0);
    const gm = fixture({enabled: false}); await showPropertiesLibrary({}, gm.runtime);
    assert.equal(gm.dialogs.length, 1); assert.equal(gm.writes.length, 0);
    const dialog = gm.dialogs[0]; assert.ok(dialog.classes.includes('theme-light')); assert.equal(dialog.modal, false); assert.equal(dialog.position.width, 560);
    assert.match(dialog.content, /Search Edge, Ability or property/); assert.match(dialog.content, /All categories/); assert.match(dialog.content, /More Details/);
    assert.ok(!dialog.content.includes('<details open'));
});

test('item draft Cancel is non-mutating, saving explicitly approves exact item UUID in GM world settings', async () => {
    const {showItemProperties} = await uiModule(), {normalizeRule} = await rulesModule();
    const cancel = fixture(); await showItemProperties(item(), cancel.runtime); assert.equal(cancel.writes.length, 0);
    const approved = normalizeRule({id: 'approved', action: 'attackMod', value: 1});
    const saved = fixture({response: [approved]}); await showItemProperties(item(), saved.runtime);
    assert.equal(saved.writes.length, 1); assert.equal(saved.writes[0].scope, 'swade-tools'); assert.equal(saved.writes[0].key, 'propertiesLibrary');
    assert.deepEqual(saved.values.propertiesLibrary.assignments['Actor.actor.Item.weapon'], [approved]);
    assert.match(saved.dialogs[0].content, /Add Property/); assert.match(saved.dialogs[0].content, /AoE, Evade and Fire keep their existing settings/);
});

test('non-GM and non-owner item views are read-only; disabled option is explicit and inert', async () => {
    const {showItemProperties} = await uiModule();
    for (const state of [fixture({gm: false, response: []}), fixture({response: []})]) {
        await showItemProperties(item({isOwner: false}), state.runtime);
        assert.deepEqual(state.dialogs[0].buttons.map(entry => entry.action), ['close']);
        assert.ok(!state.dialogs[0].content.includes('add-from-library')); assert.equal(state.writes.length, 0);
    }
    const off = fixture({enabled: false}); await showItemProperties(item(), off.runtime);
    assert.match(off.dialogs[0].content, /Saved properties remain dormant/); assert.equal(off.writes.length, 0);
});

test('item control attaches once to actual properties panel after nav and preserves native fields', async () => {
    const {bindPropertiesItemSheetControl} = await uiModule();
    const state = sheetFixture();
    bindPropertiesItemSheetControl(state.sheet, state.root, state.runtime); bindPropertiesItemSheetControl(state.sheet, state.root, state.runtime);
    const control = state.root.querySelector('[data-swade-tools-properties-control]');
    assert.equal(control.parentElement, state.panel); assert.equal(state.panel.children[1], state.field);
    assert.equal(state.nav.querySelectorAll('[data-swade-tools-properties-control]').length, 0); assert.equal(state.anchor.textContent, 'Properties');
    assert.equal(state.root.querySelectorAll('[data-swade-tools-properties-control]').length, 1);
    const open = control.querySelector('button'); assert.equal(open.type, 'button'); assert.equal(open.disabled, false); assert.equal(open.listeners.get('click').length, 1);
    assert.equal(state.writes.length, 0); assert.equal(state.dialogs.length, 0);
});

test('sheet control respects opt-in, GM-only, owner/read-only and supported item guards', async () => {
    const {bindPropertiesItemSheetControl} = await uiModule();
    for (const options of [{enabled: false}, {gm: false}, {item: {type: 'skill'}}]) {
        const state = sheetFixture(options); bindPropertiesItemSheetControl(state.sheet, state.root, state.runtime);
        assert.equal(state.root.querySelector('[data-swade-tools-properties-control]'), null);
    }
    for (const options of [{editable: false}, {item: {isOwner: false}}]) {
        const state = sheetFixture(options); bindPropertiesItemSheetControl(state.sheet, state.root, state.runtime);
        assert.equal(state.panel.querySelector('button').disabled, true);
    }
    const state = sheetFixture(); bindPropertiesItemSheetControl(state.sheet, state.root, state.runtime);
    state.values.propertiesEnabled = false; bindPropertiesItemSheetControl(state.sheet, state.root, state.runtime);
    assert.equal(state.root.querySelector('[data-swade-tools-properties-control]'), null);
});

test('sheet binder accepts section-only and legacy wrapper render, rejects navigation-only partial', async () => {
    const {bindPropertiesItemSheetControl} = await uiModule();
    for (const wrap of [state => state.panel, state => [state.root], state => ({0: state.root, jquery: '3'})]) {
        const state = sheetFixture(); bindPropertiesItemSheetControl(state.sheet, wrap(state), state.runtime);
        assert.equal(state.panel.querySelectorAll('[data-swade-tools-properties-control]').length, 1);
    }
    const state = sheetFixture(); bindPropertiesItemSheetControl(state.sheet, state.nav, state.runtime);
    assert.equal(state.panel.children.length, 1); assert.equal(state.nav.children.length, 1);
    assert.doesNotThrow(() => bindPropertiesItemSheetControl(null, null, {}));
});

test('native render hooks register idempotently per Hooks object without changing sheet prototypes', async () => {
    const {registerPropertiesItemControls} = await uiModule(), state = sheetFixture(), hooks = new Map();
    state.runtime.Hooks = {on(name, callback) { (hooks.get(name) ?? hooks.set(name, []).get(name)).push(callback); }};
    registerPropertiesItemControls(state.runtime); registerPropertiesItemControls(state.runtime);
    assert.deepEqual([...hooks.keys()], ['renderItemSheet', 'renderApplicationV2']);
    assert.equal(hooks.get('renderItemSheet').length, 1); assert.equal(hooks.get('renderApplicationV2').length, 1);
    hooks.get('renderItemSheet')[0](state.sheet, state.root); hooks.get('renderApplicationV2')[0](state.sheet, state.root);
    assert.equal(state.panel.querySelectorAll('[data-swade-tools-properties-control]').length, 1);
    assert.doesNotThrow(() => registerPropertiesItemControls({Hooks: {}}));
});

test('preview evaluates draft rather than saved rules without dice, resource or settings writes', async () => {
    const {showPropertiesPreview} = await uiModule(), {normalizeRule} = await rulesModule(), state = fixture();
    const source = item({actor: {uuid: 'Actor.actor', items: []}}), rule = normalizeRule({action: 'attackMod', value: 3});
    await showPropertiesPreview(source, state.runtime, [rule]);
    assert.equal(state.writes.length, 0); assert.deepEqual(state.values.propertiesLibrary.assignments, {});
    assert.match(state.dialogs[0].content, /Attack Modifier/); assert.match(state.dialogs[0].content, /\+3/);
    assert.match(state.dialogs[0].content, /No dice, resources, character changes or effects/);
    assert.match(state.dialogs[0].content, /name="previewAttackType"/); assert.match(state.dialogs[0].content, /name="previewRange"/);
});

test('library JSON import clearly requires explicit assignment restoration; export is data only', async () => {
    const {showPropertiesLibrary} = await uiModule(), state = fixture();
    await showPropertiesLibrary({}, state.runtime);
    assert.match(state.dialogs[0].content, /JSON import accepts data only, never scripts/);
    assert.match(state.dialogs[0].content, /later library edits do not alter existing items/);
});
