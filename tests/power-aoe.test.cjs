const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {pathToFileURL} = require('node:url');
const {panel} = require('./weapon-panel.test.cjs');
const scripts = path.resolve(__dirname, '../scripts');
const service = () => import(pathToFileURL(path.join(scripts,'services/PowerAoeCast.js')).href);

const fixture = (options = {}) => {
    const events=[],notices=[],rolls=[];
    const actor={isOwner:true};
    const item={isOwner:true,type:'power',system:{pp:2,damage:'2d6',arcane:'general',actions:{additional:{}}},
        effects:[{type:'modifier',disabled:false,system:{cost:1}},{type:'modifier',disabled:true,system:{cost:8}}]};
    const targets=new Map([['target',{id:'target',actor:{}}]]);
    const placement={templateDocument:{id:'area',async delete(){events.push('delete');}},sceneId:'scene',
        sourceToken:{id:'caster'},targetIds:options.empty?[]:['target'],shape:'cone'};
    const context={actor,item,shape:'cone',extraPP:1,getActualPP:()=>9,
        createRoll(){
            const roll={flagUpdate:{},canCast:true,raiseCount:()=>options.failed?-1:0,
                addFlag(key,value){this.flagUpdate[key]=value;},useTarget(ids){this.usetarget=ids;},
                raiseDmg(){this.dmgraise=true;},
                async rollAction(id){this.rolltype='damage';events.push(['innate-action',id]);},
                async rollBaseDamage(){this.rolltype='damage';events.push('innate-damage');},
                async display(){events.push('display');}};
            rolls.push(roll);return roll;
        },
        async prepareRoll(){events.push('prepare');},
        async performRoll(roll){events.push('roll');if(item.system.innate) roll.dontDisplay=true;}};
    const runtime={canvasRef:{scene:{id:'scene'},tokens:{get:id=>targets.get(id)}},
        async place(){events.push('place');return options.cancel?null:placement;},
        async suppress(items,fn){assert.equal(items[0],item);return fn();},
        async animate(data){events.push(['animate',data]);},notify:message=>notices.push(message),logger:{warn(){}}};
    return {events,notices,rolls,actor,item,placement,context,runtime};
};

test('Power panel preserves Extra PP/native skill and replaces unsafe template-only buttons',async()=>{
    const p=await panel({power:true,aoe:true});
    assert.ok(p.config);assert.equal(p.events.length,0);
    assert.match(p.config.content,/id="extrapp"/);assert.match(p.config.content,/swadetools-power-modifiers/);
    assert.equal(p.html.nodes.get('power-aoe-shape').value,'cone');
    assert.equal(p.html.nodes.get('power-aoe-shape').options.length,6);
    assert.doesNotMatch(p.config.content,/data-template|rof-consume-ammo|rof-recoil/);
    assert.match(p.config.buttons.mainSkill.label,/Aetherics/);
    p.html.nodes.get('extrapp').value='3';p.html.nodes.get('power-aoe-shape').value='stream';
    await p.config.buttons.mainSkill.callback(p.html);
    const context=p.events.find(e=>e[0]==='power-aoe')[1];
    assert.equal(context.extraPP,'3');assert.equal(context.shape,'stream');
    const roll={addModifier:(...args)=>p.events.push(['mod',...args]),usePP:v=>p.events.push(['pp',v]),addFlag(){}};
    await context.prepareRoll(roll);assert.ok(p.events.some(e=>e[0]==='pp'&&e[1]==='3'));
    assert.equal(p.events.some(e=>e[0]==='aoe'),false);
});

test('ordinary powers remain unchanged, while AoE damage bypasses attack-only penalties',async()=>{
    const normal=await panel({power:true});
    assert.doesNotMatch(normal.config.content,/power-aoe-shape/);
    assert.match(normal.config.content,/data-template="cone"/);
    await normal.config.buttons.mainSkill.callback(normal.html);
    assert.ok(normal.events.some(e=>e[0]==='native-skill'));
    const p=await panel({power:true,aoe:true});
    p.html.nodes.get('mod').value='-4';p.html.nodes.get('cover').value='Heavy';
    p.html.nodes.get('illumination').value='Dark';p.html.nodes.get('multiaction').value='-2';
    await p.config.buttons.mainDamage.callback(p.html);
    const context=p.events.find(e=>e[0]==='power-aoe')[1];
    assert.equal(context.actionType,'damage');
    const mods=[];await context.prepareRoll({addModifier:(...args)=>mods.push(args),usePP(){},addFlag(){}});
    assert.deepEqual(mods.map(args=>args[0]),['0']);
});

