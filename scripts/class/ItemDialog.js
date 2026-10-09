import CharRoll from './CharRoll.js';
import * as gb from './../gb.js';
import ItemRoll from './ItemRoll.js';
import Char from './Char.js';
import launchRofMacro, { getInlineRofMaximum } from '../services/RofMacroLauncher.js';
import launchAoeMacro from '../services/AoeMacroLauncher.js';
import { isAoeItem, getAoeItemSettings } from '../services/AoeItemFlags.js';
import { resolveWeaponSettingsContext, getLastWeaponSettings, saveLastWeaponSettings } from '../services/LastWeaponSettings.js';
import { readWeaponPanelSettings, restoreWeaponPanelSettings, toInlineRofSetup, bindUnifiedRofControls } from '../services/WeaponPanelSettings.js';
import { getShotgunSettings, getShotgunDamageProfiles } from '../services/ShotgunRules.js';
import { prepareNativeShotgunAttack, applyNativeShotgunProfile } from '../services/NativeShotgunAttack.js';
import { prepareWeaponDamageModifier } from '../services/WeaponDamageModifier.js';

export default class ItemDialog {
    constructor(actor,itemId,operator=null,options={}){
        this.item=actor.items.get(itemId);
        this.weaponActor=actor;
        this.damageOnly=options.damageOnly===true;
        this.options=options;
        this.damageOverride=this.damageOnly && typeof options.damageOverride==='string'
            ? options.damageOverride.trim() || null : null;
     //   this.vehicle=false;
       

        if (actor.type=='vehicle'){
            this.vehicle=actor;
           // console.log(this.vehicle);
            actor=operator ??
                actor.system?.getCrewMemberForWeapon?.(this.item) ??
                actor.system?.operator ??
                (isAoeItem(this.item) && !this.damageOnly ? null : gb.getDriver(actor));
         //   console.log(actor);
        }

        this.actor=actor;
        this.charRoll=new CharRoll(actor);

        this.dontDisplay=false;
    }

    weaponSettingsContext(){
        if (this.damageOnly || this.item?.type!=='weapon') return null;
        return resolveWeaponSettingsContext({weaponOwner:this.weaponActor,
            operator:this.actor,item:this.item,token:this.options.token});
    }

    rememberWeaponPanel(html){
        const values=readWeaponPanelSettings(html);
        const context=this.weaponSettingsContext();
        if (context) saveLastWeaponSettings(context,values);
        return values;
    }

    async executeSystemItemAction(actionId){
        const helper=game.swade?.itemChatCardHelper;

        if (typeof helper?.handleAction=='function'){
            return await helper.handleAction(
                this.item,
                this.actor,
                actionId,
                {additionalMods:[]}
            );
        }

        if (typeof helper?.handleAdditionalActions=='function'){
            return await helper.handleAdditionalActions(
                this.item,
                this.actor,
                actionId,
                {mods:[]}
            );
        }

        const message='SWADE Tools: SWADE item action API is unavailable.';
        ui.notifications.error(message);
        throw new Error(message);
    }


    saveSkill(newSkill){
        this.item.update({'system.actions.trait':newSkill});
        this.item.system.actions.trait=newSkill;
        this.dontDisplay=false;
        this.showDialog();
    }

    noSkillItem(){
        
        let item=this.item;  
        
        if (!item.system?.innate && item.type!='action'){
        
        let content=`<p><strong>${this.item.name}</strong> ${gb.trans('NoSkillQuestion')}</p>`;
        content+=`<p><select id="skillitem">`;
        this.actor.items.filter(el=>el.type=='skill').map(skill=>{
            content+=`<option value="${skill.name}">${skill.name}</option>`;
        })

        content+=`<optgroup label="${gb.trans('Attributes','SWADE')}">`;
        gb.attributesShort.map(attr=>{
            content+=`<option value="${attr.trans}">${attr.trans}</option>`
        })
        content+=`</optgroup>`

        content+=`</select></p>`;

        new Dialog({
            title: item.name,
            content: content,
            buttons: {
                no: {
                    label: `<i class="fas fa-times"></i> ${gb.trans('LeaveItBlank')}`,
                    callback: async ()=>{
                        await item.setFlag('swade-tools','skillitem',true);
                        this.dontDisplay=false;
                        this.showDialog();
                        
                    }
                },/* 
                cancel: {
                    label: `<i class="fas fa-times"></i> ${gb.trans('Unskilled')}`,
                    callback: ()=>{
                        this.saveSkill(gb.trans('Unskilled'));
                        
                    }
                }, */
                ok: {
                    label: `<i class="fas fa-check"></i> ${gb.trans('UseSkillSelected')}`,
                    callback: (html)=>{
                    
                        this.saveSkill(html.find('#skillitem')[0].value);
                        
                    }
                }

                
            }
        }).render(true);

        this.dontDisplay=true;

        }
    
    
    }

