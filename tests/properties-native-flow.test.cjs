const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const moduleOf=name=>import(pathToFileURL(path.resolve(__dirname,`../scripts/${name}`)).href);
const collection=items=>Object.assign(items,{get(id){return this.find(item=>item.id===id);}});

async function fixture(t,{enabled=true,cover=-4,nativeDodge=true}={}){
    const old={game:global.game,canvas:global.canvas};
    t.after(()=>{for(const [key,value]of Object.entries(old)){if(value===undefined)delete global[key];else global[key]=value;}});
    const {normalizeRule}=await moduleOf('services/PropertiesRules.js');
    const actor={id:'attacker',uuid:'Actor.attacker',type:'character',permission:3,
        system:{status:{},attributes:{strength:{die:{sides:8}}},stats:{globalMods:{},parry:{value:4,modifier:0}}}};
    const victim={id:'victim',uuid:'Actor.victim',type:'character',permission:3,
        system:{status:{},stats:{globalMods:{},parry:{value:4,modifier:0}}}};
    const item={id:'rifle',uuid:'Actor.attacker.Item.rifle',actor,parent:actor,type:'weapon',name:'Rifle',
        system:{range:'24/48/96',damage:'2d6',trademark:0,actions:{trait:'Shooting',traitMod:0,dmgMod:0,additional:{}}}};
    const attackerEdge={id:'custom',uuid:'Actor.attacker.Item.custom',type:'edge',name:'Custom Attack',system:{}};
    const defense={id:'defense',uuid:'Actor.victim.Item.defense',type:'ability',name:'Custom Dodge',system:{}};
    actor.items=collection([item,attackerEdge]);
    victim.items=collection([defense,...(nativeDodge?[{id:'dodge',name:'Dodge',type:'edge',system:{}}]:[]),
        {id:'shield',name:'Shield',type:'shield',system:{equipStatus:3,cover}}]);
    const scene={gridType:1,grid:{size:100}};
    const token=(id,owner,x)=>({id,name:owner.id,actor:owner,x,y:0,scene,
        document:{id,uuid:`Scene.scene.Token.${id}`,actor:owner,width:1,height:1,elevation:0}});
    const source=token('source',actor,0),target=token('target',victim,2000);
    const library={version:1,assignments:{},presets:[],favorites:[]};
    const setRules=(source,rules)=>{library.assignments[source.uuid]=rules.map(normalizeRule);};
    global.game={user:{id:'gm',isGM:true},i18n:{localize:key=>key},
        actors:new Map([[actor.id,actor],[victim.id,victim]]),settings:{get(scope,key){
            if(scope==='swade')return false;
            if(key==='propertiesEnabled')return enabled;
            if(key==='propertiesLibrary')return library;
            if(key==='fightingSkill')return 'Fighting';
            if(key==='shootingSkill')return 'Shooting';
            if(key==='autoCover'||key==='ignoreRange')return true;
            if(key.endsWith('Setting'))return key.slice(0,-7);
            return false;
        }}};
    global.canvas={scene:{id:'scene'},tokens:{get:id=>id===source.id?source:id===target.id?target:null},dimensions:{distance:1},
        grid:{distance:1,measurePath:([a,b])=>({distance:Math.hypot(a.x-b.x,a.y-b.y)/100})}};
    const {default:RollControl}=await moduleOf('class/RollControl.js');
    const attack=(total=8,existingMessage=null)=>{
        const message=existingMessage??{id:'attack',rolls:[{total}],flags:{'swade-tools':{itemroll:item.id,userof:1,skill:'Shooting',rolltype:'skill',useactor:actor.id}}};
        const control=new RollControl(message,null,game.user);
        control.getActor=asToken=>asToken?source:actor;
        control.getItemOwner=()=>actor;
        control.attackTarget(target,total,1);
        return control;
    };
    return {actor,victim,item,attackerEdge,defense,source,target,library,setRules,attack};
}

test('actual native single fire uses strongest custom/native Dodge and readied cover only once',async t=>{
    const f=await fixture(t);
    f.setRules(f.defense,[{id:'cover',action:'cover',value:-2,stack:'best',group:'cover'}]);
    const control=f.attack(8);
    assert.equal(control.propertiesInputs[0].outcome,'hit','TN is 4 + strongest cover 4, not native Dodge + cover + property');
    assert.equal(control.propertiesInputs[0].range,20);
    assert.equal(control.propertiesInputs[0].target,f.target);
    assert.equal(control.propertiesInputs[0].hitKey,'1');
    assert.match(control.targetPrint[0].print,/Properties \/ Cover: -4/);
});

