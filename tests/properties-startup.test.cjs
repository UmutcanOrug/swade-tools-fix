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