    showDialog(){
        const experimentalUnified=!this.damageOnly && typeof gb.setting==='function' &&
            gb.setting('unifiedRofExperimental')===true;
        const unifiedWeapon=experimentalUnified && this.item.type==='weapon' &&
            (this.item.system.isRanged===true || String(this.item.system.range ?? '').trim()!=='');
        if (unifiedWeapon && this.weaponActor.type==='vehicle' && !this.actor){
            ui.notifications.warn('Assign a weapon operator on the vehicle before opening its unified attack panel.');
            return;
        }
        // All normal item entry points share this dialog. Opted-in weapons use
        // the AoE attack panel; internal native damage calls bypass the route.
        if (!this.damageOnly && isAoeItem(this.item) && !unifiedWeapon){
            return launchAoeMacro(this.weaponActor,this.item,{
                operatorActor:this.actor?.type!=='vehicle' ? this.actor : null,
                promptAoeSetup:true, token:this.options.token, restoreLast:this.options.restoreLast===true
            });
        }
        
      //  let actor=this.sheet.actor;
        let item=this.item;
        let weaponinfo=this.damageOverride ? {...item.system,damage:this.damageOverride} : item.system;
        let weaponactions=item.system.actions;
        const rangedWeapon=item.type==='weapon' &&
            (item.system.isRanged===true || String(item.system.range ?? '').trim()!=='');
        const unifiedRof=!this.damageOnly && rangedWeapon && experimentalUnified;
        const weaponPanel=!this.damageOnly && item.type==='weapon';
        const aoeWeaponPanel=unifiedRof && isAoeItem(item);
        const aoeSettings=aoeWeaponPanel ? getAoeItemSettings(item) : null;
        const shotgunSettings=unifiedRof ? getShotgunSettings(item) : {enabled:false};
        const shotgunDamageProfiles=shotgunSettings.enabled ? getShotgunDamageProfiles(item) : null;
        const maxRof=unifiedRof ? getInlineRofMaximum(this.actor,item) : 1;
        // Rapid Fire may add another available option, but a fresh panel starts
        // at the weapon's own configured RoF, not the edge's optional increase.
        const defaultRof=Math.min(maxRof,Math.max(1,Number.parseInt(item.system.rof,10)||1));
        const savedSettings=!this.damageOnly && this.options.restoreLast===true
            ? getLastWeaponSettings(this.weaponSettingsContext()) : null;
        let showDamage=true;
        let showRaiseDmg=true;
        let char=new Char(this.actor)
        let powermod=''
        let hasDefaultDamage=true;
        
        let damageActions=[];
      //  let showReload=false;

        let patxt='';
        if (weaponinfo.ap>0){
            patxt=` (${gb.trans('Ap','SWADE')}: ${weaponinfo.ap})`;
        }


        if ((item.type=='power' && !weaponinfo.damage) || item.type=='gear'){
            showDamage=false;
            showRaiseDmg=false;
           
            
        }

        if (item.type=='shield' || item.type=='action'){
            showDamage=false;
            hasDefaultDamage=false;
        }

       

        for (const id in weaponactions.additional){
            if (weaponactions.additional[id].type=='damage'){
                showRaiseDmg=true;
                damageActions.push({id:id,name:weaponactions.additional[id].name});
            }
           
        }

        // AoE has already rolled its saved skill. Do not require or change the
        // item's native Trait merely to open its normal damage workflow.
        if (this.damageOnly){
            showDamage=Boolean(String(weaponinfo.damage ?? '').trim());
            showRaiseDmg=showDamage || damageActions.length>0;
            hasDefaultDamage=showDamage;
        }

       // let raise=false;
        let content=`<div class="swadetools-dialog-item">
        <div class="swadetools-itemfulldata">`

       

        if (weaponPanel) content+='<div class="swadetools-weapon-summary">';
        content+=`<div class="swadetools-2grid">`


        if (item.type=='weapon'){
        content+=`<div><strong>${gb.trans('Dmg','SWADE')}</strong>: ${shotgunSettings.enabled ? '<span data-shotgun-damage title="Short / Medium / Long range"></span>' : weaponinfo.damage}${patxt}</div>
        <div><strong>${gb.trans('Mag','SWADE')}</strong>: ${weaponinfo.currentShots}/${weaponinfo.shots}</div>
        
        
        <div><strong>${gb.trans('Range._name','SWADE')}</strong>: ${weaponinfo.range}</div>
            <div><strong>${gb.trans('RoF','SWADE')}</strong>: ${unifiedRof
                ? `<select id="rof" aria-label="Rate of Fire" style="width:55px;display:inline-block">${Array.from({length:maxRof},(_,index)=>`<option value="${index+1}"${index+1===defaultRof ? ' selected' : ''}>${index+1}</option>`).join('')}</select>`
                : weaponinfo.rof}</div>`
        }  else if (item.type=='power'){

            if (showDamage){
             
                content+=`<div><strong>${gb.trans('Dmg','SWADE')}</strong>: ${weaponinfo.damage}${patxt}</div>`;
            }
            

          
            if(gb.systemSetting('noPowerPoints')){
                powermod=0-gb.realInt(Math.ceil(weaponinfo.pp/2))
                content+=`<div><strong>${gb.trans('Item.power','TYPES')} ${gb.trans('Modifier')}</strong>: ${powermod} (${gb.realInt(weaponinfo.pp)} ${gb.trans('PPAbbreviation','SWADE')})</div>`

            } else {
                content+=`<div><strong>${gb.trans('PPCost','SWADE')}</strong>: <span class="swadetools-powercost">${gb.getPPCostMod(item)}</span>/${gb.realInt(char.getActualPP(item.system.arcane))}</div>`
            }
            
            

            content+=`<div><strong>${gb.trans('Range._name','SWADE')}</strong>: ${weaponinfo.range}</div>
            <div><strong>${gb.trans('Dur','SWADE')}</strong>: ${weaponinfo.duration}</div>
            `
        }
       
        content+=`</div>`
        if (weaponPanel) content+=`<div class="swadetools-weapon-checks">
            ${showRaiseDmg ? '<label class="swadetools-small-check" title="Add the weapon\'s Raise damage die"><input type="checkbox" id="raise" value="1">Raise Damage</label>' : ''}
            ${unifiedRof ? '<label class="swadetools-small-check" title="Apply Recoil -2 when firing at RoF 2 or higher"><input id="rof-recoil" type="checkbox">Recoil</label>' : ''}
            <label class="swadetools-small-check" title="The Drop: +4 attack and +4 damage"><input id="rof-drop" type="checkbox">The Drop</label>
            <label class="swadetools-small-check" title="Consume the configured resource on this attack"><input id="rof-consume-ammo" type="checkbox" ${aoeSettings?.consumeMode==='none' ? 'disabled' : 'checked'}>${aoeSettings?.consumeMode==='item' ? 'Consume Item' : 'Ammunition'}</label>
            </div></div>`;

        if (item.type=='power' || item.type=='weapon'){
            let templatehtml=gb.getTemplatesHTML(item);
            if (templatehtml){
                content+=`<span class="swade-tools-template-buttons"><strong>Templates:</strong>${templatehtml}</span>`
            }
            
        }

        content+=`<div class="swadetools-formpart swadetools-2grid">
        
        <div class="swadetools-mod-add"><label><strong>${gb.trans('Modifier')}</strong> <i class="far fa-question-circle swadetools-hint" title="${gb.trans('ModHint')}"></i></label><input type="text" id="mod" size=3 class="swadetools-input-number" value="${powermod}"></div>`

        if (weaponPanel) content+=`<div class="swadetools-mod-add"><label for="rof-damage-modifier"><strong>Damage Mod.</strong></label><input id="rof-damage-modifier" type="text" size="3" class="swadetools-input-number" value="" title="Damage only, for example +2 or +1d6x"></div>`;
        
        if ((!gb.systemSetting('noPowerPoints') && item.type=='power') || item.isArcaneDevice){
            let defaultValue='';
            let transTerm=gb.trans('ExtraPP');
            let initialFlag='';
            let hint=gb.trans('PPHint');
            if (item.isArcaneDevice){
                defaultValue=1;
                transTerm=gb.trans('PPCost','SWADE');
                initialFlag='SWADE'
                hint=gb.trans('ArcaneDevicePPHint');
            }   
            content+=`<div class="swade-tools-pp-extra swadetools-mod-add"><label><strong>${transTerm}</strong> <i class="far fa-question-circle swadetools-hint" title="${hint}"></i></label><input type="text" size=3 id="extrapp" value="${defaultValue}" class="swadetools-input-number"></div>`
        }

        // content+=`<div class="swadetools-raise swadetools-raise-${item.type}"><label><strong>${gb.trans('MAPenalty.Label','SWADE')}:</strong></label>
        // <label><input type="radio" name="multiaction" id="multiaction" value="0" checked><strong>${gb.trans('MAPenalty.None','SWADE')}</strong></label>
        // <label><input type="radio" name="multiaction" id="multiaction-2" value="-2"><strong> -2 </strong></label>
        // <label><input type="radio" name="multiaction" id="multiaction-4" value="-4"><strong> -4 </strong></label></div>`;
        

        if (showRaiseDmg && !weaponPanel){
            content+=`<div class="swadetools-raise swadetools-raise-${item.type}"><label><input type="checkbox" id="raise" value="1"><strong>${gb.trans('RaiseDmg')}</strong></label></div>`;
        }

       

        
        if (gb.setting('useScale')){ ///swat
            let char=new Char(this.actor);
            if (char.hasAbilitySetting('Swat')){
                content+=`<div class="swadetools-raise swadetools-raise-${item.type}"><label><input type="checkbox" id="swat" value="1"><strong>${gb.trans('SwatSetting')}</strong></label></div>`;
            }

        }




        //let showDesperate=false;

        if (gb.setting('wildAttackSkills').split(',').map(s => s.trim()).includes(weaponactions.trait)){ /// wild attack


            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('DesperateWildAttack')}:</strong></label> <select id="desperate">`
            //<option value="">${gb.trans('Default')}</option>`;
            let multiaction=[
                {val:'0',text:gb.trans('MAPenalty.None','SWADE')},
                {val:'1',text:gb.trans('WildAttack')},
                {val:'2',text:`${gb.trans('DesperateAttack')} +2/-2`},
                {val:'4',text:`${gb.trans('DesperateAttack')} +4/-4`},
            ]
         
            multiaction.forEach(act=>{
                content+=`<option value="${act.val}">${act.text}</option>`;
            })

            content+=`</select>
            </div>`;
           /*  content+=`<div class="swadetools-raise swadetools-raise-${item.type}"><label><input type="checkbox" id="wildattack" value="1"><strong>${gb.trans('WildAttack')}</strong></label></div>`;

            if (gb.setting('desperateAttack')){
                showDesperate=true;

            } */
            
        }

        

