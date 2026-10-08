const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const service = import(pathToFileURL(path.join(__dirname, '../scripts/services/AoeResourceService.js')).href);
const owner = type => ({id: `owner-${type}`, type, isOwner: true, items: []});
const makeWeapon = (actor, overrides = {}) => {
    const item = { id: 'cannon', uuid: `Actor.${actor.id}.Item.cannon`, type: 'weapon',
        name: 'HE Cannon', actor, isOwner: true, flags: {}, calls: [],
        system: {quantity: 1, shots: 8, currentShots: 8, reloadType: 'single', actions: {trait: 'Gunnery'}, ...overrides},
        canExpendResources(cost) { return this.system.currentShots >= cost; },
        async consume(cost) { this.calls.push(['consume', cost]); await Promise.resolve(); this.system.currentShots -= cost; },
        async update(changes) { this.calls.push(['update', changes]); if ('system.quantity' in changes) this.system.quantity = changes['system.quantity']; },
    };
    actor.items.push(item);
    return item;
};
test('tank HE uses native ammunition and never reduces gun quantity', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle);
    const result = await aoeResource.spend(gun, vehicle, {ammoManagement: true, consume: true});
    assert.equal(result.ok, true); assert.equal(result.consumed, 1);
    assert.equal(gun.system.currentShots, 7); assert.equal(gun.system.quantity, 1);
    assert.deepEqual(gun.calls, [['consume', 1]]);
});
test('unloaded cannon cannot fire and does not change quantity', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle, {currentShots: 0});
    const result = await aoeResource.spend(gun, vehicle, {ammoManagement: true});
    assert.equal(result.ok, false); assert.equal(result.reason, 'insufficient');
    assert.equal(gun.system.quantity, 1); assert.equal(gun.calls.length, 0);
});
test('consume off or global ammunition management off changes no ranged resources', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle);
    for (const options of [{ammoManagement: true, consume: false}, {ammoManagement: false}]) {
        const result = await aoeResource.spend(gun, vehicle, options);
        assert.equal(result.ok, true); assert.equal(result.consumed, 0);
    }
    assert.equal(gun.calls.length, 0);
});
test('legacy hand grenade consumes one quantity but not extra ammunition', async () => {
    const {aoeResource} = await service;
    const actor = owner('character');
    const grenade = makeWeapon(actor, {quantity: 3, shots: 1, currentShots: 0, actions: {trait: 'Athletics'}});
    grenade.name = 'Throw Grenade';
    const result = await aoeResource.spend(grenade, actor, {ammoManagement: true, legacyGrenade: true});
    assert.equal(result.ok, true); assert.equal(result.source, 'quantity');
    assert.equal(grenade.system.quantity, 2); assert.equal(grenade.system.currentShots, 0);
    assert.equal(grenade.calls.length, 1); assert.equal(grenade.calls[0][0], 'update');
});
test('mounted or Gunnery grenade launcher is not consumed as a grenade', async () => {
    const {aoeResource} = await service;
    for (const type of ['vehicle', 'character']) {
        const actor = owner(type), launcher = makeWeapon(actor);
        launcher.name = 'Grenade Launcher';
        const result = await aoeResource.spend(launcher, actor, {ammoManagement: true, legacyGrenade: true});
        assert.equal(result.source, 'magazine'); assert.equal(launcher.system.quantity, 1);
        assert.deepEqual(launcher.calls, [['consume', 1]]);
    }
});
test('per-item ammunition cost is supported and resource APIs resolving void count as success', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle);
    gun.flags['swade-tools'] = {aoeAmmoCost: 2};
    const result = await aoeResource.spend(gun, vehicle, {ammoManagement: true});
    assert.equal(result.consumed, 2); assert.equal(gun.system.currentShots, 6);
});
test('per-item resource lock rejects simultaneous consumption', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle);
    const results = await Promise.all([aoeResource.spend(gun, vehicle, {ammoManagement: true}), aoeResource.spend(gun, vehicle, {ammoManagement: true})]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok).reason, 'busy');
    assert.equal(gun.calls.length, 1);
});
test('permission or unavailable native weapon API blocks mutation', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle);
    gun.isOwner = false;
    assert.equal(aoeResource.validate(gun, vehicle, {ammoManagement: true}).reason, 'permission');
    gun.isOwner = true; delete gun.consume;
    assert.equal(aoeResource.validate(gun, vehicle, {ammoManagement: true}).reason, 'unsupported');
    assert.equal(gun.calls.length, 0);
});
test('linked inventory ammo validates stock and uses the weapon API once', async () => {
    const {aoeResource} = await service;
    const vehicle = owner('vehicle'), gun = makeWeapon(vehicle, {reloadType: 'none', ammo: 'HE Shells', usesAmmoFromInventory: true});
    const shells = {name: 'HE Shells', id: 'shells', uuid: 'Actor.vehicle.Item.shells', type: 'gear', system: {quantity: 2}};
    vehicle.items.push(shells);
    gun.canExpendResources = cost => shells.system.quantity >= cost;
    gun.consume = async cost => { gun.calls.push(['consume', cost]); shells.system.quantity -= cost; };
    const result = await aoeResource.spend(gun, vehicle, {ammoManagement: true});
    assert.equal(result.source, 'inventory'); assert.equal(shells.system.quantity, 1);
    assert.equal(gun.system.quantity, 1);
    shells.system.quantity = 0;
    assert.equal(aoeResource.validate(gun, vehicle, {ammoManagement: true}).ok, false);
});
test('self-consuming native weapons and consumable stacks use their own resource model', async () => {
    const {aoeResource} = await service;
    const actor = owner('character'), grenade = makeWeapon(actor, {reloadType: 'self', shots: 1, currentShots: 1, quantity: 3});
    assert.equal(aoeResource.describe(grenade, actor, {ammoManagement: true}).available, 3);
    assert.equal((await aoeResource.spend(grenade, actor, {ammoManagement: true})).source, 'self');
    const consumable = {id: 'charges', type: 'consumable', isOwner: true,
        system: {quantity: 2, charges: {default: {value: 3, max: 5}}}, consumeCalls: [],
        async consume(cost) { this.consumeCalls.push(cost); }};
    assert.equal(aoeResource.describe(consumable, actor).available, 8);
    assert.equal((await aoeResource.spend(consumable, actor)).ok, true);
    assert.deepEqual(consumable.consumeCalls, [1]);
});
test('vehicle ItemDialog preserves mounted item and accepts explicit gunner', () => {
    const text = fs.readFileSync(path.join(__dirname, '../scripts/class/ItemDialog.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace('export default class ItemDialog', 'class ItemDialog');
    const Default = {id: 'driver'}, Gunner = {id: 'gunner'};
    const actor = owner('vehicle'), gun = makeWeapon(actor);
    actor.items.get = id => actor.items.find(item => item.id === id);
    actor.system = {getCrewMemberForWeapon: () => Default};
    const ItemDialog = vm.runInNewContext(`${text}\nItemDialog;`, {
        CharRoll: class {constructor(actor) {this.actor = actor;}},
        gb: {getDriver: () => {throw new Error('Legacy driver should not be used');}},
    });
    const explicit = new ItemDialog(actor, gun.id, Gunner);
    assert.equal(explicit.item, gun); assert.equal(explicit.vehicle, actor); assert.equal(explicit.actor, Gunner);
    const nativeDefault = new ItemDialog(actor, gun.id);
    assert.equal(nativeDefault.actor, Default);
});
