const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const services=path.resolve(__dirname,'../scripts/services');
const source=fs.readFileSync(path.join(services,'rof-attack-pool.js'),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const collection=items=>Object.assign(items,{get(id){return this.find(item=>item.id===id);}});

async function runPool({inline=true,setup={},weaponRof=3,trait='Shooting',rapidFire=false,
  ownerPermission=true,shots=50,dice=[9,7,4],globalMods={},skillEffects=[],traitMod='',trademark=0,
  rollData={},reviewActions=['continue'],choosePool='use-reroll',targetCover=0,targetIllumination=false,
  targetDistance=5,mutate=null,flags={},assignedOutcome='miss',aoe=false,noTargets=false,
  placements=null,afterPrepare=null,quantity=20,ammoManagement=true}={}) {
  const shotgunRules=await import(pathToFileURL(path.join(services,'ShotgunRules.js')));
  const aoeFlags=await import(pathToFileURL(path.join(services,'AoeItemFlags.js')));
  const {aoeResource}=await import(pathToFileURL(path.join(services,'AoeResourceService.js')));
  const {withSuppressedAoeAutomation}=await import(pathToFileURL(path.join(services,'AoeAnimationService.js')));
  const events=[],notices=[],prompts=[],reviews=[],cards=[],assignments=[];
  const nativeCalls=[],nativeMessages=[],aoeCalls=[],preparations=[],hookHandlers=new Map();let hookId=0;
  const Hooks={call(){},on(name,handler){const id=++hookId;hookHandlers.set(id,{name,handler});return id;},off(_name,id){hookHandlers.delete(id);}};
  const emit=(name,...args)=>{for(const hook of [...hookHandlers.values()])if(hook.name===name)hook.handler(...args);};
  const queue=[...dice],actions=[...reviewActions];
  const skill={id:'skill',name:trait,type:'skill',system:{swid:trait.toLowerCase(),attribute:'agility',
    die:{sides:8,modifier:0},'wild-die':{sides:6},effects:skillEffects}};
  const actor={id:'actor',uuid:'Actor.actor',name:'Shooter',isOwner:true,type:'character',
    system:{wildcard:true,attributes:{strength:{die:{sides:8}}},wounds:{value:0},fatigue:{value:0},
      bennies:{value:3},stats:{globalMods}},
    getRollData:()=>rollData,async spendBenny(){events.push('benny');this.system.bennies.value--;return true;}};
  const weapon={id:'weapon',uuid:'Actor.actor.Item.weapon',name:'Rifle',type:'weapon',actor,parent:actor,
    flags:{'swade-tools':{aoeEnabled:aoe,...flags}},
    system:{rof:weaponRof,isRanged:true,range:'10/20/40',currentShots:shots,shots:50,reloadType:'single',quantity,
      damage:'2d6',trademark,actions:{trait,traitMod}},
    getFlag(scope,key){return this.flags?.[scope]?.[key]??null;},canExpendResources(cost){return this.system.currentShots>=cost;},
    async consume(cost){events.push(`ammo:${cost}`);this.system.currentShots-=cost;},
    async update(change){if(Object.hasOwn(change,'system.quantity')){events.push('quantity');this.system.quantity=change['system.quantity'];}
      if(Object.hasOwn(change,'system.currentShots')){events.push('fallback-ammo');this.system.currentShots=change['system.currentShots'];}}};
  actor.items=collection([skill,weapon,...(rapidFire?[{id:'rapid',name:'Rapid Fire',type:'edge',system:{swid:'rapid-fire'}}]:[])]);
  const token={id:'source',actor,document:{id:'source',uuid:'Scene.scene.Token.source',center:{x:0,y:0}}};
  const target={id:'target',name:'Target',actor:{name:'Target',items:[],system:{stats:{scale:0}}},
    document:{uuid:'Scene.scene.Token.target',center:{x:targetDistance*100,y:0},regions:[]}};
  if(targetCover)target.actor.items.push({name:'Target Cover',isReadied:true,system:{cover:targetCover}});
  if(targetIllumination)target.document.regions.push({behaviors:[{type:'attackModifiers',system:{illumination:'dark'}}]});
  const inlineSetup={weaponId:weapon.id,itemUuid:weapon.uuid,actorUuid:actor.uuid,weaponActorUuid:actor.uuid,
    trait,rof:2,recoil:false,consumeAmmo:true,calledShot:'Torso',otherModifierFormula:'0',aoe,...setup};
  if(mutate)mutate({actor,weapon,skill,inlineSetup});
  actor.isOwner=ownerPermission;
  class MockRoll {
    static replaceFormulaData(formula,data){return formula.replace(/@([A-Za-z0-9_.]+)/g,(_m,ref)=>String(ref.split('.').reduce((v,k)=>v?.[k],data)));}
    static validate(formula){return /^[\d() dx+\-]+$/.test(formula);}
    constructor(formula,data={}){this.formula=formula;this.data=data;this.dice=[];}
    async evaluate(){events.push(`roll:${this.formula}`);
      const resolved=MockRoll.replaceFormulaData(this.formula,this.data);
      const expression=resolved.replace(/\d+d\d+x?/g,()=>{assert.ok(queue.length,'Unexpected dice');return String(queue.shift());});
      assert.match(expression,/^[\d() +\-]+$/);this.total=Function(`return (${expression})`)();
      this.dice=[{results:[{result:this.total}]}];return this;}
  }
  const game={user:{id:'gm',isGM:true,bennies:0,targets:new Set(noTargets?[]:[target])},
    modules:new Map([['swade-tools',{active:true}]]),
    settings:{get(_ns,key){return key==='shootingSkill'?'Shooting':key==='ammoManagement'&&ammoManagement;}},
    i18n:{localize:key=>key},messages:{get:id=>nativeMessages.find(message=>message.id===id)},
    swadetools:{async item(owner,id,operator,options){events.push('native-damage');nativeCalls.push({owner,id,operator,options});
      const raise={checked:false},mod={value:'0'},called={value:'Torso',options:['None','Torso','Head'].map(value=>({value}))};
      const button={dataset:{button:'mainDamage'},textContent:'Damage',click(){
        const message={id:`native-${nativeMessages.length+1}`,modifier:mod.value,flags:{'swade-tools':{rolltype:'damage',itemroll:id}},
          updateSource(change){this.target=change['flags.swade-tools.usetarget'];}};
        nativeMessages.push(message);emit('preCreateChatMessage',message,{flags:message.flags},{},'gm');}};
      const dom={querySelectorAll:()=>[button],querySelector:selector=>selector==='#raise'?raise:selector==='#mod'?mod:selector==='#calledshots'?called:null};
      emit('renderDialog',{title:weapon.name},dom);
    }}};
  const DialogV2={async prompt(config){prompts.push(config);
    if(config.window.title==='SWADE RoF Attack Pool')return{weaponId:'weapon',rof:2,recoil:false,consumeAmmo:true,otherModifier:0,calledShot:'None'};
    const elements={};for(let i=0;i<Number(inlineSetup.rof||2);i++){
      elements[`target-${i}`]={value:target.document.uuid};elements[`outcome-${i}`]={value:assignedOutcome};
    }
    const result=config.ok.callback(null,{form:{elements}});assignments.push(...result);return result;
  },async wait(config){reviews.push(config);return config.window.title.includes('Choose Benny')?choosePool:actions.length?actions.shift():'continue';}};
  const dependencies={scope:{actor,item:weapon,weaponActor:actor,token,...(inline?{rofSetup:inlineSetup}:{})},
    game,canvas:{scene:{},tokens:{controlled:[token]},dimensions:{size:100,distance:1}},Roll:MockRoll,
    CONFIG:{SWADE:{rollModifiers:{illumination:{modifiers:{dark:{label:'Dark Region',value:-4}}}}}},
    foundry:{utils:{escapeHTML,getProperty:(obj,ref)=>ref.split('.').reduce((v,k)=>v?.[k],obj)},applications:{api:{DialogV2}}},
    ui:{notifications:Object.fromEntries(['warn','error','info'].map(kind=>[kind,text=>notices.push({kind,text})]))},
    Hooks,
    ChatMessage:{getSpeaker:input=>input,async create(data){const message={...data,id:'pool',async update(change){Object.assign(this,change);}};cards.push(message);return message;}},
    fromUuid:async()=>null,setTimeout(callback,ms){if(ms<=100)callback();return 1;},clearTimeout(){}};
  dependencies.scope.rofServices={...shotgunRules,...aoeFlags,aoeResource,withSuppressedAoeAutomation,
    isAoeItem:item=>item.flags?.['swade-tools']?.aoeEnabled===true,
    async prepareAoePoolPoints(context){events.push('prepare-aoe');preparations.push(context);
      if(afterPrepare)afterPrepare({actor,weapon});
      return placements??context.candidates.map((_candidate,candidateIndex)=>({candidateIndex,attackPoint:{x:100+candidateIndex*100,y:100}}));},
    async launchAoeMacro(actualActor,item,options){events.push('aoe-projectile');aoeCalls.push({actualActor,item,options});return true;},
  };
  await new AsyncFunction(...Object.keys(dependencies),source)(...Object.values(dependencies));
  return{actor,weapon,skill,events,notices,prompts,reviews,cards,assignments,queue,nativeCalls,nativeMessages,aoeCalls,preparations};
}

test('inline RoF skips only the initial setup and preserves review plus target allocation',async()=>{
  const s=await runPool();
  assert.equal(s.prompts.length,1);assert.match(s.prompts[0].window.title,/Assign RoF Results/);
  assert.equal(s.reviews.length,1);assert.equal(s.assignments.length,2);assert.equal(s.cards.length,1);
  assert.deepEqual(s.events.filter(event=>event.startsWith('ammo:')),['ammo:5']);
  assert.equal(s.weapon.system.currentShots,45);
});

test('inline damage data references are resolved before native damage without rolling extra shared dice',async()=>{
  for(const aoe of [false,true]){
    const s=await runPool({aoe,noTargets:aoe,setup:{damageModifier:'@damageBonus'},
      rollData:{damageBonus:2},assignedOutcome:'hit'});
    assert.equal(s.queue.length,0);
    assert.equal(s.events.filter(event=>event.startsWith('roll:')).length,3);
    if(aoe)assert.ok(s.aoeCalls.every(call=>call.options.attackSetup.damageModifier==='2'));
    else {
      assert.equal(s.nativeMessages.length,2);
      assert.ok(s.nativeMessages.every(message=>message.modifier.includes('2') && !message.modifier.includes('@')));
    }
  }
});

test('AoE pool rechecks operator and source ownership after placement before ammunition commitment',async()=>{
  for(const change of [({actor})=>{actor.isOwner=false;},({actor})=>{actor.uuid='Actor.replaced';}]){
    const s=await runPool({aoe:true,noTargets:true,afterPrepare:change});
    assert.equal(s.aoeCalls.length,0);assert.equal(s.weapon.system.currentShots,50);
    assert.ok(!s.events.some(event=>event.startsWith('ammo:')));
  }
});

test('legacy macro flow retains its original setup prompt and weapon-only maximum',async()=>{
  const s=await runPool({inline:false});
  assert.equal(s.prompts.length,2);assert.equal(s.prompts[0].window.title,'SWADE RoF Attack Pool');
  assert.equal(s.events.filter(event=>event==='ammo:5').length,1);
  const legacyCap=await runPool({inline:false,weaponRof:1,rapidFire:true});
  assert.equal(legacyCap.prompts.length,1);assert.equal(legacyCap.cards.length,0);
  assert.equal(legacyCap.events.length,0);
});

test('stale inline identity, native Trait, ownership and selected RoF are rejected without fallback setup or ammo',async()=>{
  for(const options of [
    {setup:{itemUuid:'Actor.other.Item.weapon'}},{setup:{weaponActorUuid:'Actor.other'}},
    {setup:{actorUuid:'Actor.other'}},{setup:{weaponId:'missing'}},{setup:{trait:'Gunnery'}},
    {trait:''},{ownerPermission:false},{setup:{rof:1}},{setup:{rof:4}},{setup:{rof:2.5}},
    {setup:{rof:7},weaponRof:7},{setup:{rof:NaN}},
    {mutate:({weapon})=>{weapon.system.actions.trait='Gunnery';}},
  ]){
    const s=await runPool(options);
    assert.equal(s.prompts.length,0,JSON.stringify(options));assert.equal(s.cards.length,0);
    assert.ok(!s.events.some(event=>event.startsWith('ammo:')||event.startsWith('roll:')));
    assert.equal(s.weapon.system.currentShots,50);assert.ok(s.notices.length);
  }
});

test('inline maximum allows one Rapid Fire die for Shooting, never for unrelated Gunnery, and never beyond six',async()=>{
  const allowed=await runPool({rapidFire:true,weaponRof:2,setup:{rof:3},dice:[9,8,7,4]});
  assert.equal(allowed.cards.length,1);assert.deepEqual(allowed.events.filter(event=>event.startsWith('ammo:')),['ammo:10']);
  for(const opts of [{rapidFire:true,trait:'Gunnery',weaponRof:2,setup:{rof:3}},
    {rapidFire:true,weaponRof:5,setup:{rof:7}}]){
    const s=await runPool(opts);assert.equal(s.cards.length,0);assert.equal(s.events.length,0);
  }
});

test('inline Mod dice, @data, MAP and prepared native modifiers evaluate once and stay fixed on pool Bennies',async()=>{
  const s=await runPool({dice:[4,9,7,3,10,8,4],reviewActions:['actor-benny','continue'],
    setup:{otherModifierFormula:'+1d6',multiAction:-2},traitMod:'@bonus',trademark:1,rollData:{bonus:2},
    skillEffects:[{label:'Skill Effect',value:1},{label:'Ignored',value:99,ignore:true}],
    globalMods:{trait:[{label:'Trait',value:1}],agility:[{label:'Agility',value:1}],attack:[{label:'Attack',value:1}]}});
  assert.equal(s.events.filter(event=>event==='roll:+1d6').length,1);
  assert.equal(s.events.filter(event=>event==='roll:@bonus').length,1);
  assert.equal(s.events.filter(event=>event==='benny').length,1);
  assert.equal(s.events.filter(event=>event==='ammo:5').length,1);
  assert.match(s.cards[0].content,/Base common modifier:<\/strong>\s*\+9/);
  assert.equal(s.cards[0].rolls.length,8);assert.equal(s.assignments[0].result.modifier,9);
  assert.ok(!s.cards[0].content.includes('Ignored +99'));
});

test('manual Cover and Illumination are non-stacking target candidates and range is applied only per target',async()=>{
  const s=await runPool({setup:{multiAction:-2,cover:'Light',illumination:'Dim'},
    targetDistance:15,targetCover:4,targetIllumination:true});
  assert.equal(s.assignments[0].result.modifier,-2);
  const profile=s.assignments[0].targetProfile;
  assert.equal(profile.total,-10);
  assert.equal(profile.modifiers.filter(mod=>mod.label.includes('Range')).length,1);
  assert.equal(profile.modifiers.filter(mod=>mod.label.includes('Cover')).length,1);
  assert.equal(profile.modifiers.filter(mod=>/Illumination|Dark/.test(mod.label)).length,1);
  assert.ok(profile.ignoredMods.some(mod=>mod.label==='Manual Cover'));
});

test('invalid inline formulas and modifier enums cannot roll or consume ammo',async()=>{
  for(const setup of [{otherModifierFormula:'bad formula'},{otherModifierFormula:'@missing'},
    {damageModifier:'bad formula'},{multiAction:-3},{cover:-3},{illumination:'unknown'},
    {calledShot:'Invalid'},{consumeAmmo:'true'}]){
    const s=await runPool({setup});assert.equal(s.cards.length,0);assert.equal(s.events.length,0);
    assert.equal(s.prompts.length,0);assert.equal(s.weapon.system.currentShots,50);
  }
});

test('inline consume-off and canceled pool review never expend ammunition',async()=>{
  const off=await runPool({setup:{consumeAmmo:false}});assert.equal(off.cards.length,1);
  assert.ok(!off.events.some(event=>event.startsWith('ammo:')));assert.equal(off.weapon.system.currentShots,50);
  const canceled=await runPool({reviewActions:[null]});assert.equal(canceled.cards.length,0);
  assert.ok(!canceled.events.some(event=>event.startsWith('ammo:')));
});

test('inline native damage receives the real owner/operator and damage-only mode without another attack panel',async()=>{
  const s=await runPool({assignedOutcome:'hit'});
  assert.equal(s.nativeCalls.length,2);assert.equal(s.nativeMessages.length,2);
  assert.ok(s.nativeCalls.every(call=>call.owner===s.actor&&call.operator===s.actor&&call.options.damageOnly));
  assert.ok(s.nativeCalls.every(call=>!Object.hasOwn(call.options,'damageOverride')));
  assert.deepEqual(s.nativeMessages.map(message=>message.target),['target','target']);
  assert.equal(s.events.filter(event=>event==='ammo:5').length,1);
});

test('AoE RoF pool needs no pre-targets, collects every point before ammo, and forwards each pre-rolled result exactly once',async()=>{
  const s=await runPool({aoe:true,noTargets:true,setup:{cover:'Light',illumination:'Dim',multiAction:-2}});
  assert.equal(s.preparations.length,1);assert.equal(s.prompts.length,0);
  assert.equal(s.aoeCalls.length,2);assert.equal(s.nativeCalls.length,0);
  assert.ok(s.events.indexOf('prepare-aoe')<s.events.indexOf('ammo:5'));
  assert.equal(s.events.filter(event=>event==='ammo:5').length,1);
  assert.equal(s.events.filter(event=>event.startsWith('roll:')).length,3);
  for(let index=0;index<2;index++){
    const call=s.aoeCalls[index],pool=call.options.poolAttack;
    assert.equal(call.actualActor,s.actor);assert.equal(call.item,s.weapon);
    assert.equal(call.options.skipConsumption,true);assert.equal(pool.disableBenny,true);
    assert.equal(pool.candidateIndex,index);assert.equal(pool.baseModifier,-6);
    assert.equal(pool.rawRoll,s.preparations[0].candidates[index].roll);
    assert.equal(pool.poolId,'pool');assert.equal(pool.weaponUuid,s.weapon.uuid);
    assert.equal(pool.weaponActorUuid,s.actor.uuid);assert.equal(pool.operatorActorUuid,s.actor.uuid);
    assert.deepEqual(call.options.attackPoint,{x:100+index*100,y:100});
  }
});

test('canceled, partial or invalid AoE preplacements never consume ammo or resolve any projectile',async()=>{
  for(const placements of [[],[{candidateIndex:0,attackPoint:{x:100,y:100}}],
    [{candidateIndex:0,attackPoint:{x:100,y:100}},{candidateIndex:0,attackPoint:{x:200,y:100}}],
    [{candidateIndex:0,attackPoint:{x:NaN,y:100}},{candidateIndex:1,attackPoint:{x:200,y:100}}]]){
    const s=await runPool({aoe:true,noTargets:true,placements});
    assert.equal(s.cards.length,0);assert.equal(s.aoeCalls.length,0);
    assert.ok(!s.events.some(event=>event.startsWith('ammo:')));assert.equal(s.weapon.system.currentShots,50);
  }
  const disabled=await runPool({aoe:true,noTargets:true,flags:{aoeEnabled:false}});
  assert.equal(disabled.events.length,0);assert.equal(disabled.preparations.length,0);
});

test('AoE pool honors saved resource mode once with the RoF table cost, including None and exact Item quantity',async()=>{
  const item=await runPool({aoe:true,noTargets:true,quantity:5,flags:{aoeConsumeMode:'item',aoeAmmoCost:99}});
  assert.equal(item.weapon.system.quantity,0);assert.equal(item.weapon.system.currentShots,50);
  assert.equal(item.events.filter(event=>event==='quantity').length,1);
  assert.ok(!item.events.some(event=>event.startsWith('ammo:')));assert.equal(item.aoeCalls.length,2);
  assert.match(item.cards[0].content,/Items spent:<\/strong>\s*5/);
  const none=await runPool({aoe:true,noTargets:true,shots:0,flags:{aoeConsumeMode:'none'},setup:{consumeAmmo:true}});
  assert.equal(none.weapon.system.currentShots,0);assert.equal(none.weapon.system.quantity,20);
  assert.equal(none.aoeCalls.length,2);assert.match(none.cards[0].content,/Ammo spent:<\/strong>\s*0/);
  const low=await runPool({aoe:true,noTargets:true,quantity:4,flags:{aoeConsumeMode:'item'}});
  assert.equal(low.events.length,0);assert.equal(low.preparations.length,0);
});

test('disabled global ammunition management preserves ammo in both ordinary and AoE inline pools',async()=>{
  for(const aoe of [false,true]){
    const s=await runPool({aoe,noTargets:aoe,shots:0,ammoManagement:false});
    assert.equal(s.weapon.system.currentShots,0);assert.equal(s.cards.length,1);
    assert.ok(!s.events.some(event=>event.startsWith('ammo:')));
    assert.match(s.cards[0].content,/Ammo spent:<\/strong>\s*0/);
  }
});

test('inline context and ammo are checked again after review/placement, and native rejection cannot use fallback ammo',async()=>{
  for(const afterPrepare of [({weapon})=>{weapon.system.currentShots=0;},
    ({weapon})=>{weapon.system.actions.trait='Gunnery';},({actor})=>{actor.isOwner=false;},
    ({weapon})=>{weapon.flags['swade-tools'].aoeDamageAction='changed-he-action';},
    ({weapon})=>{weapon.flags['swade-tools'].aoeBlastSize='large';},
    ({weapon})=>{weapon.flags['swade-tools'].aoeConsumeMode='none';},
    ({weapon})=>{weapon.flags['swade-tools'].aoeEnabled=false;}]){
    const s=await runPool({aoe:true,noTargets:true,afterPrepare});
    assert.equal(s.aoeCalls.length,0);assert.equal(s.cards.length,0);
    assert.ok(!s.events.some(event=>event.startsWith('ammo:')||event==='fallback-ammo'));
  }
  const rejected=await runPool({mutate:({weapon})=>{weapon.canExpendResources=()=>false;}});
  assert.equal(rejected.events.length,0);assert.equal(rejected.weapon.system.currentShots,50);
});

test('opted-in shotgun pool adds one pellet bonus and uses transient damage by each target range',async()=>{
  for(const [targetDistance,expected]of [[5,'3d6'],[15,'2d6'],[30,'1d6']]){
    const s=await runPool({flags:{sgEnabled:true},targetDistance,assignedOutcome:'hit'});
    assert.equal(s.assignments[0].result.modifier,2);
    assert.equal(s.nativeCalls.length,2);
    assert.ok(s.nativeCalls.every(call=>call.options.damageOverride===expected&&call.options.damageOnly));
    assert.equal(s.weapon.system.damage,'2d6');assert.equal(s.weapon.system.actions.traitMod,'');
    assert.equal(s.events.filter(event=>event==='ammo:5').length,1);
  }
});

test('Slug cancels only an explicitly preincluded Shot bonus; disabled profiles ignore forged Shotgun setup',async()=>{
  const slug=await runPool({flags:{sgEnabled:true,sgBonusIncluded:true},traitMod:'+2',
    setup:{shotgunMode:'slug'},targetDistance:50,assignedOutcome:'hit'});
  assert.equal(slug.assignments[0].result.modifier,0);
  assert.ok(slug.nativeCalls.every(call=>call.options.damageOverride==='2d10'));
  assert.equal(slug.weapon.system.actions.traitMod,'+2');assert.equal(slug.weapon.system.damage,'2d6');
  const disabled=await runPool({setup:{shotgunMode:'slug',bothBarrels:true},assignedOutcome:'hit'});
  assert.equal(disabled.assignments[0].result.modifier,0);
  assert.ok(disabled.nativeCalls.every(call=>!Object.hasOwn(call.options,'damageOverride')));
});

test('Shot outside Long, Both Barrels with a pool, and SG plus AoE are rejected before dice and ammunition',async()=>{
  for(const opts of [{targetDistance:50},{flags:{sgEnabled:true,sgDoubleBarrel:true},setup:{bothBarrels:true}},
    {aoe:true,noTargets:true}]){
    const s=await runPool({flags:{sgEnabled:true},...opts});
    assert.equal(s.events.length,0);assert.equal(s.cards.length,0);assert.equal(s.weapon.system.currentShots,50);
  }
});

test('launcher injects optional inline setup without changing the legacy scope and shares its RoF cap',async()=>{
  const previous=Object.fromEntries(['game','canvas','foundry','fetch','ui'].map(key=>[key,global[key]]));
  const captures=[];
  const actor={uuid:'Actor.gunner',items:collection([{id:'shoot',name:'Shooting',type:'skill',system:{swid:'shooting'}},
    {name:'Custom Rapid',type:'edge',system:{swid:'rapid-fire'}}])};
  const owner={uuid:'Actor.vehicle'},item={id:'gun',uuid:'Actor.vehicle.Item.gun',actor:owner,system:{rof:3,actions:{trait:'shoot'}}};
  const token={actor:owner};
  global.game={modules:new Map([['swade-tools',{version:'test'}]]),settings:{get(_ns,key){return key==='shootingSkill'?'Shooting':'Custom Rapid';}}};
  global.canvas={tokens:{controlled:[token]}};
  global.foundry={utils:{getRoute:value=>value,AsyncFunction:function(){return async scope=>captures.push(scope);}}};
  global.fetch=async()=>({ok:true,text:async()=> 'SWADE RoF Attack Pool and Damage Allocator'});
  global.ui={notifications:{warn(){},error(){}}};
  try{
    const {launchRofMacro,getInlineRofMaximum}=await import(`${pathToFileURL(path.join(services,'RofMacroLauncher.js'))}?inline-test`);
    assert.equal(getInlineRofMaximum(actor,item),4);
    assert.equal(getInlineRofMaximum({...actor,items:collection([])},item),3);
    assert.equal(getInlineRofMaximum(actor,{...item,system:{...item.system,rof:6}}),6);
    assert.equal(await launchRofMacro(actor,item,owner),true);assert.equal(Object.hasOwn(captures[0],'rofSetup'),false);
    assert.equal(await launchRofMacro(actor,item,owner,{setup:{rof:2,otherModifierFormula:'+1d6'}}),true);
    assert.deepEqual(captures[1].rofSetup,{weaponId:'gun',itemUuid:item.uuid,actorUuid:actor.uuid,weaponActorUuid:owner.uuid,
      trait:'shoot',rof:2,otherModifierFormula:'+1d6'});
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete global[key];else global[key]=value;}}
});