        if ((hasDefaultDamage && damageActions.length>0) || (!hasDefaultDamage && damageActions.length>1)){
            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('Damage')}:</strong> <i class="far fa-question-circle swadetools-hint" title="${gb.trans('ActDmgHint')}"></i></label> <select id="actiondmg">`;

            if (hasDefaultDamage){
                content+=`<option value="">${gb.trans('Default')}</option>`;
            }
            

          //  console.log(damageActions)
         
            damageActions.forEach(act=>{
                content+=`<option value="${act.id}">${act.name}</option>`;
            })
             
            /* for (const i in damageActions) {
                content+=`<option value="${act[i].id}">${act[i].name}</option>`;
            }  */

           

            content+=`</select>
            </div>`;
        }


        gb.log(item.effects,item.type);

        /// ==> START POWER MODIFIERS

        if (item.type=='power'){

            const modifiers = item.effects.filter(e => e.type === "modifier");

            if (modifiers){

            content+=`<div class="swadetools-damage-actions swadetools-mod-add swadetools-mid-title"><h3>${gb.trans('PPMods','SWADE')}</h3></div>`; 
            
            content+=`<div class="swadetools-power-modifiers">`;

            for (const e of modifiers) {
            content += `
                <label>
                <input type="checkbox" class="swadetools-powermod-check" ${e.disabled ? "" : "checked"} data-id="${e.id}">
                ${e.name}
                </label>
            `;
            }   

            content+='</div>';

            }

        }
        

        /// ==> END POWER MODIFIERS


        if ( gb.setting('selectModifiers') || gb.setting('askCalledShots') || unifiedRof){
        content+=`<div class="swadetools-damage-actions swadetools-mod-add swadetools-mid-title"><h3>${gb.trans("ModOther",'SWADE')}</h3></div>`;
        }


        if (!this.actor.isWildcard && gb.setting('useGroupRolls')){
            content+=`<div class="swadetools-raise swadetools-raise-${item.type}"><label><input type="checkbox" id="grouproll" value="1"><strong>${gb.trans('GroupRoll','SWADE')}</strong></label></div>`;
        }

        /* if (showDesperate){
            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('DesperateAttack')}:</strong></label> <select id="desperate">`
            //<option value="">${gb.trans('Default')}</option>`;
            let multiaction=[
                {val:'0',text:gb.trans('MAPenalty.None','SWADE')+' (0)'},
                {val:'2',text:`${gb.trans('Skill')} +2 / ${gb.trans('Dmg','SWADE')} -2`},
                {val:'4',text:`${gb.trans('Skill')} +4 / ${gb.trans('Dmg','SWADE')} -4`},
            ]
         
