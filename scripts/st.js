import SystemRoll from './class/SystemRoll.js';
import ItemDialog from './class/ItemDialog.js';
import { isAoeItem } from './services/AoeItemFlags.js';

export const attribute=async(actor,attribute)=>{
    let sys=new SystemRoll(actor);
    await sys.rollAtt(attribute);
}


export const skill=async(actor,skillItemId)=>{
    let sys=new SystemRoll(actor);           
    await sys.rollSkill(skillItemId);
}

export const run=async(actor)=>{
    let sys=new SystemRoll(actor);
            await sys.rollRun();
}


export const item=async(actor,itemId,operator=null,options={})=>{
    let item=actor.items.get(itemId)
    if (!item){
        ui.notifications.warn('The selected item could not be found.');
        return false;
    }
    if (item.type=='weapon' || item.type=='power' || isAoeItem(item) ||
        (options.damageOnly===true && ['gear','consumable'].includes(item.type))){
        const dialogOptions={
            ...options,
            restoreLast:options.restoreLast===true,
            token:options.token ?? (actor?.isToken ? actor.token ?? actor.parent : undefined)
        };
        let itemshow=new ItemDialog(actor,itemId,operator,dialogOptions);
        return itemshow.showDialog();
    } else {
        item.show();
    }
}
   

