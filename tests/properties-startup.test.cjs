const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const path=require('node:path');

test('actual ESM startup graph loads with Properties opt-out and native ApplicationV2 settings menu',()=>{
    const entry=pathToFileURL(path.resolve(__dirname,'../scripts/start.js')).href;
    const settings=pathToFileURL(path.resolve(__dirname,'../scripts/settings.js')).href;
    const script=`
      const assert=require('node:assert/strict');
      const registrations=new Map(), schemas=new Map(), menus=new Map();
      globalThis.FormApplication=class {};
      globalThis.Application=class {};
      globalThis.Dialog=class {};
      globalThis.foundry={applications:{api:{ApplicationV2:class {},DialogV2:class {}}}};
      globalThis.Hooks={on(name,callback){if(!registrations.has(name))registrations.set(name,[]);registrations.get(name).push(callback);return 1;},once(name,callback){return this.on(name,callback);},off(){}};
      globalThis.document={addEventListener(){}};
      globalThis.game={user:{id:'gm',isGM:true},users:[],actors:[],scenes:[],packs:[],tables:[],
        i18n:{localize:key=>key},settings:{
          register(scope,key,schema){schemas.set(key,schema);},
          registerMenu(scope,key,schema){menus.set(key,schema);},
          get(scope,key){if(!schemas.has(key))throw Error('Unregistered setting');return schemas.get(key).default;}
        }};
      (async()=>{
        await import(${JSON.stringify(entry)});
        assert.equal(registrations.get('applyActiveEffect').length,1,'die steps register before actor preparation');
        await (await import(${JSON.stringify(settings)})).registerSettings();
        assert.equal(schemas.get('propertiesEnabled').default,false);
        assert.equal(schemas.get('propertiesEnabled').scope,'world');
        assert.equal(schemas.get('propertiesLibrary').config,false);
        assert.equal(schemas.get('propertiesEventLedger').config,false);
        assert.equal(menus.get('propertiesLibraryMenu').restricted,true);
        assert.ok(menus.get('propertiesLibraryMenu').type.prototype instanceof foundry.applications.api.ApplicationV2);
        assert.ok(registrations.get('renderItemSheet').length);
      })().catch(error=>{console.error(error);process.exitCode=1;});`;
    const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
});

