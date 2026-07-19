import * as gb from '../gb.js';
import {
    getStandardRofResourceCost
} from './AttackModeResolver.js';
import WeaponResourceService from './WeaponResourceService.js';
import AmmoDamageService from './AmmoDamageService.js';

export default class NativeRofService {
    static installed=false;

    static install() {
        if (this.installed) {
            return;
        }

        const helper=game.swade?.itemChatCardHelper;

        if (!helper?.handleAction) {
            return;
        }

        this.installed=true;
        const original=helper.handleAction;

        helper.handleAction=async function(
            item,
            actor,
            actionKey,
            options={}
        ) {
            const action=foundry.utils.getProperty(
                item,
                `system.actions.additional.${actionKey}`
            );
            const isWeaponAttack=item?.type==='weapon' &&
                (actionKey==='formula' || action?.type==='trait');
            const rof=Math.max(1,Number(action?.dice) || 1);
            const standardCost=getStandardRofResourceCost(rof);
            const traitName=action?.override ??
                item.system?.actions?.trait;
            const isRangedAttack=WeaponResourceService.isRangedAttack(
                item,
                traitName,
                {
                    fightingSkill:
                        game.settings.get(gb.moduleName,'fightingSkill'),
                    shootingSkill:
                        game.settings.get(gb.moduleName,'shootingSkill')
                }
            );
            const shouldNormalize=
                game.settings.get(
                    gb.moduleName,
                    'nativeRofNormalization'
                )===true &&
                item?.type==='weapon' &&
                action?.type==='trait' &&
                isRangedAttack &&
                rof>1 &&
                standardCost!==null &&
                Number(action.resourcesUsed ?? 1)===1;

            if (shouldNormalize) {
                try {
                    await item.update({
                        [`system.actions.additional.${actionKey}.resourcesUsed`]:
                            standardCost
                    });
                } catch (error) {
                    console.error(
                        `${gb.moduleName} | Native RoF normalization failed`,
                        error
                    );
                    ui.notifications.error(
                        gb.trans('NativeRofNormalizationFailed')
                    );
                    return null;
                }
            }

            const ammoSnapshot=isWeaponAttack
                ? AmmoDamageService.beginNativeAttack(item,actionKey)
                : null;

            try {
                return await original.call(
                    this,
                    item,
                    actor,
                    actionKey,
                    options
                );
            } finally {
                AmmoDamageService.endNativeAttack(ammoSnapshot);
            }
        };
    }
}
