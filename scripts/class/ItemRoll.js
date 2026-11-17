import CharRoll from "./CharRoll.js";
import * as gb from './../gb.js';
import {getPropertyCombatModifiers} from '../services/PropertiesCombat.js';
import {validatePowerCastSnapshot, powerDamageFormula, renderPowerCastSummary} from '../services/PowerModifiers.js';

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
        let action=this.powerCast?.damageActions?.[actionId] ?? this.actions[actionId];

        this.defineAction(actionId);


        if (action.type=='trait'){

      


                  
          
           if (this.consumeWeaponAmmunition!==false && gb.realInt(action.resourcesUsed)>0){
            this.useShots(this.powerCast?.cost ?? action.resourcesUsed);
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
            let damage=this.powerCast?.damage ?? this.item.system?.damage;
            
            

            if (action.override){
                damage=action.override;
            } /* else {
                
                ui.notifications.warn(gb.trans('NoDmgActionDefined'));
                
            } */

           

            this.addDmgMod();
            await this.rollDamage(this.powerCast ? powerDamageFormula(this.powerCast,damage) : damage,this.getApInfo(action),this.raiseDie());
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
    setPowerModifiers(snapshot,item=this.item){
        if (item.type!=='power') throw new Error('Power Modifiers require a power.');
        this.powerCast=validatePowerCastSnapshot(snapshot);
        this.item=item;
        this.data=item.system.actions;
        this.actions=this.data.additional;
        this.addFlag('powerCast',this.powerCast);
        this.addFlavor(renderPowerCastSummary(this.powerCast),true);
        this.useShots(this.powerCast.cost);
        if (this.powerCast.cost===0) this.manageshots=false;
        this.useTarget(this.powerCast.targets.map(target=>target.uuid.split('.').at(-1)).join(','));
    }

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
        if (!this.propertiesAttackApplied){
            const properties=getPropertyCombatModifiers({actor:this.actor,item:this.item,flags:this.flagUpdate});
            if (properties.totals.attackMod) this.addModifier(properties.totals.attackMod,'Properties: Attack');
            this.propertiesAttackApplied=true;
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
        this.addModifier(this.powerCast?.dmgMod ?? this.data.dmgMod,gb.trans('ModItem'));
       
        if (this.actor?.system?.stats?.globalMods?.damage && this.actor?.system?.stats?.globalMods?.damage.length > 0) {
            this.actor?.system?.stats?.globalMods?.damage.forEach(el => {
                this.addModifier(el.value,`${el.label} (${gb.trans('GlobalMod.Damage','SWADE')})`);
            });
        }
        if (!this.propertiesDamageApplied){
            const properties=getPropertyCombatModifiers({actor:this.actor,item:this.item,flags:this.flagUpdate,
                target:this.propertiesTarget,range:this.propertiesRange});
            if (properties.totals.damageMod) this.addModifier(properties.totals.damageMod,'Properties: Damage');
            this.propertiesDamageApplied=true;
        }
    }
    ///

    useTarget(targetid){
        /// set the target for info
        this.usetarget=targetid;
    }

    usePP(extraPP){
        if (this.item.type=='power'){
            if (this.powerCast){this.useShots(this.powerCast.cost);return;}
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

        let finalAp=this.powerCast?.ap ?? this.item.system.ap;

        if (action && action?.ap){
            finalAp=Number(action.ap)+(this.powerCast?.choices.ap ?? 0)*2;
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

        if (this.item.system.ap || (this.powerCast && finalAp)){
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

        
        
        const damage=override ?? this.powerCast?.damage ?? this.item.system.damage;
        await this.rollDamage(this.powerCast ? powerDamageFormula(this.powerCast,damage) : damage,this.getApInfo(),this.raiseDie());
    }

    
}
