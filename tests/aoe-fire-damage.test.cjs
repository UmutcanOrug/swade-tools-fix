const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeFireDamage.js')).href);
const properties = {...require('../scripts/services/PropertiesCombat.js'), ...require('../scripts/services/PropertiesEffects.js'),
    isPropertiesEnabled: require('../scripts/services/PropertiesRules.js').isPropertiesEnabled};
const rollControlSource = fs.readFileSync(path.resolve(__dirname, '../scripts/class/RollControl.js'), 'utf8')
    .replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace('export default class RollControl', 'class RollControl') + '\nRollControl;';

const html = () => ({chunks: [], append(text) { this.chunks.push(text); return this; },
    find() { return this; }, on() { return this; }, ready() { return this; }, css() { return this; }});
const fixture = async (total = 18) => {
    const {getAoeFireDamageTarget} = await service;
    const calls = {warnings: [], wounds: [], status: [], bennies: 0, rolls: [], applied: []};
    const actor = {id: 'victim', uuid: 'Actor.victim', name: 'Victim', type: 'character',
        system: {stats: {toughness: {value: 10, armor: 4}, globalMods: {ap: [{value: 99}]}},
            attributes: {vigor: {soakBonus: 0}}},
        items: {get() { throw new Error('Fire must not resolve an attack item.'); }}};
    const document = {id: 'victimToken', uuid: 'Scene.original.Token.victimToken', actor};
    const target = {id: document.id, name: 'Victim Token', document, actor}; document.object = target;
    const otherActor = {...actor, id: 'other', uuid: 'Actor.other'};
    const other = {id: 'unrelated', name: 'Other', actor: otherActor,
        document: {uuid: 'Scene.original.Token.unrelated', actor: otherActor}};
    const tokens = new Map([[target.id, target], [other.id, other]]);
    const scene = {id: 'original', tokens: new Map([[document.id, document]])};
    const game = {user: {id: 'gm', isGM: true, targets: new Set([other])},
        actors: new Map([[actor.id, actor]]), scenes: new Map([[scene.id, scene]])};
    const canvas = {scene, tokens: {get: id => tokens.get(id), placeables: [...tokens.values()]}};
    const binding = {version: 1, actorUuid: actor.uuid, targetUuid: document.uuid,
        sceneId: scene.id, targetId: document.id};
    const chat = {rolls: [{total, terms: [{total}]}], flags: {'swade-tools': {
        rolltype: 'damage', userof: 1, useactor: actor.id, aoeFireDamage: binding}},
        isContentVisible: true, async update() { throw new Error('Frozen target must not be replaced.'); }};
    class Char {
        constructor(owner) {this.actor = owner;}
        hasAbilitySetting(name) { return this.actor.abilities?.includes(name) ?? false; }
        spendBenny() { calls.bennies++; return true; }
        is(name) { return this.actor.system.status?.[name] === true; }
        isVehicle() { return this.actor.type === 'vehicle'; }
        applyWounds(number) { calls.wounds.push([this.actor.uuid, number]); }
        on(status) { calls.status.push([this.actor.uuid, status]); }
    }
    class CharRoll {
        constructor(owner) {this.actor = owner; this.flags = {}; calls.rolls.push(this);}
        addFlag(key, value) { this.flags[key] = value; }
        addFlavor() {} addModifier() {} addEdgeModifier() {}
        async rollAtt(attribute) {this.attribute = attribute;}
        async rollSkill() {} display() {this.displayed = true;}
    }
    const gb = {realInt: value => parseInt(value) || 0, trans: value => value,
        raiseCount: (value, tn = 4) => Math.floor((value - tn) / 4),
        setting: () => false, settingKeyName: () => false, systemSetting: () => false,
        isHeavyArmor: () => false, isHeavyWeapon: item => item?.system?.isHeavyWeapon === true,
        getArmorArea: owner => owner.system.stats.toughness.armor,
        actorIsJoker: () => true, mainGM: () => true};
    const context = {...properties, game, canvas, gb, Char, CharRoll, getAoeFireDamageTarget: message =>
        getAoeFireDamageTarget(message, {gameRef: game, canvasRef: canvas}),
        ui: {notifications: {warn: text => calls.warnings.push(text), error: text => calls.warnings.push(text),
            info: text => calls.warnings.push(text)},
            chat: {scrollBottom() {}}}, setTimeout};
    const RollControl = vm.runInNewContext(rollControlSource, context);
    const element = html(), control = new RollControl(chat, element, game.user);
    return {actor, target, other, game, canvas, binding, chat, calls, tokens, scene, control, element, context};
};

