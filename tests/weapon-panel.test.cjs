const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const scripts = path.resolve(__dirname, '../scripts');
const source = fs.readFileSync(path.join(scripts, 'class/ItemDialog.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export default class ItemDialog', 'class ItemDialog');
const load = name => import(pathToFileURL(path.join(scripts, `services/${name}.js`)).href);

// Small DOM surface for the actual classic Dialog content and event bindings.
const mockHtml = content => {
    const nodes = new Map(), multipleGroups = [];
    for (const match of content.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>|<input\b([^>]*)>/g)) {
        const tag=match[3]===undefined ? 'select' : 'input';
        const attrs=match[3] ?? match[1],body=match[2] ?? '';
        const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
        if (!id) continue;
        const events = new Map();
        const options = tag === 'select' ? [...body.matchAll(/<option value="([^"]*)"([^>]*)/g)].map(m => ({value:m[1],selected:/\bselected\b/.test(m[2])})) : undefined;
        nodes.set(id, {id, value: options?.find(option=>option.selected)?.value ?? options?.[0]?.value ?? /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? '',
            options, checked:/\bchecked\b/.test(attrs), disabled:/\bdisabled\b/.test(attrs),
            addEventListener:(event, callback)=>events.set(event,callback),
            change(){events.get('change')?.();}});
    }
    for (const _ of content.matchAll(/data-rof-multiple-only/g)) multipleGroups.push({hidden:false});
    const details = content.includes('data-unified-rof-options') ? {hidden:true, open:false} : null;
    const damageLabel=content.includes('data-shotgun-damage') ? {textContent:''} : null;
    const root = {nodeType:1, querySelector(selector) {
        if (selector.startsWith('#')) return nodes.get(selector.slice(1)) ?? null;
        if (selector === '[data-unified-rof-options]') return details;
        if (selector === '[data-aoe-consumption]') return content.includes('data-aoe-consumption') ? details : null;
        if (selector === '[data-shotgun-damage]') return damageLabel;
        return null;
    }, querySelectorAll:selector=>selector==='[data-rof-multiple-only]' ? multipleGroups : []};
    return {0:root, nodes, details, damageLabel, multipleGroups, on(){},
        find:selector=>root.querySelector(selector) ? [root.querySelector(selector)] : []};
};