test('per-weapon/token RoF launch guard blocks duplicate pools and releases after success or thrown failure',async()=>{
  const previous=Object.fromEntries(['game','canvas','foundry','fetch','ui'].map(key=>[key,global[key]]));
  const warnings=[],captures=[];let finishFirst,startedResolve,failNext=false;
  const started=new Promise(resolve=>{startedResolve=resolve;});
  const actor={uuid:'Actor.actor'},item={id:'weapon',uuid:'Actor.actor.Item.weapon',actor,system:{actions:{trait:'Shooting'}}};
  const token={id:'token',actor,document:{uuid:'Scene.scene.Token.token'}};
  global.game={modules:new Map([['swade-tools',{version:'test'}]])};global.canvas={tokens:{controlled:[token]}};
  global.ui={notifications:{warn:text=>warnings.push(text),error(){}}};
  global.fetch=async()=>({ok:true,text:async()=> 'SWADE RoF Attack Pool and Damage Allocator'});
  global.foundry={utils:{getRoute:value=>value,AsyncFunction:function(){return async scope=>{
    captures.push(scope);if(captures.length===1){startedResolve();await new Promise(resolve=>{finishFirst=resolve;});}
    if(failNext){failNext=false;throw Error('Simulated RoF failure');}
  };}}};
  try{
    const {launchRofMacro}=await import(`${pathToFileURL(path.join(services,'RofMacroLauncher.js'))}?guard-test`);
    const first=launchRofMacro(actor,item,null,{setup:{rof:2}});await started;
    assert.equal(await launchRofMacro(actor,item,null,{setup:{rof:2}}),false);
    assert.equal(captures.length,1);assert.equal(warnings.length,1);
    finishFirst();assert.equal(await first,true);
    assert.equal(await launchRofMacro(actor,item),true);
    failNext=true;assert.equal(await launchRofMacro(actor,item),false);
    assert.equal(await launchRofMacro(actor,item),true);assert.equal(captures.length,4);
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete global[key];else global[key]=value;}}
});

