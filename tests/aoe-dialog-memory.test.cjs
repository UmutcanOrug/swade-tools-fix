const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const services = path.resolve(__dirname, '../scripts/services');
const load = name => import(pathToFileURL(path.join(services, name)).href);

const fixture = () => {
    const owner = { uuid: 'Actor.owner', name: 'Owner', type: 'character' };
    const token = { document: { uuid: 'Scene.scene.Token.source' }, actor: owner };
    const item = { uuid: `${owner.uuid}.Item.weapon`, name: 'HE Weapon', type: 'weapon', actor: owner,
        system: { damage: '3d6', range: '10/20/40', shots: 4, currentShots: 2, reloadType: 'single' },
        flags: { 'swade-tools': { aoeEnabled: true } }, reloads: 0,
        async reload() { this.reloads++; } };
    const context = { item, weaponOwner: owner, operatorActor: owner, token,
        attackSkill: { name: 'Gunnery' }, settings: { blastSize: 'medium', consume: true,
            consumeMode: 'ammo', ammoCost: 1, damageAction: '' }, resource: { label: 'Loaded ammunition', available: 2 } };
    const fields = { mod: { value: '0' }, 'rof-damage-modifier': {value:''}, 'rof-drop':{checked:false}, multiaction: { value: '0' }, cover: { value: '0' },
        illumination: { value: '0' }, 'aoe-consume': { checked: true, disabled: false } };
    const form = { nodeType: 1, querySelector: selector => fields[selector.slice(1)], find: () => ({ each() {} }) };
    form[0] = fields.mod; // V13 native forms are indexed by their controls.
    global.game = { user: { id: 'player' }, modules: new Map() };
    global.canvas = { tokens: { controlled: [] } };
    global.foundry = { utils: { escapeHTML: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;') } };
    global.ui = { notifications: { warn() {} } };
    let config, renders = 0;
    class FakeDialog {
        constructor(data) { config = data; }
        render() { renders++; config.render(form); return this; }
    }
    return { owner, token, item, context, fields, form, FakeDialog,
        get config() { return config; }, get renders() { return renders; } };
};
const memoryContext = (api, context) => api.resolveWeaponSettingsContext({
    item: context.item, weaponOwner: context.weaponOwner,
    operator: context.operatorActor, token: context.token
});

test('ordinary AoE panel opens with clean defaults despite saved settings and never auto-fires', async () => {
    const memory = await load('LastWeaponSettings.js'), { showAoeAttackDialog } = await load('AoeAttackDialog.js');
    memory.clearLastWeaponSettings(); const f = fixture(), key = memoryContext(memory, f.context);
    memory.saveLastWeaponSettings(key, { modifier: '+4', multiaction: '-2', cover: 'Heavy', consumeAmmo: false });
    const pending = showAoeAttackDialog(f.context, { DialogClass: f.FakeDialog, addModifierButtons() {} });
    assert.equal(f.renders, 1); assert.equal(f.fields.mod.value, '0'); assert.equal(f.fields.cover.value, '0');
    assert.equal(f.fields['aoe-consume'].checked, true); assert.doesNotMatch(f.config.content, /Last settings restored/);
    assert.equal(f.item.reloads, 0); f.config.buttons.cancel.callback(); assert.equal(await pending, null);
    assert.equal(memory.getLastWeaponSettings(key).modifier, '+4');
});

test('Shift AoE panel restores canonical native manual values only, requiring an explicit attack click', async () => {
    const memory = await load('LastWeaponSettings.js'), { showAoeAttackDialog } = await load('AoeAttackDialog.js');
    memory.clearLastWeaponSettings(); const f = fixture(), key = memoryContext(memory, f.context);
    memory.saveLastWeaponSettings(key, { modifier: '1d6+@bonus', multiaction: '-4', cover: 'Medium',
        illumination: 'Dark', consumeAmmo: false, rof: '3', damageModifier: '+2', drop:true, raise: true });
    const pending = showAoeAttackDialog({ ...f.context, restoreLast: true }, { DialogClass: f.FakeDialog, addModifierButtons() {} });
    assert.equal(f.fields.mod.value, '1d6+@bonus'); assert.equal(f.fields.multiaction.value, '-4');
    assert.equal(f.fields.cover.value, '-4'); assert.equal(f.fields.illumination.value, '-4');
    assert.equal(f.fields['aoe-consume'].checked, false); assert.match(f.config.content, /Last settings restored/);
    f.config.buttons.attack.callback(f.form);
    assert.deepEqual(await pending, { otherModifierFormula: '1d6+@bonus', damageModifier: '+2', theDrop: true, situationalModifier: -12, consume: false,
        modifierParts: { modifier: '1d6+@bonus', multiAction: -4, cover: -4, illumination: -4 } });
    const saved = memory.getLastWeaponSettings(key);
    assert.equal(saved.cover, 'Medium'); assert.equal(saved.illumination, 'Dark');
    assert.equal(saved.rof, '1'); assert.equal(saved.recoil, false); assert.equal(saved.damageModifier, '+2'); assert.equal(saved.raise, undefined);
});

test('AoE attack stores raw manual values with canonical enums and no item/server writes', async () => {
    const memory = await load('LastWeaponSettings.js'), { showAoeAttackDialog } = await load('AoeAttackDialog.js');
    memory.clearLastWeaponSettings(); const f = fixture(), key = memoryContext(memory, f.context);
    const originalFlags = structuredClone(f.item.flags), originalSystem = structuredClone(f.item.system);
    const pending = showAoeAttackDialog(f.context, { DialogClass: f.FakeDialog, addModifierButtons() {} });
    f.fields.mod.value = '  +1d6  '; f.fields.multiaction.value = '-2'; f.fields.cover.value = '-6';
    f.fields.illumination.value = '-2'; f.fields['aoe-consume'].checked = false;
    f.config.buttons.attack.callback(f.form); await pending;
    assert.deepEqual(memory.getLastWeaponSettings(key), {
        modifier: '  +1d6  ', multiaction: '-2', cover: 'Heavy', illumination: 'Dim', consumeAmmo: false,
        rof: '1', recoil: false, damageModifier: '', drop: false
    });
    assert.deepEqual(f.item.flags, originalFlags); assert.deepEqual(f.item.system, originalSystem);
});

test('saved consume true cannot enable disabled None mode and invalid remembered enums leave defaults', async () => {
    const memory = await load('LastWeaponSettings.js'), { showAoeAttackDialog } = await load('AoeAttackDialog.js');
    memory.clearLastWeaponSettings(); const f = fixture(), key = memoryContext(memory, f.context);
    f.context.settings = { ...f.context.settings, consumeMode: 'none', consume: false };
    f.fields['aoe-consume'] = { checked: false, disabled: true };
    memory.saveLastWeaponSettings(key, { consumeAmmo: true, multiaction: '-99', cover: 'Invalid', illumination: 'Invalid' });
    const pending = showAoeAttackDialog({ ...f.context, restoreLast: true }, { DialogClass: f.FakeDialog, addModifierButtons() {} });
    assert.equal(f.fields['aoe-consume'].checked, false); assert.equal(f.fields['aoe-consume'].disabled, true);
    assert.equal(f.fields.multiaction.value, '0'); assert.equal(f.fields.cover.value, '0');
    f.config.buttons.attack.callback(f.form); assert.equal((await pending).consume, false);
});

test('AoE Cancel/Reload/close do not save edits or spend firing resources', async () => {
    const memory = await load('LastWeaponSettings.js'), { showAoeAttackDialog } = await load('AoeAttackDialog.js');
    for (const action of ['cancel', 'reload', 'close']) {
        memory.clearLastWeaponSettings(); const f = fixture(), key = memoryContext(memory, f.context);
        memory.saveLastWeaponSettings(key, { modifier: '+2' });
        const pending = showAoeAttackDialog(f.context, { DialogClass: f.FakeDialog, addModifierButtons() {} });
        f.fields.mod.value = '+99';
        if (action === 'close') f.config.close(); else await f.config.buttons[action].callback();
        assert.equal(await pending, null); assert.equal(memory.getLastWeaponSettings(key).modifier, '+2');
        assert.equal(f.item.reloads, action === 'reload' ? 1 : 0);
    }
});

test('AoE memory remains isolated across users, firing tokens and operators', async () => {
    const memory = await load('LastWeaponSettings.js'), { showAoeAttackDialog } = await load('AoeAttackDialog.js');
    memory.clearLastWeaponSettings(); const f = fixture();
    memory.saveLastWeaponSettings(memoryContext(memory, f.context), { modifier: '+4' });
    for (const context of [
        { ...f.context, token: { document: { uuid: 'Scene.scene.Token.other' }, actor: f.owner } },
        { ...f.context, operatorActor: { uuid: 'Actor.other' } },
        { ...f.context, differentUser: true }
    ]) {
        f.fields.mod.value = '0'; if (context.differentUser) game.user.id = 'other-player';
        const pending = showAoeAttackDialog({ ...context, restoreLast: true }, { DialogClass: f.FakeDialog, addModifierButtons() {} });
        assert.equal(f.fields.mod.value, '0'); f.config.buttons.cancel.callback(); await pending;
    }
});

test('AoE launcher forwards restoreLast and resolved source token into the old dialog without changing normal scope', async () => {
    const memory = await load('LastWeaponSettings.js'), { resolveAoeLaunchScope } = await load('AoeMacroLauncher.js');
    memory.clearLastWeaponSettings(); const f = fixture();
    global.Dialog = f.FakeDialog;
    memory.saveLastWeaponSettings(memoryContext(memory, f.context), { modifier: '+3' });
    const scope = await resolveAoeLaunchScope(f.owner, f.item, { token: f.token, restoreLast: true });
    assert.equal(scope.restoreLast, true); assert.equal(scope.token, f.token);
    const pending = scope.aoeServices.showAoeAttackDialog({ ...f.context, token: undefined });
    assert.equal(f.fields.mod.value, '+3'); f.config.buttons.cancel.callback(); await pending;
    assert.equal((await resolveAoeLaunchScope(f.owner, f.item, { token: f.token })).restoreLast, false);
});