async function panel({experimental=false, aoe=false, shotgun=false, doubleBarrel=false,
    restoreLast=false, damageOnly=false, damageOverride, maxRof=3, rapidFire=false, consumeMode='ammo',
    cache, tokenId='source',translations,missingVehicleOperator=false,damageProfiles}={}) {
    const [helpers,memory] = await Promise.all([load('WeaponPanelSettings'),load('LastWeaponSettings')]);
    const events=[], notices=[], dialogs=[];
    const item={id:'weapon',uuid:'Actor.shooter.Item.weapon',name:'Test Weapon',type:'weapon',isOwner:true,
        effects:[],system:{isRanged:true,damage:'3d6',ap:1,range:'12/24/48',shots:12,currentShots:10,
            rof:maxRof,reloadType:'single',actions:{trait:'Shooting',traitMod:'',additional:{}}},getFlag:()=>undefined};
    const actor={id:'shooter',uuid:'Actor.shooter',type:'character',isWildcard:true,isOwner:true,
        items:{get:()=>item},system:{}};
    if(missingVehicleOperator)actor.type='vehicle';
    item.actor=actor; item.parent=actor;
    const token={id:tokenId,actor,document:{id:tokenId,uuid:`Scene.scene.Token.${tokenId}`}};
    const context=()=>memory.resolveWeaponSettingsContext({weaponOwner:actor,operator:actor,item,token,userId:'test-user'});
    if (!cache) memory.clearLastWeaponSettings();
    else memory.saveLastWeaponSettings(context(),cache);
    class ItemRoll {
        constructor(){events.push(['new-roll']);}
        addModifier(...args){events.push(['modifier',...args]);}
        addFlag(...args){events.push(['flag',...args]);}
        setWeaponDamageModifier(value){events.push(['damage-modifier',value]);}
        setConsumeAmmunition(value){events.push(['consume-ammunition',value]);}
        setWeaponTheDrop(value){events.push(['the-drop',value]);}
        usingVehicle(){} raiseDmg(){events.push(['raise']);} useTarget(){}
        async rollBaseSkill(...args){events.push(['native-skill',...args]);}
        async rollBaseDamage(...args){events.push(['native-damage',...args]);}
        display(){events.push(['display']);}
    }
    const gb=new Proxy({setting:key=>({unifiedRofExperimental:experimental,selectModifiers:true,
            askCalledShots:true,wildAttackSkills:'',shootingSkill:'Shooting',fightingSkill:'Fighting'}[key] ?? ''),
        trans:(key,scope='SWADETOOLS')=>translations?.[`${scope}.${key}`] ?? key,systemSetting:()=>false,stringMod:()=>'',itemSkillMod:()=>0,realInt:value=>Number(value)||0,
        getTemplatesHTML:()=>'',log(){},modButtons(){}}, {get:(object,key)=>object[key] ?? (()=>'')});
    const ItemDialog=vm.runInNewContext(`${source}\nItemDialog;`,{gb,ItemRoll,CharRoll:class {},
        Char:class {hasEdgeSetting(key){return key==='Rapid Fire' && rapidFire;} hasAbilitySetting(){return false;}},
        Dialog:class {constructor(config,options){dialogs.push({config,options});} render(){return this;}},
        isAoeItem:()=>aoe,getAoeItemSettings:()=>({consumeMode}),getInlineRofMaximum:()=>maxRof,
        getShotgunSettings:()=>({enabled:shotgun,doubleBarrel}),
        getShotgunDamageProfiles:()=>damageProfiles ?? {shot:{short:'3d6',medium:'2d6',long:'1d6'},slug:{short:'2d10',medium:'2d10',long:'2d10'}},
        prepareWeaponDamageModifier:value=>value==='invalid' ? {ok:false,reason:'Invalid damage modifier.'} : {ok:true,formula:String(value??'').trim()},
        resolveWeaponSettingsContext:context=>memory.resolveWeaponSettingsContext({...context,userId:'test-user'}),
        getLastWeaponSettings:memory.getLastWeaponSettings,saveLastWeaponSettings:memory.saveLastWeaponSettings,
        ...helpers,ui:{notifications:{warn:message=>notices.push(message)}},
        launchRofMacro:async(...args)=>events.push(['pool',...args]),
        launchAoeMacro:async(...args)=>events.push(['aoe',...args]),
        prepareNativeShotgunAttack:async setup=>{events.push(['shotgun-prepare',setup]);return {ok:true,
            damage:'2d6',modifierFormulaResolved:'2'};},
        applyNativeShotgunProfile:(_roll,prepared)=>events.push(['shotgun-apply',prepared])});
    const instance=new ItemDialog(actor,item.id,null,{restoreLast,damageOnly,damageOverride,token});
    await instance.showDialog();
    const config=dialogs.at(-1)?.config;
    const html=config ? mockHtml(config.content) : null;
    config?.render(html);
    return {item,actor,token,instance,config,html,dialogs,events,notices,context:context(),memory};
}

if (require.main===module) {
test('default-off panel preserves native RoF and Rapid Fire buttons without a selector',async()=>{
    const p=await panel({rapidFire:true});
    assert.ok(p.config.buttons.rofAllocator); assert.ok(p.config.buttons.rapidFire);
    assert.doesNotMatch(p.config.content,/id="rof"|shotgun-mode/);
    await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.events.filter(e=>e[0]==='native-skill').length,1);
    assert.equal(p.events.filter(e=>e[0]==='pool').length,0);
});

