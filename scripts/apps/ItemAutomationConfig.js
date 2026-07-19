import * as gb from '../gb.js';
import AutomationService from '../services/AutomationService.js';
import AmmoDamageService from '../services/AmmoDamageService.js';

export default class ItemAutomationConfig {
    static install() {
        Hooks.on('getItemSheetHeaderButtons',(sheet,buttons)=>{
            const item=sheet.item ?? sheet.document;

            if (!item || item.documentName!=='Item') {
                return;
            }

            buttons.unshift({
                label: gb.trans('AutomationConfigShort'),
                class: 'swade-tools-automation-config',
                icon: 'fas fa-sliders',
                onclick: ()=>this.open(item)
            });
        });
    }

    static async open(item) {
        const resolution=AutomationService.getResolutionProfile(item);
        const rule=AutomationService.getCombatRule(item);
        const ammoDamage=AmmoDamageService.getRule(item);
        const esc=value=>foundry.utils.escapeHTML(String(value ?? ''));
        const selected=(value,expected)=>value===expected ? 'selected' : '';
        const checked=value=>value ? 'checked' : '';
        const actions=Object.entries(item.system?.actions?.additional ?? {});
        const actorItems=Array.from(item.actor?.items ?? []);
        const activationOptions=[
            `<option value="formula" ${selected(resolution.activationAction,'formula')}>${esc(gb.trans('MainTraitAction'))}</option>`,
            ...actions
                .filter(([,action])=>action?.type==='trait')
                .map(([id,action])=>
                    `<option value="${esc(id)}" ${selected(resolution.activationAction,id)}>${esc(action.name)}</option>`
                )
        ].join('');
        const selectedDamageItemUuid=
            resolution.damageSourceItemUuid || item.uuid;
        const selectedDamageAction=resolution.damageAction || '__base__';
        const damageOptions=actorItems.flatMap(actorItem=>{
            const options=[];
            const prefix=actorItem.name;

            if (actorItem.system?.damage) {
                const value=`${actorItem.uuid}|||__base__`;
                options.push(
                    `<option value="${esc(value)}" `+
                    `${selected(
                        `${selectedDamageItemUuid}|||${selectedDamageAction}`,
                        value
                    )}>${esc(prefix)} — ${esc(gb.trans('MainDamageAction'))}</option>`
                );
            }

            for (const [id,action] of Object.entries(
                actorItem.system?.actions?.additional ?? {}
            )) {
                if (action?.type!=='damage') {
                    continue;
                }

                const value=`${actorItem.uuid}|||${id}`;
                options.push(
                    `<option value="${esc(value)}" `+
                    `${selected(
                        `${selectedDamageItemUuid}|||${selectedDamageAction}`,
                        value
                    )}>${esc(prefix)} — ${esc(action.name)}</option>`
                );
            }

            return options;
        }).join('');
        const traitListId=`swade-tools-traits-${foundry.utils.randomID()}`;
        const traitOptions=[
            ...gb.attributes,
            ...(item.actor?.itemTypes?.skill ?? []).map(skill=>skill.name)
        ];
        const linkedItemOptions=(selectedUuid,filter)=>[
            `<option value="" ${selected(selectedUuid,'')}>${esc(gb.trans('UseThisItem'))}</option>`,
            ...actorItems
                .filter(filter)
                .map(actorItem=>
                    `<option value="${esc(actorItem.uuid)}" ${selected(selectedUuid,actorItem.uuid)}>${esc(actorItem.name)}</option>`
                )
        ].join('');
        const resourceSourceOptions=linkedItemOptions(
            resolution.resourceSourceItemUuid,
            actorItem=>
                actorItem.id!==item.id &&
                ['weapon','consumable','gear'].includes(actorItem.type)
        );
        const content=`
            <div class="standard-form swade-tools-automation-form">
                <fieldset>
                    <legend>${esc(gb.trans('ResolutionProfile'))}</legend>
                    <div class="form-group">
                        <label>${esc(gb.trans('ResolutionMode'))}</label>
                        <div class="form-fields">
                            <select name="resolutionMode">
                                <option value="none" ${selected(resolution.mode,'none')}>${esc(gb.trans('ResolutionNone'))}</option>
                                <option value="template-only" ${selected(resolution.mode,'template-only')}>${esc(gb.trans('ResolutionTemplateOnly'))}</option>
                                <option value="area-evasion" ${selected(resolution.mode,'area-evasion')}>${esc(gb.trans('ResolutionAreaEvasion'))}</option>
                                <option value="opposed" ${selected(resolution.mode,'opposed')}>${esc(gb.trans('ResolutionOpposed'))}</option>
                                <option value="grenade" ${selected(resolution.mode,'grenade')}>${esc(gb.trans('ResolutionGrenade'))}</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('ActivationAction'))}</label>
                        <div class="form-fields">
                            <select name="activationAction">${activationOptions}</select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('TemplatePreset'))}</label>
                        <div class="form-fields">
                            <select name="templatePreset">
                                ${['small','medium','large','cone','stream'].map(value=>
                                    `<option value="${value}" ${selected(resolution.templatePreset,value)}>${esc(value)}</option>`
                                ).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('DefenseTrait'))}</label>
                        <div class="form-fields">
                            <input name="defenseTrait" type="text" list="${traitListId}" value="${esc(resolution.defenseTrait)}">
                            <input name="defenseModifier" type="number" step="1" value="${Number(resolution.defenseModifier) || 0}">
                            <datalist id="${traitListId}">
                                ${[...new Set(traitOptions)].map(value=>`<option value="${esc(value)}"></option>`).join('')}
                            </datalist>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('TargetNumber'))}</label>
                        <div class="form-fields">
                            <input name="targetNumber" type="number" min="1" step="1" value="${Number(resolution.targetNumber) || 4}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('TargetFilter'))}</label>
                        <div class="form-fields">
                            <select name="targetFilter">
                                <option value="all" ${selected(resolution.targetFilter,'all')}>${esc(gb.trans('TargetAll'))}</option>
                                <option value="enemies" ${selected(resolution.targetFilter,'enemies')}>${esc(gb.trans('TargetEnemies'))}</option>
                                <option value="allies" ${selected(resolution.targetFilter,'allies')}>${esc(gb.trans('TargetAllies'))}</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('AutomationOptions'))}</label>
                        <div class="form-fields">
                            <label><input name="autoTarget" type="checkbox" ${checked(resolution.autoTarget)}> ${esc(gb.trans('AutoTarget'))}</label>
                            <label><input name="damageOnFailure" type="checkbox" ${checked(resolution.damageOnFailure)}> ${esc(gb.trans('DamageFailedTargets'))}</label>
                            <label><input name="includeSelf" type="checkbox" ${checked(resolution.includeSelf)}> ${esc(gb.trans('IncludeSelf'))}</label>
                            <label><input name="useWalls" type="checkbox" ${checked(resolution.useWalls)}> ${esc(gb.trans('RespectWalls'))}</label>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('DamageSourceItem'))}</label>
                        <div class="form-fields">
                            <select name="damageSelection">
                                <option value="">${esc(gb.trans('NoDamage'))}</option>
                                ${damageOptions}
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('ResourceSourceItem'))}</label>
                        <div class="form-fields">
                            <select name="resourceSourceItemUuid">${resourceSourceOptions}</select>
                            <input name="resourcesUsed" type="number" min="0" step="1"
                                title="${esc(gb.trans('ResourceAmount'))}"
                                value="${Math.max(0,Number(resolution.resourcesUsed) || 0)}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('PowerPointAutomation'))}</label>
                        <div class="form-fields">
                            <input name="autoSpendPowerPoints" type="checkbox"
                                ${checked(resolution.autoSpendPowerPoints)}>
                        </div>
                    </div>
                </fieldset>
                ${['consumable','gear'].includes(item.type) ? `
                <fieldset>
                    <legend>${esc(gb.trans('AmmoDamageRule'))}</legend>
                    <div class="form-group">
                        <label>${esc(gb.trans('AmmoDamageEnabled'))}</label>
                        <div class="form-fields">
                            <input name="ammoDamageEnabled" type="checkbox"
                                ${checked(ammoDamage.enabled)}>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('AmmoDamageModifier'))}</label>
                        <div class="form-fields">
                            <input name="ammoDamageModifier" type="text"
                                value="${esc(ammoDamage.modifier)}"
                                placeholder="+1d6x">
                        </div>
                    </div>
                </fieldset>
                ` : ''}
                <fieldset>
                    <legend>${esc(gb.trans('CombatModifierRule'))}</legend>
                    <div class="form-group">
                        <label>${esc(gb.trans('RuleEnabled'))}</label>
                        <div class="form-fields">
                            <input name="ruleEnabled" type="checkbox" ${checked(rule.enabled)}>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('RuleRole'))}</label>
                        <div class="form-fields">
                            <select name="ruleRole">
                                <option value="defender" ${selected(rule.role,'defender')}>${esc(gb.trans('RuleDefender'))}</option>
                                <option value="attacker" ${selected(rule.role,'attacker')}>${esc(gb.trans('RuleAttacker'))}</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('RuleAttackType'))}</label>
                        <div class="form-fields">
                            <select name="ruleAttackType">
                                <option value="ranged" ${selected(rule.attackType,'ranged')}>${esc(gb.trans('RuleRanged'))}</option>
                                <option value="melee" ${selected(rule.attackType,'melee')}>${esc(gb.trans('RuleMelee'))}</option>
                                <option value="all" ${selected(rule.attackType,'all')}>${esc(gb.trans('RuleAllAttacks'))}</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('RuleModifier'))}</label>
                        <div class="form-fields">
                            <input name="ruleValue" type="number" step="1" value="${Number(rule.value) || 0}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('RuleGroup'))}</label>
                        <div class="form-fields">
                            <select name="ruleGroup">
                                <option value="cover" ${selected(rule.group,'cover')}>${esc(gb.trans('RuleCoverGroup'))}</option>
                                <option value="illumination" ${selected(rule.group,'illumination')}>${esc(gb.trans('RuleIlluminationGroup'))}</option>
                                <option value="stack" ${selected(rule.group,'stack')}>${esc(gb.trans('RuleStackGroup'))}</option>
                            </select>
                            <select name="ruleMode">
                                <option value="best" ${selected(rule.mode,'best')}>${esc(gb.trans('RuleBest'))}</option>
                                <option value="stack" ${selected(rule.mode,'stack')}>${esc(gb.trans('RuleStack'))}</option>
                                <option value="replace" ${selected(rule.mode,'replace')}>${esc(gb.trans('RuleReplace'))}</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${esc(gb.trans('RequiresReadied'))}</label>
                        <div class="form-fields">
                            <input name="requiresReadied" type="checkbox" ${checked(rule.requiresReadied)}>
                        </div>
                    </div>
                </fieldset>
            </div>
        `;

        const result=await foundry.applications.api.DialogV2.prompt({
            window: {title: `${item.name}: ${gb.trans('AutomationConfig')}`},
            content,
            ok: {
                label: gb.trans('Save'),
                callback: (_event,button)=>{
                    const form=button.form.elements;
                    const damageSelection=
                        form.damageSelection.value.split('|||');
                    const damageItemUuid=damageSelection[0] || '';
                    const damageAction=damageSelection[1] || '';
                    return {
                        resolution: {
                            version: 1,
                            mode: form.resolutionMode.value,
                            activationAction: form.activationAction.value.trim() || 'formula',
                            templatePreset: form.templatePreset.value,
                            defenseTrait: form.defenseTrait.value.trim() || 'Athletics',
                            defenseModifier: form.defenseModifier.valueAsNumber || 0,
                            targetNumber: form.targetNumber.valueAsNumber || 4,
                            autoTarget: form.autoTarget.checked,
                            damageOnFailure:
                                form.damageOnFailure.checked &&
                                Boolean(damageItemUuid),
                            damageEnabled: Boolean(damageItemUuid),
                            includeSelf: form.includeSelf.checked,
                            targetFilter: form.targetFilter.value,
                            damageAction:
                                damageAction==='__base__' ? '' : damageAction,
                            damageSourceItemUuid:
                                damageItemUuid===item.uuid
                                    ? ''
                                    : damageItemUuid,
                            resourceSourceItemUuid: form.resourceSourceItemUuid.value,
                            resourcesUsed: Math.max(
                                0,
                                form.resourcesUsed.valueAsNumber || 0
                            ),
                            autoSpendPowerPoints:
                                form.autoSpendPowerPoints.checked,
                            useWalls: form.useWalls.checked
                        },
                        combatRule: {
                            version: 1,
                            enabled: form.ruleEnabled.checked,
                            role: form.ruleRole.value,
                            attackType: form.ruleAttackType.value,
                            value: form.ruleValue.valueAsNumber || 0,
                            group: form.ruleGroup.value,
                            mode: form.ruleMode.value,
                            requiresReadied: form.requiresReadied.checked
                        },
                        ammoDamage: {
                            version: 1,
                            enabled:
                                form.ammoDamageEnabled?.checked ?? false,
                            modifier:
                                form.ammoDamageModifier?.value?.trim() ?? ''
                        }
                    };
                }
            },
            rejectClose: false,
            modal: true
        });

        if (!result) {
            return;
        }

        if (result.ammoDamage.enabled &&
            AmmoDamageService.normalizeModifier(
                result.ammoDamage.modifier
            )===null) {
            ui.notifications.warn(gb.trans('InvalidAmmoDamageModifier'));
            return;
        }

        await item.update({
            [`flags.${gb.moduleName}.resolution`]: result.resolution,
            [`flags.${gb.moduleName}.combatRule`]: result.combatRule,
            [`flags.${gb.moduleName}.ammoDamage`]: result.ammoDamage
        });

        ui.notifications.info(gb.trans('AutomationSaved'));
    }
}