test('startup wires the fresh native and RoF outcome resolver for automatic effects without an injected approval resolver',()=>{
    const entry=pathToFileURL(path.resolve(__dirname,'../scripts/start.js')).href;
    const effects=pathToFileURL(path.resolve(__dirname,'../scripts/services/PropertiesEffects.js')).href;
    const rules=pathToFileURL(path.resolve(__dirname,'../scripts/services/PropertiesRules.js')).href;
    const script=`
      const assert=require('node:assert/strict');
      globalThis.FormApplication=class {};globalThis.Application=class {};globalThis.Dialog=class {};
      globalThis.foundry={applications:{api:{ApplicationV2:class {},DialogV2:class {}}}};
      globalThis.Hooks={on(){return 1;},once(){return 1;},off(){}};
      globalThis.document={addEventListener(){}};
      (async()=>{
        await import(${JSON.stringify(entry)});
        const {registerPropertyCandidate}=await import(${JSON.stringify(effects)});
        const {normalizeRule}=await import(${JSON.stringify(rules)});
        const clone=value=>JSON.parse(JSON.stringify(value));
        const actor={id:'attacker',uuid:'Actor.attacker',type:'character',ownership:{player:3},items:new Map(),effects:new Map()};
        const victim={id:'victim',uuid:'Actor.victim',type:'character',items:new Map(),effects:new Map(),statuses:new Set(),
          system:{attributes:{strength:{die:{sides:8,modifier:0}}}}};
        const item={id:'rifle',uuid:'Actor.attacker.Item.rifle',name:'Rifle',type:'weapon',actor,system:{equipStatus:3}};
        actor.items.set(item.id,item);
        const target={id:'target',uuid:'Scene.scene.Token.target',actor:victim,name:'Victim'};
        const token={id:target.id,document:target,actor:victim};target.object=token;
        const scene={id:'scene',tokens:new Map([[target.id,target]])};
        const gm={id:'gm',isGM:true,active:true},player={id:'player',isGM:false,active:true};
        const settings={propertiesEnabled:true,propertiesLibrary:{version:1,assignments:{[item.uuid]:[normalizeRule({
          id:'weakening',name:'Weakening',action:'traitSteps',trigger:'hit',trait:'strength',value:-1,automaticAccept:true,automaticAcceptSince:1,stack:'sum'
        })]}},propertiesEventLedger:{version:1,candidates:{},events:{}}};
        const game={user:gm,users:new Map([[gm.id,gm],[player.id,player]]),actors:new Map([[actor.id,actor]]),
          scenes:new Map([[scene.id,scene]]),messages:new Map(),time:{worldTime:100},
          settings:{get:(_scope,key)=>settings[key],set:async(_scope,key,value)=>{settings[key]=clone(value);}}};
        let created=0,calculations=0;
        victim.createEmbeddedDocuments=async(type,data)=>{
          assert.equal(type,'ActiveEffect');
          return data.map(raw=>{const effect={...clone(raw),id:'effect-'+(++created),parent:victim,active:true};
            victim.effects.set(effect.id,effect);return effect;});
        };
        class NativeControl {
          constructor(message){this.message=message;this.propertiesInputs=[];}
          isCritical(){return false;}
          attackTarget(found,total){calculations++;const result=total+this.gmmod;
            this.propertiesInputs.push({target:found,outcome:result>=8?'raise':result>=4?'hit':'miss'});}
        }
        const documents=new Map([[actor.uuid,actor],[item.uuid,item],[target.uuid,target],[victim.uuid,victim]]);
        const runtime={gameRef:game,canvasRef:{scene,tokens:new Map([[token.id,token]])},
          fromUuid:async uuid=>documents.get(uuid),RollControlClass:NativeControl};
        const message=(id,total,extra={})=>{
          const value={id,timestamp:100,user:'player',author:player,isContentVisible:true,rolls:[{total,formula:'1d8x'}],
            flags:{'swade-tools':{itemroll:item.id,rolltype:'skill',userof:1,...extra}},
            async update(data){for(const [key,value]of Object.entries(data)){const parts=key.split('.');let object=this;
              for(const part of parts.slice(0,-1))object=object[part]??={};object[parts.at(-1)]=clone(value);}}};
          game.messages.set(id,value);return value;
        };
        const input=message=>({message,actor,item,target:token,outcome:'hit',hitKey:'1',attackType:'ranged',range:10});
        const hit=message('native-hit',5);
        assert.equal((await registerPropertyCandidate(input(hit),runtime)).status,'applied');
        assert.equal(created,1);assert.equal(calculations,1);
        await registerPropertyCandidate(input(hit),runtime);assert.equal(created,1,'render replay must not repeat effects');
        const corrected=message('native-corrected',7,{gmmod:-4});
        assert.notEqual((await registerPropertyCandidate(input(corrected),runtime)).status,'applied');
        assert.equal(created,1,'staged hit cannot override a fresh corrected miss');
        const pool=message('pool-hit',5,{propertiesPool:{version:1,assignments:[{
          hitKey:'1',targetUuid:target.uuid,targetActorUuid:victim.uuid,total:5,modifier:0,outcome:'hit'
        }]}});
        const nativeCalls=calculations;
        assert.equal((await registerPropertyCandidate(input(pool),runtime)).status,'applied');
        assert.equal(created,2);assert.equal(calculations,nativeCalls,'RoF must resolve its own exact usable die');
        const invalid=message('pool-invalid',5,{propertiesPool:{version:1,assignments:[{
          hitKey:'1',targetUuid:target.uuid,targetActorUuid:victim.uuid,total:2,modifier:0,outcome:'hit'
        }]}});
        assert.notEqual((await registerPropertyCandidate(input(invalid),runtime)).status,'applied');
        assert.equal(created,2,'inconsistent RoF arithmetic must fail closed');
      })().catch(error=>{console.error(error);process.exitCode=1;});`;
    const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stdout+result.stderr+(result.error?.message??''));
});