test('experimental compact panel keeps classic classes and routes RoF 1 to native single fire',async()=>{
    const p=await panel({experimental:true,rapidFire:true});
    assert.deepEqual(Array.from(p.dialogs[0].options.classes),['dialog swadetools-vertical']);
    assert.equal(p.config.buttons.rofAllocator,undefined); assert.equal(p.config.buttons.rapidFire,undefined);
    assert.equal(p.html.nodes.get('rof').options.length,3);
    assert.equal(p.html.details,null);assert.doesNotMatch(p.config.content,/Attack Options/);
    assert.equal(p.html.nodes.get('rof').value,'3');
    p.html.nodes.get('rof').value='1';p.html.nodes.get('rof').change();
    assert.equal(p.html.nodes.get('rof-recoil').disabled,true);
    await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.events.filter(e=>e[0]==='native-skill').length,1);
    assert.equal(p.events.filter(e=>e[0]==='pool').length,0);
});

test('RoF 2+ forwards raw manual options and explicit source without native fire or a second setup',async()=>{
    const p=await panel({experimental:true});
    for (const [id,value] of Object.entries({rof:'3',mod:'@bonus + 1d6x',multiaction:'-2',cover:'Medium',
        illumination:'Dark',calledshots:'Head','rof-damage-modifier':'+2'})) p.html.nodes.get(id).value=value;
    p.html.nodes.get('rof').change(); p.html.nodes.get('rof-drop').checked=true;
    await p.config.buttons.mainSkill.callback(p.html);
    const call=p.events.find(e=>e[0]==='pool'); assert.ok(call);
    assert.equal(call[1],p.actor); assert.equal(call[2],p.item); assert.equal(call[4].token,p.token);
    const setup=call[4].setup;
    assert.equal(setup.rof,3);assert.equal(setup.otherModifierFormula,'@bonus + 1d6x');
    assert.equal(setup.multiAction,-2);assert.equal(setup.cover,'Medium');assert.equal(setup.illumination,'Dark');
    assert.equal(setup.calledShot,'Head');assert.equal(setup.theDrop,true);assert.equal(setup.recoil,true);
    assert.equal(setup.damageModifier,'+2');assert.equal(setup.aoe,false);
    assert.equal(p.events.some(e=>e[0]==='new-roll'),false);
});

test('invalid RoF cannot fire and lower item cap falls back to the weapon default',async()=>{
    const p=await panel({experimental:true,maxRof:2,restoreLast:true,cache:{rof:5,modifier:'-2'}});
    assert.equal(p.html.nodes.get('rof').value,'2');
    p.html.nodes.get('rof').value='99';await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.notices.length,1);assert.equal(p.events.length,0);
});

test('Shift restores manual values without firing; normal click stays clean and Raise is never reused',async()=>{
    const cache={modifier:'@bonus - 2',multiaction:'-4',cover:'Light',illumination:'Dim',calledshots:'Head',
        rof:2,recoil:false,raise:true,targets:['bad']};
    const shifted=await panel({experimental:true,restoreLast:true,cache});
    assert.equal(shifted.html.nodes.get('mod').value,'@bonus - 2');assert.equal(shifted.html.nodes.get('rof').value,'2');
    assert.equal(shifted.html.nodes.get('rof-recoil').checked,false);assert.equal(shifted.html.nodes.get('raise').checked,false);
    assert.equal(shifted.events.length,0);assert.match(shifted.config.content,/Last settings restored/);
    const clean=await panel({experimental:true,cache});
    assert.equal(clean.html.nodes.get('mod').value,'');assert.equal(clean.html.nodes.get('rof').value,'3');
    assert.doesNotMatch(clean.config.content,/Last settings restored/);
});

test('native manual values are saved raw while prepared Shotgun formulas are transiently resolved',async()=>{
    const p=await panel({experimental:true,shotgun:true,maxRof:1});
    p.html.nodes.get('mod').value='@bonus';await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.events.find(e=>e[0]==='shotgun-prepare')[1].modifierFormula,'@bonus');
    assert.equal(p.events.find(e=>e[0]==='modifier')[1],'2');
    assert.equal(p.memory.getLastWeaponSettings(p.context).modifier,'@bonus');
    assert.equal(p.events.filter(e=>e[0]==='native-skill').length,1);
    assert.equal(p.item.system.actions.traitMod,'');
});

