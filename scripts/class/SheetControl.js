import * as gb from './../gb.js';
import * as st from './../st.js';
import CharRoll from './CharRoll.js';
import ItemDialog from './ItemDialog.js';
import ItemRoll from './ItemRoll.js';
import SystemRoll from './SystemRoll.js';
import { bindAoeInventoryControls } from '../services/AoeItemConfig.js';
import { isAoeItem } from '../services/AoeItemFlags.js';
import { getWeaponSettingsClickOptions } from '../services/LastWeaponSettings.js';

const nativeWeaponRecallTargets = new WeakSet();

export default class SheetControl {

    constructor(sheet,html){
        this.sheet=sheet;
        this.rollWithouDialog=false;  /// allow disable/enable dialog in the user configuration



        this.html=html;

     
    }


    replaceClickHandler(container, selector, callback) {
        container.find(selector).each((i, el) => {
            const $el = $(el);
            const clone = $el.clone(true, false);
            clone.off('click').on('click', callback);
            $el.replaceWith(clone);
        });
    }

    bindAttributes(){
        gb.attributes.forEach(attribute => {
            const selector = '.attribute button.attribute-value[data-attribute="' + attribute + '"]';
            this.replaceClickHandler(this.html, selector, async () => {
                await st.attribute(this.sheet.actor, attribute);
            });
        });
        /* gb.attributes.map(attribute=>{
            this.html.find('.attribute button.attribute-value[data-attribute="'+attribute+'"]').unbind('click').bind('click', async ()=>{   
                   
               await st.attribute(this.sheet.actor,attribute);               
              
            })
        }) */
    }

    bindRun(){
       
            this.replaceClickHandler(this.html, '.running-die', async () => {
        await st.run(this.sheet.actor);
    });
        
        /* this.html.find('.running-die').unbind('click').bind('click',async ()=>{
            await st.run(this.sheet.actor);
        }) */
    }

    bindManeuver(){

        this.replaceClickHandler(this.html, '#maneuverCheck', async () => {
            let driveSkill;
    
            if (this.sheet.actor.system.driver.skill) {
                driveSkill = this.sheet.actor.system.driver.skill;
            } else {
                driveSkill = this.sheet.actor.system.driver.skillAlternative;
            }
    
            const realActor = await this.sheet.actor.getDriver();
            let skillId = realActor.items.find(el => el.name === driveSkill && el.type === 'skill')?.id;
    
            const sys = new SystemRoll(realActor);
            sys.useManeuver(this.sheet.actor);
    
            if (!skillId) {
                skillId = driveSkill;
            }
    
            await sys.rollSkill(skillId);
        });
        /* this.html.find('#maneuverCheck').unbind('click').bind('click', async ()=>{
            
          //  console.log(this.sheet.actor.system);
            let driveSkill;
            if (this.sheet.actor.system.driver.skill){
                driveSkill=this.sheet.actor.system.driver.skill
            } else {
                driveSkill=this.sheet.actor.system.driver.skillAlternative
            }




            const realActor=await this.sheet.actor.getDriver();
           
            let skillId=realActor.items.find(el=>el.name==driveSkill && el.type=='skill')?.id;

            let sys=new SystemRoll(realActor);
            sys.useManeuver(this.sheet.actor);

            if (!skillId){
                skillId=driveSkill;
            }
            
            await sys.rollSkill(skillId);
        }) */
    }

    bindSkills(){

        let addel = '';
        if (!gb.setting('itemNameClick')) {
            addel = 'ol.skill-list li.item.skill button.skill-name,';
        }
    
        const selector = addel +
            'ol.skill-list li.item.skill button.skill-die,' +
            'ol.skill-list li.item.skill img.skill-icon,' +
            '.skill-list-main ol.skill-list li.item.skill button.skill-name,' +
            '.skills-list .skill.item a:not(.item-edit)';
    
        this.replaceClickHandler(this.html, selector, async (ev) => {
            const skillId = $(ev.currentTarget).closest('[data-item-id]').attr('data-item-id');
            await st.skill(this.sheet.actor, skillId);
        });

       
       /*  let addel=''
        if(!gb.setting('itemNameClick')){
            addel='ol.skill-list li.item.skill button.skill-name,';
        }

       
        this.html.find(addel+'ol.skill-list li.item.skill button.skill-die,ol.skill-list li.item.skill img.skill-icon,.skill-list-main ol.skill-list li.item.skill button.skill-name, .skills-list .skill.item a:not(.item-edit)').unbind('click').bind('click',async (ev)=>{
          
           
            let skillId=$(ev.currentTarget).closest('[data-item-id]').attr('data-item-id');

          
            await st.skill(this.sheet.actor,skillId);

                
            
          
        }) */

      
       
    }


    bindDamage(){

        const selector = '.quick-list a.damage-roll, .inventory button.damage-roll';

    this.replaceClickHandler(this.html, selector, async (ev) => {
        const itemId = $(ev.currentTarget).parents('.item').data('itemId');
        const sys = new SystemRoll(this.sheet.actor);
        // this.addJokerModifier(this.sheet.actor.id);  
        await sys.rollDamage(itemId);
        // console.log(itemId);
    });
       
            /* this.html.find('.quick-list a.damage-roll, .inventory button.damage-roll').unbind('click').bind('click', async (ev)=>{
                let itemId=$(ev.currentTarget).parents('.item').data('itemId');
                let sys=new SystemRoll(this.sheet.actor);
               // this.addJokerModifier(this.sheet.actor.id);  
                await sys.rollDamage(itemId);
                //console.log(itemId);
            }); */

         //   this.html.find('')
         //   game.actors.get("WO2pFlDeowqDMNQc").items.get("7UFVVJxrE1JF7YNO").rollDamage()
        
    }


