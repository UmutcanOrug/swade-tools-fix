const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('all normal ItemDialog entry points route enabled AoE weapons to its panel without modifying the item', async () => {
    const source = fs.readFileSync(path.join(__dirname,'../scripts/class/ItemDialog.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class ItemDialog','class ItemDialog');
    const launches=[];
    const ItemDialog=vm.runInNewContext(`${source}\nItemDialog;`,{
        isAoeItem:item=>item.flags?.['swade-tools']?.aoeEnabled===true,
        launchAoeMacro:async(owner,item,options)=>{launches.push({owner,item,options});return 'AoE panel';},
        CharRoll:class {}, Char:class {constructor(){throw Error('Normal dialog must not open for AoE');}},
        gb:{getDriver(){throw Error('Missing AoE crew is resolved by the launcher, not legacy lookup');}}
    });
    const gunner={type:'character',id:'gunner'};
    const item={id:'gun',type:'weapon',flags:{'swade-tools':{aoeEnabled:true}}};
    const tank={type:'vehicle',items:{get:()=>item},system:{operator:gunner}};
    const dialog=new ItemDialog(tank,item.id);
    assert.equal(await dialog.showDialog(),'AoE panel');
    assert.equal(launches[0].owner,tank);
    assert.equal(launches[0].options.operatorActor,gunner);
    assert.equal(launches[0].options.promptAoeSetup,true);
    tank.system={};
    assert.equal(await new ItemDialog(tank,item.id).showDialog(),'AoE panel');
    assert.equal(launches[1].owner,tank);
    assert.equal(launches[1].options.operatorActor,null);
});

test('actual native ItemDialog damage-only mode ignores missing native Trait and retains named damage actions', () => {
    const source = fs.readFileSync(path.join(__dirname,'../scripts/class/ItemDialog.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export default class ItemDialog','class ItemDialog');
    const dialogs = [];
    const gb = new Proxy({
        trans:key=>key, setting:()=>'', systemSetting:()=>false,
        getTemplatesHTML:()=>'', stringMod:()=>'',
    }, {get:(object,key)=>object[key] ?? (()=>'')});
    const ItemDialog = vm.runInNewContext(`${source}\nItemDialog;`, {
        gb, isAoeItem:()=>true, launchAoeMacro:()=>{throw Error('Native damage must not launch another AoE attack');},
        CharRoll:class {}, Char:class {hasAbilitySetting(){return false;} hasEdgeSetting(){return false;}},
        Dialog:class {constructor(config){dialogs.push(config);} render(){return this;}}
    });
    for (const type of ['weapon','gear','consumable']) {
        const item = {id:'aoe',name:'HE',type,isOwner:true,system:{damage:'',
            actions:{trait:'',additional:{he:{type:'damage',name:'HE Blast',override:'3d6'}}}},getFlag:()=>undefined};
        const actor = {type:'character',items:{get:()=>item}};
        const dialog = new ItemDialog(actor,item.id,null,{damageOnly:true});
        dialog.noSkillItem = ()=>{throw Error('AoE damage must not prompt for the native Trait');};
        dialog.showDialog();
        const config = dialogs.at(-1);
        assert.ok(config.buttons.he, type);
        assert.equal(config.buttons.mainSkill,undefined,type);
        assert.equal(config.buttons.mainDamage,undefined,type);
        assert.match(config.content,/id="raise"/);
        assert.equal(item.system.actions.trait,'');
        item.system.damage='3d6';
        dialog.showDialog();
        assert.ok(dialogs.at(-1).buttons.mainDamage,type);
        assert.equal(dialogs.at(-1).buttons.mainSkill,undefined,type);
    }
});
