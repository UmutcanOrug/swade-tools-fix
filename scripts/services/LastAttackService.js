import * as gb from '../gb.js';
import ItemRoll from '../class/ItemRoll.js';

export default class LastAttackService {
    static installed=false;

    static install() {
        if (this.installed) {
            return;
        }

        this.installed=true;
        Hooks.on(
            'swadeToolsAttackComplete',
            (...args)=>this.rememberCustomAttack(...args)
        );
    }

    static getSnapshot() {
        return game.user?.getFlag?.(gb.moduleName,'lastAttack') ?? null;
    }

    static async remember(
        actor,
        item,
        action,
        rof,
        resourcesUsed,
        targetUuids,
        origin='native'
    ) {
        if (!game.user?.setFlag || item?.type!=='weapon') {
            return;
        }

        await game.user.setFlag(gb.moduleName,'lastAttack',{
            version: 1,
            origin,
            actorUuid: actor.uuid,
            itemUuid: item.uuid,
            action: action || 'formula',
            rof: Math.max(1,Number(rof) || 1),
            resourcesUsed: Math.max(0,Number(resourcesUsed) || 0),
            targetUuids: Array.from(targetUuids ?? []),
            sceneId: canvas.scene?.id ?? null,
            timestamp: Date.now()
        });

        actor.sheet?.render?.(false);
    }

    static async rememberCustomAttack(
        actor,
        item,
        action,
        rof,
        resourcesUsed,
        targetUuids
    ) {
        return this.remember(
            actor,
            item,
            action,
            rof,
            resourcesUsed,
            targetUuids,
            'swade-tools'
        );
    }

    static matches(actor,item) {
        const snapshot=this.getSnapshot();
        return Boolean(
            snapshot &&
            snapshot.actorUuid===actor?.uuid &&
            snapshot.itemUuid===item?.uuid
        );
    }

    static async repeat(expectedActor=null) {
        const snapshot=this.getSnapshot();

        if (!snapshot) {
            ui.notifications.warn(gb.trans('NoLastAttack'));
            return null;
        }

        const actor=await fromUuid(snapshot.actorUuid);
        const item=await fromUuid(snapshot.itemUuid);

        if (!actor || !item || (expectedActor &&
            actor.uuid!==expectedActor.uuid)) {
            ui.notifications.warn(gb.trans('LastAttackUnavailable'));
            return null;
        }

        await this.restoreTargets(snapshot);

        const resolutionMode=item.getFlag?.(gb.moduleName,'resolution')?.mode;

        if (resolutionMode && resolutionMode!=='none') {
            const {default: ResolutionService}=await import(
                './ResolutionService.js'
            );
            return ResolutionService.startItemWorkflow(actor,item);
        }

        if (snapshot.origin==='swade-tools') {
            const itemRoll=new ItemRoll(actor,item);
            itemRoll.useShots(snapshot.resourcesUsed,true);
            itemRoll.useTarget(
                Array.from(game.user.targets ?? [])
                    .map(target=>target.id)
                    .filter(Boolean)
                    .join(',')
            );

            let roll=null;
            const additional=item.system?.actions?.additional?.[snapshot.action];

            if (additional?.type==='trait') {
                roll=await itemRoll.rollAction(snapshot.action);
            } else {
                roll=await itemRoll.rollBaseSkill(snapshot.rof);
            }

            if (roll) {
                await itemRoll.display();
            }

            return roll;
        }

        const helper=game.swade?.itemChatCardHelper;

        if (!helper?.handleAction) {
            ui.notifications.error(gb.trans('NativeActionUnavailable'));
            return null;
        }

        return helper.handleAction(
            item,
            actor,
            snapshot.action || 'formula',
            {additionalMods: [],event: null}
        );
    }

    static async restoreTargets(snapshot) {
        if ((game.user.targets?.size ?? 0)>0 ||
            snapshot.sceneId!==canvas.scene?.id) {
            return;
        }

        for (const uuid of snapshot.targetUuids ?? []) {
            const document=await fromUuid(uuid);
            const token=document?.object ??
                canvas.tokens?.get(document?.id);

            token?.setTarget?.(true,{
                user: game.user,
                releaseOthers: false,
                groupSelection: true
            });
        }
    }
}