    bindNativeWeaponRecallClicks(){
        const root=this.html?.nodeType===1 ? this.html : this.html?.[0];
        const actor=this.sheet.actor ??
            (this.sheet.document?.documentName==='Actor' ? this.sheet.document : null);
        if (!root?.querySelectorAll || !actor?.items) return;
        const controlsSelector='.item-controls, .item-actions, .controls, [data-item-controls], '+
            '[data-swade-tools-aoe-controls], .item-edit, .item-delete, '+
            '[data-action="editItem"], [data-action="deleteItem"]';
        for (const row of root.querySelectorAll('[data-item-id]')){
            const itemId=row.dataset.itemId;
            if (actor.items.get(itemId)?.type!=='weapon') continue;
            const targets=new Set(row.querySelectorAll(
                '.name[data-action="showItem"], .item-name, .item-show, .item-image, .item-img'
            ));
            for (const child of row.children){
                if (child.tagName==='IMG') targets.add(child);
            }
            for (const target of targets){
                if (nativeWeaponRecallTargets.has(target) || target.closest(controlsSelector)) continue;
                nativeWeaponRecallTargets.add(target);
                target.addEventListener('click',async event=>{
                    if (event.shiftKey!==true || event.button>0) return;
                    const item=actor.items.get(itemId);
                    // AoE owns its capture route; do not also open a regular
                    // weapon dialog or suppress its independent click handler.
                    if (!item || item.type!=='weapon' || isAoeItem(item) ||
                        !item.isOwner || this.sheet.isEditable===false) return;
                    const clicked=event.target?.nodeType===1
                        ? event.target : event.target?.parentElement;
                    if (clicked?.closest(controlsSelector)) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    event.stopPropagation();
                    await st.item(actor,item.id,null,
                        getWeaponSettingsClickOptions(event,this.sheet));
                },true);
            }
        }
    }

    bindItem(){



        


      let findEl=`.inventory .item-img,.inventory .item-image, .inventory .item-name, .inventory .weapon .damage-roll`

      findEl+=`,.quickaccess .item-image, .quickaccess .item-name, .quickaccess .item-show`

      findEl+=`,.quickaccess-list .item-image, .quickaccess-list .item-name, .quickaccess-list .item-show`


      findEl+=`,.powers-list .item-image, .powers-list .item-name, .powers-list .item-show`

      findEl+=`,.power-header .item-img, .power-header .item-name`

        this.html.find(findEl).each((index,el)=>{
            this.doItem($(el));
        });
 
        
    }

    doItem(target){
        let parentDiv=target.parents('.item')
        let itemId=parentDiv.data('itemId')
        
       // target.css('background','yellow');
     //   const actions=

       // console.log(target.attr('class'));

        if (itemId){

            let actorItem=this.sheet.actor.items.find(el=>el.id==itemId)
            let type=actorItem?.type;
            if (type=='power' || type=='weapon' || (type=='gear' && (actorItem.system.isArcaneDevice===true || actorItem.system.actions?.trait || !$.isEmptyObject(actorItem.system.actions?.additional ?? {}))) || (type=='shield' && actorItem.system.actions?.trait) || type=='action'){


                if(!gb.setting('itemNameClick')){
                    parentDiv.addClass('swadetools-noshow')
                }
                
                target.off('click').on('click',ev=>{
                    const item=new ItemDialog(this.sheet.actor,itemId,null,
                        getWeaponSettingsClickOptions(ev,this.sheet));
                    return item.showDialog();
                })


                const templatehtml=gb.getTemplatesHTML(actorItem);
                if (templatehtml && !target.closest('li').find('.swade-tools-template-buttons').length){

                   

                    const itemControls=target.closest('li').find('.item-controls');
                    itemControls.prepend(`<span class="swade-tools-template-buttons">${templatehtml}</span>`).on('click','button[data-template]',button=>{
                        
                        let templateType=$(button.currentTarget).data("template");

                        gb.showTemplate(templateType,this.sheet.actor.items.get(itemId));
                        
                       
                    });
                }
            }

            
       

            
          }     
       
    }

   

    rebindAll(){
        this.bindAttributes();
        this.bindSkills();
        this.bindDamage();
        this.bindItem();
        this.bindRun();
        this.bindManeuver();
        this.bindNativeWeaponRecallClicks();
        bindAoeInventoryControls(this.sheet, this.html);

        
    }

    
}

// Native V13 DocumentSheetV2 does not inherit the legacy ActorSheet render
// hook. Install only the new Shift shortcut here; ordinary clicks are untouched.
globalThis.Hooks?.on('renderApplicationV2',(sheet,html)=>{
    if (sheet?.document?.documentName!=='Actor' && !sheet?.actor) return;
    new SheetControl(sheet,html).bindNativeWeaponRecallClicks();
});