test('internal damageOnly ignores memory, AoE routing, Shotgun UI and RoF and forwards only damage override',async()=>{
    const p=await panel({experimental:true,aoe:true,shotgun:true,damageOnly:true,restoreLast:true,
        damageOverride:'1d6',cache:{modifier:'-4',rof:3}});
    assert.doesNotMatch(p.config.content,/id="rof"|shotgun-mode|Last settings restored/);
    assert.match(p.config.content,/1d6/);assert.equal(p.config.buttons.mainSkill,undefined);
    await p.config.buttons.mainDamage.callback(p.html);
    assert.equal(p.events.find(e=>e[0]==='native-damage')[1],'1d6');
    assert.equal(p.memory.getLastWeaponSettings(p.context).modifier,'-4');
    assert.equal(p.events.some(e=>['pool','aoe','shotgun-prepare'].includes(e[0])),false);
});

test('explicit Shotgun profile appears only with experimental opt-in and invalid barrel combinations clear',async()=>{
    const legacy=await panel({shotgun:true,doubleBarrel:true});assert.doesNotMatch(legacy.config.content,/shotgun-mode/);
    const p=await panel({experimental:true,shotgun:true,doubleBarrel:true});
    assert.equal(p.html.details,null);const barrels=p.html.nodes.get('shotgun-both-barrels');
    barrels.checked=true;p.html.nodes.get('rof').value='2';p.html.nodes.get('rof').change();
    assert.equal(barrels.disabled,true);assert.equal(barrels.checked,false);
    p.html.nodes.get('rof').value='1';p.html.nodes.get('rof').change();assert.equal(barrels.disabled,false);
    barrels.checked=true;p.html.nodes.get('shotgun-mode').value='slug';p.html.nodes.get('shotgun-mode').change();
    assert.equal(barrels.disabled,true);assert.equal(barrels.checked,false);
});

test('AoE single fire forwards panel settings once, while AoE RoF uses the shared pool',async()=>{
    const p=await panel({experimental:true,aoe:true,consumeMode:'item'});
    assert.equal(p.html.details,null);assert.match(p.config.content,/Consume Item/);
    p.html.nodes.get('rof').value='1';p.html.nodes.get('rof').change();
    assert.equal(p.html.nodes.has('calledshots'),false);assert.equal(p.html.nodes.has('rof-drop'),true);
    p.html.nodes.get('mod').value='+2';p.html.nodes.get('rof-damage-modifier').value='+1d6x';p.html.nodes.get('multiaction').value='-2';p.html.nodes.get('cover').value='Light';p.html.nodes.get('rof-drop').checked=true;
    await p.config.buttons.mainSkill.callback(p.html);
    const single=p.events.find(e=>e[0]==='aoe');assert.equal(single[3].attackSetup.otherModifierFormula,'+2');
    assert.equal(single[3].attackSetup.situationalModifier,-4);assert.equal(single[3].token,p.token);
    assert.equal(single[3].attackSetup.damageModifier,'+1d6x');
    assert.equal(single[3].attackSetup.theDrop,true);
    p.html.nodes.get('rof').value='2';await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.events.find(e=>e[0]==='pool')[4].setup.aoe,true);
    assert.equal(p.events.some(e=>e[0]==='native-skill'),false);
});

test('disabled AoE resource mode cannot be enabled by Shift cache and legacy AoE receives restore context',async()=>{
    const p=await panel({experimental:true,aoe:true,maxRof:1,consumeMode:'none',restoreLast:true,cache:{consumeAmmo:true}});
    assert.equal(p.html.nodes.get('rof-consume-ammo').disabled,true);
    await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.events.find(e=>e[0]==='aoe')[3].attackSetup.consume,false);
    const legacy=await panel({aoe:true,restoreLast:true});
    const call=legacy.events.find(e=>e[0]==='aoe');assert.equal(call[3].restoreLast,true);assert.equal(call[3].token,legacy.token);
    assert.equal(legacy.dialogs.length,0);
});

