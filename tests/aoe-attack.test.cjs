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
const assertCardTotal = (content, expected) => assert.match(content,
  new RegExp(`<div class="dice-total"[^>]*>${expected}<\\/div>`));
const visibleCardHtml = content => content.replace(/<details\b[\s\S]*?<\/details>/g,'');
const currentCard = s => s.cards.at(-1);
const rerollCurrentCard = async (s, source = 'actor') => {
  const card = currentCard(s);
  return s.platform.__swadeGrenadeBennyRuntime.handlers.get(card.flags.world.grenadeBennySession)(source,card.id);
};
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
  ...await import(pathToFileURL(path.join(services, 'AoeAnimationService.js'))),
});

// Execute the full bundled attack. Only the Foundry UI/documents and dice are
// mocked; item/operator resolution, saved configuration and ammo are real.
async function runAttack({vehicle = false, flags = {}, name = 'HE Cannon',
  trait = 'Gunnery', category = '', quantity = 1, currentShots = 4,
  dice = [6, 4], canceled = false, actorSkills, manualChoice,
  crewForWeapon = true, legacyDriver = false, nativeDamage = true,
  damage = '3d6', additional = {}, failureOnSpend = false, ammoManagement = true,
  noOperator = false, globalMods = {}, skillEffects = [], itemModifier = '', rollData = {}, secondaryWeapon = false,
  wildcard = true, itemType = 'weapon', charges, destroyOnEmpty = false,
  panelCanceled = false, panelReload = false, panelValues = null, bennySpendResult = true,
  automatedAnimations = false, poolScope = {}} = {}) {
  const profile = await loadServices();
  const events = [], notices = [], cards = [], nativeCalls = [], nativeCards = [];
  const animations = [], automaticAnimationEvents = [];
  const queue = [...dice], hooks = new Map(), timers = new Map();
  let nextId = 0, crosshairCalls = 0, setupDialogs = 0, quantityUpdates = 0, panelCalls = 0;
  const panelContexts = [];
  const gunner = {
    id: 'gunner', uuid: 'Actor.gunner', name: 'Assigned Gunner', type: 'character', isOwner: true,
    system: {wildcard, wounds: {value: 0}, fatigue: {value: 0}, bennies: {value: 3}, stats: {globalMods}},
    items: collection(actorSkills ?? [skill('gunnery', 'Gunnery', 10), skill('shooting', 'Shooting')]),
    getRollData: () => rollData,
    async spendBenny() { events.push('benny'); if (!bennySpendResult) return false; this.system.bennies.value--; return true; },
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
    img: 'icons/weapons/artillery/cannon.webp',
    isOwner: true, actor: owner, parent: owner,
    flags: {'swade-tools': {aoeEnabled: true, ...flags}},
    system: {quantity, currentShots, shots: 4, reloadType: 'single', category, charges, destroyOnEmpty,
      actions: {trait, traitMod:itemModifier, additional}, damage, range: '10/20/40', templates: {medium: true}, ap: 1},
    getFlag(_scope, key) { return this.flags['swade-tools'][key]; },
    canExpendResources(cost) { return this.system.currentShots >= cost; },
    async consume(cost) {
      const usage = {itemUpdates: {'system.currentShots': this.system.currentShots - cost}};
      emit('swadePreConsumeItem', this, cost, usage);
      events.push('ammo'); if (failureOnSpend) throw Error('mock failure');
      await Promise.resolve(); this.system.currentShots -= cost;
      emit('swadeConsumeItem', this, cost, usage);
    },
    async update(change) { events.push('quantity'); quantityUpdates++; this.system.quantity = change['system.quantity']; },
    async reload() { events.push('reload'); this.system.currentShots = this.system.shots; },
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
  if (automatedAnimations) {
    const automaticAnimation = (item, trigger) => {
      const data = {item}; emit('aa.getRequiredData', data);
      automaticAnimationEvents.push({item, trigger, stopped: data.stopWorkflow === true});
    };
    Hooks.on('swadeConsumeItem', item => automaticAnimation(item, 'consume'));
    Hooks.on('swadeAction', (_actor, item) => automaticAnimation(item, 'damage'));
  }
  class MockRoll {
    static validate(formula) { return /^[\d() dx+\-]+$/.test(formula); }
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
        const expression = MockRoll.replaceFormulaData(this.formula,this.data).replace(/\d+d\d+x?/g, () => {
          assert.ok(queue.length, 'No unexpected modifier dice'); return String(queue.shift());
        });
        assert.match(expression, /^[\d() +\-]+$/); this.total = Function(`return (${expression})`)();
      }
      return this;
    }
    async render({flavor}) { return `<div>${escapeHTML(flavor)}: ${this.total}</div>`; }
    toJSON() { return {formula: this.formula, total: this.total}; }
  }
  const platform = {document: {addEventListener() {}, createElement() {
    const holder = {innerHTML:'', querySelector(selector) {
      if (selector !== '[data-grenade-targets]') return null;
      const start = holder.innerHTML.indexOf('<div data-grenade-targets');
      if (start < 0) return null;
      const contentStart = holder.innerHTML.indexOf('>',start)+1;
      const tags = /<\/?div\b[^>]*>/g;
      tags.lastIndex=contentStart;
      let depth=1, tag;
      while ((tag=tags.exec(holder.innerHTML))) {
        depth += tag[0].startsWith('</') ? -1 : 1;
        if (!depth) break;
      }
      assert.ok(tag,'Target wrapper must remain a complete div');
      return {set innerHTML(content) {
        holder.innerHTML=holder.innerHTML.slice(0,contentStart)+content+holder.innerHTML.slice(tag.index);
      }};
    }};
    return holder;
  }}};
  const game = {
    user: {id: 'gm', isGM: true, bennies: 3, async spendBenny() { this.bennies--; return true; }},
    actors: collection([owner, gunner, other]), messages,
    modules: new Map([['sequencer',{active:true}], ['swade-tools',{active:nativeDamage}],
      ['autoanimations',{active:Boolean(automatedAnimations)}]]),
    settings: {get(namespace, key) { return namespace === 'swade' && key === 'ammoManagement' && ammoManagement; }},
    i18n: {localize: key => key.split('.').at(-1)},
    swadetools: {async item(actualOwner, id, operator, options) {
      nativeCalls.push({actualOwner, id, operator, options});
      const raiseCheckbox = {checked: false}, actionSelect = {options: Object.keys(additional).map(value => ({value})), value: ''};
      const main = {dataset: {button: 'mainDamage'}, textContent: 'Damage', click() {
        emit('swadeAction', operator, actualOwner.items.get(id), 'damage', {total: 1}, 'gm');
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
  if (automatedAnimations) platform.AutomatedAnimations = {async playAnimation(sourceToken, item, options) {
    animations.push({sourceToken, item, options}); events.push('animation:aa');
    if (automatedAnimations === 'error') throw new Error('Simulated optional AA failure');
    return automatedAnimations === 'no-match' ? false : {systemData: options};
  }};
  const Sequencer = {Database: {entryExists: () => false}, Crosshair: {
    PLACEMENT_RESTRICTIONS: {ANYWHERE: 'anywhere'}, CALLBACKS: {CANCEL: 'cancel'},
    async show(config) { crosshairCalls++; events.push('crosshair'); return canceled ? null : {x: 100, y: 100, config}; },
  }};
  platform.Sequencer = Sequencer;
  const dependencies = {
    scope: {actor: vehicle ? owner : gunner, operatorActor: vehicle ? null : gunner,
      weaponActor: owner, item: manualChoice ? null : weapon, token,
      aoeServices: {...profile, showAoeAttackDialog: async context => {
        panelCalls++; panelContexts.push(context); events.push('attack-panel');
        if (panelCanceled) return null;
        if (panelReload) { await context.item.reload(); return null; }
        return panelValues ?? {otherModifierFormula:'0',situationalModifier:0,consume:context.settings.consume};
      }, aoeResource: {
        describe: (item, actualOwner, opts) => profile.aoeResource.describe(item, actualOwner, {...opts, ammoManagement}),
        validate: (item, actualOwner, opts) => profile.aoeResource.validate(item, actualOwner, {...opts, ammoManagement}),
        spend: (item, actualOwner, opts) => profile.aoeResource.spend(item, actualOwner, {...opts, ammoManagement}),
      }}, ...poolScope},
    game, Roll: MockRoll, Hooks, Sequencer, globalThis: platform, CONFIG: {},
    canvas: {scene, grid: {size: 100}, tokens: {controlled: [token], placeables: victims}},
    ui: {notifications: Object.fromEntries(['warn','error','info'].map(kind => [kind, text => notices.push({kind, text})]))},
    foundry: {utils: {escapeHTML, randomID: () => 'aoe-session', getRoute: value => value,
      getProperty(object, name) { return name.split('.').reduce((value, key) => value?.[key], object); }},
      applications: {api: {DialogV2: {async prompt() {
        setupDialogs++; return manualChoice ?? 'weapon';
      }}}}},
    CONST: {GRID_SNAPPING_MODES: {CENTER: 1, VERTEX: 2}},
    ChatMessage: {getSpeaker: input => ({actor: input.actor.uuid, token: input.token.id}),
      async create(data) {const message = {...data, id: `attack-card-${cards.length+1}`, async update(change) {
        for (const [key,value] of Object.entries(change)) {
          if (!key.includes('.')) {this[key]=value;continue;}
          const parts=key.split('.'),property=parts.pop();let target=this;
          for (const part of parts) target=target[part]??={};
          target[property]=value;
        }
      }};
        cards.push(message); return message;}},
    fromUuid: async reference => [owner,gunner,other].find(actor => actor.uuid === reference),
    setTimeout(callback, ms) { const id = ++nextId; if (ms <= 100) callback(); else timers.set(id,callback); return id; },
    clearTimeout: id => timers.delete(id),
  };
  await new AsyncFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  return {weapon, owner, gunner, other, events, notices, cards, nativeCalls, nativeCards,
    animations, automaticAnimationEvents,
    crosshairCalls, setupDialogs, quantityUpdates, scene, platform, queue, panelCalls, panelContexts, victims, emit,
    async emitHook(name,...args) {
      for (const handler of [...hooks.values()]) if (handler.name === name) await handler.callback(...args);
    }};
}

module.exports = {runAttack};
if (require.main === module) {
test('AoE core parses as a Foundry async macro and never modifies user target rings', () => {
  assert.doesNotThrow(() => new AsyncFunction('scope', source));
  assert.ok(!/setTarget\(|updateTokenTargets\(/.test(source));
  assert.ok(!/Use Result|DialogV2\.wait/.test(source));
});

test('AA full attack dispatches once with actual blast and suppresses native consumption/damage, not future actions', async () => {
  const s = await runAttack({vehicle:true, automatedAnimations:true, dice:[6,4,9,5]});
  assert.equal(s.animations.length,1);
  const call = s.animations[0];
  assert.equal(call.item,s.weapon);
  assert.equal(call.sourceToken.actor,s.owner);
  assert.equal(call.options.templateData,s.scene.templates.get('template'));
  assert.equal(call.options.isTemplate,true);
  assert.deepEqual(call.options.targets,s.victims);
  assert.deepEqual(call.options.hitTargets,s.victims);
  assert.equal(call.options.templateData.flags.swade?.origin,undefined);
  assert.deepEqual(s.automaticAnimationEvents.map(event=>event.trigger),['consume','damage','damage']);
  assert.ok(s.automaticAnimationEvents.every(event=>event.stopped));
  await rerollCurrentCard(s);
  assert.equal(s.cards.length,2); assert.equal(s.animations.length,1);
  assert.equal(s.weapon.system.currentShots,3); assert.equal(s.nativeCards.length,2);
  s.emit('swadeAction',s.gunner,s.weapon,'damage',{total:1},'gm');
  assert.equal(s.automaticAnimationEvents.at(-1).stopped,false);
});

test('AA optional API failure or unmatched item cannot stop native target damage or force a fallback explosion', async () => {
  for (const automatedAnimations of ['error','no-match']) {
    const s = await runAttack({vehicle:true,automatedAnimations});
    assert.equal(s.animations.length,1);
    assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
    assert.ok(s.automaticAnimationEvents.every(event=>event.stopped));
    assert.ok(!s.notices.some(notice=>/JB2A.*not found/.test(notice.text)));
  }
});

test('failed AA attack has no hitTargets and Benny success resolves damage without replaying AA or ammunition', async () => {
  const s = await runAttack({vehicle:true,automatedAnimations:true,dice:[2,3,6,4]});
  assert.equal(s.animations.length,1); assert.deepEqual(s.animations[0].options.hitTargets,[]);
  assert.equal(s.nativeCards.length,0);
  await rerollCurrentCard(s);
  assert.equal(s.animations.length,1); assert.equal(s.nativeCards.length,2);
  assert.equal(s.weapon.system.currentShots,3); assert.equal(s.cards.length,2);
  assert.ok(s.automaticAnimationEvents.every(event=>event.stopped));
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
  assert.equal(s.panelCalls,1);
  assert.ok(s.events.indexOf('attack-panel') < s.events.indexOf('crosshair'));
  assert.equal(s.weapon.system.currentShots, 3); assert.equal(s.weapon.system.quantity, 1);
  assert.equal(s.quantityUpdates, 0); assertCardTotal(s.cards[0].content, 6);
  assert.match(s.cards[0].content, /Assigned Gunner; <strong>Vehicle:<\/strong> Tank/);
  assert.deepEqual(s.nativeCards.map(card => card.targets), ['one','two']);
  assert.ok(s.nativeCalls.every(call => call.actualOwner === s.owner && call.operator === s.gunner));
});

test('AoE card has a compact item header, exactly one dice box, visible native-style targets and closed Details', async () => {
  const s = await runAttack({vehicle:true});
  const content=s.cards[0].content, visible=visibleCardHtml(content);
  assert.match(visible,/<img src="icons\/weapons\/artillery\/cannon.webp"/);
  assert.match(visible,/<strong style="font-size:15px;line-height:18px">HE Cannon<\/strong>/);
  assert.match(visible,/Gunnery:<\/strong> <span[^>]*>Success<\/span>/);
  assert.equal((content.match(/class="dice-roll"/g)??[]).length,1);
  assert.equal((content.match(/class="dice-result"/g)??[]).length,1);
  assert.equal((content.match(/class="dice-total"/g)??[]).length,1);
  assertCardTotal(visible,6);
  assert.ok(!/<h2|Trait Die \(d|Wild Die \(d|Total Modifier|Wounds \+0|Range \+0|Fatigue \+0|Skill \+0|Item \+0|Trademark \+0|Other \+0/.test(visible));
  assert.match(content,/<details class="swadetools-aoe-details"[^>]*>\s*<summary[^>]*>Details<\/summary>/);
  assert.ok(!/<details\b[^>]*\bopen\b/.test(content));
  for (const text of ['Range:','Medium Blast Template','3d6; AP 1','Assigned Gunner']) {
    assert.ok(content.includes(text),text);assert.ok(!visible.includes(text),`${text} belongs in Details`);
  }
  for (const name of ['Target one','Target two']) assert.ok(visible.includes(`${name}: <strong>Hit</strong>`));
  assert.equal((visible.match(/class="swadetools-aoe-target"/g)??[]).length,2);
  assert.equal((visible.match(/fa-bullseye/g)??[]).length,2);
  assert.match(visible,/Benny Reroll \(3\)/);assert.match(visible,/GM Reroll \(3\)/);
  assert.ok(!visible.includes('These controls work')&&!visible.includes('Use before the GM'));
  assert.equal(s.cards[0].rolls.length,2);
  assert.equal(s.events.filter(event=>event.startsWith('roll:')).length,2);
});

test('only nonzero modifiers appear in the compact summary without changing stored rolls', async () => {
  const s = await runAttack({itemModifier:'+1',globalMods:{attack:[{value:2}]},
    panelValues:{otherModifierFormula:'3',situationalModifier:0,consume:true}});
  const visible=visibleCardHtml(s.cards[0].content);
  assert.match(visible,/Item \+1, Effects \+2, Other \+3/);assertCardTotal(visible,12);
  assert.ok(!/Wounds|Fatigue|Trademark|Range \+0|Skill \+0|Benny \+0/.test(visible));
  assert.equal(s.cards[0].rolls.length,4);
});

test('Benny history is collapsed but GM Raise review remains visible and compact', async () => {
  const s=await runAttack({dice:[5,3,9,4]});
  await rerollCurrentCard(s);
  const content=currentCard(s).content,visible=visibleCardHtml(content);
  assert.match(visible,/Gunnery:<\/strong> <span[^>]*>Raise<\/span>/);
  assert.match(visible,/data-aoe-gm-review[^>]*><strong>GM: review existing damage and its \+1d6x Raise bonus/);
  assert.match(visible,/Benny Reroll \(2\)/);
  assert.ok(!visible.includes('Roll history:')&&!visible.includes('Benny reroll:'));
  assert.match(content,/Roll history:<\/strong> 1 Benny spent/);
  assert.match(content,/Benny 1 \(used\)/);
  assert.match(content,/Gunnery gained a Raise after damage was rolled/);
  assert.equal((content.match(/class="dice-roll"/g)??[]).length,1);assertCardTotal(visible,9);
  assert.equal(currentCard(s).rolls[0].total,9);
  assert.equal(s.nativeCards.length,2);assert.equal(s.weapon.system.currentShots,3);
});

test('deviation refresh preserves styled target rows and never labels a failed intended blast as Hit', async () => {
  const s=await runAttack({dice:[2,3,6,4]});
  const initial=visibleCardHtml(s.cards[0].content);
  assert.ok(!initial.includes(': <strong>Hit</strong>'));
  assert.match(initial,/Target one: <strong>Blast<\/strong>/);
  assert.match(initial,/Deviation:<\/strong> GM: move the red template to resolve/);
  s.victims[0].name='Moved Target';
  const template=s.scene.templates.get('template');template.x=100;template.y=100;
  await s.emitHook('updateMeasuredTemplate',template,{x:100,y:100});
  const deviated=visibleCardHtml(s.cards[0].content);
  assert.match(deviated,/Moved Target: <strong>Blast<\/strong>/);
  assert.ok(!deviated.includes('Target one')&&!deviated.includes(': <strong>Hit</strong>'));
  assert.equal((deviated.match(/class="swadetools-aoe-target"/g)??[]).length,2);
  assert.equal(s.nativeCards.length,2);
  await rerollCurrentCard(s);
  const rerolled=visibleCardHtml(currentCard(s).content);
  assert.match(rerolled,/Moved Target: <strong>Hit<\/strong>/);
  assert.match(rerolled,/data-aoe-gm-review/);
  assert.ok(!rerolled.includes('Deviation:'));
  assert.equal(s.nativeCards.length,2);
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
  const manual = await runAttack({vehicle:true,noOperator:true,manualChoice:'weapon'});
  assert.equal(manual.cards.length,0); assert.equal(manual.panelCalls,0);
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

test('native Trait ignores old AoE skill override; saved blast, consume and damage action still apply', async () => {
  const s = await runAttack({flags:{aoeSkill:'Shooting', aoeBlastSize:'large', aoeConsume:false, aoeDamageAction:'he'},
    additional:{he:{type:'damage',name:'HE Damage',override:'4d6',ap:2}}, dice:[8,3]});
  assert.equal(s.weapon.system.currentShots,4); assert.equal(s.setupDialogs,0);
  assertCardTotal(s.cards[0].content,8); assert.match(s.cards[0].content,/Large Blast Template/);
  assert.equal(s.panelCalls,1); assert.equal(s.panelContexts[0].attackSkill.name,'Gunnery');
  assert.match(s.cards[0].content,/4d6; AP 2/);
  assert.equal(s.scene.templates.get('template').distance,3);
  assert.ok(s.nativeCards.every(card => card.action === 'he' && card.raise));
});

test('blank native Trait cannot fall back to a saved AoE skill or implicit Shooting', async () => {
  const s = await runAttack({trait:'',flags:{aoeSkill:'Gunnery'}});
  assert.equal(s.panelCalls,0); assert.equal(s.crosshairCalls,0); assert.equal(s.cards.length,0);
  assert.equal(s.weapon.system.currentShots,4);
  assert.ok(s.notices.some(notice=>/Set this item's Trait in its Properties/.test(notice.text)));
});

test('canceling the attack panel or reloading creates no attack, template or firing ammo debit', async () => {
  const canceled = await runAttack({panelCanceled:true});
  assert.equal(canceled.panelCalls,1); assert.equal(canceled.crosshairCalls,0);
  assert.equal(canceled.cards.length,0); assert.equal(canceled.weapon.system.currentShots,4);
  assert.ok(!canceled.events.some(event=>event.startsWith('roll:')));
  const reloaded = await runAttack({currentShots:0,panelReload:true});
  assert.equal(reloaded.panelCalls,1); assert.equal(reloaded.crosshairCalls,0);
  assert.equal(reloaded.cards.length,0); assert.equal(reloaded.weapon.system.currentShots,4);
  assert.deepEqual(reloaded.events,['attack-panel','reload']);
});

test('panel Mod dice and MAP/Cover/Illumination combine once and stay fixed on Benny without affecting damage', async () => {
  const s = await runAttack({dice:[5,8,4,9,5],panelValues:{
    otherModifierFormula:'+1d6',situationalModifier:-4,consume:true,
    modifierParts:{modifier:'+1d6',multiAction:-2,cover:-2,illumination:0}}});
  assertCardTotal(s.cards[0].content,9);
  assert.match(s.cards[0].content,/Other Modifiers: Mod. \+1d6; Multi-Action -2; Cover -2/);
  assert.ok(!/Illumination 0/.test(s.cards[0].content));
  await rerollCurrentCard(s);
  assertCardTotal(currentCard(s).content,10);
  assert.equal(s.events.filter(event=>event==='roll:+1d6').length,1);
  assert.equal(s.weapon.system.currentShots,3);
  assert.ok(s.nativeCalls.every(call=>!call.options?.otherModifier && !call.options?.cover && !call.options?.multiAction));
});

test('invalid panel Mod formula is rejected before ammo, placement or attack roll', async () => {
  const s = await runAttack({panelValues:{otherModifierFormula:'bad formula',situationalModifier:0,consume:true}});
  assert.equal(s.panelCalls,1); assert.equal(s.crosshairCalls,0); assert.equal(s.cards.length,0);
  assert.equal(s.weapon.system.currentShots,4);
});

test('native-style AoE panel keeps English item data, textual Mod, ordinary modifiers, Reload and trait button, without skill/operator selectors', async () => {
  const {showAoeAttackDialog,readAoeAttackDialogValues} = await import(pathToFileURL(path.join(services,'AoeAttackDialog.js')));
  const previousFoundry = global.foundry;
  global.foundry = {utils:{escapeHTML}};
  let config, options, modifierButtons=0, reloaded=0;
  const context = {item:{name:'HE Cannon',system:{damage:'3d6',ap:1,range:'10/20/40',currentShots:0,shots:4,rof:1,reloadType:'single'},async reload(){reloaded++;}},
    weaponOwner:{type:'vehicle',name:'Tank'},operatorActor:{name:'Gunner'},attackSkill:{name:'Gunnery'},
    settings:{blastSize:'medium',consume:true,ammoCost:1,damageAction:''},resource:{label:'Loaded ammunition',available:0}};
  const fields = {mod:{value:'+1d6'},multiaction:{value:'-2'},cover:{value:'-4'},illumination:{value:'-2'},'aoe-consume':{checked:true}};
  const form = {querySelector: selector=>fields[selector.slice(1)]};
  class FakeDialog {constructor(data,opts){config=data;options=opts;} render(){config.render(form);return this;}}
  try {
    const answer = showAoeAttackDialog(context,{DialogClass:FakeDialog,addModifierButtons:()=>modifierButtons++});
    assert.deepEqual(options.classes,['dialog swadetools-vertical']);
    for (const text of ['swadetools-dialog-item','Damage:','AP:','Range:','Shots:','RoF:','Medium Blast Template','Other Modifiers','Multi-Action Penalty','Cover:','Illumination:','Consume Ammunition']) assert.ok(config.content.includes(text),text);
    assert.match(config.content,/type="text" id="mod"/);
    assert.ok(!/name="attackSkill"|name="operator"|name="grenadeId"|Called Shot|Raise Damage|Use Result/.test(config.content));
    assert.equal(config.buttons.attack.label,'Gunnery / AoE');
    assert.equal(config.buttons.cancel.label,'Cancel'); assert.equal(config.buttons.reload.label,'Reload');
    assert.equal(modifierButtons,1);
    config.buttons.attack.callback(form);config.close();
    assert.deepEqual(await answer,{otherModifierFormula:'+1d6',situationalModifier:-8,consume:true,
      modifierParts:{modifier:'+1d6',multiAction:-2,cover:-4,illumination:-2}});
    const reload = showAoeAttackDialog(context,{DialogClass:FakeDialog,addModifierButtons:()=>{}});
    await config.buttons.reload.callback();config.close();
    assert.equal(await reload,null);assert.equal(reloaded,1);
    assert.equal(readAoeAttackDialogValues(form).otherModifierFormula,'+1d6');
  } finally { global.foundry=previousFoundry; }
});

test('Benny rerolls Gunnery within the same attack, with no extra shot/template or damage', async () => {
  const s = await runAttack({vehicle:true,dice:[5,3,9,4]});
  await rerollCurrentCard(s);
  assert.equal(s.gunner.system.bennies.value,2); assert.equal(s.weapon.system.currentShots,3);
  assert.equal(s.events.filter(event => event==='ammo').length,1);
  assert.equal(s.events.filter(event => event==='template').length,1);
  assert.equal(s.nativeCards.length,2); assertCardTotal(currentCard(s).content,9);
  assert.match(currentCard(s).content,/Gunnery gained a Raise/);
});

test('each paid Benny creates a new current attack card and fades only the previous attack card', async () => {
  const s=await runAttack({vehicle:true,dice:[5,3,9,4,10,4]});
  const first=currentCard(s);
  const nativeSnapshot=s.nativeCards.map(card=>({targets:card.targets,raise:card.raise,flags:JSON.stringify(card.flags)}));
  await rerollCurrentCard(s);
  const second=currentCard(s);
  assert.equal(s.cards.length,2);assert.notEqual(first.id,second.id);
  assertCardTotal(first.content,5);assertCardTotal(second.content,9);
  assert.match(first.content,/data-aoe-superseded style="opacity:.5;filter:grayscale\(1\)"/);
  assert.match(first.content,/Superseded by Benny reroll/);
  assert.ok(!/data-grenade-benny|data-benny-source/.test(first.content));
  assert.equal(first.flags.world.grenadeBennySession,null);assert.equal(first.flags.world.aoeSuperseded,true);
  assert.equal(first.flags.world.aoeSupersededBy,second.id);
  assert.equal(second.flags.world.aoePreviousMessage,first.id);
  assert.equal(second.flags.world.grenadeBennySession,'aoe-session');
  assert.match(second.content,new RegExp(`data-grenade-message="${second.id}"`));
  assert.match(visibleCardHtml(second.content),/data-aoe-gm-review/);
  assert.equal(first.rolls[0].total,5);assert.equal(second.rolls[0].total,9);
  await rerollCurrentCard(s);
  const third=currentCard(s);
  assert.equal(s.cards.length,3);assertCardTotal(second.content,9);assertCardTotal(third.content,10);
  assert.ok(!second.content.includes('data-grenade-benny'));
  assert.equal(second.flags.world.aoeSupersededBy,third.id);
  assert.match(third.content,/Benny Reroll \(1\)/);
  assert.deepEqual(s.nativeCards.map(card=>({targets:card.targets,raise:card.raise,flags:JSON.stringify(card.flags)})),nativeSnapshot);
  assert.equal(s.weapon.system.currentShots,3);assert.equal(s.crosshairCalls,1);
  assert.equal(s.events.filter(event=>event==='ammo').length,1);
  assert.equal(s.events.filter(event=>event==='template').length,1);
});

test('lower paid rerolls still publish a new card, keep the higher result, and store the actual reroll dice', async () => {
  const s=await runAttack({dice:[9,5,3,2]});
  const previous=currentCard(s);
  await rerollCurrentCard(s);
  const latest=currentCard(s),visible=visibleCardHtml(latest.content);
  assert.equal(s.cards.length,2);assertCardTotal(previous.content,9);assertCardTotal(latest.content,9);
  assert.match(visible,/Previous result kept \(reroll 3\)/);
  assert.deepEqual(latest.rolls.map(roll=>roll.total),[9,5,3,2]);
  assert.match(latest.content,/Benny 1<\/td>\s*<td>3<\/td><td>2<\/td>/);
  assert.ok(!visible.includes('Roll history:')&&!/<details\b[^>]*\bopen\b/.test(latest.content));
  assert.equal(s.gunner.system.bennies.value,2);assert.equal(s.nativeCards.length,2);
  assert.ok(!previous.content.includes('data-grenade-benny'));
  assert.ok(!visible.includes('data-aoe-gm-review'));
});

test('a paid Extra natural-one failure gets a new passive-history card but cannot replace the earlier hit', async () => {
  const s=await runAttack({wildcard:false,dice:[6,1,4]});
  await rerollCurrentCard(s);
  const latest=currentCard(s);
  assert.equal(s.cards.length,2);assertCardTotal(latest.content,6);
  assert.match(visibleCardHtml(latest.content),/Previous result kept \(reroll 1, natural 1\)/);
  assert.deepEqual(latest.rolls.map(roll=>roll.total),[6,1,4]);
  assert.match(latest.content,/Natural 1 failure/);
  assert.equal(s.nativeCards.length,2);assert.equal(s.gunner.system.bennies.value,2);
});

test('old-card clicks and deletion, including a stale session-flag snapshot, cannot affect the new active card', async () => {
  const s=await runAttack({dice:[5,3,9,4,10,5]});
  const first=currentCard(s),key=first.flags.world.grenadeBennySession;
  const staleDeletedDocument={id:first.id,flags:{world:{grenadeBennySession:key}}};
  const reroll=s.platform.__swadeGrenadeBennyRuntime.handlers.get(key);
  await rerollCurrentCard(s);
  const second=currentCard(s),rollCount=s.events.filter(event=>event.startsWith('roll:')).length;
  await reroll('actor',first.id);
  await reroll('actor','');
  assert.equal(s.gunner.system.bennies.value,2);assert.equal(s.cards.length,2);
  assert.equal(s.events.filter(event=>event.startsWith('roll:')).length,rollCount);
  await s.emitHook('deleteChatMessage',first);
  await s.emitHook('deleteChatMessage',staleDeletedDocument);
  assert.equal(s.platform.__swadeGrenadeBennyRuntime.handlers.get(key),reroll);
  assert.equal(reroll.activeMessageId,second.id);
  await rerollCurrentCard(s);
  assert.equal(s.cards.length,3);assert.equal(s.gunner.system.bennies.value,1);
  const latest=currentCard(s);
  await s.emitHook('deleteChatMessage',latest);
  assert.equal(s.platform.__swadeGrenadeBennyRuntime.handlers.has(key),false);
  await reroll('actor',latest.id);
  assert.equal(s.gunner.system.bennies.value,1);assert.equal(s.cards.length,3);
});

test('a refused Benny spend produces no new card or attempt and leaves the current card active', async () => {
  const s=await runAttack({bennySpendResult:false,dice:[6,4]});
  const previous=currentCard(s);
  await rerollCurrentCard(s);
  assert.equal(s.cards.length,1);assert.equal(currentCard(s),previous);
  assert.equal(previous.flags.world.grenadeBennySession,'aoe-session');
  assert.ok(!previous.content.includes('data-aoe-superseded'));
  assert.match(previous.content,/The Benny could not be spent/);
  assert.match(previous.content,/Benny Reroll \(3\)/);
  assert.equal(s.gunner.system.bennies.value,3);
  assert.equal(s.events.filter(event=>event.startsWith('roll:')).length,2);
  assert.equal(s.nativeCards.length,2);assert.equal(s.weapon.system.currentShots,3);
});

test('GM pool Benny reroll creates the same new-card presentation without spending actor Bennies', async () => {
  const s=await runAttack({dice:[6,4,8,3]});
  await rerollCurrentCard(s,'gm');
  assert.equal(s.cards.length,2);assert.equal(s.gunner.system.bennies.value,3);
  assertCardTotal(currentCard(s).content,8);
  assert.match(currentCard(s).content,/GM Reroll \(2\)/);
  assert.ok(!s.cards[0].content.includes('data-grenade-benny'));
  assert.equal(s.weapon.system.currentShots,3);assert.equal(s.nativeCards.length,2);
});

test('critical Gunnery reroll overrides a prior hit and cannot spend another Benny without Dumb Luck', async () => {
  const s = await runAttack({vehicle:true, dice:[6,4,1,1]});
  await rerollCurrentCard(s); await rerollCurrentCard(s);
  assert.equal(s.gunner.system.bennies.value,2);
  assert.match(currentCard(s).content,/Critical Failure/);
  assert.equal(s.scene.templates.get('template').fillColor,'#d62828');
  assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
  assert.match(currentCard(s).content,/Gunnery changed after damage was rolled/);
});

test('failed AoE attack can Benny reroll to a hit and roll previously pending damage once', async () => {
  const s = await runAttack({vehicle:true, dice:[2,3,6,4]});
  assert.equal(s.nativeCards.length,0);
  await rerollCurrentCard(s);
  assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
  assertCardTotal(currentCard(s).content,6);
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

test('Consume Item reduces exactly selected item quantity, preserves ammunition, and Benny cannot repeat it', async () => {
  const s = await runAttack({quantity:2,currentShots:4,dice:[6,4,9,5],flags:{aoeConsumeMode:'item'}});
  assert.equal(s.panelContexts[0].settings.consumeMode,'item');
  assert.equal(s.panelContexts[0].resource.source,'quantity');
  assert.equal(s.weapon.system.quantity,1);assert.equal(s.weapon.system.currentShots,4);
  assert.equal(s.quantityUpdates,1);assert.ok(!s.events.includes('ammo'));
  await rerollCurrentCard(s);
  assert.equal(s.weapon.system.quantity,1);assert.equal(s.weapon.system.currentShots,4);
  assert.equal(s.quantityUpdates,1);assert.equal(s.nativeCards.length,2);
});

test('explicit Consume Ammunition on a thrown grenade uses native ammo, never its item quantity', async () => {
  const s = await runAttack({name:'Throw Grenade',trait:'Athletics',category:'Throwable',quantity:3,
    actorSkills:[skill('athletics','Athletics')],flags:{aoeConsumeMode:'ammo'}});
  assert.equal(s.panelContexts[0].settings.consumeMode,'ammo');
  assert.equal(s.panelContexts[0].resource.source,'magazine');
  assert.equal(s.weapon.system.quantity,3);assert.equal(s.weapon.system.currentShots,3);
  assert.equal(s.quantityUpdates,0);assert.equal(s.events.filter(event=>event==='ammo').length,1);
});

test('saved none mode cannot silently consume even if a forged panel result enables its checkbox', async () => {
  const s = await runAttack({quantity:2,flags:{aoeConsumeMode:'none'},
    panelValues:{otherModifierFormula:'0',situationalModifier:0,consume:true}});
  assert.equal(s.panelContexts[0].settings.consumeMode,'none');
  assert.equal(s.panelContexts[0].resource.managed,false);
  assert.equal(s.weapon.system.quantity,2);assert.equal(s.weapon.system.currentShots,4);
  assert.equal(s.quantityUpdates,0);assert.ok(!s.events.includes('ammo'));
  assert.equal(s.nativeCards.length,2);
});

test('per-attack consumption unchecked skips the resource without changing saved item mode', async () => {
  const s = await runAttack({quantity:2,flags:{aoeConsumeMode:'item'},
    panelValues:{otherModifierFormula:'0',situationalModifier:0,consume:false}});
  assert.equal(s.weapon.system.quantity,2);assert.equal(s.weapon.system.currentShots,4);
  assert.equal(s.weapon.flags['swade-tools'].aoeConsumeMode,'item');
  assert.equal(s.quantityUpdates,0);assert.equal(s.nativeCards.length,2);
});

test('attack panel has one context-dependent consume checkbox and none mode cannot be enabled there', async () => {
  const {buildAoeAttackDialogContent,readAoeAttackDialogValues,showAoeAttackDialog} = await import(pathToFileURL(path.join(services,'AoeAttackDialog.js')));
  const previousFoundry=global.foundry;global.foundry={utils:{escapeHTML}};
  const context={item:{name:'Bomb',system:{damage:'3d6',range:'5/10/20'}},weaponOwner:{type:'character'},
    operatorActor:{name:'Thrower'},attackSkill:{name:'Athletics'},
    settings:{blastSize:'medium',consume:true,ammoCost:1,consumeMode:'item'},resource:{label:'Item quantity',available:2}};
  try {
    const itemContent=buildAoeAttackDialogContent(context);
    assert.equal((itemContent.match(/id="aoe-consume"/g)??[]).length,1);
    assert.match(itemContent,/<strong>Consume Item<\/strong>/);assert.match(itemContent,/Items per Attack: 1/);
    assert.ok(!itemContent.includes('<strong>Consume Ammunition</strong>'));
    const noneContext={...context,settings:{...context.settings,consumeMode:'none',consume:false}};
    const noneContent=buildAoeAttackDialogContent(noneContext);
    assert.match(noneContent,/id="aoe-consume" disabled/);
    assert.match(noneContent,/Configure Consume Ammunition or Consume Item in AoE Settings/);
    const form={querySelector:id=>id==='#aoe-consume'?{checked:true}: {value:'0'}};
    assert.equal(readAoeAttackDialogValues(form,{consumeMode:'none'}).consume,false);
    let config;
    class FakeDialog{constructor(data){config=data;}render(){return this;}}
    const result=showAoeAttackDialog(noneContext,{DialogClass:FakeDialog,addModifierButtons:()=>{}});
    config.buttons.attack.callback(form);config.close();
    assert.equal((await result).consume,false);
  } finally {global.foundry=previousFoundry;}
});

test('prepared Gunnery effects and global trait/attribute/attack modifiers apply once without Benny stacking', async () => {
  const s = await runAttack({vehicle:true,dice:[5,3,6,4,7,5],
    skillEffects:[{label:'Skill bonus',value:2},{value:99,ignore:true}],
    globalMods:{trait:[{value:1}],smarts:[{value:2}],attack:[{value:1}],bennyTrait:[{value:2}]}});
  assertCardTotal(s.cards[0].content,11);
  await rerollCurrentCard(s); assertCardTotal(currentCard(s).content,14);
  await rerollCurrentCard(s); assertCardTotal(currentCard(s).content,15);
  assert.match(currentCard(s).content,/Total Modifier:<\/strong> \+8/);
  assert.equal(s.weapon.system.currentShots,3);
});

test('prepared @field formulas use the chosen gunner roll data', async () => {
  const s = await runAttack({vehicle:true,rollData:{bonus:2},
    globalMods:{attack:[{label:'Crew fire control',value:'@bonus+1'}]}});
  assertCardTotal(s.cards[0].content,9);
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

test('manual macro only chooses weapon, then uses its native Trait and assigned gunner', async () => {
  const s = await runAttack({vehicle:true,manualChoice:'weapon'});
  assert.equal(s.setupDialogs,1); assert.equal(s.panelCalls,1);
  assert.ok(s.events.includes('roll:1d10x'));
  assert.ok(s.nativeCalls.every(call => call.operator === s.gunner && call.actualOwner === s.owner));
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
  await rerollCurrentCard(s);
  assert.equal(s.gunner.system.bennies.value,2);
  assert.match(currentCard(s).content, /Success with a Raise/);
  assert.equal(s.nativeCards.length,2); assert.equal(s.weapon.system.currentShots,3);
});

test('Extra confirmed critical failure locks Benny rerolls while an ordinary natural 1 cannot replace a hit', async () => {
  const critical = await runAttack({wildcard:false, dice:[1,1]});
  assert.match(critical.cards[0].content,/Confirmed Critical Failure/);
  await rerollCurrentCard(critical);
  assert.equal(critical.gunner.system.bennies.value,3);
  const hit = await runAttack({wildcard:false, dice:[6,1,4]});
  await rerollCurrentCard(hit);
  assertCardTotal(currentCard(hit).content,6);
  assert.match(currentCard(hit).content,/Natural 1 failure/);
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
  const opts = {itemType:'consumable',quantity:1,charges:{default:{value:1,max:1}},destroyOnEmpty:true,flags:{aoeConsumeMode:'ammo'}};
  const blocked = await runAttack(opts);
  assert.equal(blocked.crosshairCalls,0); assert.equal(blocked.cards.length,0);
  assert.ok(!blocked.events.includes('ammo'));
  assert.ok(blocked.notices.some(notice=>/deleted before damage/.test(notice.text)));
  const manual = await runAttack({...opts,flags:{aoeConsume:false}});
  assert.equal(manual.nativeCards.length,2); assert.ok(!manual.events.includes('ammo'));
});

test('last consumable in Consume Item mode can become quantity zero while its profile remains for GM damage', async () => {
  const s=await runAttack({itemType:'consumable',quantity:1,charges:{default:{value:1,max:1}},destroyOnEmpty:true,
    flags:{aoeConsumeMode:'item'}});
  assert.equal(s.weapon.system.quantity,0);assert.equal(s.weapon.system.currentShots,4);
  assert.equal(s.weapon.system.charges.default.value,1);
  assert.equal(s.owner.items.get(s.weapon.id),s.weapon);
  assert.equal(s.quantityUpdates,1);assert.equal(s.nativeCards.length,2);
  assert.ok(!s.events.includes('ammo'));
});
}