            multiaction.forEach(act=>{
                content+=`<option value="${act.val}">${act.text}</option>`;
            })

            content+=`</select>
            </div>`;
        }
 */

        if ( gb.setting('selectModifiers') || unifiedRof ){
            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('MAPenalty.Label','SWADE')}:</strong></label> <select id="multiaction">`
            //<option value="">${gb.trans('Default')}</option>`;
            let multiaction=[
                {val:'0',text:gb.trans('MAPenalty.None','SWADE')+' (0)'},
                {val:'-2',text:' -2 '},
                {val:'-4',text:' -4 '},
            ]
         
            multiaction.forEach(act=>{
                content+=`<option value="${act.val}">${act.text}</option>`;
            })

            content+=`</select>
            </div>`;
        
            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('Cover._name','SWADE')}:</strong></label> <select id="cover">`
            //<option value="">${gb.trans('Default')}</option>`;
            let cover=[
                {val:'None',text:gb.trans('MAPenalty.None','SWADE')+' (0)'},
                {val:'Light',text:gb.trans('Cover.Light','SWADE')+ ' (-2)'},
                {val:'Medium',text:gb.trans('Cover.Medium','SWADE')+ ' (-4)'},
                {val:'Heavy',text:gb.trans('Cover.Heavy','SWADE')+ ' (-6)'},
                {val:'Total',text:gb.trans('Cover.Total','SWADE')+ ' (-8)'}
            ]
         
            cover.forEach(act=>{
                content+=`<option value="${act.val}">${act.text}</option>`;
            })

            content+=`</select>
            </div>`;
      
            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('Illumination._name','SWADE')}:</strong></label> <select id="illumination">`
            //<option value="">${gb.trans('Default')}</option>`;
            let illumination=[
                {val:'None',text:gb.trans('MAPenalty.None','SWADE')+' (0)'},
                {val:'Dim',text:gb.trans('Illumination.Dim','SWADE')+ ' (-2)'},
                {val:'Dark',text:gb.trans('Illumination.Dark','SWADE')+ ' (-4)'},
                {val:'Pitch',text:gb.trans('Illumination.Pitch','SWADE')+ ' (-6)'}
            ]
         
            illumination.forEach(act=>{
                content+=`<option value="${act.val}">${act.text}</option>`;
            })

            content+=`</select>
            </div>`;
        }

        if ((gb.setting('askCalledShots') || unifiedRof) && !aoeWeaponPanel){
            content+=`<div class="swadetools-damage-actions swadetools-mod-add"><label><strong>${gb.trans('CalledShot')}:</strong> <i class="far fa-question-circle swadetools-hint" title="${gb.trans('CalledShotHint')}"></i></label> <select id="calledshots">`
            //<option value="">${gb.trans('Default')}</option>`;

          //  console.log(damageActions)

            let called=[
                {val:'Torso',text:gb.trans('Torso','SWADE')+' (0)'},
                {val:'Arms',text:gb.trans('Arms','SWADE')+ ' (-2)'},
                {val:'Legs',text:gb.trans('Legs','SWADE')+ ' (-2)'},
                {val:'Head',text:gb.trans('Head','SWADE')+ ' (-4/+4 '+gb.trans('Damage')+')'}
            ]
         
            called.forEach(act=>{
                content+=`<option value="${act.val}">${act.text}</option>`;
            })
             
            /* for (const i in damageActions) {
                content+=`<option value="${act[i].id}">${act[i].name}</option>`;
            }  */

           

            content+=`</select>
            </div>`;
        }

        
        content+=`</div>`


       

        if (shotgunSettings.enabled) content+=`<div class="swadetools-2grid" style="align-items:center;margin:4px 0">
            <label for="shotgun-mode">Ammunition</label><select id="shotgun-mode"><option value="shot">Shot</option><option value="slug">Slug</option></select>
            ${shotgunSettings.doubleBarrel ? '<label style="grid-column:1 / -1"><input id="shotgun-both-barrels" type="checkbox">Both Barrels (one target, +4 damage)</label>' : ''}
            </div>`;
        if (savedSettings) content+='<div style="font-size:11px;margin-top:3px">Last settings restored.</div>';

        let buttons={};

        let skillName=weaponactions.trait;
        let skillflag=item.getFlag('swade-tools','skillitem')
        let noMainSkill=this.damageOnly;

        if (this.item.system?.innate){
            skillName=gb.trans('InnatePower');
        }
       
        if (!skillName && !this.damageOnly){

            if (skillflag!==true && this.item.type!='action'){
                skillName=this.noSkillItem();
            } else {
                noMainSkill=true;
            }
            
           
           // skillName=gb.trans('Unskilled');
        }

        
       
           
           // skillName=gb.trans('Unskilled');
        

        


        let skillIcon='<i class="fas fa-bullseye"></i> ';
        let damageIcon='<i class="fas fa-tint"></i> ';
        let resistIcon='<i class="fas fa-shield"></i> ';
        let genericIcon='<i class="fas fa-circle"></i> '
        let macroIcon='<i class="fas fa-robot"></i> ';
        

        if (!noMainSkill){  //// hide button for main skill if there's no skill

        buttons.mainSkill={
            label: skillIcon+skillName+gb.stringMod(gb.itemSkillMod(this.item)),
            callback: async (html)=>{
                if (unifiedRof){
                    if (aoeWeaponPanel && shotgunSettings.enabled){ui.notifications.warn('Shotgun and AoE damage profiles cannot be enabled together. Choose the appropriate item profile.');return;}
                    const values=readWeaponPanelSettings(html);
                    const selectedRof=Number(values.rof ?? 1);
                    if (!Number.isInteger(selectedRof) || selectedRof<1 || selectedRof>maxRof){
                        ui.notifications.warn('Select a valid Rate of Fire for this weapon.');
                        return;
                    }
                    if (selectedRof>1){
                        this.rememberWeaponPanel(html);
                        return launchRofMacro(this.actor,this.item,this.vehicle,{setup:{...toInlineRofSetup(values),aoe:aoeWeaponPanel},token:this.options.token});
                    }
                    if (aoeWeaponPanel){
                        this.rememberWeaponPanel(html);
                        const selected=toInlineRofSetup(values);
                        const cover={None:0,Light:-2,Medium:-4,Heavy:-6,Total:-8}[selected.cover] ?? 0;
                        const illumination={None:0,Dim:-2,Dark:-4,Pitch:-6}[selected.illumination] ?? 0;
                        return launchAoeMacro(this.weaponActor,this.item,{operatorActor:this.actor,
                            token:this.options.token,attackSetup:{otherModifierFormula:selected.otherModifierFormula,
                                damageModifier:selected.damageModifier,
                                theDrop:selected.theDrop,
                                situationalModifier:selected.multiAction+cover+illumination,consume:selected.consumeAmmo,
                                modifierParts:{modifier:selected.otherModifierFormula,multiAction:selected.multiAction,cover,illumination}}});
                    }
                }
                
                let itemRoll=new ItemRoll(this.actor,this.item);
                const preparedDamage=weaponPanel ? prepareWeaponDamageModifier(readWeaponPanelSettings(html).damageModifier,this.actor) : null;
                if (preparedDamage && !preparedDamage.ok){ui.notifications.warn(preparedDamage.reason);return;}
                let shotgun;
                if (shotgunSettings.enabled){
                    const values=readWeaponPanelSettings(html);
                    shotgun=await prepareNativeShotgunAttack({item:this.item,weaponOwner:this.weaponActor,
                        operator:this.actor,token:this.options.token,mode:values.shotgunMode,
                        bothBarrels:values.bothBarrels,consumeAmmo:values.consumeAmmo,
                        modifierFormula:values.modifier,action:'attack'});
                    if (!shotgun.ok){ui.notifications.warn(shotgun.reason);return;}
                }
                
                
                if (await this.processItemFormDialog(html,itemRoll,undefined,shotgun?.modifierFormulaResolved,preparedDamage)===false) return;
                if (shotgun) applyNativeShotgunProfile(itemRoll,shotgun);
                await itemRoll.rollBaseSkill();               
                itemRoll.display();
               

                /* let data={
                    mod: {
                        value: weaponactions.skillMod,
                        reason: gb.trans('ModItem')
                    },
                    skill: weaponactions.skill,
                    weapon: item.name+patxt,
                    weaponid: item._id,
                }

                this.processRoll(html,data); */
            }
        }
    }

        const isRangedWeapon=
            this.item.type=='weapon' &&
            (
                this.item.system?.isRanged===true ||
                String(this.item.system?.range ?? '').trim()!==''
            );
        if (isRangedWeapon && !noMainSkill && !unifiedRof){
            buttons.rofAllocator={
                label: `<i class="fas fa-burst"></i> RoF`,
                callback: async ()=>{
                    await launchRofMacro(
                        this.actor,
                        this.item,
                        this.vehicle
                    );
                }
            };
        }
        
        if (showDamage){
        buttons.mainDamage={
            label: damageIcon+gb.trans('Damage'),//weaponinfo.damage+gb.stringMod(weaponactions.dmgMod),
            
            callback: async (html)=>{
               
                let itemRoll=new ItemRoll(this.actor,this.item)
                let damageOverride=this.damageOverride;
                let modifierOverride;
                let shotgunDamage;
                if (shotgunSettings.enabled){
                    if (aoeWeaponPanel){ui.notifications.warn('Choose either Shotgun or AoE damage rules for this weapon.');return;}
                    const values=readWeaponPanelSettings(html);
                    const shotgun=await prepareNativeShotgunAttack({item:this.item,weaponOwner:this.weaponActor,
                        operator:this.actor,token:this.options.token,mode:values.shotgunMode,
                        bothBarrels:values.bothBarrels,modifierFormula:'0',action:'damage'});
                    if (!shotgun.ok){ui.notifications.warn(shotgun.reason);return;}
                    damageOverride=shotgun.damage;
                    modifierOverride=shotgun.modifierFormulaResolved;
                    shotgunDamage=shotgun;
                }
                if (await this.processItemFormDialog(html,itemRoll,'damage',modifierOverride)===false) return;
                if (shotgunDamage) applyNativeShotgunProfile(itemRoll,shotgunDamage);
                await itemRoll.rollBaseDamage(damageOverride);
                itemRoll.display();

                /* let data={
                    mod: {
                        value: weaponactions.dmgMod,
                        reason: gb.trans('ModItem')
                    },
                    damage: weaponinfo.damage,
                    weapon: item.name+patxt,
                    weaponid: item._id,
                }

                this.processRoll(html,data); */
            }
        }
    }
      

    if (weaponinfo.shots>0 && weaponinfo.reloadType!="none"){ /// autoReload
        buttons.reload={
            label: `<i class="fas fa-redo"></i> `+gb.trans('Reload','SWADE'),
            callback: ()=> {
                this.item.reload(); // swade system reload
                //gb.rechargeWeapon(this.actor,this.item);
            }
        }

        /* swade system now handles reload
         if (gb.setting('reloadX')){
            
            buttons.reloadx={
                label: `<i class="fas fa-spinner"></i> `+gb.trans('Reload','SWADE')+' X',
                callback: ()=> {
                    /// ask how many bullets
                    gb.rechargeWeaponXDialog(this.actor,this.item);
                }
            }
        } */
    }

        if (skillName==gb.setting('fightingSkill')){
           /*  buttons.wildattack={
                label: gb.trans('WildAttack'),
                callback: (html)=>{
                    let itemRoll=new ItemRoll(this.actor,this.item);
                    
            //    console.log(this.item);
                    this.processItemFormDialog(html,itemRoll);
                    
                   
                    itemRoll.rollBaseSkill();                  
                    itemRoll.wildAttack();
                    itemRoll.display();
                }
            } */

            let char=new Char(this.actor);

            if (char.hasEdgeSetting('Frenzy') || char.hasEdgeSetting('Improved Frenzy')){

                let btFrenzyName;
                let frenzyRof;

                if (char.hasEdgeSetting('Improved Frenzy')){

                    btFrenzyName=gb.settingKeyName('Improved Frenzy')
                    frenzyRof=3
                } else if (char.hasEdgeSetting('Frenzy')){
                    btFrenzyName=gb.settingKeyName('Frenzy')
                    frenzyRof=2
                }

                buttons.frenzy={
                    label: btFrenzyName,
                    callback: async (html)=>{
                        let itemRoll=new ItemRoll(this.actor,this.item);
                    
            //    console.log(this.item);
                    if (await this.processItemFormDialog(html,itemRoll,'skill')===false) return;
                    
                    await itemRoll.rollBaseSkill(frenzyRof);                  
                   
                    itemRoll.display();
                    }
                }
            }
        }


        if (skillName == gb.setting('shootingSkill')) {
            let rof = gb.realInt(this.item?.system?.rof)+1;
              
            let char = new Char(this.actor);
            if (char.hasEdgeSetting('Rapid Fire') && !unifiedRof) {
                buttons.rapidFire={
                    label: gb.settingKeyName('Rapid Fire') +' ('+gb.trans('RoF','SWADE')+' '+rof+')',
                    callback: async (html)=>{
                        let itemRoll=new ItemRoll(this.actor,this.item);
                        if (await this.processItemFormDialog(html,itemRoll,'skill')===false) return;
                        if (readWeaponPanelSettings(html).consumeAmmo!==false) itemRoll.useShots(gb.RoFBullets[rof]);
                        
                        await itemRoll.rollBaseSkill(rof);
                        itemRoll.display();
                    }
                }
            }
        }


        if (item.isArcaneDevice){
            buttons['arcanedevice']={
                label: gb.trans('ActivateArcaneDevice','SWADE'),
                callback: async (html)=>{


                    let itemRoll=new ItemRoll(this.actor,this.item)
                if (await this.processItemFormDialog(html,itemRoll,'skill')===false) return;

                await itemRoll.rollArcaneDevice();
              //  itemRoll.rollBaseDamage();
                itemRoll.display();
                }
            }
        }
      

        for (const id in weaponactions.additional){
           
            let action=weaponactions.additional[id];

            let actionIcon;
            if (action.type=='trait'){
                actionIcon=skillIcon;
            } else if (action.type=='damage'){
                actionIcon=damageIcon;
            }else if (action.type=='resist'){
                actionIcon=resistIcon;
            } else if (action.type=='macro'){
                actionIcon=macroIcon
            }else {
                actionIcon=genericIcon
            }
       



           /// go to RollControl
                buttons[id]={
                    label: actionIcon+action.name,
                    callback: async (html)=>{

                        if (action.type=='resist'){ 

                            gb.rollResist(action.skillOverride,action.traitMod);
                        
                        } else if (action.type=='macro'){
                            await this.executeSystemItemAction(id);
                        }else  {
                            let itemRoll=new ItemRoll(this.actor,this.item)
                            if (await this.processItemFormDialog(html,itemRoll,action.type)===false) return;
                            await itemRoll.rollAction(id);
                            itemRoll.display();
                        }

                    }
                }
            
        }

      

      
        if (!this.dontDisplay){
        new Dialog({
            title: item.name,
            content: content,
            buttons: buttons,
            render: (html)=>{

               if (savedSettings) restoreWeaponPanelSettings(html,savedSettings,{maxRof:unifiedRof?maxRof:6});
               if (unifiedRof) bindUnifiedRofControls(html,savedSettings,shotgunDamageProfiles);

               gb.modButtons(html);


                html.on('click','button[data-template]',button=>{
                        
                    let templateType=$(button.currentTarget).data("template");

                    gb.showTemplate(templateType,item);
                    
                   
                })

                html.on('click','.swadetools-powermod-check', async ev => {
                   
      const id = ev.target.dataset.id;
      const enabled = ev.target.checked;

       gb.log(ev,id,enabled);

      const effect = item.effects.get(id);
      if(!effect) return;

      await effect.update({ disabled: !enabled });

      const cost = effect.system.cost ?? 0;

    // span com valor original
    html.find("span.swadetools-powercost").text(gb.getPPCostMod(item));
   // const baseCost = Number(span.data("basecost"));


    });
                
            }
        },{classes:['dialog swadetools-vertical']}).render(true);
        }
        
    }


    


    /* processRoll(html,data){
      //  console.log(data);
        let charRoll=new CharRoll(this.actor)
        let type='skill';
        if (data.damage!==undefined){
            type='damage';
        }
        this.processItemFormDialog(html,charRoll);

        charRoll.combatRoll(data.weaponid);


        if (data.shots!==undefined){
            charRoll.useShots(data.shots);
        }

        charRoll.addFlavor(data.weapon);

        if (data.mod!==undefined){
           
              
                charRoll.addModifier(data.mod.value,data.mod.reason);
            
        }

        if (type=='skill'){
            let rof=1;
            if (data.rof!==undefined){
                rof=data.rof;
            }
            
            charRoll.rollSkill(data.skill,rof);
        } else

        if (type=='damage'){
            
            charRoll.rollDamage(data.damage)
        }

        
        charRoll.display();
    } */

    async processItemFormDialog(html,charRoll,actionType,modifierOverride,preparedWeaponDamage){
        const weaponPanel=!this.damageOnly && this.item.type==='weapon';
        if (weaponPanel){
            const values=readWeaponPanelSettings(html);
            const damage=preparedWeaponDamage ?? prepareWeaponDamageModifier(values.damageModifier,this.actor);
            if (!damage.ok){ui.notifications.warn(damage.reason);return false;}
            charRoll.setWeaponDamageModifier(damage.formula);
            charRoll.setConsumeAmmunition(values.consumeAmmo!==false);
            charRoll.setWeaponTheDrop(values.drop===true);
        }
        if (!this.damageOnly && actionType!=='damage') this.rememberWeaponPanel(html);
        
        if (this.vehicle){
            charRoll.usingVehicle(this.vehicle);
        }
        
           charRoll.addModifier(weaponPanel && actionType==='damage' ? '0' : modifierOverride ?? html.find("#mod")[0].value,gb.trans('Additional'))
            if (html.find("#raise")[0]?.checked){
                charRoll.raiseDmg();
            } 


           /*  if (html.find("#wildattack")[0]?.checked){
                charRoll.addModifier(2,gb.trans('WildAttack'));
                await charRoll.wildAttack();
            }  */

            if (html.find("#swat")[0]?.checked){
                charRoll.addFlag('useswat',1);
            } 


            if (html.find("#grouproll")[0]?.checked){
                charRoll.rollGroup();
            }
        
            if (html.find('#extrapp')[0]){
                charRoll.usePP(html.find('#extrapp')[0].value);
            }

            if (html.find('#calledshots')[0]){
                charRoll.addFlag('usecalled',html.find('#calledshots')[0].value);
                
                
            }

            if (html.find("#multiaction")[0] && !(weaponPanel && actionType==='damage')){
                charRoll.addModifier(html.find('#multiaction')[0].value,gb.trans('MAPenalty.Label','SWADE'));
            } 

            if (html.find("#desperate")[0]){
                let despmod=html.find('#desperate')[0].value;
                if (despmod==1){ /// wildAttack
                    charRoll.addModifier(2,gb.trans('WildAttack'));
                    await charRoll.wildAttack();
                } else {
                if (actionType=='damage'){
                    despmod=0-gb.realInt(html.find('#desperate')[0].value)
                }
                charRoll.addModifier(despmod,gb.trans('DesperateAttack'));
                charRoll.addFlag('desperateattack',html.find('#desperate')[0].value);
                }
            } 

            if (html.find('#cover')[0] && !(weaponPanel && actionType==='damage')){
                switch (html.find('#cover')[0].value) {
                    case 'Light':
                        charRoll.addModifier(-2,gb.trans('Cover.Light','SWADE'));
                        break;
                    case 'Medium':
                        charRoll.addModifier(-4,gb.trans('Cover.Medium','SWADE'));
                        break;
                    case 'Heavy':
                        charRoll.addModifier(-6,gb.trans('Cover.Heavy','SWADE'));
                        break;
                    case 'Total':
                        charRoll.addModifier(-8,gb.trans('Cover.Total','SWADE'));
                        break;
                }
            }
            if (html.find('#illumination')[0] && !(weaponPanel && actionType==='damage')){
                switch (html.find('#illumination')[0].value) {
                    case 'Dim':
                        charRoll.addModifier(-2,gb.trans('Illumination.Dim','SWADE'));
                        break;
                    case 'Dark':
                        charRoll.addModifier(-4,gb.trans('Illumination.Dark','SWADE'));
                        break;
                    case 'Pitch':
                        charRoll.addModifier(-6,gb.trans('Illumination.Pitch','SWADE'));
                        break;
                }
            }

            if (html.find('#actiondmg')[0] && html.find('#actiondmg')[0].value!=''){
                charRoll.useDamageAction(html.find('#actiondmg')[0].value);
            }

            
        
    }
}