test('Power cost counts enabled modifiers/Extra PP and native trait-action overrides only',async()=>{
    const {getPowerAoeCost}=await service();const f=fixture();
    assert.equal(getPowerAoeCost(f.item,1),4);
    f.item.system.actions.additional.cast={type:'trait',resourcesUsed:5};
    assert.equal(getPowerAoeCost(f.item,9,'cast'),5);
    for(const extra of ['2.5','invalid','1d6']) assert.throws(()=>getPowerAoeCost(f.item,extra),/whole numbers/);
});

test('Power cannot consume ammo or quantity even through an old resource-service call',async()=>{
    const {describeAoeResource,commitAoeResources}=await import(pathToFileURL(path.join(scripts,'services/AoeResourceService.js')).href);
    let writes=0;const item={type:'power',isOwner:true,system:{quantity:4},update(){writes++;},
        flags:{'swade-tools':{aoeConsume:true,aoeConsumeMode:'item',aoeAmmoCost:2}}};
    const plan=describeAoeResource(item);assert.equal(plan.managed,false);assert.equal(plan.cost,0);
    await commitAoeResources(item);assert.equal(writes,0);
});

test('cancel and insufficient PP never roll, spend, animate or leave a template',async()=>{
    const {runPowerAoe}=await service();const f=fixture({cancel:true});
    assert.equal(await runPowerAoe(f.context,f.runtime),false);assert.deepEqual(f.events,['place']);
    const short=fixture();short.context.getActualPP=()=>3;
    assert.equal(await runPowerAoe(short.context,short.runtime),false);
    assert.equal(short.events.length,0);assert.match(short.notices[0],/Power Points/);
    const changed=fixture();let available=9;changed.context.getActualPP=()=>available;
    changed.runtime.place=async()=>{available=0;return changed.placement;};
    assert.equal(await runPowerAoe(changed.context,changed.runtime),false);assert.deepEqual(changed.events,['delete']);
});

test('native cast runs once with frozen targets and AA gets native cone without fallback',async()=>{
    const {runPowerAoe}=await service();const f=fixture();
    const result=await runPowerAoe(f.context,f.runtime);
    assert.equal(result.success,true);assert.equal(f.rolls.length,1);
    assert.equal(f.rolls[0].usetarget,'target');assert.equal(f.rolls[0].flagUpdate.powerAoe.sceneId,'scene');
    assert.deepEqual(f.events.slice(0,4),['place','prepare','roll','display']);
    const aa=f.events.at(-1)[1];assert.equal(aa.templateDocument,f.placement.templateDocument);
    assert.equal(aa.allowFallback,false);assert.equal(aa.targets.length,1);
    const failed=fixture({failed:true});await runPowerAoe(failed.context,failed.runtime);
    assert.equal(failed.events.some(e=>Array.isArray(e)&&e[0]==='animate'),false);
});

test('empty areas never reuse selected targets; stale/missing tokens are filtered',async()=>{
    const {runPowerAoe,getPowerAoeTargets}=await service();const f=fixture({empty:true});
    const result=await runPowerAoe(f.context,f.runtime);assert.deepEqual(result.snapshot.targetIds,[]);
    assert.equal(f.rolls[0].usetarget,'');assert.ok(f.rolls[0].flagUpdate.powerAoe);
    assert.deepEqual(getPowerAoeTargets({...result.snapshot,targetIds:['target','target','gone']},f.runtime.canvasRef).map(t=>t.id),['target']);
    assert.deepEqual(getPowerAoeTargets({...result.snapshot,sceneId:'other'},f.runtime.canvasRef),[]);
});

test('damage-only and no-PP variant never require PP; innate casts damage once without recast',async()=>{
    const {runPowerAoe}=await service();
    for(const variant of [{actionType:'damage'},{noPowerPoints:true}]){
        const f=fixture();Object.assign(f.context,variant);f.context.getActualPP=()=>{throw new Error('must not read PP');};
        assert.ok(await runPowerAoe(f.context,f.runtime));
    }
    const f=fixture();f.item.system.innate=true;
    assert.ok(await runPowerAoe(f.context,f.runtime));assert.equal(f.rolls.length,2);
    assert.equal(f.events.filter(e=>e==='roll').length,1);assert.equal(f.events.filter(e=>e==='innate-damage').length,1);
    assert.equal(f.rolls[1].flagUpdate.powerAoe.sceneId,'scene');
    const configured=fixture();configured.item.system.innate=true;
    configured.context.prepareRoll=async roll=>{roll.raiseDmg();roll.addFlag('damageaction','heavy-burst');};
    await runPowerAoe(configured.context,configured.runtime);
    assert.equal(configured.rolls[1].dmgraise,true);
    assert.ok(configured.events.some(e=>Array.isArray(e)&&e[0]==='innate-action'&&e[1]==='heavy-burst'));
});

