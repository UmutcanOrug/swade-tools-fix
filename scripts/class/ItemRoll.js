import CharRoll from "./CharRoll.js";
import * as gb from './../gb.js';

export default class ItemRoll extends CharRoll{
    constructor(actor,item){
        super();
        this.actor=actor;
        this.item=item;
        this.data=item.system.actions;
        this.actions=this.data.additional;
        
        //this.combatRoll(this.item._id);

        this.addFlavor(item.name);
        this.isItem(item);


     //   console.log(this.manageshots);
        

        /* if (actor.data.type=='vehicle'){
            this.usingVehicle(actor);
            actor=game.actors.get(actor.data.data.driver.id);
            
        } */
      //  console.log(this.item);

    }




    async rollAction(actionId){
        let action=this.actions[actionId];

        this.defineAction(actionId);


        if (action.type=='trait'){

      


                  
          
           if (this.consumeWeaponAmmunition!==false && gb.realInt(action.resourcesUsed)>0){
            this.useShots(action.resourcesUsed);
            } 
            
            

            
           
           // this.addModifier(action.traitMod,action.name);
           this.addModifier(action.modifier,action.name); /// => changed name

            
            let rof=1;
            if (action.dice!==undefined){
               rof=action.dice;
            }

            let skill=this.data.trait;

           // console.log(skill,'skill1');
            
            if (action.override){
                skill=action.override;
            }

           // console.log(skill,'skill2');
            
            this.addSkillMod();

           
            
            await this.rollSkill(skill,rof);
            

        } else if (action.type=='damage'){
            this.addModifier(action.modifier,action.name);
            let damage=this.item.system?.damage;      
            
            

            if (action.override){
                damage=action.override;
            } /* else {
                
                ui.notifications.warn(gb.trans('NoDmgActionDefined'));
                
            } */

           

            this.addDmgMod();
            await this.rollDamage(damage,this.getApInfo(action),this.raiseDie());
        }

        
        

        
    }

    raiseDie(){
        let raisedie=6;
        if (this.item.system?.bonusDamageDie){
            raisedie=this.item.system.bonusDamageDie;
        }

        return raisedie;
    }

    /// universal mods
    setWeaponDamageModifier(formula){
        this.weaponDamageModifier=String(formula ?? '').trim();
        this.addFlag('weaponDamageModifier',this.weaponDamageModifier);
    }

    setConsumeAmmunition(consume){
        // A weapon checkbox must not alter Power Point/arcane-device handling.
        if (this.item?.type!=='weapon') return;
        this.consumeWeaponAmmunition=consume!==false;
        if (!this.consumeWeaponAmmunition) this.manageshots=false;
    }

    setWeaponTheDrop(enabled){
        this.weaponTheDrop=enabled===true;
        this.addFlag('weaponTheDrop',this.weaponTheDrop);
    }

    addSkillMod(){
        if (this.weaponTheDrop && !this.weaponTheDropAttackApplied){
            this.addModifier(4,'The Drop');
            this.weaponTheDropAttackApplied=true;
        }
        this.addModifier(this.item.system.trademark,gb.trans('TrademarkWeapon.Label','SWADE'))
        this.addModifier(this.shotgunTraitModOverride ?? this.item.system.actions.traitMod,gb.trans('ModItem'));
        if (this.actor?.system?.stats?.globalMods?.attack && this.actor?.system?.stats?.globalMods?.attack.length > 0) {
            this.actor?.system?.stats?.globalMods?.attack.forEach(el => {
                this.addModifier(el.value,`${el.label} (${gb.trans('GlobalMod.Attack','SWADE')})`);
            });
        }
    }

    addDmgMod(){
        if (this.weaponTheDrop && !this.weaponTheDropDamageApplied){
            this.addModifier(4,'The Drop');
            this.weaponTheDropDamageApplied=true;
        }
        if (this.weaponDamageModifier && !this.weaponDamageModifierApplied){
            // Use the native formula pipeline even for numeric modifiers; do
            // not evaluate a formula as JavaScript or roll its dice early.
            const modifier=this.addDiceModifier(`(${this.weaponDamageModifier})`);
            this.reasons.push(`Damage Mod: ${modifier}`);
            this.weaponDamageModifierApplied=true;
        }
        this.addModifier(this.data.dmgMod,gb.trans('ModItem'));        
       
        if (this.actor?.system?.stats?.globalMods?.damage && this.actor?.system?.stats?.globalMods?.damage.length > 0) {
            this.actor?.system?.stats?.globalMods?.damage.forEach(el => {
                this.addModifier(el.value,`${el.label} (${gb.trans('GlobalMod.Damage','SWADE')})`);
            });
        }
    }
    ///

    useTarget(targetid){
        /// set the target for info
        this.usetarget=targetid;
    }

    usePP(extraPP){
        if (this.item.type=='power'){
            let usepp=gb.getPPCostMod(this.item)+gb.realInt(extraPP);
            if (usepp<0){ /// min 0
                usepp=0
            }

           // console.log(usepp,'usepp');
            this.useShots(usepp);
        } else if (this.item.isArcaneDevice){
            this.useShots(gb.realInt(extraPP))
        }
    }




    async rollBaseSkill(rof=1){

        let rofstr='';
        if (rof>1){
            rofstr=rof;
        }
        this.defineAction('formula'+rofstr);
        
        
       
        this.addSkillMod();

        let attr=gb.findAttr(this.data.trait)
       // gb.log(this.data.skill,attr);
        if (attr){
            await this.rollAtt(attr,rof);
        } else {
            await this.rollSkill(this.data.trait,rof);
        }
        
       
        
        
        
    }

    getApInfo(action=false){
        let extrainfo='';

        let finalAp=this.item.system.ap;

        if (action && action?.ap){
            finalAp=action.ap;
        }
        let reason=[];

        if (this.actor?.system?.stats?.globalMods?.ap && this.actor?.system?.stats?.globalMods?.ap.length > 0) {
            this.actor?.system?.stats?.globalMods?.ap.forEach(el => {
                finalAp=finalAp+el.value
                reason.push(`${el.label}: ${el.value}`)
            });

            if (finalAp<0){
                finalAp=0
            }
        }

        if (this.item.system.ap){
            extrainfo+=` [${gb.trans('Ap','SWADE')}: ${finalAp}`;
        

        if (reason.length>0){
            extrainfo+=` (${reason.join(', ')})`
        }

            extrainfo+=`]`
      
        }

        return extrainfo;
    }

    async rollBaseDamage(override=null){
        this.defineAction('damage');
        this.addDmgMod();
        /* let extrainfo='';

        let finalAp=this.item.system.ap;
        let reason=[];

        if (this.actor?.system?.stats?.globalMods?.ap && this.actor?.system?.stats?.globalMods?.ap.length > 0) {
            this.actor?.system?.stats?.globalMods?.ap.forEach(el => {
                finalAp=finalAp+el.value
                reason.push(`${el.label}: ${el.value}`)
            });

            if (finalAp<0){
                finalAp=0
            }
        }

        if (this.item.system.ap){
            extrainfo+=` [${gb.trans('Ap','SWADE')}: ${finalAp}`;
        

        if (reason.length>0){
            extrainfo+=` (${reason.join(', ')})`
        }

            extrainfo+=`]`
      
        } */

        
        
        await this.rollDamage(override ?? this.item.system.damage,this.getApInfo(),this.raiseDie());
    }

    
}
