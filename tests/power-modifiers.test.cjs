const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const modifiers=require('../scripts/services/PowerModifiers.js');
const effects=require('../scripts/services/PowerModifierEffects.js');
const {panel}=require('./weapon-panel.test.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
const noImports=source=>source.replace(/^import\s[\s\S]*?;\r?\n/gm,'');
const makePower=(name='Burst')=>({id:'power',uuid:'Actor.caster.Item.power',type:'power',name,
    actor:{id:'caster',uuid:'Actor.caster'},effects:[],system:{pp:2,damage:'2d6',ap:0,range:'Cone Template',duration:'Instant',
        actions:{trait:'Spellcasting',dmgMod:'',additional:{}}}});

test('core Damage is +2 PP once, separate from Raise; names, SWIDs and Damage Field are distinguished',()=>{
    for(const name of ['Blast','Bolt','Burst','Blast (Ice Storm)']){
        const item=makePower(name),before=copy(item);
        const cast=modifiers.preparePowerCast(item,{damage:true},{id:'cast'}).snapshot;
        assert.equal(cast.cost,4);assert.equal(modifiers.powerDamageFormula(cast,'2d6'),'(2d6)+1d6');
        assert.deepEqual(item,before);assert.equal(cast.damage,'2d6');
    }
    const renamed=makePower('Acid Spray');renamed.system.swid='burst';
    assert.equal(modifiers.preparePowerCast(renamed,{damage:true}).snapshot.cost,4);
    const field=makePower('Damage Field');field.system.damage='2d4';
    assert.equal(modifiers.powerDamageFormula(modifiers.preparePowerCast(field,{damage:true}).snapshot,'2d4'),'2d6');
    assert.throws(()=>modifiers.preparePowerCast(makePower('Smite'),{damage:true}),/native Damage/);
});

test('common modifiers account separately, cap AP, enforce exclusive options and forbid Cone/Touch Range',()=>{
    const item=makePower('Blast');item.system.range='12';
    const state=modifiers.preparePowerCast(item,{damage:true,ap:3,heavyWeapon:true,range:2,
        light:'glow',pace:'hinder',fatigue:true,lingering:true,selective:true},{extraPP:1,shape:'large'}).snapshot;
    assert.equal(state.ap,6);assert.equal(state.heavyWeapon,true);assert.equal(state.rangeMultiplier,3);
    assert.equal(state.cost,20); // base 2 + Extra 1 + selected modifiers 17
    for(const selection of [{ap:4},{range:3},{light:'both'},{pace:'both'}])assert.throws(()=>modifiers.preparePowerCast(item,selection));
    for(const range of ['Cone Template','Touch','Self']){
        item.system.range=range;assert.throws(()=>modifiers.preparePowerCast(item,{range:1}),/cannot extend/);
    }
    for(const pp of ['1d6','1.5',NaN,Infinity])assert.throws(()=>modifiers.preparePowerCast(item,{}, {extraPP:pp}),/whole number/);
    const free=modifiers.preparePowerCast(item,{}, {extraPP:-2}).snapshot;assert.equal(free.cost,0);
});

test('native modifiers are prepared on an unsaved clone, charge once, and never update item/effect documents',()=>{
    const item=makePower();let writes=0;
    const effect={id:'damage',type:'modifier',name:'Damage',disabled:true,system:{cost:2},
        changes:[{key:'system.damage'}],toObject(){return {id:this.id,type:this.type,name:this.name,disabled:this.disabled,system:this.system};},update(){writes++;}};
    item.effects=[effect];
    item.clone=(data,options)=>{
        assert.equal(options.keepId,true);assert.equal(data.effects[0].disabled,false);
        return {...item,system:{...item.system,damage:'3d6'}};
    };
    assert.doesNotMatch(modifiers.renderPowerModifiers(item),/id="power-mod-damage"/);
    const prepared=modifiers.preparePowerCast(item,{nativeIds:['damage']});
    assert.equal(prepared.snapshot.cost,4);assert.equal(prepared.snapshot.damage,'3d6');
    assert.equal(prepared.snapshot.damageUpgrade,'');assert.equal(effect.disabled,true);assert.equal(writes,0);
    assert.throws(()=>modifiers.preparePowerCast(item,{damage:true}),/native Damage/);
    assert.throws(()=>modifiers.preparePowerCast(item,{nativeIds:['gone']}),/unavailable/);
});

test('selected native target modifiers bridge effects without double PP or duplicate summary labels',()=>{
    const item=makePower();item.effects=[{id:'fatigue',name:'Fatigue',type:'modifier',disabled:false,system:{cost:2}}];
    const cast=modifiers.preparePowerCast(item).snapshot;
    assert.equal(cast.cost,4);assert.equal(cast.choices.fatigue,true);
    assert.equal(modifiers.powerModifierLabels(cast).filter(label=>/Fatigue/.test(label)).length,1);
});

test('trait-action resource override retains native semantics plus newly declared modifier cost',()=>{
    const item=makePower();item.system.actions.additional.cast={type:'trait',resourcesUsed:5};
    assert.equal(modifiers.preparePowerCast(item,{damage:true},{actionId:'cast',extraPP:9}).snapshot.cost,7);
});

test('actual Power dialog exposes modifiers; preview/cancel does not roll, spend or persist selections',async()=>{
    const p=await panel({power:true,aoe:true});
    for(const id of ['damage','ap','light','pace','fatigue','heavyWeapon','lingering','selective'])
        assert.ok(p.html.nodes.has(`power-mod-${id}`),id);
    assert.equal(p.html.nodes.has('power-mod-range'),true); // fixture has a numeric range
    assert.equal(p.events.length,0);
    p.html.nodes.get('power-mod-damage').checked=true;
    p.html.nodes.get('power-mod-ap').value='2';
    await p.config.buttons.mainSkill.callback(p.html);
    const context=p.events.find(event=>event[0]==='power-aoe')[1];
    assert.equal(context.powerCast.cost,6);assert.equal(context.powerCast.ap,4);
    assert.equal(context.powerCast.damageUpgrade,'die');
    const fresh=await panel({power:true,aoe:true});assert.equal(fresh.html.nodes.get('power-mod-damage').checked,false);
    assert.equal(fresh.item.system.damage,'2d6');
});

test('snapshot validation rejects corrupted enums, formulas, durations and target identities',()=>{
    const state=modifiers.preparePowerCast(makePower()).snapshot;
    assert.deepEqual(modifiers.validatePowerCastSnapshot(state),state);
    for(const patch of [{id:''},{cost:-1},{ap:Infinity},{damageUpgrade:'eval'},{rangeMultiplier:999},
        {duration:{instant:true,seconds:-1}},{targets:[{uuid:'Actor.victim',actorUuid:'Actor.victim'}]},
        {choices:{...state.choices,light:'evil'}},{damageActions:{x:{type:'macro'}}}])
        assert.throws(()=>modifiers.validatePowerCastSnapshot({...state,...patch}),/could not be verified/);
});

function nativeItemRoll(){
    const source=noImports(fs.readFileSync(path.resolve(__dirname,'../scripts/class/ItemRoll.js'),'utf8'))
        .replace('export default class ItemRoll','class ItemRoll');
    class Base {
        constructor(){this.flagUpdate={};this.reasons=[];this.mod=0;this.record=[];this.flavor=[];}
        addFlag(key,value){this.flagUpdate[key]=value;}addFlavor(value){this.flavor.push(value);}
        isItem(){} useShots(value){this.shotsUsed=value;}defineAction(){}raiseDmg(){this.dmgraise=true;}
        addModifier(value){this.record.push(['modifier',value]);}addDiceModifier(value){this.record.push(['dice',value]);}
        async rollDamage(...args){this.record.push(['damage',...args]);}
    }
    return Function('CharRoll','gb','getPropertyCombatModifiers',...Object.keys(modifiers),`${source}\nreturn ItemRoll;`)(
        Base,{trans:key=>key,realInt:Number},()=>({totals:{}}),...Object.values(modifiers));
}
test('production ItemRoll freezes Power damage, AP and explicit actions and keeps Raise independent of upgrades',async()=>{
    const Roll=nativeItemRoll(),item=makePower();
    item.system.actions.additional.alt={type:'damage',name:'Ice',override:'2d8',modifier:'1',ap:1};
    const cast=modifiers.preparePowerCast(item,{damage:true,ap:2,heavyWeapon:true}).snapshot;
    item.system.damage='99d12';item.system.ap=99;item.system.actions.additional.alt.override='99d12';
    const roll=new Roll(item.actor,item);roll.setPowerModifiers(cast);roll.raiseDmg();
    await roll.rollBaseDamage();
    assert.equal(roll.record.find(row=>row[0]==='damage')[1],'(2d6)+1d6');
    assert.match(roll.record.find(row=>row[0]==='damage')[2],/4/);assert.equal(roll.dmgraise,true);
    const alt=new Roll(item.actor,item);alt.setPowerModifiers(cast);await alt.rollAction('alt');
    assert.equal(alt.record.find(row=>row[0]==='damage')[1],'(2d8)+1d6');
    assert.match(alt.record.find(row=>row[0]==='damage')[2],/5/);
    alt.usePP(999);assert.equal(alt.shotsUsed,cast.cost);
});

test('native BasicRoll rolls upgraded and Raise dice separately with normal Acing',async()=>{
    const source=noImports(fs.readFileSync(path.resolve(__dirname,'../scripts/class/BasicRoll.js'),'utf8'))
        .replace('export default class BasicRoll','class BasicRoll');
    let formula;
    const gbSource=fs.readFileSync(path.resolve(__dirname,'../scripts/gb.js'),'utf8');
    const explode=Function(`${gbSource.slice(gbSource.indexOf('export const explodeAllDice='),gbSource.indexOf('export const updateParry='))
        .replace('export const','const')}\nreturn explodeAllDice;`)();
    const Basic=Function('gb','CONFIG',`${source}\nreturn BasicRoll;`)({explodeAllDice:explode}, {Dice:{SwadeRoll:class {
        constructor(value){formula=value;}async evaluate(){}
    }}});
    const roll=new Basic();
    await roll.buildDamageRoll('(2d6)+1d6',0,true,6);
    assert.equal(formula,'(2d6x)+1d6x+1d6x');
});

const setPath=(object,key,value)=>{
    const parts=key.split('.');let node=object;
    for(const part of parts.slice(0,-1))node=node[part] ??= {};
    const last=parts.at(-1);if(last.startsWith('-='))delete node[last.slice(2)];else node[last]=copy(value);
};
function fixture(selection={light:'glow',pace:'hinder',fatigue:true,lingering:true}){
    let counter=0,ledger={version:1,events:{}},rolls=0;
    const item=makePower(),caster=item.actor;caster.ownership={player:3};caster.items=new Map([[item.id,item]]);
    const victim={id:'victim',uuid:'Scene.scene.Token.victim.Actor.victim',type:'character',effects:new Map(),
        items:new Map([['stealth',{id:'stealth',name:'Stealth',type:'skill',system:{swid:'stealth'}}]]),
        system:{fatigue:{value:0,max:2},pace:{ground:6}}};
    const target={id:'victim',uuid:'Scene.scene.Token.victim',actor:victim,light:{dim:0,bright:0},flags:{},parent:{grid:{distance:2}},
        async update(patch){for(const [key,value]of Object.entries(patch))setPath(this,key,value);}};
    const gm={id:'a',isGM:true,active:true},player={id:'player',isGM:false,active:true};
    const game={user:gm,users:new Map([[gm.id,gm],[player.id,player]]),time:{worldTime:10},
        settings:{get:()=>ledger,set:async(_scope,_key,value)=>{ledger=copy(value);}},
        actors:new Map([[caster.id,caster]]),scenes:new Map([['scene',{tokens:new Map([[target.id,target]])}]]),messages:new Map(),
        combat:{id:'combat',round:1,turn:0,combatants:new Map(),combatant:{id:'caster',actor:caster,token:{uuid:'Scene.scene.Token.caster'}}}};
    game.combat.combatants.set('caster',game.combat.combatant);
    victim.createEmbeddedDocuments=async(_type,data)=>data.map(value=>{
        const effect={...copy(value),id:`effect-${++counter}`,parent:victim,
            async update(patch){for(const [key,value]of Object.entries(patch))setPath(this,key,value);},
            async delete(){victim.effects.delete(this.id);}};
        victim.effects.set(effect.id,effect);return effect;
    });
    const cast=modifiers.preparePowerCast(item,selection,{id:'cast',targets:[{uuid:target.uuid,actorUuid:victim.uuid}]}).snapshot;
    const message={id:'attack',user:'player',rolls:[{total:6}],speaker:{alias:'Caster'},whisper:['a'],blind:true,
        flags:{'swade-tools':{powerCast:cast,rolltype:'skill'}}};game.messages.set(message.id,message);
    const cards=[];
    const runtime={gameRef:game,fromUuid:async uuid=>uuid===target.uuid?target:null,
        RollClass:class {constructor(formula){this.formula=formula;this.total=7;}async evaluate(){rolls++;}},
        createDamageCard:async data=>cards.push(data)};
    const input={message,actor:caster,item,target,outcome:'hit',total:6,critical:false};
    return {game,item,caster,victim,target,cast,message,input,runtime,cards,get ledger(){return ledger;},get rolls(){return rolls;}};
}
test('primary GM creates bound effects once across simultaneous requests, fresh Benny cards and reloads',async()=>{
    const f=fixture();
    await Promise.all([effects.resolvePowerModifierTarget(f.input,f.runtime),effects.resolvePowerModifierTarget(f.input,f.runtime)]);
    assert.equal(f.victim.effects.size,4); // Hinder/Glow already affect the target, so Fatigue is eligible.
    const entry=Object.values(f.ledger.events)[0];assert.equal(entry.status,'applied');assert.equal(entry.fatiguePending,false);
    const benny={...f.message,id:'benny',rolls:[{total:9}]};f.game.messages.set(benny.id,benny);
    await effects.resolvePowerModifierTarget({...f.input,message:benny,total:9},f.runtime);
    assert.equal(f.victim.effects.size,4);
    assert.equal(f.target.light.dim,2);
});

test('players, secondary GMs, failed/critical casts, stale totals, unowned sources and changed target actors cannot mutate effects',async()=>{
    for(const setup of [
        f=>{f.game.user=f.game.users.get('player');},
        f=>{const second={id:'z',active:true,isGM:true};f.game.users.set('z',second);f.game.user=second;},
        f=>{f.input.outcome='miss';},f=>{f.input.critical=true;},f=>{f.input.total=4;},
        f=>{f.caster.ownership={player:0};},f=>{f.cast.targets[0].actorUuid='Actor.other';},f=>{f.target.hidden=true;}
    ]){
        const f=fixture();setup(f);await effects.resolvePowerModifierTarget(f.input,f.runtime);
        assert.equal(f.victim.effects.size,0);assert.equal(f.rolls,0);
    }
});

test('Fatigue is added only after actual native damage and does not repeat on damage/Soak clicks',async()=>{
    const f=fixture({fatigue:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    assert.equal(f.victim.effects.size,0);
    await effects.resolvePowerModifierDamage(f.input,f.runtime);
    await effects.resolvePowerModifierDamage(f.input,f.runtime);
    assert.equal(f.victim.effects.size,1);assert.equal(Object.values(f.ledger.events)[0].fatigueStatus,'applied');
    const effect=[...f.victim.effects.values()][0];
    for(const [start,expected]of [[0,1],[1,2],[2,2],[3,3]]){
        f.victim.system.fatigue.value=start;const changes={};
        effects.applyPowerModifierChange(f.victim,{effect,key:'system.fatigue.value'},null,null,changes);
        assert.equal(f.victim.system.fatigue.value,expected);
    }
});

test('non-damaging resisted powers stay pending until GM confirms affected, then automate once',async()=>{
    const f=fixture({light:'shroud',fatigue:true});f.cast.damage='';
    assert.equal((await effects.resolvePowerModifierTarget(f.input,f.runtime)).status,'pending');
    assert.equal(f.victim.effects.size,0);
    await effects.resolvePowerModifierTarget({...f.input,confirmed:true},f.runtime);
    assert.equal(f.victim.effects.size,2);
    await effects.resolvePowerModifierTarget({...f.input,confirmed:true},f.runtime);assert.equal(f.victim.effects.size,2);
});

test('Hinder/Hurry take strongest once, cancel each other, never reduce Pace below zero, and Shroud/Glow affect defense once',async()=>{
    const f=fixture({pace:'hinder',light:'shroud'});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const hinder=[...f.victim.effects.values()].find(effect=>effect.flags['swade-tools'].powerModifier.kind==='hinder');
    const second={...copy({...hinder,parent:undefined}),id:'zzz'};f.victim.effects.set(second.id,second);
    effects.applyPowerModifierChange(f.victim,{effect:hinder,key:'system.pace.ground'},null,null,{});
    assert.equal(f.victim.system.pace.ground,4);
    effects.applyPowerModifierChange(f.victim,{effect:second,key:'system.pace.ground'},null,null,{});assert.equal(f.victim.system.pace.ground,4);
    f.victim.system.pace.ground=1;effects.applyPowerModifierChange(f.victim,{effect:hinder,key:'system.pace.ground'},null,null,{});
    assert.equal(f.victim.system.pace.ground,0);assert.equal(effects.powerTargetDefense(f.victim,4),1);
});

test('instant effects survive until end of target NEXT turn; lingering rolls base-minus-step once, without Raise or PP',async()=>{
    const f=fixture({damage:true,light:'glow',lingering:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const caster={combatId:'combat',round:1,combatantId:'caster',actorUuid:f.caster.uuid,tokenUuid:'Scene.scene.Token.caster'};
    const target={combatId:'combat',round:1,combatantId:'victim',actorUuid:f.victim.uuid,tokenUuid:f.target.uuid};
    await effects.advancePowerModifierTurns(caster,target,f.runtime);
    assert.equal(f.cards.length,1);assert.equal(f.cards[0].damage.formula,'(2d4x)+1d4x');
    assert.deepEqual(f.cards[0].privacy.whisper,['a']);assert.equal(f.cards[0].privacy.blind,true);
    assert.equal(f.victim.effects.size,1);assert.equal(f.rolls,1);
    await effects.advancePowerModifierTurns(caster,target,f.runtime);assert.equal(f.rolls,1);
    await effects.advancePowerModifierTurns(target,{...caster,round:2},f.runtime);
    assert.equal(f.victim.effects.size,0);assert.equal(f.target.light.dim,0);
});

test('caster-turn durations expire at caster end and do not mistake a different linked token for the victim',async()=>{
    const f=fixture({pace:'hurry',lingering:true});f.cast.duration={label:'5',instant:false,seconds:30};
    await effects.resolvePowerModifierTarget(f.input,f.runtime);
    await effects.advancePowerModifierTurns({}, {combatId:'combat',round:1,combatantId:'other',actorUuid:f.victim.uuid,tokenUuid:'Scene.scene.Token.other'},f.runtime);
    assert.equal(f.cards.length,0);
    await effects.advancePowerModifierTurns({combatId:'combat',round:5,combatantId:'caster'}, {combatId:'combat',round:6,combatantId:'other'},f.runtime);
    assert.equal(f.victim.effects.size,2);
    await effects.advancePowerModifierTurns({combatId:'combat',round:6,combatantId:'caster'}, {combatId:'combat',round:6,combatantId:'other'},f.runtime);
    assert.equal(f.victim.effects.size,0);
});

test('Glow restores only its own light changes and does not overwrite later manual lighting edits',async()=>{
    const f=fixture({light:'glow'});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    assert.equal(f.target.light.dim,2);f.target.light.dim=10;f.victim.effects.clear();
    await effects.synchronizePowerGlow(f.target,f.runtime);
    assert.equal(f.target.light.dim,10);assert.equal(f.target.flags['swade-tools'].powerModifierLight,undefined);
});

test('outside combat World Time handles expiration and a one-time lingering tick; d4 loses a die',async()=>{
    assert.equal(effects.lingeringDamageFormula('2d4'),'1d4x');assert.equal(effects.lingeringDamageFormula('1d4'),'0');
    for(const formula of ['@damage','2d6 + Math.random()','1d100','1d6r<2'])assert.throws(()=>effects.lingeringDamageFormula(formula));
    const f=fixture({light:'glow',lingering:true});f.game.combat=null;
    await effects.resolvePowerModifierTarget(f.input,f.runtime);
    await effects.expirePowerModifierTime(15,f.runtime);assert.equal(f.rolls,0);
    await effects.expirePowerModifierTime(16,f.runtime);assert.equal(f.rolls,1);assert.equal(f.victim.effects.size,0);
    await effects.expirePowerModifierTime(100,f.runtime);assert.equal(f.rolls,1);
});

test('failed effect writes are claimed durably and cannot create automatic duplicates on retry',async()=>{
    const f=fixture({pace:'hinder'});f.victim.createEmbeddedDocuments=async()=>{throw Error('disconnected');};
    await assert.rejects(effects.resolvePowerModifierTarget(f.input,f.runtime),/disconnected/);
    assert.equal(Object.values(f.ledger.events)[0].status,'review');
    assert.equal((await effects.resolvePowerModifierTarget(f.input,f.runtime)).status,'review');
});

test('turn hook uses native Combat.previous on a remote update/reload, not an origin-client preUpdate assumption',async()=>{
    const f=fixture({light:'glow'});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const glow=[...f.victim.effects.values()][0];
    await glow.update({'flags.swade-tools.powerModifier.nextTurn':'combat:1:victim'});
    const hooks=new Map();effects.registerPowerModifierEffects({...f.runtime,hooks:{on:(key,fn)=>hooks.set(key,fn)}});
    f.game.combat.combatants.set('victim',{id:'victim',actor:f.victim,token:{uuid:f.target.uuid}});
    f.game.combat.previous={round:1,turn:1,combatantId:'victim'};f.game.combat.round=2;
    hooks.get('updateCombat')(f.game.combat,{round:2,turn:0});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.victim.effects.size,0);
});

test('multiple casters keep independent Glow durations; bonuses do not stack and ending one cast preserves the other light',async()=>{
    const f=fixture({light:'glow'});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const second={...f.message,id:'second',flags:{'swade-tools':{powerCast:{...f.cast,id:'cast-2'}}}};
    f.game.messages.set(second.id,second);
    await effects.resolvePowerModifierTarget({...f.input,message:second},f.runtime);
    assert.equal(f.victim.effects.size,2);
    assert.equal([...f.victim.effects.values()].reduce((sum,e)=>sum+e.changes.length,0),1);
    await effects.endPowerModifierCast(f.message,f.runtime);
    assert.equal(f.victim.effects.size,1);assert.equal(f.target.light.dim,2);
    assert.equal([...f.victim.effects.values()][0].changes.length,1);
    await effects.endPowerModifierCast(second,f.runtime);assert.equal(f.victim.effects.size,0);assert.equal(f.target.light.dim,0);
    await effects.resolvePowerModifierTarget(f.input,f.runtime);assert.equal(f.victim.effects.size,0);
});

test('ending a cast also cancels pending Fatigue without deleting unrelated native effects',async()=>{
    const f=fixture({fatigue:true,lingering:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    f.victim.effects.set('native',{id:'native',name:'Other spell',flags:{}});
    await effects.endPowerModifierCast(f.message,f.runtime);
    assert.equal(f.victim.effects.size,1);assert.ok(f.victim.effects.has('native'));
    await effects.resolvePowerModifierDamage(f.input,f.runtime);assert.equal(f.victim.effects.size,1);
});

test('Power range resolves English/localized attributes and freezes base multiples without rolling',()=>{
    const item=makePower('Blast');item.actor.system={attributes:{smarts:{die:{sides:8}}}};
    for(const range of ['Smarts x2','Smarts * 2','Smarts \u00d7 2']){
        item.system.range=range;
        const cast=modifiers.preparePowerCast(item,{range:1}).snapshot;
        assert.equal(cast.rangeSquares,32);assert.equal(cast.rangeLimit,null);
    }
    item.system.range='Zeka x2';
    assert.deepEqual(modifiers.powerRangeProfile(item,item.actor,{i18n:{localize:key=>key==='SWADE.AttrSma'?'Zeka':key}}),{distance:null,squares:16});
});

test('invalid Lingering formulas are rejected before PP; explicit damage actions freeze their own base/AP/Heavy',()=>{
    const item=makePower();item.system.damage='2d6)';
    assert.throws(()=>modifiers.preparePowerCast(item,{lingering:true}),/plain base/);
    item.system.damage='2d6';item.system.actions.additional.ice={type:'damage',override:'2d8',ap:2,isHeavyWeapon:true};
    const cast=modifiers.preparePowerCast(item,{lingering:true,damage:true,ap:1},{damageAction:'ice'}).snapshot;
    assert.equal(cast.lingeringFormula,'(2d6x)+1d4x');assert.equal(cast.lingeringAp,4);assert.equal(cast.lingeringHeavyWeapon,true);
});

test('Power critical failure is natural trait/Wild ones even if positive modifiers lift the total above 4',()=>{
    const dice=(...results)=>({terms:[{dice:results.map(result=>({results:[{result}],total:result}))}]});
    assert.equal(modifiers.powerActivationCritical(dice(1,1),{isWildcard:true}),true);
    assert.equal(modifiers.powerActivationCritical(dice(1,6),{isWildcard:true}),false);
    assert.equal(modifiers.powerActivationCritical(dice(1),{isWildcard:false}),true);
    assert.equal(modifiers.powerActivationCritical(dice(6),{isWildcard:false}),false);
});

test('native Power PP charges declared cost once, failure one PP, preserves remaining debt and never charges innate damage',()=>{
    const source=noImports(fs.readFileSync(path.resolve(__dirname,'../scripts/class/CharRoll.js'),'utf8')).replace('export default class CharRoll','class CharRoll');
    const spent=[],gb={systemSetting:()=>false,trans:key=>key};
    const Native=Function('BasicRoll','gb','Char',...Object.keys(modifiers),`${source}\nreturn CharRoll;`)(class {},gb,
        class {spendPP(...args){spent.push(args);}},...Object.values(modifiers));
    const roll=new Native({isWildcard:true});roll.item={type:'power',_id:'power',system:{}};
    roll.flagUpdate.powerCast={id:'cast'};roll.rolltype='skill';roll.shotsUsed=6;roll.raiseCount=()=>0;
    roll.roll={terms:[{dice:[{total:1},{total:1}]}]};roll.powerCount();assert.deepEqual(spent,[[1,'power']]);
    assert.equal(roll.flagUpdate.arcanefail.pp,5);
    spent.length=0;roll.roll.terms[0].dice=[{total:5},{total:3}];roll.powerCount();assert.deepEqual(spent,[[6,'power']]);
    spent.length=0;roll.rolltype='damage';roll.item.system.innate=true;roll.powerCount();assert.deepEqual(spent,[]);
});

test('a Power cannot worsen or improve its own Hit/Raise on re-render or Benny through the Shroud/Glow it just applied',async()=>{
    const f=fixture({light:'shroud'});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    assert.equal(effects.powerTargetDefense(f.victim,2),1);
    assert.equal(effects.powerTargetDefense(f.victim,2,f.cast.id),0);
    assert.equal(effects.powerTargetDefense(f.victim,2,'other-cast'),1);
});

test('combat deletion converts timed effects to World Time instead of leaving permanent combat flags',async()=>{
    const f=fixture({light:'glow',lingering:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const hooks=new Map();effects.registerPowerModifierEffects({...f.runtime,hooks:{on:(key,fn)=>hooks.set(key,fn)}});
    hooks.get('deleteCombat')(f.game.combat);f.game.combat=null;
    await new Promise(resolve=>setImmediate(resolve));
    for(const effect of f.victim.effects.values())assert.equal(effect.flags['swade-tools'].powerModifier.combatId,null);
    await effects.expirePowerModifierTime(16,f.runtime);assert.equal(f.victim.effects.size,0);assert.equal(f.rolls,1);
});

test('remaining Soak damage can apply the original Power Fatigue without turning the Soak actor into the caster',async()=>{
    const f=fixture({fatigue:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const soak={id:'soak',flags:{'swade-tools':{rolltype:'soak',powerModifierSource:{cast:f.cast}}}};
    f.runtime.fromUuid=async uuid=>uuid===f.target.uuid?f.target:uuid===f.caster.uuid?f.caster:uuid===f.item.uuid?f.item:null;
    await effects.resolvePowerModifierDamage({message:soak,target:f.target},f.runtime);
    assert.equal(f.victim.effects.size,1);
    assert.equal(Object.values(f.ledger.events)[0].fatigueStatus,'applied');
    assert.equal(soak.flags['swade-tools'].powerCast,undefined);
});

test('late damage/Soak cards do not add expired Fatigue after the target next turn has ended',async()=>{
    const f=fixture({fatigue:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const caster={combatId:'combat',round:1,combatantId:'caster',actorUuid:f.caster.uuid,tokenUuid:'Scene.scene.Token.caster'};
    const victim={combatId:'combat',round:1,combatantId:'victim',actorUuid:f.victim.uuid,tokenUuid:f.target.uuid};
    await effects.advancePowerModifierTurns(caster,victim,f.runtime);
    await effects.advancePowerModifierTurns(victim,{...caster,round:2},f.runtime);
    await effects.resolvePowerModifierDamage(f.input,f.runtime);
    assert.equal(f.victim.effects.size,0);assert.equal(Object.values(f.ledger.events)[0].fatigueStatus,'expired');
});

test('Fatigue applied during the next target turn expires at that same turn end, not another round later',async()=>{
    const f=fixture({fatigue:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    const caster={combatId:'combat',round:1,combatantId:'caster',actorUuid:f.caster.uuid,tokenUuid:'Scene.scene.Token.caster'};
    const victim={combatId:'combat',round:1,combatantId:'victim',actorUuid:f.victim.uuid,tokenUuid:f.target.uuid};
    await effects.advancePowerModifierTurns(caster,victim,f.runtime);
    await effects.resolvePowerModifierDamage(f.input,f.runtime);assert.equal(f.victim.effects.size,1);
    await effects.advancePowerModifierTurns(victim,{...caster,round:2},f.runtime);assert.equal(f.victim.effects.size,0);
});

test('ambiguous/special power durations expose a bounded explicit next-turn or rounds choice',()=>{
    const item=makePower();item.system.duration='Special';
    assert.match(modifiers.renderPowerModifiers(item),/power-mod-expiry/);
    assert.equal(modifiers.preparePowerCast(item,{durationMode:'nextTurn'}).snapshot.duration.instant,true);
    assert.equal(modifiers.preparePowerCast(item,{durationMode:'rounds',durationRounds:3}).snapshot.duration.seconds,18);
    assert.throws(()=>modifiers.preparePowerCast(item,{durationMode:'rounds',durationRounds:0}),/whole number/);
    item.system.duration="Until the end of the victim's next turn";
    assert.equal(modifiers.preparePowerCast(item).snapshot.duration.instant,true);
});

test('Fatigue applies immediately when another selected modifier already affects the target, even before damage',async()=>{
    const f=fixture({fatigue:true,pace:'hinder'});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    assert.equal(f.victim.effects.size,2);assert.equal(Object.values(f.ledger.events)[0].fatiguePending,false);
});

test('actual Lingering or its Soak remainder can settle eligible original Fatigue without a second casting cost',async()=>{
    const f=fixture({fatigue:true,lingering:true});await effects.resolvePowerModifierTarget(f.input,f.runtime);
    f.runtime.fromUuid=async uuid=>uuid===f.target.uuid?f.target:uuid===f.caster.uuid?f.caster:uuid===f.item.uuid?f.item:null;
    const message={id:'lingering',flags:{'swade-tools':{aoeFire:{kind:'powerLingering',
        powerModifierMessageId:f.message.id,powerModifierCastId:f.cast.id}}}};
    await effects.resolvePowerModifierDamage({message,target:f.target},f.runtime);
    assert.ok([...f.victim.effects.values()].some(effect=>effect.flags['swade-tools'].powerModifier.kind==='fatigue'));
    await effects.resolvePowerModifierDamage({message,target:f.target},f.runtime);
    assert.equal([...f.victim.effects.values()].filter(effect=>effect.flags['swade-tools'].powerModifier.kind==='fatigue').length,1);
});

test('No Power Points applies the new modifier cost to the native casting penalty without showing Extra PP',async()=>{
    const p=await panel({power:true,noPowerPoints:true});
    assert.equal(p.html.nodes.has('extrapp'),false);
    p.html.nodes.get('power-mod-damage').checked=true;
    await p.config.buttons.mainSkill.callback(p.html);
    const mods=p.events.filter(event=>event[0]==='modifier').map(event=>Number(event[1] || 0));
    assert.equal(mods.reduce((sum,value)=>sum+value,0),-2);
    assert.equal(p.events.some(event=>event[0]==='extra-pp'),false);
});

test('automatic effects require an active GM before a casting roll or PP commitment',async()=>{
    const p=await panel({power:true,gameRef:{users:new Map([['player',{id:'player',active:true,isGM:false}]])}});
    p.html.nodes.get('power-mod-lingering').checked=true;
    await p.config.buttons.mainSkill.callback(p.html);
    assert.match(p.notices[0],/active GM/);assert.equal(p.events.some(event=>event[0]==='native-skill'),false);
    assert.equal(p.events.some(event=>event[0]==='extra-pp'),false);
});

test('localized Extra group rolls keep their Wild Die protection while Conviction never rescues a natural-one Extra',()=>{
    const grouped={terms:[{dice:[{total:1,options:{flavor:'Zaubern'}},{total:6,options:{flavor:'Wild Die'}}]}]};
    assert.equal(modifiers.powerActivationCritical(grouped,{isWildcard:false}),false);
    grouped.terms[0].dice[1].options.flavor='Destino';
    assert.equal(modifiers.powerActivationCritical(grouped,{isWildcard:false}),false);
    const conviction={terms:[{total:1}],dice:[{total:1},{total:6}]};
    assert.equal(modifiers.powerActivationCritical(conviction,{isWildcard:false}),true);
});
