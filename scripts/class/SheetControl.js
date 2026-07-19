import * as gb from './../gb.js';
import * as st from './../st.js';
import CharRoll from './CharRoll.js';
import ItemDialog from './ItemDialog.js';
import ItemRoll from './ItemRoll.js';
import SystemRoll from './SystemRoll.js';
import AutomationService from '../services/AutomationService.js';
import ResolutionService from '../services/ResolutionService.js';
import LastAttackService from '../services/LastAttackService.js';

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

    bindNativeTools(){
        const container=this.html?.jquery ? this.html : $(this.html);
        const supportedTypes=new Set([
            'weapon',
            'power',
            'gear',
            'consumable',
            'action',
            'shield'
        ]);

        container.find('[data-item-id]').each((_index,element)=>{
            const row=$(element);
            const itemId=row.attr('data-item-id') ?? row.data('itemId');
            const item=this.sheet.actor.items.get(itemId);

            if (!item || !supportedTypes.has(item.type)){
                return;
            }

            let controls=row.find('.item-controls').first();

            if (!controls.length){
                controls=row.children('.swade-tools-inline-controls').first();

                if (!controls.length){
                    controls=$(
                        '<span class="swade-tools-inline-controls"></span>'
                    );
                    row.append(controls);
                }
            }

            if (!controls.find('.swade-tools-native-open').length){
                const button=$(
                    `<button type="button" class="swade-tools-native-open" `+
                    `title="${gb.trans('OpenCombatAssistant')}">`+
                    `<i class="fas fa-crosshairs"></i></button>`
                );

                button.on('click',(event)=>{
                    event.preventDefault();
                    event.stopPropagation();
                    new ItemDialog(this.sheet.actor,item.id).showDialog();
                });
                controls.prepend(button);
            }

            const profile=AutomationService.getResolutionProfile(item);

            if (profile.mode!=='none' &&
                !controls.find('.swade-tools-native-workflow').length){
                const automationButton=$(
                    `<button type="button" class="swade-tools-native-workflow" `+
                    `title="${gb.trans('RunAutomationWorkflow')}">`+
                    `<i class="fas fa-wand-magic-sparkles"></i></button>`
                );
                automationButton.on('click',async event=>{
                    event.preventDefault();
                    event.stopPropagation();
                    await ResolutionService.startItemWorkflow(this.sheet.actor,item);
                });
                controls.prepend(automationButton);
            } else if (profile.mode==='none'){
                controls.find('.swade-tools-native-workflow').remove();
            }

            if (LastAttackService.matches(this.sheet.actor,item) &&
                !controls.find('.swade-tools-repeat-last').length){
                const repeatButton=$(
                    `<button type="button" class="swade-tools-repeat-last" `+
                    `title="${gb.trans('RepeatLastAttack')}">`+
                    `<i class="fas fa-clock-rotate-left"></i></button>`
                );
                repeatButton.on('click',async event=>{
                    event.preventDefault();
                    event.stopPropagation();
                    await LastAttackService.repeat(this.sheet.actor);
                });
                controls.prepend(repeatButton);
            } else if (!LastAttackService.matches(this.sheet.actor,item)){
                controls.find('.swade-tools-repeat-last').remove();
            }
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

            if (type=='power' || type=='weapon' || (type=='gear' && (actorItem.system.isArcaneDevice===true || actorItem.system.actions.trait || !$.isEmptyObject(actorItem.system.actions.additional))) || (type=='shield' && actorItem.system.actions.trait) || type=='action'){


                if(!gb.setting('itemNameClick')){
                    parentDiv.addClass('swadetools-noshow')
                }
                
                target.off('click').on('click',ev=>{
                    let item=new ItemDialog(this.sheet.actor,itemId);
                     item.showDialog();
                })


                let templatehtml=gb.getTemplatesHTML(actorItem);
                if (templatehtml && !target.closest('li').find('.swade-tools-template-buttons').length){

                   

                    target.closest('li').find('.item-controls').prepend(`<span class="swade-tools-template-buttons">${templatehtml}</span>`).on('click','button[data-template]',button=>{
                        
                        let templateType=$(button.currentTarget).data("template");

                        gb.showTemplate(templateType,this.sheet.actor.items.get(itemId));
                        
                       
                    })
                }
            }

            
       

            
          }     
       
    }

   

    rebindAll(){
        if (gb.setting('nativeSheetIntegration')){
            this.bindNativeTools();
            return;
        }

        this.bindAttributes();
        this.bindSkills();
        this.bindDamage();
        this.bindItem();
        this.bindRun();
        this.bindManeuver();

        
    }

    
}