test('native PP bookkeeping keeps failed→Benny contract and never charges AoE innate damage',()=>{
    const source=fs.readFileSync(path.join(scripts,'class/CharRoll.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class CharRoll','class CharRoll');
    const spent=[];const gb={systemSetting:()=>false,trans:key=>key};
    const CharRoll=Function('BasicRoll','gb','Char',`${source}\nreturn CharRoll;`)(class {},gb,class {spendPP(...args){spent.push(args);}});
    const roll=new CharRoll({});roll.item={type:'power',_id:'burst',system:{innate:false}};
    roll.rolltype='skill';roll.shotsUsed=5;roll.flagUpdate.powerAoe={sceneId:'scene'};roll.raiseCount=()=>-1;
    roll.powerCount();assert.deepEqual(spent,[[1,'burst']]);
    assert.deepEqual(roll.flagUpdate.arcanefail,{pp:4,arcaneItem:'burst'});
    roll.raiseCount=()=>0;spent.length=0;roll.powerCount();assert.deepEqual(spent,[[5,'burst']]);
    roll.item.system.innate=true;roll.rolltype='damage';spent.length=0;roll.powerCount();assert.deepEqual(spent,[]);
    roll.flagUpdate.powerAoe=undefined;roll.rolltype='skill';roll.powerCount();assert.deepEqual(spent,[[5,'burst']]);
    roll.item.system.innate=false;roll.flagUpdate={powerAoe:{sceneId:'scene'}};
    roll.shotsUsed=0;roll.raiseCount=()=>-1;spent.length=0;roll.powerCount();
    assert.deepEqual(spent,[]);assert.equal(roll.flagUpdate.arcanefail,undefined);
});

test('actual native target selection respects empty areas, scene identity and missing tokens',async()=>{
    const source=fs.readFileSync(path.join(scripts,'class/RollControl.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class RollControl','class RollControl');
    const Control=Function('gb',`${source}\nreturn RollControl;`)({trans:key=>key,mainGM:()=>false});
    const token={id:'target',actor:{}};
    global.canvas={scene:{id:'scene'},tokens:{get:id=>id==='target'?token:null}};
    const chain={append(){return this;},on(){return this;},ready(){return this;}};
    for(const [area,count] of [
        [{powerAoe:{sceneId:'scene',targetIds:['target','gone','target']}},1],
        [{powerAoe:{sceneId:'scene',targetIds:[]}},0],
        [{powerAoe:{sceneId:'other',targetIds:['target']}},0],
        [{aoeArea:{sceneId:'scene',targets:['Scene.scene.Token.target','Scene.other.Token.target']}},1]
    ]){
        const control=new Control({rolls:[{total:5}],flags:{'swade-tools':{itemroll:'burst',userof:1,rolltype:'skill',...area}}},chain,
            {get targets(){throw new Error('Area cards must never read current target rings');}});
        let calls=0;control.attackTarget=()=>calls++;
        await control.findTargets();assert.equal(calls,count);
    }
    delete global.canvas;
});

test('native Power Benny preserves the area and remaining PP without recreating a template',async()=>{
    const source=fs.readFileSync(path.join(scripts,'class/RollControl.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class RollControl','class RollControl');
    const calls=[],patches=[],spent=[];
    const Control=Function('gb','Char','withSuppressedAoeAutomation',`${source}\nreturn RollControl;`)(
        {trans:key=>key,raiseCount:()=>0},class {spendPP(...args){spent.push(args);}},
        async(items,fn)=>{calls.push('guard');return fn();});
    const item={id:'burst'},actor={items:new Map([['burst',item]])};
    global.game={user:{_id:'player',id:'player'}};global.ChatMessage={getSpeaker:()=>({})};
    global.Hooks={call(){calls.push('native-hook');}};
    global.CONFIG={Dice:{SwadeRoll:class {
        constructor(){this.terms=[{}];this.total=6;}async evaluate(){calls.push('dice');}
        async toMessage(){calls.push('chat');return {update:async patch=>patches.push(patch)};}
    }}};
    const snapshot={sceneId:'scene',sourceTokenId:'caster',targetIds:['target'],shape:'cone'};
    const flags={itemroll:'burst',powerAoe:snapshot,arcanefail:{pp:4,arcaneItem:'burst'}};
    const chat={rolls:[{formula:'1d8x-2',terms:[{options:{}}]}],flavor:'FailedPP',flags:{'swade-tools':flags}};
    await new Control(chat,{},'player').rerollBasic(actor,true);
    assert.deepEqual(calls,['guard','dice','native-hook','chat']);assert.deepEqual(spent,[[4,'burst']]);
    assert.deepEqual(patches[0]['flags.swade-tools'].powerAoe,snapshot);
    assert.deepEqual(patches[0]['flags.swade-tools'].arcanefail,{});
    delete global.game;delete global.ChatMessage;delete global.Hooks;delete global.CONFIG;
});

test('GM Power correction settles only the failed activation remaining PP and clears its debt',async()=>{
    const {settlePowerAoeCorrection}=await service();const paid=[];
    const message={flavor:'Burst<div>Failed PP</div>',flags:{'swade-tools':{powerAoe:{},rolltype:'skill',itemroll:'burst',arcanefail:{arcaneItem:'burst',pp:4}}}};
    const context={message,rawTotal:3,modifier:2,criticalFailure:false,getAvailablePP:()=>7,
        spendPP:async(...args)=>paid.push(args),failedPpHtml:'<div>Failed PP</div>'};
    const update=await settlePowerAoeCorrection(context);
    assert.deepEqual(paid,[[4,'burst']]);assert.equal(update['flags.swade-tools.gmmod'],2);
    assert.equal(update.flavor,'Burst');assert.deepEqual(update['flags.swade-tools.arcanefail'],{});
    await settlePowerAoeCorrection({...context,modifier:5});assert.equal(paid.length,1);
});

test('failed/critical/invalid/underfunded Power corrections cannot trigger extra PP or damage',async()=>{
    const {settlePowerAoeCorrection}=await service();let paid=0;
    const context=()=>({message:{flags:{'swade-tools':{powerAoe:{},rolltype:'skill',itemroll:'burst',arcanefail:{arcaneItem:'burst',pp:4}}}},
        rawTotal:3,modifier:2,getAvailablePP:()=>2,spendPP:async()=>paid++});
    assert.deepEqual(await settlePowerAoeCorrection({...context(),modifier:0}),{'flags.swade-tools.gmmod':0});
    await assert.rejects(settlePowerAoeCorrection(context()),/Power Points/);
    await assert.rejects(settlePowerAoeCorrection({...context(),getAvailablePP:()=>NaN}),/Power Points/);
    await assert.rejects(settlePowerAoeCorrection({...context(),criticalFailure:true}),/Critical Failure/);
    await assert.rejects(settlePowerAoeCorrection({...context(),modifier:'invalid'}),/numeric/);
    assert.equal(paid,0);
});

test('actual native Power target gate honors GM correction only for new area cards',()=>{
    const source=fs.readFileSync(path.join(scripts,'class/RollControl.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class RollControl','class RollControl');
    const Control=Function('gb',`${source}\nreturn RollControl;`)({raiseCount:(total,tn)=>Math.floor((total-tn)/4)});
    for(const [area,critical,expected] of [[true,false,false],[true,true,true],[false,false,true]]){
        const control=new Control({rolls:[{total:3}],flags:{'swade-tools':{userof:1,...(area?{powerAoe:{}}:{})}}},{},'player');
        control.gmmod=2;control.isCritical=()=>critical;
        assert.equal(control.failedPower({type:'power'}),expected);
    }
});

test('deleted synthetic power caster never falls back to another token or base actor',()=>{
    const source=fs.readFileSync(path.join(scripts,'class/RollControl.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class RollControl','class RollControl');
    const warnings=[];global.game={scenes:{get:()=>({tokens:{get:()=>null}})}};
    global.ui={notifications:{warn:message=>warnings.push(message)}};
    const Control=Function(`${source}\nreturn RollControl;`)();
    const control=new Control({rolls:[{}],flags:{'swade-tools':{powerAoe:{sceneId:'scene',sourceTokenId:'deleted'},usetoken:'deleted'}}},{},'player');
    assert.equal(control.getActor(),null);assert.equal(control.findActor(),false);assert.equal(warnings.length,1);
    delete global.game;delete global.ui;
});