test('fire handoff preserves already evaluated damage, original privacy, and one native SWADE roll', async () => {
    const {createAoeFireDamageCard} = await service;
    const damage = {formula: '3d6x', total: 14, _evaluated: true, terms: [{faces: 6, results: [6, 4, 4]}],
        options: {}, async evaluate() {throw new Error('No second roll.');}, async render() {throw new Error('Native SWADE renders once later.');}};
    class SwadeRoll {
        static fromRoll(original) {return Object.assign(new this(), original);}
    }
    let created;
    const result = await createAoeFireDamageCard({actor: {id: 'a', uuid: 'Actor.a'},
        targetUuid: 'Scene.s.Token.t', damage, flavor: 'Fire Damage: 3d6',
        content: '<div>Fire Continues to Burn</div><details><summary>More Details</summary>Check: 3</details>',
        privacy: {whisper: ['gm', {id: 'owner'}], blind: true}, fireFlags: {actorUuid: 'Actor.a', effectUuid: 'Actor.a.ActiveEffect.fire'}},
    {gameRef: {user: {id: 'gm'}}, SwadeRollClass: SwadeRoll,
        ChatMessageClass: {getSpeaker: ({actor}) => ({actor: actor.id}), async create(data) {created = data; return data;}}});
    assert.equal(result, created); assert.equal(created.rolls.length, 1);
    assert.ok(created.rolls[0] instanceof SwadeRoll); assert.equal(created.rolls[0].terms, damage.terms);
    assert.equal(created.rolls[0].total, 14); assert.equal(created.rolls[0]._evaluated, true);
    assert.equal(created.rolls[0].options.rerollable, false); assert.equal(created.rolls[0].options.rollType, 'damage');
    assert.deepEqual(created.whisper, ['gm', 'owner']); assert.equal(created.blind, true);
    assert.equal(created.content.includes('dice-total'), false);
    assert.equal(created.flags['swade-tools'].itemroll, undefined);
    assert.deepEqual(created.flags['swade-tools'].aoeFireDamage, {version: 1, actorUuid: 'Actor.a',
        targetUuid: 'Scene.s.Token.t', sceneId: 's', targetId: 't'});
});

test('core fallback embeds the evaluated dice once when custom HTML suppresses Foundry auto rendering', async () => {
    const {createAoeFireDamageCard} = await service;
    let renders = 0, created;
    const damage = {total: 9, _evaluated: true, async render() {renders++; return '<div class="dice-total">9</div>';},
        async evaluate() {throw new Error('No second roll.');}};
    await createAoeFireDamageCard({actor: {uuid: 'Actor.a'}, targetUuid: 'Scene.s.Token.t', damage,
        content: '<div>Fire Extinguishes</div>'}, {SwadeRollClass: {}, ChatMessageClass: {
        async create(data) {created = data; return data;}}});
    assert.equal(renders, 1); assert.equal((created.content.match(/dice-total/g) ?? []).length, 1);
    assert.match(created.content, /9<\/div><div>Fire Extinguishes/); assert.equal(created.rolls[0], damage);
    assert.deepEqual(created.whisper, []); assert.equal(created.blind, false);
});

