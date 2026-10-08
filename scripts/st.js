import SystemRoll from './class/SystemRoll.js';
import ItemDialog from './class/ItemDialog.js';

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
    if (item.type=='weapon' || item.type=='power' ||
        (options.damageOnly===true && ['gear','consumable'].includes(item.type))){
        let itemshow=new ItemDialog(actor,itemId,operator,options);
        return itemshow.showDialog();
    } else {
        item.show();
    }
}
   

