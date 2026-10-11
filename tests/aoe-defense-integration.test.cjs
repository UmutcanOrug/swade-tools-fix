const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {runAttack} = require('./aoe-attack.test.cjs');
const moduleOf = name => import(pathToFileURL(path.join(__dirname, '../scripts/services', name)).href);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Model Foundry's recursive expandObject semantics. Expanding only the outer
// "flags.world.*" key misses UUID-key corruption inside nested flag maps.
const expandDotted = source => {
    if (Array.isArray(source)) return source.map(expandDotted);
    if (!plain(source)) return source;
    const expanded = {};
    for (const [key, value] of Object.entries(source)) {
        const parts = key.split('.');
        const last = parts.pop();
        let current = expanded;
        for (const part of parts) current = current[part] ??= {};
        current[last] = expandDotted(value);
    }
    return expanded;
};
const mergeDocument = (target, change) => {
    for (const [key, value] of Object.entries(change)) {
        if (plain(value) && plain(target[key])) mergeDocument(target[key], value);
        else target[key] = value;
    }
    return target;
};

async function fullAttack({faces = [[4, 2]], dice = [6, 4], autoEvade = true, fire = true,
    flags = {}, flammability, itemType = 'weapon', quantity = 2, fireDice = faces.map(() => 4), targetNames = [],
    fireSwadeRollClass} = {}) {
    const [evade, fireApi, results] = await Promise.all([
        moduleOf('AoeEvade.js'), moduleOf('AoeFire.js'), moduleOf('AoeTargetResults.js')]);
    const calls = [], fireCalls = [], documents = new Map(), updates = [];
    const targets = faces.map((face, index) => {
        const id = `victim-${index + 1}`, actorUuid = `Scene.scene.Token.${id}.Actor.actor-${id}`;
        const actor = {uuid: actorUuid, name: targetNames[index] ?? `Victim ${index + 1}`, isWildcard: true, items: [],
            flags: {'swade-tools': flammability ? {aoeFlammability: flammability} : {}},
            system: {attributes: {agility: {die: {sides: 8}}}}, effects: new Map(),
            async createEmbeddedDocuments(type, entries) {
                assert.equal(type, 'ActiveEffect');
                const effect = {...entries[0], parent: this, id: 'fire', uuid: `${this.uuid}.ActiveEffect.fire`};
                this.effects.set(effect.id, effect); documents.set(effect.uuid, effect); return [effect];
            }};
        const token = {id, name: actor.name, actor, x: 350 + index * 100, y: 20, w: 50, h: 50,
            center: {x: 375 + index * 100, y: 45}, document: {id, uuid: `Scene.scene.Token.${id}`, actor, name: actor.name}};
        documents.set(actor.uuid, actor); documents.set(token.document.uuid, token.document);
        return token;
    });
    const facesByActor = new Map(targets.map((token, index) => [token.actor.uuid, faces[index]]));
    let runtime;
    const attack = await runAttack({name: 'Flamethrower', trait: 'Shooting', range: 'Cone Template',
        dice, itemType, quantity, targetTokens: targets,
        flags: {aoeTemplateShape: 'cone', aoeTemplateOrigin: 'token', aoeAutoEvade: autoEvade,
            aoeEvadeModifier: -2, aoeFireEnabled: fire, aoeFireIntensity: 3, aoeFireMaxIntensity: 3, ...flags},
        configureRuntime: async dependencies => {
            const {game, canvas, scope, ChatMessage, Hooks, ui} = dependencies;
            game.user.active = true;
            game.users = new Map([[game.user.id, game.user]]);
            canvas.scene.id = 'scene';
            game.scenes = new Map([[canvas.scene.id, canvas.scene]]);
            // Native getSpeaker accepts actor-only environmental damage too;
            // the basic attack fixture's speaker stub requires a source token.
            ChatMessage.getSpeaker = ({actor, token}) => ({actor: actor.id ?? actor.uuid,
                token: token?.id, alias: actor.name});
            for (const value of [scope.weaponActor, scope.operatorActor, scope.item]) {
                if (value?.uuid) documents.set(value.uuid, value);
            }
            for (const token of targets) token.document.parent = canvas.scene;

            const create = ChatMessage.create.bind(ChatMessage);
            ChatMessage.create = async data => {
                const message = await create({...data, flags: expandDotted(data.flags ?? {})});
                message.isOwner = true;
                message.update = async change => {
                    updates.push({id: message.id, change: structuredClone(change)});
                    mergeDocument(message, expandDotted(change));
                    return message;
                };
                game.messages.set(message.id, message);
                return message;
            };
            class NativeAgilityRoll {
                constructor(actor) {this.actor = actor; this.modifiers = [];}
                addModifier(value, label) {this.modifiers.push({value, label});}
                async rollAtt(attribute) {
                    assert.equal(attribute, 'agility');
                    const face = facesByActor.get(this.actor.uuid);
                    assert.ok(face, 'Evade must use the actual impacted token actor');
                    const total = Math.max(...face) + this.modifiers.reduce((sum, mod) => sum + mod.value, 0);
                    calls.push({actorUuid: this.actor.uuid, attribute, modifiers: this.modifiers, total});
                    return {total, formula: '{1d8x,1d6x}kh-2',
                        dice: face.map(result => ({results: [{result}], total: result})),
                        toJSON() {return {formula: this.formula, total: this.total};},
                        async render() {return `<div class="dice-roll">Evade ${this.total}</div>`;}};
                }
            }
            runtime = {gameRef: game, canvasRef: canvas, fromUuid: async uuid => documents.get(uuid),
                ChatMessageClass: ChatMessage, CharRollClass: NativeAgilityRoll,
                SwadeRollClass: fireSwadeRollClass,
                RollClass: class {
                    constructor(formula) {this.formula = formula;}
                    async evaluate() {
                        assert.ok(fireDice.length, `No test fire die for ${this.formula}`);
                        this.total = fireDice.shift(); fireCalls.push({formula: this.formula, total: this.total}); return this;
                    }
                    toJSON() {return {formula: this.formula, total: this.total};}
                    async render() {return `<div class="dice-roll">${this.formula}: ${this.total}</div>`;}
                },
                notifications: ui.notifications, Hooks};
            evade.registerAoeEvadeAuthority();
            fireApi.registerAoeFire(runtime);
            // Only canvas placement and the native die adapter are mocked.
            // The macro invokes the actual Evade/Fire services and authority
            // validation with a real persisted attack card and token UUIDs.
            scope.aoeServices.placeWeaponAoeTemplatePoint = async () => ({x: 1000, y: 50, direction: 0});
            scope.aoeServices.resolveAoeEvade = (message, uuid) => evade.resolveAoeEvade(message, uuid, runtime);
            scope.aoeServices.recordAoeFireHit = (message, uuid) => fireApi.recordAoeFireHit(message, uuid, runtime);
        }});
    return {...attack, runtime, api: {evade, fire: fireApi, results}, calls, fireCalls, documents, updates,
        attacks: attack.cards.filter(card => card.flags?.world?.aoeAttack),
        evadeCards: attack.cards.filter(card => card.flags?.world?.aoeEvadeCheck),
        fireCards: attack.cards.filter(card => card.flags?.['swade-tools']?.aoeFireCheck)};
}