test('AoE and Shotgun damage profiles are rejected without rolling a native attack',async()=>{
    const p=await panel({experimental:true,aoe:true,shotgun:true});
    await p.config.buttons.mainSkill.callback(p.html);await p.config.buttons.mainDamage.callback(p.html);
    assert.equal(p.notices.length,2);assert.equal(p.events.some(e=>['native-skill','native-damage','pool','aoe','shotgun-prepare'].includes(e[0])),false);
});

test('control transitions enable default recoil only for multiple fire and stale select values are ignored',async()=>{
    const p=await panel({experimental:true,restoreLast:true,cache:{cover:'Removed',illumination:'Dark',rof:1}});
    assert.equal(p.html.nodes.get('cover').value,'None');assert.equal(p.html.nodes.get('illumination').value,'Dark');
    p.html.nodes.get('rof').value='2';p.html.nodes.get('rof').change();assert.equal(p.html.nodes.get('rof-recoil').checked,true);
    assert.equal(p.html.details,null);assert.ok(p.html.multipleGroups.every(e=>e.hidden===false));
    p.html.nodes.get('rof').value='1';p.html.nodes.get('rof').change();assert.equal(p.html.nodes.get('rof-recoil').checked,false);
    assert.equal(p.html.details,null);assert.ok(p.html.multipleGroups.every(e=>e.hidden===true));
});

test('changing Shotgun ammunition mode does not overwrite a manually unchecked Recoil option',async()=>{
    const p=await panel({experimental:true,shotgun:true});
    p.html.nodes.get('rof').value='2';p.html.nodes.get('rof').change();
    p.html.nodes.get('rof-recoil').checked=false;
    p.html.nodes.get('shotgun-mode').value='slug';p.html.nodes.get('shotgun-mode').change();
    assert.equal(p.html.nodes.get('rof-recoil').checked,false);
});

test('unified vehicle AoE panel with no assigned operator warns without a null-actor crash or roll',async()=>{
    const p=await panel({experimental:true,aoe:true,missingVehicleOperator:true});
    assert.equal(p.dialogs.length,0);assert.equal(p.events.length,0);
    assert.match(p.notices[0],/Assign a weapon operator/);
});

test('Shotgun header shows transient range-based damage and updates for Slug and Both Barrels',async()=>{
    const p=await panel({experimental:true,shotgun:true,doubleBarrel:true,maxRof:1});
    assert.equal(p.html.damageLabel.textContent,'3d6 / 2d6 / 1d6');
    p.html.nodes.get('shotgun-both-barrels').checked=true;p.html.nodes.get('shotgun-both-barrels').change();
    assert.equal(p.html.damageLabel.textContent,'3d6 / 2d6 / 1d6 +4');
    p.html.nodes.get('shotgun-mode').value='slug';p.html.nodes.get('shotgun-mode').change();
    assert.equal(p.html.damageLabel.textContent,'2d10');assert.equal(p.item.system.damage,'3d6');
});

test('all fresh weapon panels expose independent damage and checked ammunition without Attack Options',async()=>{
    for(const experimental of [false,true]){
        const p=await panel({experimental,maxRof:1});
        assert.ok(p.html.nodes.has('rof-damage-modifier'));assert.equal(p.html.nodes.get('rof-consume-ammo').checked,true);
        assert.equal(p.html.details,null);assert.doesNotMatch(p.config.content,/Attack Options/);
        p.html.nodes.get('mod').value='-3';p.html.nodes.get('rof-damage-modifier').value='+1d6x';
        p.html.nodes.get('rof-consume-ammo').checked=false;
        await p.config.buttons.mainSkill.callback(p.html);
        assert.deepEqual(p.events.find(e=>e[0]==='damage-modifier'),['damage-modifier','+1d6x']);
        assert.deepEqual(p.events.find(e=>e[0]==='consume-ammunition'),['consume-ammunition',false]);
        assert.equal(p.events.find(e=>e[0]==='modifier')[1],'-3');
        p.events.length=0;
        p.html.nodes.get('multiaction').value='-4';p.html.nodes.get('cover').value='Medium';p.html.nodes.get('illumination').value='Dark';
        await p.config.buttons.mainDamage.callback(p.html);
        assert.equal(p.events.find(e=>e[0]==='damage-modifier')[1],'+1d6x');
        assert.deepEqual(p.events.filter(e=>e[0]==='modifier').map(e=>e[1]),['0']);
        assert.equal(p.events.filter(e=>e[0]==='native-damage').length,1);
    }
});

