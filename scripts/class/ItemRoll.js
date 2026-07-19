import CharRoll from "./CharRoll.js";
import * as gb from './../gb.js';
import WeaponResourceService from '../services/WeaponResourceService.js';
import AmmoDamageService from '../services/AmmoDamageService.js';

export default class ItemRoll extends CharRoll{
    constructor(actor,item){
        super();
        this.actor=actor;
        this.item=item;
        this.data=item.system.actions;
        this.actions=this.data.additional;
        this.attackAmmoDamageCaptured=false;
        this.attackAmmoDamageSnapshot=null;
        this.ammoDamageOverrideSet=false;
        this.ammoDamageOverride=null;
        
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
            this.captureAttackAmmoDamage();
            let rof=1;
            if (action.dice!==undefined){
               rof=action.dice;
            }

            let skill=this.data.trait;

            if (action.override){
                skill=action.override;
            }

            if (this.item.type=='weapon'){
                if (this.usesRangedWeaponResources(skill)){
                    const resourcesUsed=WeaponResourceService.resolveCost(
                        action,
                        rof
                    );

                    if (resourcesUsed===null){
                        ui.notifications.warn(
                            gb.trans('RofExplicitCostRequired')
                        );
                        this.dontDisplay=true;
                        return null;
                    }

                    this.useShots(resourcesUsed);
                } else {
                    this.useShots(0);
                }
            } else if (gb.realInt(action.resourcesUsed)>0){
                this.useShots(action.resourcesUsed);
            }

            // this.addModifier(action.traitMod,action.name);
            this.addModifier(action.modifier,action.name); /// => changed name

           // console.log(skill,'skill2');
            
            this.addSkillMod();

           
            
            const roll=await this.rollSkill(skill,rof);

            if (!roll){
                return null;
            }
            

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

        return this.roll ?? null;
    }

    raiseDie(){
        let raisedie=6;
        if (this.item.system?.bonusDamageDie){
            raisedie=this.item.system.bonusDamageDie;
        }

        return raisedie;
    }

    /// universal mods
    addSkillMod(){
        this.addModifier(this.item.system.trademark,gb.trans('TrademarkWeapon.Label','SWADE'))
        this.addModifier(this.item.system.actions.traitMod,gb.trans('ModItem'));
        if (this.actor?.system?.stats?.globalMods?.attack && this.actor?.system?.stats?.globalMods?.attack.length > 0) {
            this.actor?.system?.stats?.globalMods?.attack.forEach(el => {
                this.addModifier(el.value,`${el.label} (${gb.trans('GlobalMod.Attack','SWADE')})`);
            });
        }
    }

    addDmgMod(){
        this.addModifier(this.data.dmgMod,gb.trans('ModItem'));        
        const ammoModifier=this.ammoDamageOverrideSet
            ? this.ammoDamageOverride
            : AmmoDamageService.getDamageModifier(this.item);

        if (ammoModifier){
            this.addModifier(ammoModifier.value,ammoModifier.label);
        }
       
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
        this.captureAttackAmmoDamage();
        const usesRangedResources=
            this.usesRangedWeaponResources(this.data.trait);

        let rofstr='';
        if (rof>1){
            rofstr=rof;

            if (this.item.type=='weapon' &&
                usesRangedResources &&
                !this.resourceCostExplicit){
                const resourcesUsed=WeaponResourceService.resolveCost({},rof);

                if (resourcesUsed===null){
                    ui.notifications.warn(gb.trans('RofExplicitCostRequired'));
                    this.dontDisplay=true;
                    return null;
                }

                this.useShots(resourcesUsed,false);
            }
        }

        if (this.item.type==='weapon' && !usesRangedResources){
            this.useShots(0);
        }
        this.defineAction('formula'+rofstr);
        
        
       
        this.addSkillMod();

        let attr=gb.findAttr(this.data.trait)
       // gb.log(this.data.skill,attr);
        let roll;

        if (attr){
            roll=await this.rollAtt(attr,rof);
        } else {
            roll=await this.rollSkill(this.data.trait,rof);
        }

        return roll ?? null;
    }

    usesRangedWeaponResources(traitName){
        return WeaponResourceService.isRangedAttack(
            this.item,
            traitName,
            {
                fightingSkill: gb.setting('fightingSkill'),
                shootingSkill: gb.setting('shootingSkill')
            }
        );
    }

    captureAttackAmmoDamage(){
        if (this.item?.type!=='weapon') {
            return;
        }

        this.attackAmmoDamageCaptured=true;
        this.attackAmmoDamageSnapshot=
            AmmoDamageService.normalizeSnapshot(
                AmmoDamageService.getDamageModifier(this.item)
            );
    }

    useAmmoDamageSnapshot(snapshot){
        this.ammoDamageOverrideSet=true;
        this.ammoDamageOverride=
            AmmoDamageService.normalizeSnapshot(snapshot);
    }

    autoItemFlags(){
        super.autoItemFlags();

        if (this.rolltype==='skill' && this.item?.type==='weapon'){
            const snapshot=this.attackAmmoDamageCaptured
                ? this.attackAmmoDamageSnapshot
                : AmmoDamageService.normalizeSnapshot(
                    AmmoDamageService.getDamageModifier(this.item)
                );
            this.addFlag('ammoDamageSnapshot',snapshot);
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

    async rollBaseDamage(){
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

        
        
        await this.rollDamage(this.item.system.damage,this.getApInfo(),this.raiseDie());
        return this.roll ?? null;
    }

    
}