module.exports = {fullAttack};
if (require.main === module) {
test('recursive flag expansion reproduces why a literal target UUID is not a persistent map key', () => {
    const expanded = expandDotted({'flags.world.aoeEvadeResults': {'Scene.scene.Token.victim-1': {evaded: false}}});
    assert.equal(expanded.flags.world.aoeEvadeResults['Scene.scene.Token.victim-1'], undefined);
    assert.deepEqual(expanded.flags.world.aoeEvadeResults.Scene.scene.Token['victim-1'], {evaded: false});
});

test('full cone resolves Evade, native damage and automatic default ignition on one attack card', async () => {
    const s = await fullAttack();
    assert.equal(s.attacks.length, 1); assert.equal(s.evadeCards.length, 0); assert.equal(s.fireCards.length, 0);
    assert.equal(s.cards.length, 1, 'Defense and fire may not add separate chat messages');
    assert.equal(s.nativeCards.length, 1); assert.equal(s.nativeCards[0].targets, 'victim-1');
    const attack = s.attacks[0], uuid = s.victims[0].document.uuid;
    assert.equal(attack.flags.world.aoeAttack.autoEvade, true);
    assert.equal(attack.flags.world.aoeAttack.fire.enabled, true);
    assert.equal(s.calls.length, 1); assert.equal(s.calls[0].total, 2);
    assert.deepEqual(s.calls[0].modifiers, [{value: -2, label: 'Evade'}]);
    assert.equal(s.api.results.getAoeTargetResult(attack.flags.world.aoeEvadeResults, uuid).evaded, false);
    const fire = s.api.results.getAoeTargetResult(attack.flags.world.aoeFireResults, uuid);
    assert.equal(fire.status, 'not-ignited'); assert.equal(fire.check, 4); assert.equal(fire.threshold, 6);
    assert.match(attack.content, /Evade: 2 — Hit/);
    assert.match(attack.content, /Fire: 4\/6 — No ignition/);
    assert.match(attack.content, /<summary>AoE Details<\/summary>/);
    assert.equal(Object.hasOwn(attack.flags.world.aoeEvadeResults, uuid), false);
    assert.equal(Object.hasOwn(attack.flags.world.aoeFireResults, uuid), false);
    assert.equal(s.events.filter(event => event === 'ammo').length, 1);
    const repeated = await s.api.evade.resolveAoeEvade(attack, uuid, s.runtime);
    assert.equal(repeated.allowed, true); assert.equal(s.calls.length, 1);
    await s.api.fire.recordAoeFireHit(attack, uuid, s.runtime);
    assert.equal(s.fireCalls.length, 1, 'Retry must not reroll ignition');
});

test('full cone attack with successful Evade persists Evaded and never rolls damage or offers Fire Check', async () => {
    const s = await fullAttack({faces: [[6, 3]]});
    assert.equal(s.evadeCards.length, 0); assert.equal(s.nativeCards.length, 0); assert.equal(s.fireCards.length, 0);
    assert.equal(s.fireCalls.length, 0);
    const attack = s.attacks[0], uuid = s.victims[0].document.uuid;
    assert.equal(s.api.results.getAoeTargetResult(attack.flags.world.aoeEvadeResults, uuid).evaded, true);
    assert.match(attack.content, /Victim 1: Evaded/);
    assert.doesNotMatch(attack.content, /data-aoe-damage-target=/);
    assert.equal(s.api.results.getAoeTargetResult(attack.flags.world.aoeFireResults, uuid), undefined);
});

test('full cone processes independent victims without losing the earlier encoded result through flag merges', async () => {
    const s = await fullAttack({faces: [[6, 3], [4, 2], [3, 2]], fireDice: [2, 6, 11]});
    const attack = s.attacks[0], uuids = s.victims.map(token => token.document.uuid);
    assert.equal(s.calls.length, 3); assert.equal(s.evadeCards.length, 0);
    assert.equal(s.nativeCards.length, 2); assert.equal(s.fireCards.length, 0);
    assert.equal(s.cards.length, 2, 'Only the actual ignition adds a native fire damage card, not an extra check card');
    const fireDamage = s.cards.find(card => card.flags?.['swade-tools']?.aoeFireDamage);
    assert.equal(fireDamage.rolls[0].total, 11);
    assert.equal(fireDamage.flags['swade-tools'].aoeFireDamage.targetUuid, uuids[2]);
    assert.deepEqual(s.nativeCards.map(card => card.targets), ['victim-2', 'victim-3']);
    assert.deepEqual(uuids.map(uuid => s.api.results.getAoeTargetResult(attack.flags.world.aoeEvadeResults, uuid).evaded),
        [true, false, false]);
    assert.equal(s.api.results.getAoeTargetResult(attack.flags.world.aoeFireResults, uuids[0]), undefined);
    assert.equal(s.api.results.getAoeTargetResult(attack.flags.world.aoeFireResults, uuids[1]).status, 'not-ignited');
    const ignited = s.api.results.getAoeTargetResult(attack.flags.world.aoeFireResults, uuids[2]);
    assert.equal(ignited.status, 'burning'); assert.equal(ignited.damageTotal, 11);
    assert.equal(s.victims[2].actor.effects.get('fire').name, 'On Fire');
    assert.deepEqual(s.victims[2].actor.effects.get('fire').statuses, ['swade-tools-on-fire']);
    assert.match(attack.content, /Victim 1: Evaded/);
    assert.match(attack.content, /Victim 2: Hit/);
    assert.match(attack.content, /Victim 3: Hit/);
    assert.match(attack.content, /Fire: 6\/6 — On Fire · Damage 11 \(3d6\)/);
    assert.equal(s.events.filter(event => event === 'ammo').length, 1);
});

test('actual services respect opt-ins and a failed cone cannot enter automatic defense or fire', async () => {
    const disabled = await fullAttack({autoEvade: false, fire: false});
    assert.equal(disabled.calls.length, 0); assert.equal(disabled.evadeCards.length, 0);
    assert.equal(disabled.nativeCards.length, 1); assert.equal(disabled.fireCards.length, 0);
    const failed = await fullAttack({dice: [2, 3]});
    assert.equal(failed.calls.length, 0); assert.equal(failed.evadeCards.length, 0);
    assert.equal(failed.nativeCards.length, 0); assert.equal(failed.fireCards.length, 0);
    assert.equal(failed.attacks[0].flags.world.aoeAttack.success, false);
});
}