test('invalid Damage Mod stops a native Shotgun attack before resource preparation',async()=>{
    const p=await panel({experimental:true,shotgun:true,maxRof:1});
    p.html.nodes.get('rof-damage-modifier').value='invalid';
    await p.config.buttons.mainSkill.callback(p.html);
    assert.equal(p.notices.length,1);
    assert.equal(p.events.some(e=>['shotgun-prepare','native-skill','display','consume-ammunition'].includes(e[0])),false);
});

test('fresh RoF follows weapon cap and Shift restores Damage Mod and ammunition without replaying Raise',async()=>{
    for(const maxRof of [1,3,4,6]){
        const fresh=await panel({experimental:true,maxRof});
        assert.equal(fresh.html.nodes.get('rof').value,String(maxRof));
        assert.equal(fresh.html.nodes.get('rof-recoil').checked,maxRof>1);
    }
    const p=await panel({experimental:true,restoreLast:true,cache:{rof:1,damageModifier:'@bonus+1d6',consumeAmmo:false,raise:true}});
    assert.equal(p.html.nodes.get('rof').value,'1');assert.equal(p.html.nodes.get('rof-damage-modifier').value,'@bonus+1d6');
    assert.equal(p.html.nodes.get('rof-consume-ammo').checked,false);assert.equal(p.html.nodes.get('raise').checked,false);
});

test('Shotgun header follows custom Shot and Slug range damage without replacing native item damage',async()=>{
    const p=await panel({experimental:true,shotgun:true,maxRof:1,damageProfiles:{
        shot:{short:'4d6',medium:'3d6+1',long:'2d6'},slug:{short:'3d10',medium:'2d10',long:'1d10+2'}}});
    assert.equal(p.html.damageLabel.textContent,'4d6 / 3d6+1 / 2d6');
    p.html.nodes.get('shotgun-mode').value='slug';p.html.nodes.get('shotgun-mode').change();
    assert.equal(p.html.damageLabel.textContent,'3d10 / 2d10 / 1d10+2');assert.equal(p.item.system.damage,'3d6');
});

test('shared checkboxes are always the same ordered vertical stack and Vulnerable is automatic only',async()=>{
    for(const opts of [{},{shotgun:true,doubleBarrel:true},{aoe:true}]){
        const p=await panel({experimental:true,maxRof:1,...opts});
        const stack=/class="swadetools-weapon-checks">([\s\S]*?)<\/div>/.exec(p.config.content)?.[1];
        assert.ok(stack);assert.deepEqual([...stack.matchAll(/id="([^"]+)"/g)].map(match=>match[1]),
            ['raise','rof-recoil','rof-drop','rof-consume-ammo']);
        assert.doesNotMatch(p.config.content,/rof-vulnerable|data-rof-multiple-only/);
        assert.equal(p.html.nodes.get('rof-drop').disabled,false);
        p.html.nodes.get('rof-drop').checked=true;
        await p.config.buttons.mainSkill.callback(p.html);
        if(!opts.aoe)assert.deepEqual(p.events.find(e=>e[0]==='the-drop'),['the-drop',true]);
    }
    const css=fs.readFileSync(path.resolve(__dirname,'../css/swadetools.css'),'utf8');
    assert.match(css,/\.swadetools-weapon-checks\s*\{[^}]*flex-direction:column/s);
});
}

module.exports={panel,mockHtml};