test('an automatically applied Vulnerable effect cannot turn its own native hit or damage link into a Raise',async t=>{
    const f=await fixture(t,{nativeDodge:false,cover:0});
    const {registerPropertyCandidate}=await moduleOf('services/PropertiesEffects.js');
    const clone=value=>JSON.parse(JSON.stringify(value));
    f.setRules(f.item,[{id:'vulnerable',name:'Vulnerable on Hit',action:'status',status:'vulnerable',trigger:'hit',
        automaticAccept:true,automaticAcceptSince:1}]);
    f.victim.effects=new Map();f.victim.statuses=new Set();
    const gm={id:'gm',isGM:true,active:true};game.user=gm;game.users=new Map([[gm.id,gm]]);
    const scene={id:'scene',tokens:new Map([[f.target.id,f.target.document]])};
    game.scenes=new Map([[scene.id,scene]]);game.messages=new Map();
    let ledger={version:1,candidates:{},events:{}};
    const oldGet=game.settings.get;
    game.settings.get=(scope,key)=>key==='propertiesEventLedger'?ledger:oldGet(scope,key);
    game.settings.set=async(_scope,key,value)=>{assert.equal(key,'propertiesEventLedger');ledger=clone(value);};
    f.victim.createEmbeddedDocuments=async(type,data)=>{
        assert.equal(type,'ActiveEffect');
        f.victim.system.status.isVulnerable=true;f.victim.statuses.add('vulnerable');
        return data.map(raw=>{const effect={...clone(raw),id:'vulnerable-effect',parent:f.victim,active:true};
            f.victim.effects.set(effect.id,effect);return effect;});
    };
    const before=f.attack(7),message=before.chat;
    Object.assign(message,{timestamp:100,user:gm.id,isContentVisible:true,async update(data){
        for(const [key,value]of Object.entries(data)){
            const parts=key.split('.');let object=this;
            for(const part of parts.slice(0,-1))object=object[part]??={};
            object[parts.at(-1)]=clone(value);
        }
    }});
    game.messages.set(message.id,message);
    const documents=new Map([[f.actor.uuid,f.actor],[f.item.uuid,f.item],[f.target.document.uuid,f.target.document]]);
    const runtime={gameRef:game,canvasRef:canvas,fromUuid:async uuid=>documents.get(uuid),
        resolvePropertyCandidate:async()=>({outcome:'hit'}),statusEffects:[{id:'vulnerable',name:'Vulnerable',
            changes:[{key:'system.status.isVulnerable',mode:5,value:'true'}]}]};
    assert.equal(before.propertiesInputs[0].outcome,'hit');
    const applied=await registerPropertyCandidate(before.propertiesInputs[0],runtime);
    assert.equal(applied.status,'applied');
    const rerender=f.attack(7,message);
    assert.equal(rerender.propertiesInputs[0].outcome,'hit');
    assert.match(rerender.targetPrint[0].print,/data-swadetools-raise=0/);
    assert.doesNotMatch(rerender.targetPrint[0].print,/data-swadetools-raise=1/);
    const next=f.attack(7,{...message,id:'next',flags:{'swade-tools':{...message.flags['swade-tools']}}});
    assert.equal(next.propertiesInputs[0].outcome,'raise','a different attack benefits from existing Vulnerable normally');
    message.flags['swade-tools'].gmmod=1;
    assert.equal(f.attack(7,message).propertiesInputs[0].outcome,'raise','a genuine GM card correction recalculates the original card');
});

test('default-off keeps existing single-fire Dodge/cover behavior and stages no effect',async t=>{
    const f=await fixture(t,{enabled:false});
    f.setRules(f.defense,[{id:'cover',action:'cover',value:-2,stack:'best',group:'cover'}]);
    const control=f.attack(8);
    assert.equal(control.propertiesInputs.length,0);
    assert.match(control.targetPrint[0].print,/swadetools-term-miss/,'legacy TN stays 10 when new feature is off');
});

test('actual native target calculation adds range-specific outgoing bonus but not the already-rolled common bonus',async t=>{
    const f=await fixture(t,{nativeDodge:false,cover:0});
    f.setRules(f.attackerEdge,[{id:'common',action:'attackMod',value:1},
        {id:'range',action:'attackMod',value:2,conditions:{minRange:10,maxRange:25}}]);
    assert.equal(f.attack(2).propertiesInputs[0].outcome,'hit','2 rolled + 2 contextual = 4; common +1 is already in rolled total');
    f.target.x=3000;
    assert.equal(f.attack(2).propertiesInputs[0].outcome,'miss');
});

test('actual ItemRoll adds approved attack and damage modifiers once and excludes AoE items',async t=>{
    const f=await fixture(t);
    f.setRules(f.attackerEdge,[{id:'attack',action:'attackMod',value:1},{id:'damage',action:'damageMod',value:2}]);
    const {default:ItemRoll}=await moduleOf('class/ItemRoll.js');
    const attack=new ItemRoll(f.actor,f.item);attack.addSkillMod();attack.addSkillMod();
    assert.equal(attack.mod,1);
    const damage=new ItemRoll(f.actor,f.item);damage.addDmgMod();damage.addDmgMod();
    assert.equal(damage.mod,2);
    f.item.flags={'swade-tools':{aoeEnabled:true}};
    const aoe=new ItemRoll(f.actor,f.item);aoe.addSkillMod();aoe.addDmgMod();
    assert.equal(aoe.mod,0);
});

test('native damage metadata freezes the exact target, attack root and per-hit identity',async t=>{
    const f=await fixture(t);
    const {propertySourceForTarget}=await moduleOf('services/PropertiesCombat.js');
    const message={id:'reroll',flags:{'swade-tools':{propertiesRootId:'original'}}};
    const source=propertySourceForTarget({message,actor:f.actor,item:f.item,target:f.target,
        outcome:'raise',hitKey:'skill-2',attackType:'ranged',range:20});
    assert.equal(source.rootId,'original');assert.equal(source.attackMessageId,'reroll');
    assert.equal(source.targetUuid,f.target.document.uuid);assert.equal(source.targetActorUuid,f.victim.uuid);
    assert.equal(source.hitKey,'skill-2');assert.equal(source.outcome,'raise');
});
