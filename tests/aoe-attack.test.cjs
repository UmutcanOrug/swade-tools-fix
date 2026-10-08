const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const services = path.join(root, 'scripts/services');
const source = fs.readFileSync(path.join(services, 'grenade-attack.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, value => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]));
const collection = items => Object.assign(items, {
  get(id) { return this.find(item => item.id === id); },
  getName(name) { return this.find(item => item.name === name); },
});
const skill = (id, name, sides = 8, swid = name.toLowerCase()) => ({
  id, uuid: `Actor.gunner.Item.${id}`, name, type: 'skill',
  system: {swid, die: {sides, modifier: 0}, 'wild-die': {sides: 6}},
});
const loadServices = async () => ({
  ...await import(pathToFileURL(path.join(services, 'AoeAttackProfile.js'))),
  ...await import(pathToFileURL(path.join(services, 'AoeResourceService.js'))),
});

// Execute the full bundled attack. Only the Foundry UI/documents and dice are
// mocked; item/operator resolution, saved configuration and ammo are real.
async function runAttack({vehicle = false, flags = {}, name = 'HE Cannon',
  trait = 'Gunnery', category = '', quantity = 1, currentShots = 4,
  dice = [6, 4], canceled = false, actorSkills, manualChoice,
  crewForWeapon = true, legacyDriver = false, nativeDamage = true,
  damage = '3d6', additional = {}, failureOnSpend = false, ammoManagement = true,
  noOperator = false, globalMods = {}, skillEffects = [], itemModifier = '', rollData = {}, secondaryWeapon = false,
  wildcard = true, itemType = 'weapon', charges, destroyOnEmpty = false} = {}) {
  const profile = await loadServices();
  const events = [], notices = [], cards = [], nativeCalls = [], nativeCards = [];
  const queue = [...dice], hooks = new Map(), timers = new Map();
  let nextId = 0, crosshairCalls = 0, setupDialogs = 0, quantityUpdates = 0;
  const gunner = {
    id: 'gunner', uuid: 'Actor.gunner', name: 'Assigned Gunner', type: 'character', isOwner: true,
    system: {wildcard, wounds: {value: 0}, fatigue: {value: 0}, bennies: {value: 3}, stats: {globalMods}},
    items: collection(actorSkills ?? [skill('gunnery', 'Gunnery', 10), skill('shooting', 'Shooting')]),
    getRollData: () => rollData,
    async spendBenny() { events.push('benny'); this.system.bennies.value--; return true; },
  };
  gunner.items.find(item => item.type === 'skill').system.effects = skillEffects;
  gunner.items.find(item => item.type === 'skill').system.attribute = 'smarts';
  const other = {...gunner, id: 'other', uuid: 'Actor.other', name: 'Other Gunner',
    items: collection([skill('gunnery2', 'Gunnery', 12)])};
  const owner = vehicle ? {
    id: 'tank', uuid: 'Actor.tank', name: 'Tank', type: 'vehicle', isOwner: true,
    items: collection([]),
    system: noOperator ? {} : legacyDriver ? {driver: {id: 'Actor.gunner'}} : {
      operator: gunner,
      ...(crewForWeapon ? {getCrewMemberForWeapon: () => gunner} : {}),
    },
  } : gunner;
  const weapon = {id: 'weapon', uuid: `${owner.uuid}.Item.weapon`, name, type: itemType,
    isOwner: true, actor: owner, parent: owner,
    flags: {'swade-tools': {aoeEnabled: true, ...flags}},
    system: {quantity, currentShots, shots: 4, reloadType: 'single', category, charges, destroyOnEmpty,
      actions: {trait, traitMod:itemModifier, additional}, damage, range: '10/20/40', templates: {medium: true}, ap: 1},
    getFlag(_scope, key) { return this.flags['swade-tools'][key]; },
    canExpendResources(cost) { return this.system.currentShots >= cost; },
    async consume(cost) { events.push('ammo'); if (failureOnSpend) throw Error('mock failure'); this.system.currentShots -= cost; },
    async update(change) { events.push('quantity'); quantityUpdates++; this.system.quantity = change['system.quantity']; },
  };
  owner.items.push(weapon);
  if (secondaryWeapon) owner.items.push({...weapon,id:'other-grenade',uuid:`${owner.uuid}.Item.other-grenade`,
    name:'Other Grenade',system:{...weapon.system,damage:'9d6'}});
  const token = {id: 'source', actor: owner, x: 0, y: 0, w: 100, h: 100,
    center: {x: 50, y: 50}, document: {id: 'source', uuid: 'Scene.scene.Token.source'}};
  const victims = ['one','two'].map(id => ({id, name: `Target ${id}`, isVisible: true,
    actor: {name: id}, center: {x: 100, y: 100}, document: {uuid: `Scene.scene.Token.${id}`}}));
  const scene = {grid: {distance: 1, size: 100, units: 'in.'}, templates: new Map(),
    async createEmbeddedDocuments(_type, data) {
      events.push('template'); const doc = {...data[0], id: 'template',
        async update(change) { Object.assign(this, change); }};
      this.templates.set(doc.id, doc); return [doc];
    }};
  const messages = new Map();
  const Hooks = {on(name, callback) { const id = ++nextId; hooks.set(id, {name, callback}); return id; },
    off(_name, id) { hooks.delete(id); }};
  const emit = (name, ...args) => {
    for (const handler of [...hooks.values()]) if (handler.name === name) handler.callback(...args);
  };
  class MockRoll {
    static validate(formula) { return /^[\d() +\-]+$/.test(formula); }
    static replaceFormulaData(formula, data) {
      return formula.replace(/@([A-Za-z0-9_.]+)/g, (_match, reference) =>
        String(reference.split('.').reduce((value,key)=>value?.[key],data) ?? 0));
    }
    constructor(formula, data = {}) { this.formula = formula; this.data = data; this.dice = []; }
    async evaluate() {
      events.push(`roll:${this.formula}`);
      if (/^1d\d+x?$/.test(this.formula)) {
        assert.ok(queue.length, 'No unexpected attack dice'); this.total = queue.shift();
        this.dice = [{results: [{result: this.total}]}];
      } else {
        const expression = MockRoll.replaceFormulaData(this.formula,this.data);
        assert.match(expression, /^[\d() +\-]+$/); this.total = Function(`return (${expression})`)();
      }
      return this;
    }
    async render({flavor}) { return `<div>${escapeHTML(flavor)}: ${this.total}</div>`; }
    toJSON() { return {formula: this.formula, total: this.total}; }
  }
  const platform = {document: {addEventListener() {}}};
  const game = {
    user: {id: 'gm', isGM: true, bennies: 3, async spendBenny() { this.bennies--; return true; }},
    actors: collection([owner, gunner, other]), messages,
    modules: new Map([['sequencer',{active:true}], ['swade-tools',{active:nativeDamage}]]),
    settings: {get(namespace, key) { return namespace === 'swade' && key === 'ammoManagement' && ammoManagement; }},
    i18n: {localize: key => key.split('.').at(-1)},
    swadetools: {async item(actualOwner, id, operator, options) {
      nativeCalls.push({actualOwner, id, operator, options});
      const raiseCheckbox = {checked: false}, actionSelect = {options: Object.keys(additional).map(value => ({value})), value: ''};
      const main = {dataset: {button: 'mainDamage'}, textContent: 'Damage', click() {
        const message = {id: `damage-${++nextId}`, flags: {'swade-tools': {rolltype: 'damage', itemroll: id}},
          updateSource(change) { this.targets = change['flags.swade-tools.usetarget']; }};
        emit('preCreateChatMessage', message, {flags: message.flags}, {}, 'gm');
        message.raise = raiseCheckbox.checked; message.action = actionSelect.value;
        messages.set(message.id, message); nativeCards.push(message);
      }};
      const buttons = [...(damage ? [main] : []), ...Object.keys(additional).map(key => ({...main, textContent: additional[key].name, dataset: {button: key}}))];
      const dom = {querySelectorAll: () => buttons,
        querySelector: selector => selector === '#raise' ? raiseCheckbox : selector === '#actiondmg' ? actionSelect : null};
      emit('renderDialog', {title: name}, dom);
    }},
  };
  const Sequencer = {Database: {entryExists: () => false}, Crosshair: {
    PLACEMENT_RESTRICTIONS: {ANYWHERE: 'anywhere'}, CALLBACKS: {CANCEL: 'cancel'},
    async show(config) { crosshairCalls++; events.push('crosshair'); return canceled ? null : {x: 100, y: 100, config}; },
  }};
  platform.Sequencer = Sequencer;
  const dependencies = {
    scope: {actor: vehicle ? owner : gunner, operatorActor: vehicle ? null : gunner,
      weaponActor: owner, item: manualChoice ? null : weapon, token,
      aoeServices: {...profile, aoeResource: {
        describe: (item, actualOwner, opts) => profile.aoeResource.describe(item, actualOwner, {...opts, ammoManagement}),
        validate: (item, actualOwner, opts) => profile.aoeResource.validate(item, actualOwner, {...opts, ammoManagement}),
        spend: (item, actualOwner, opts) => profile.aoeResource.spend(item, actualOwner, {...opts, ammoManagement}),
      }}},
    game, Roll: MockRoll, Hooks, Sequencer, globalThis: platform, CONFIG: {},
    canvas: {scene, grid: {size: 100}, tokens: {controlled: [token], placeables: victims}},
    ui: {notifications: Object.fromEntries(['warn','error','info'].map(kind => [kind, text => notices.push({kind, text})]))},
    foundry: {utils: {escapeHTML, randomID: () => 'aoe-session', getRoute: value => value,
      getProperty(object, name) { return name.split('.').reduce((value, key) => value?.[key], object); }},
      applications: {api: {DialogV2: {async prompt() {
        setupDialogs++; return {grenadeId:'weapon', attackSkill:manualChoice ?? 'auto', otherModifier:0, consume: true};
      }}}}},
    CONST: {GRID_SNAPPING_MODES: {CENTER: 1, VERTEX: 2}},
    ChatMessage: {getSpeaker: input => ({actor: input.actor.uuid, token: input.token.id}),
      async create(data) {const message = {...data, id: 'attack-card', async update(change) {Object.assign(this, change);}};
        cards.push(message); return message;}},
    fromUuid: async reference => [owner,gunner,other].find(actor => actor.uuid === reference),
    setTimeout(callback, ms) { const id = ++nextId; if (ms <= 100) callback(); else timers.set(id,callback); return id; },
    clearTimeout: id => timers.delete(id),
  };
  await new AsyncFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  return {weapon, owner, gunner, other, events, notices, cards, nativeCalls, nativeCards,
    crosshairCalls, setupDialogs, quantityUpdates, scene, platform, queue};
}

test('AoE core parses as a Foundry async macro and never modifies user target rings', () => {
  assert.doesNotThrow(() => new AsyncFunction('scope', source));
  assert.ok(!/setTarget\(|updateTokenTargets\(/.test(source));
  assert.ok(!/Use Result|DialogV2\.wait/.test(source));
});

test('skill resolver supports arbitrary skill ID, name, SWID and saved override', async () => {
  const {resolveAoeSkill} = await loadServices();
  const actor = {items: collection([skill('artillery-id', 'Heavy Gunnery', 10, 'gunnery-heavy')])};
  for (const trait of ['artillery-id','heavy gunnery','GUNNERY HEAVY']) {
    assert.equal(resolveAoeSkill(actor, {system:{actions:{trait}}}).id, 'artillery-id');
  }
  assert.equal(resolveAoeSkill(actor, {system:{actions:{trait:'Shooting'}}}, 'artillery-id').id, 'artillery-id');
  assert.equal(resolveAoeSkill(actor, {system:{actions:{trait:'Piloting'}}}), null);
});

test('tank uses assigned gunner Gunnery and native damage, consumes one shell not gun quantity', async () => {
  const s = await runAttack({vehicle: true});
  assert.equal(s.setupDialogs, 0); assert.equal(s.crosshairCalls, 1);
  assert.equal(s.weapon.system.currentShots, 3); assert.equal(s.weapon.system.quantity, 1);
  assert.equal(s.quantityUpdates, 0); assert.match(s.cards[0].content, /Gunnery:<\/strong> 6/);
  assert.match(s.cards[0].content, /Assigned Gunner; <strong>Vehicle:<\/strong> Tank/);
  assert.deepEqual(s.nativeCards.map(card => card.targets), ['one','two']);
  assert.ok(s.nativeCalls.every(call => call.actualOwner === s.owner && call.operator === s.gunner));
});

test('current vehicle operator and legacy driver both resolve without vehicle Athletics', async () => {
  for (const opts of [{crewForWeapon:false}, {legacyDriver:true}]) {
    const s = await runAttack({vehicle: true, ...opts});
    assert.equal(s.cards.length, 1); assert.match(s.cards[0].content, /Gunnery/);
  }
});

test('GM tank with no assigned crew/operator never silently picks a random world actor', async () => {
  const s = await runAttack({vehicle:true, noOperator:true});
  assert.equal(s.crosshairCalls,0); assert.equal(s.cards.length,0);
  assert.equal(s.weapon.system.currentShots,4);
  assert.ok(!s.events.some(event=>event.startsWith('roll:')));
  assert.ok(s.notices.some(notice=>/Assign a gunner or operator/.test(notice.text)));
  const manual = await runAttack({vehicle:true,noOperator:true,manualChoice:'Actor.other|gunnery2'});
  assert.equal(manual.cards.length,1);
  assert.ok(manual.nativeCalls.every(call=>call.operator===manual.other));
});

test('deleted saved damage action is rejected before spending a shell or creating a template', async () => {
  const s = await runAttack({vehicle:true,flags:{aoeDamageAction:'missing-he'}});
  assert.equal(s.cards.length,0); assert.equal(s.crosshairCalls,0);
  assert.equal(s.weapon.system.currentShots,4);
  assert.ok(s.notices.some(notice=>/configured AoE damage action no longer exists/.test(notice.text)));
});

test('new explicitly enabled AoE item never borrows damage from an unrelated grenade', async () => {
  const s = await runAttack({name:'Throw Grenade',damage:'',secondaryWeapon:true});
  assert.equal(s.cards.length,1); assert.equal(s.nativeCards.length,0);
  assert.match(s.cards[0].content,/No direct damage is configured/);
  assert.ok(!/9d6/.test(s.cards[0].content));
});

test('saved AoE skill, blast size, consume flag and damage action apply on direct use', async () => {
  const s = await runAttack({flags:{aoeSkill:'Shooting', aoeBlastSize:'large', aoeConsume:false, aoeDamageAction:'he'},
    additional:{he:{type:'damage',name:'HE Damage',override:'4d6',ap:2}}, dice:[8,3]});
  assert.equal(s.weapon.system.currentShots,4); assert.equal(s.setupDialogs,0);
  assert.match(s.cards[0].content,/Shooting:<\/strong> 8/); assert.match(s.cards[0].content,/Large Blast Template/);
  assert.match(s.cards[0].content,/4d6; AP 2/);
  assert.equal(s.scene.templates.get('template').distance,3);
  assert.ok(s.nativeCards.every(card => card.action === 'he' && card.raise));
});

test('Benny rerolls Gunnery within the same attack, with no extra shot/template or damage', async () => {
  const s = await runAttack({vehicle:true,dice:[5,3,9,4]});
  const runtime = s.platform.__swadeGrenadeBennyRuntime;
  await runtime.handlers.get('aoe-session')('actor');
  assert.equal(s.gunner.system.bennies.value,2); assert.equal(s.weapon.system.currentShots,3);
  assert.equal(s.events.filter(event => event==='ammo').length,1);
  assert.equal(s.events.filter(event => event==='template').length,1);
  assert.equal(s.nativeCards.length,2); assert.match(s.cards[0].content,/Gunnery:<\/strong> 9/);
  assert.match(s.cards[0].content,/Gunnery gained a Raise/);
});

test('critical Gunnery reroll overrides a prior hit and cannot spend another Benny without Dumb Luck', async () => {
  const s = await runAttack({vehicle:true, dice:[6,4,1,1]});
  const reroll = s.platform.__swadeGrenadeBennyRuntime.handlers.get('aoe-session');
  await reroll('actor'); await reroll('actor');
  assert.equal(s.gunner.system.bennies.value,2);
  assert.match(s.cards[0].content,/Critical Failure/);
  assert.equal(s.scene.templates.get('template').fillColor,'#d62828');
  assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
  assert.match(s.cards[0].content,/Gunnery changed after damage was rolled/);
});

test('failed AoE attack can Benny reroll to a hit and roll previously pending damage once', async () => {
  const s = await runAttack({vehicle:true, dice:[2,3,6,4]});
  assert.equal(s.nativeCards.length,0);
  await s.platform.__swadeGrenadeBennyRuntime.handlers.get('aoe-session')('actor');
  assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
  assert.match(s.cards[0].content,/Gunnery:<\/strong> 6/);
  assert.equal(s.events.filter(event=>event==='template').length,1);
});

test('disabled SWADE ammo management keeps magazine and tank gun quantity unchanged', async () => {
  const s = await runAttack({vehicle:true, ammoManagement:false, currentShots:0});
  assert.equal(s.weapon.system.currentShots,0); assert.equal(s.weapon.system.quantity,1);
  assert.equal(s.events.filter(event=>event==='ammo').length,0);
  assert.equal(s.cards.length,1); assert.equal(s.nativeCards.length,2);
});

test('saved ammunition cost expends exactly the configured count, once', async () => {
  const s = await runAttack({vehicle:true, flags:{aoeAmmoCost:2}});
  assert.equal(s.weapon.system.currentShots,2); assert.equal(s.weapon.system.quantity,1);
  assert.equal(s.events.filter(event=>event==='ammo').length,1);
});

test('prepared Gunnery effects and global trait/attribute/attack modifiers apply once without Benny stacking', async () => {
  const s = await runAttack({vehicle:true,dice:[5,3,6,4,7,5],
    skillEffects:[{label:'Skill bonus',value:2},{value:99,ignore:true}],
    globalMods:{trait:[{value:1}],smarts:[{value:2}],attack:[{value:1}],bennyTrait:[{value:2}]}});
  assert.match(s.cards[0].content,/Gunnery:<\/strong> 11/);
  const reroll = s.platform.__swadeGrenadeBennyRuntime.handlers.get('aoe-session');
  await reroll('actor'); assert.match(s.cards[0].content,/Gunnery:<\/strong> 14/);
  await reroll('actor'); assert.match(s.cards[0].content,/Gunnery:<\/strong> 15/);
  assert.match(s.cards[0].content,/Total Modifier:<\/strong> \+8/);
  assert.equal(s.weapon.system.currentShots,3);
});

test('prepared @field formulas use the chosen gunner roll data', async () => {
  const s = await runAttack({vehicle:true,rollData:{bonus:2},
    globalMods:{attack:[{label:'Crew fire control',value:'@bonus+1'}]}});
  assert.match(s.cards[0].content,/Gunnery:<\/strong> 9/);
  assert.match(s.cards[0].content,/Prepared effects: Crew fire control: @bonus\+1/);
});

test('invalid configured modifier formula or missing @field cannot consume ammunition', async () => {
  for (const opts of [{itemModifier:'broken formula'},{itemModifier:'@missing.field'},
    {globalMods:{attack:[{value:'not a formula'}]}}, {globalMods:{bennyTrait:[{value:'@missing'}]}}]) {
    const s = await runAttack({vehicle:true,...opts});
    assert.equal(s.cards.length,0); assert.equal(s.crosshairCalls,0);
    assert.equal(s.weapon.system.currentShots,4);
    assert.ok(s.notices.some(notice=>/invalid roll formula|unavailable field/.test(notice.text)));
  }
});

test('manual all-skills override can choose another owned vehicle gunner', async () => {
  const s = await runAttack({vehicle:true,manualChoice:'Actor.other|gunnery2'});
  assert.equal(s.setupDialogs,1); assert.ok(s.events.includes('roll:1d12x'));
  assert.ok(s.nativeCalls.every(call => call.operator === s.other && call.actualOwner === s.owner));
});

test('canceling placement, disabled AoE, missing skill or empty magazine never consumes or rolls', async () => {
  const scenarios = [
    {canceled:true}, {flags:{aoeEnabled:false}}, {currentShots:0},
    {trait:'Missing Gunnery'},
  ];
  for (const opts of scenarios) {
    const s = await runAttack(opts); assert.equal(s.cards.length,0);
    assert.equal(s.events.filter(event=>event==='ammo').length,0);
    assert.ok(!s.events.some(event=>event.startsWith('roll:')));
    assert.equal(s.events.filter(event=>event==='template').length,0);
  }
});

test('legacy thrown grenade retains quantity consumption but reusable launcher does not', async () => {
  const grenade = await runAttack({name:'Throw Grenade',trait:'Athletics',category:'Throwable',quantity:2,
    actorSkills:[skill('athletics','Athletics')],flags:{aoeEnabled:undefined}});
  assert.equal(grenade.weapon.system.quantity,1); assert.equal(grenade.weapon.system.currentShots,4);
  const launcher = await runAttack({name:'Grenade Launcher',trait:'Gunnery'});
  assert.equal(launcher.weapon.system.quantity,1); assert.equal(launcher.weapon.system.currentShots,3);
});

test('Extra natural 1 is an ordinary failure when confirmation d6 is not 1, even with positive modifiers', async () => {
  const s = await runAttack({wildcard:false, dice:[1,4,6], globalMods:{attack:[{value:5}]}});
  assert.match(s.cards[0].content, /Failure - Resolve Deviation/);
  assert.match(s.cards[0].content, /Critical Failure not confirmed/);
  assert.equal(s.nativeCards.length,0);
  assert.equal(s.cards[0].rolls[1].formula,'1d6');
  await s.platform.__swadeGrenadeBennyRuntime.handlers.get('aoe-session')('actor');
  assert.equal(s.gunner.system.bennies.value,2);
  assert.match(s.cards[0].content, /Success with a Raise/);
  assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
});

test('Extra confirmed critical failure locks Benny rerolls while an ordinary natural 1 cannot replace a hit', async () => {
  const critical = await runAttack({wildcard:false, dice:[1,1]});
  assert.match(critical.cards[0].content,/Confirmed Critical Failure/);
  await critical.platform.__swadeGrenadeBennyRuntime.handlers.get('aoe-session')('actor');
  assert.equal(critical.gunner.system.bennies.value,3);
  const hit = await runAttack({wildcard:false, dice:[6,1,4]});
  await hit.platform.__swadeGrenadeBennyRuntime.handlers.get('aoe-session')('actor');
  assert.match(hit.cards[0].content,/Gunnery:<\/strong> 6/);
  assert.match(hit.cards[0].content,/Natural 1 failure/);
  assert.equal(hit.nativeCards.length,2);
});

test('gear AoE uses a named native damage action without requiring a main Damage button', async () => {
  const s = await runAttack({itemType:'gear', quantity:2, damage:'',
    additional:{he:{type:'damage',name:'HE Blast',override:'3d6'}}, flags:{aoeDamageAction:'he'}});
  assert.equal(s.weapon.system.quantity,1);
  assert.equal(s.nativeCards.length,2);
  assert.ok(s.nativeCards.every(card=>card.action==='he'));
  assert.ok(s.nativeCalls.every(call=>call.options.damageOnly===true));
});

test('last auto-destroy consumable charge is blocked before ammo debit, but manual consumption is allowed', async () => {
  const opts = {itemType:'consumable',quantity:1,charges:{default:{value:1,max:1}},destroyOnEmpty:true};
  const blocked = await runAttack(opts);
  assert.equal(blocked.crosshairCalls,0); assert.equal(blocked.cards.length,0);
  assert.ok(!blocked.events.includes('ammo'));
  assert.ok(blocked.notices.some(notice=>/deleted before damage/.test(notice.text)));
  const manual = await runAttack({...opts,flags:{aoeConsume:false}});
  assert.equal(manual.nativeCards.length,2); assert.ok(!manual.events.includes('ammo'));
});
