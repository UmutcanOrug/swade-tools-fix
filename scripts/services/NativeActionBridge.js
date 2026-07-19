import * as gb from '../gb.js';
import LastAttackService from './LastAttackService.js';
import AmmoDamageService from './AmmoDamageService.js';

export default class NativeActionBridge {
    static installed=false;

    static install() {
        if (this.installed) {
            return;
        }

        this.installed=true;
        Hooks.on('swadeAction', (...args)=>this.onSwadeAction(...args));
    }

    static async onSwadeAction(actor,item,action,roll,userId) {
        if (!actor || !item || !roll || (userId && userId!==game.user.id)) {
            return;
        }

        const messageId=roll.messageId ?? roll.options?.messageId;

        // SWADE Tools' own rolls call this hook before their message exists.
        // Only bridge native SWADE rolls that already have a concrete message.
        if (!messageId) {
            return;
        }

        const message=game.messages?.get(messageId);

        if (!message || !message.isAuthor) {
            return;
        }

        const actionObject=foundry.utils.getProperty(
            item,
            `system.actions.additional.${action}`
        );
        const actionType=String(actionObject?.type ?? action ?? '').toLowerCase();

        // A resistance action is a defender roll, not a new attack by the item owner.
        if (actionType==='resist') {
            return;
        }

        const resolutionMode=item.getFlag?.(gb.moduleName,'resolution')?.mode;

        // Profile-managed powers and area workflows create their own target
        // result cards. Bridging them into the legacy attack resolver would
        // resolve the same action a second time.
        if (resolutionMode && resolutionMode!=='none') {
            return;
        }

        const rolltype=actionType==='damage' || action==='damage'
            ? 'damage'
            : 'skill';
        const rof=Math.max(1,Number(actionObject?.dice ?? roll.options?.rof ?? 1) || 1);
        // This value must mirror what native SWADE actually consumed.
        // Standard RoF costs are enforced by the custom combat assistant;
        // native additional actions use their own Resources Used field.
        const resourcesUsed=Math.max(
            0,
            Number(actionObject?.resourcesUsed ?? 1) || 0
        );
        const frozenTargets=message.flags?.swade?.targets ?? [];
        const liveTargets=Array.from(game.user.targets ?? []);
        const targetUuids=frozenTargets.length
            ? frozenTargets.map(target=>target.uuid).filter(Boolean)
            : liveTargets
                .map(target=>target.document?.uuid)
                .filter(Boolean);
        const targetIds=targetUuids.map(uuid=>{
            const document=globalThis.fromUuidSync?.(uuid);
            return document?.id ?? String(uuid).split('.').pop();
        }).filter(Boolean);
        const loadedAmmo=item.getFlag?.('swade','loadedAmmo');
        const nativeAmmoSnapshot=
            AmmoDamageService.getNativeAttackSnapshot(item,action);
        const ammoDamageSnapshot=nativeAmmoSnapshot.captured
            ? nativeAmmoSnapshot.snapshot
            : AmmoDamageService.normalizeSnapshot(
                AmmoDamageService.getDamageModifier(item)
            );
        const existing=message.flags?.[gb.moduleName] ?? {};
        const flags=foundry.utils.mergeObject(existing,{
            itemroll: item.id,
            itemUuid: item.uuid,
            useactor: item.parent?.id ?? actor.id,
            usetoken: actor.token?.id ?? null,
            skill: actionObject?.override ?? item.system?.actions?.trait ?? '',
            rolltype,
            userof: rof,
            resourcesUsed,
            usetarget: targetIds.join(','),
            targetUuids,
            sceneId: canvas.scene?.id ?? null,
            useaction: action,
            nativeRoll: true,
            loadedAmmo: loadedAmmo ? {
                id: loadedAmmo._id ?? loadedAmmo.id ?? null,
                name: loadedAmmo.name ?? ''
            } : null,
            ammoDamageSnapshot
        },{
            inplace: false,
            insertKeys: true,
            overwrite: true
        });

        await message.update({
            [`flags.${gb.moduleName}`]: flags
        });

        if (rolltype==='skill' && ['weapon','power'].includes(item.type)) {
            await LastAttackService.remember(
                actor,
                item,
                action,
                rof,
                resourcesUsed,
                targetUuids,
                'native'
            );
        }
    }
}