test('launcher honors explicit source token and rejects synthetic clones or ambiguous fallback sources',async()=>{
  const previous=Object.fromEntries(['game','canvas','foundry','fetch','ui'].map(key=>[key,global[key]]));
  const warnings=[],captures=[];
  const owner={id:'base',uuid:'Scene.scene.Token.owner.Actor.base'};
  const cloneOwner={id:'base',uuid:'Scene.scene.Token.clone.Actor.base'};
  const operator={id:'operator',uuid:'Actor.operator'};
  const item={id:'gun',uuid:`${owner.uuid}.Item.gun`,actor:owner,system:{actions:{trait:'Gunnery'}}};
  const first={id:'first',actor:owner,document:{uuid:'Scene.scene.Token.first'}};
  const second={id:'second',actor:owner,document:{uuid:'Scene.scene.Token.second'}};
  const clone={id:'clone',actor:cloneOwner,document:{uuid:'Scene.scene.Token.clone'}};
  owner.getActiveTokens=()=>[first];
  global.game={modules:new Map([['swade-tools',{version:'test'}]])};
  global.canvas={tokens:{controlled:[clone]}};
  global.ui={notifications:{warn:text=>warnings.push(text),error(){}}};
  global.fetch=async()=>({ok:true,text:async()=> 'SWADE RoF Attack Pool and Damage Allocator'});
  global.foundry={utils:{getRoute:value=>value,AsyncFunction:function(){return async scope=>captures.push(scope);}}};
  try{
    const {launchRofMacro}=await import(`${pathToFileURL(path.join(services,'RofMacroLauncher.js'))}?source-test`);
    assert.equal(await launchRofMacro(operator,item,owner,{token:{object:second}}),true);
    assert.equal(captures[0].token,second,'explicit TokenDocument.object must take precedence');
    assert.equal(captures[0].actor,operator);assert.equal(captures[0].weaponActor,owner);
    assert.equal(await launchRofMacro(operator,item,owner,{token:clone}),false);
    assert.equal(captures.length,1,'wrong synthetic clone cannot silently fall back to the owner');
    assert.equal(await launchRofMacro(operator,item,owner),true);
    assert.equal(captures[1].token,first,'fallback may find unique exact owner active token');
    global.canvas.tokens.controlled=[first,second];
    assert.equal(await launchRofMacro(operator,item,owner),false,'two controlled matches are ambiguous');
    global.canvas.tokens.controlled=[];owner.getActiveTokens=()=>[first,second];
    assert.equal(await launchRofMacro(operator,item,owner),false,'two active matches are ambiguous');
    owner.getActiveTokens=()=>[clone];
    assert.equal(await launchRofMacro(operator,item,owner),false,'same base ID is not the same synthetic actor');
    assert.equal(captures.length,2);assert.equal(warnings.length,4);
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete global[key];else global[key]=value;}}
});