test('invalid target and unrolled damage never create a native fire card', async () => {
    const {createAoeFireDamageCard} = await service;
    for (const input of [{targetUuid: 'Actor.a'}, {damage: {total: 9, _evaluated: false}}, {damage: {total: NaN}}]) {
        await assert.rejects(createAoeFireDamageCard({actor: {uuid: 'Actor.a'}, targetUuid: 'Scene.s.Token.t',
            damage: {total: 9, _evaluated: true}, ...input}, {ChatMessageClass: {create() {throw new Error('must not create');}}}), /unavailable/);
    }
});

test('core fallback keeps evaluated damage and apply binding when optional dice rendering fails', async () => {
    const {createAoeFireDamageCard} = await service;
    for (const render of [undefined, async () => {throw new Error('Optional render failed.');}]) {
        let created;
        const damage = {formula: '3d6x<script>', total: 15, _evaluated: true, render};
        await createAoeFireDamageCard({actor: {uuid: 'Actor.a'}, targetUuid: 'Scene.s.Token.t', damage,
            content: '<div>Fire Continues to Burn</div>'}, {SwadeRollClass: {},
            ChatMessageClass: {async create(data) {created = data; return data;}}});
        assert.match(created.content, /dice-total">15/); assert.match(created.content, /3d6x&lt;script&gt;/);
        assert.equal(created.rolls[0], damage); assert.equal(created.flags['swade-tools'].rolltype, 'damage');
        assert.equal(created.flags['swade-tools'].aoeFireDamage.targetUuid, 'Scene.s.Token.t');
    }
});

test('native fire damage applies AP zero against normal armor, never actor AP or weapon bonuses', async () => {
    const f = await fixture(13);
    await f.control.findTargets();
    assert.equal(f.control.targets.length, 1); assert.equal(f.control.targets[0], f.target);
    assert.match(f.control.targetShow, /Targetshaken/); assert.doesNotMatch(f.control.targetShow, /Targetwound/);
    await f.control.targetFunction(f.target.id, 0);
    assert.deepEqual(f.calls.wounds, []); assert.deepEqual(f.calls.status, [['Actor.victim', 'isShaken']]);
    assert.deepEqual([...f.game.user.targets], [f.other]);
});

test('native fire damage retains wound, soak, and GM apply controls without an inventory item', async () => {
    const f = await fixture(18);
    await f.control.findTargets();
    assert.match(f.control.targetShow, /swadetools-applydamage/);
    assert.match(f.control.targetShow, /swadetools-soakdamage/);
    await f.control.targetFunction(f.target.id, 2);
    assert.deepEqual(f.calls.wounds, [['Actor.victim', 2]]);
    assert.deepEqual(f.calls.status, [['Actor.victim', 'isShaken']]);
    await f.control.soakFunction(f.target.id);
    assert.equal(f.calls.bennies, 1); assert.equal(f.calls.rolls.length, 1);
    assert.equal(f.calls.rolls[0].attribute, 'vigor'); assert.equal(f.calls.rolls[0].displayed, true);
    assert.equal(f.calls.rolls[0].flags.rolltype, 'soak');
    assert.equal(f.calls.rolls[0].flags.aoeFireDamage, f.binding);
    assert.equal(f.calls.rolls[0].flags.useactor, f.actor.id);
});

test('environmental fire respects Unstoppable even when its victim has a Joker', async () => {
    const f = await fixture(22); f.actor.abilities = ['Unstoppable'];
    await f.control.findTargets();
    assert.match(f.control.targetShow, /1 Targetwound /);
    assert.doesNotMatch(f.control.targetShow, /3 Targetwounds/);
});

test('fire retains standard Heavy Armor protection, Wound Cap and Hardy handling', async () => {
    const heavy = await fixture(22); heavy.context.gb.isHeavyArmor = () => true;
    await heavy.control.findTargets();
    assert.match(heavy.control.targetShow, /HeavyArmorWarn/);
    assert.doesNotMatch(heavy.control.targetShow, /swadetools-applydamage/);
    const cap = await fixture(50); cap.context.gb.settingKeyName = key => key === 'Wound Cap';
    await cap.control.findTargets(); assert.match(cap.control.targetShow, /4 Targetwounds/);
    const hardy = await fixture(13); hardy.actor.system.status = {isShaken: true}; hardy.actor.abilities = ['Hardy'];
    await hardy.control.findTargets(); await hardy.control.targetFunction(hardy.target.id, 0);
    assert.deepEqual(hardy.calls.wounds, []); assert.deepEqual(hardy.calls.status, []);
    assert.match(hardy.calls.warnings.join(''), /HardyWarn/);
});

test('fire Soak rerolls resolve the exact synthetic victim, never its world actor or another token', async () => {
    const f = await fixture();
    f.actor.uuid = 'Scene.original.Token.victimToken.Actor.victim'; f.binding.actorUuid = f.actor.uuid;
    const baseActor = {...f.actor, uuid: 'Actor.victim'}; f.game.actors.set(f.actor.id, baseActor);
    f.control.rolltype = 'soak'; f.chat.flags['swade-tools'].aoeFireSoakActorUuid = f.actor.uuid;
    assert.equal(f.control.findActor(), f.actor); assert.notEqual(f.control.findActor(), baseActor);
    f.chat.flags['swade-tools'].aoeFireSoakActorUuid = 'Actor.replaced';
    assert.equal(f.control.findActor(), false);
});

test('wrong scene, stale actor or token, and forged target IDs cannot apply or soak fire damage', async () => {
    for (const mutate of [f => {f.canvas.scene = {id: 'different'};},
        f => {f.target.actor = {...f.actor, uuid: 'Actor.replaced'};},
        f => {f.scene.tokens.delete(f.target.id);}, f => {f.tokens.delete(f.target.id);},
        f => {f.binding.targetUuid = 'Scene.original.Token.other';}]) {
        const f = await fixture(); await f.control.findTargets(); mutate(f);
        await f.control.targetFunction(f.target.id, 2); await f.control.soakFunction(f.target.id);
        assert.deepEqual(f.calls.wounds, []); assert.deepEqual(f.calls.status, []);
        assert.equal(f.calls.bennies, 0); assert.equal(f.calls.rolls.length, 0);
        assert.equal(f.calls.warnings.length, 2);
    }
    const f = await fixture(); await f.control.findTargets();
    await f.control.targetFunction(f.other.id, 2); await f.control.soakFunction(f.other.id);
    assert.deepEqual(f.calls.wounds, []); assert.equal(f.calls.bennies, 0);
});

test('unavailable fire target never falls back to current user targets or mutates the card', async () => {
    const f = await fixture(); f.canvas.scene = {id: 'elsewhere'};
    await f.control.findTargets();
    assert.equal(f.control.targets.length, 0); assert.equal(f.control.targetShow, '');
    assert.match(f.element.chunks.join(''), /Open the original scene/);
    assert.equal(f.control.getActor(), null);
});

test('players cannot apply native fire damage and private fire cards expose no target controls', async () => {
    const f = await fixture(); await f.control.findTargets(); f.game.user.isGM = false;
    await f.control.targetFunction(f.target.id, 2);
    assert.deepEqual(f.calls.wounds, []); assert.deepEqual(f.calls.status, []);
    const privateCard = await fixture(); privateCard.chat.isContentVisible = false;
    await privateCard.control.doActions(); assert.deepEqual(privateCard.element.chunks, []);
});

test('fire damage skips environmental rerolls but keeps GM edit; native Soak and ordinary cards keep rerolls', async () => {
    const f = await fixture(); const added = [];
    f.control.addBennyButton = () => added.push('benny'); f.control.addFreeRerollButton = () => added.push('free');
    f.control.addEditButton = () => added.push('edit');
    f.control.addButtons(); assert.deepEqual(added, ['edit']);
    added.length = 0; f.control.rolltype = 'soak'; f.control.addButtons();
    assert.deepEqual(added, ['benny', 'free', 'edit']);
    added.length = 0; delete f.chat.flags['swade-tools'].aoeFireDamage; f.control.rolltype = 'damage';
    f.control.addButtons(); assert.deepEqual(added, ['benny', 'free', 'edit']);
});
