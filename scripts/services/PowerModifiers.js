import {validateShotgunDamageFormula} from './ShotgunRules.js';
const clone = value => JSON.parse(JSON.stringify(value));
const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? collection ?? []);
export const escapePowerHTML = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const integer = (value, label, min = 0, max = 10000) => {
    const number = Number(value === '' || value === undefined ? 0 : value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} must be a whole number (${min}-${max}).`);
    return number;
};
export const corePowerId = item => {
    const id = String(item?.system?.swid ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const swid=/^(?:(?:swade|power))*(blast|bolt|burst|damagefield)$/.exec(id);
    if (swid) return swid[1];
    return /^(blast|bolt|burst|damage field)(?=\s*\(|$)/i.exec(String(item?.name ?? '').trim())?.[1].toLowerCase().replace(/ /g, '') ?? '';
};
export const powerRangeProfile=(item,actor=item?.actor,gameRef=globalThis.game)=>{
    const range=String(item?.system?.range ?? '').trim();
    if(/^\d+(?:\.\d+)?$/.test(range))return {distance:Number(range),squares:null};
    const match=/^(.+?)(?:\s*(?:x|\*|\u00d7)\s*(\d+(?:\.\d+)?))?$/i.exec(range);
    if(!match)return {distance:null,squares:null};
    for(const [key,label]of Object.entries({agility:'AttrAgi',smarts:'AttrSma',spirit:'AttrSpr',strength:'AttrStr',vigor:'AttrVig'})){
        const localized=gameRef?.i18n?.localize?.(`SWADE.${label}`);
        if(![key,localized].some(name=>name && name.toLowerCase()===match[1].trim().toLowerCase()))continue;
        const die=Number(actor?.system?.attributes?.[key]?.die?.sides),multiple=Number(match[2] ?? 1);
        if(die>0 && Number.isFinite(die*multiple))return {distance:null,squares:die*multiple};
    }
    return {distance:null,squares:null};
};
const nativeModifiers = item => values(item?.effects).filter(effect => effect.type === 'modifier');
const covers = (item, kind) => nativeModifiers(item).some(effect => {
    const name = String(effect.name ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const keys = values(effect.changes).map(change => change.key);
    return kind === 'damage' ? name === 'damage' || name === 'increaseddamage' || keys.includes('system.damage')
        : kind === 'ap' ? name.startsWith('armorpiercing') || keys.includes('system.ap')
        : kind === 'heavyWeapon' ? name === 'heavyweapon' || keys.includes('system.isHeavyWeapon')
        : kind === 'range' ? name === 'range' || keys.includes('system.range')
        : kind === 'light' ? ['glow','shroud'].includes(name)
        : kind === 'pace' ? ['hinder','hurry'].includes(name)
        : kind === 'lingering' ? name==='lingeringdamage' : name === kind.toLowerCase();
});
const fields = Object.freeze({
    ap: {label:'Armor Piercing', options:[['0','None'],['1','AP 2 (+1 PP)'],['2','AP 4 (+2 PP)'],['3','AP 6 (+3 PP)']]},
    light: {label:'Glow / Shroud', options:[['','None'],['glow','Glow (+1 PP)'],['shroud','Shroud (+1 PP)']]},
    pace: {label:'Hinder / Hurry', options:[['','None'],['hinder','Hinder (+1 PP)'],['hurry','Hurry (+1 PP)']]},
    range: {label:'Range', options:[['0','Normal'],['1','Double (+1 PP)'],['2','Triple (+2 PP)']]}
});
export const renderPowerModifiers = item => {
    const esc = escapePowerHTML, damaging = Boolean(item.system?.damage), profile = corePowerId(item);
    let html = '<section class="swadetools-power-modifiers swadetools-power-cast"><h3>Power Modifiers</h3>';
    if (damaging && ['blast','bolt','burst','damagefield'].includes(profile) && !covers(item,'damage')) {
        html += `<label class="swadetools-power-check"><input id="power-mod-damage" type="checkbox">Damage: ${profile === 'damagefield' ? '2d6' : '+1d6'} (+2 PP)</label>`;
    }
    for (const [key, field] of Object.entries(fields)) {
        if (covers(item,key) || (key === 'ap' && !damaging) ||
            (key === 'range' && /touch|self|cone/i.test(String(item.system?.range)))) continue;
        html += `<label class="swadetools-power-choice"><span>${field.label}</span><select id="power-mod-${key}">${field.options.map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label>`;
    }
    for (const [key,label,cost] of [['fatigue','Fatigue',2],['heavyWeapon','Heavy Weapon',2],['lingering','Lingering Damage',2],['selective','Selective',1]]) {
        if (covers(item,key) || (['heavyWeapon','lingering'].includes(key) && !damaging)) continue;
        html += `<label class="swadetools-power-check"><input id="power-mod-${key}" type="checkbox">${label} (+${cost} PP)</label>`;
    }
    for (const effect of nativeModifiers(item)) html += `<label class="swadetools-power-check"><input type="checkbox" class="swadetools-powermod-check" data-id="${esc(effect.id)}" ${effect.disabled ? '' : 'checked'}>${esc(effect.name)} (${Number(effect.system?.cost) || 0} PP)</label>`;
    if(!parsePowerDuration(item).instant && parsePowerDuration(item).seconds===null)
        html+='<label class="swadetools-power-choice"><span>Effect Duration</span><select id="power-mod-expiry"><option value="rounds">Rounds</option><option value="nextTurn">Target\'s Next Turn</option></select></label><label class="swadetools-power-choice"><span>Rounds</span><input id="power-mod-rounds" type="number" min="1" max="10000" value="5"></label>';
    return html + '<div class="swadetools-power-preview" data-power-preview></div></section>';
};
export const readPowerModifiers = (html, item) => {
    const root = html?.[0] ?? html;
    const input = key => html.find(`#power-mod-${key}`)[0];
    const native = root?.querySelectorAll?.('.swadetools-powermod-check');
    return {damage: input('damage')?.checked === true, ap: input('ap')?.value ?? 0,
        light: input('light')?.value ?? '', pace: input('pace')?.value ?? '', range: input('range')?.value ?? 0,
        fatigue: input('fatigue')?.checked === true, heavyWeapon: input('heavyWeapon')?.checked === true,
        lingering: input('lingering')?.checked === true, selective: input('selective')?.checked === true,
        durationRounds:input('rounds')?.value,durationMode:input('expiry')?.value,
        nativeIds: native?.length ? Array.from(native).filter(node => node.checked).map(node => node.dataset.id)
            : nativeModifiers(item).filter(effect => !effect.disabled).map(effect => effect.id)};
};
const normalizeChoices = (item, data) => {
    const choices = {damage: data.damage === true, ap: integer(data.ap,'Armor Piercing',0,3),
        light: data.light || '', pace: data.pace || '', range: integer(data.range,'Range',0,2),
        fatigue: data.fatigue === true, heavyWeapon: data.heavyWeapon === true,
        lingering: data.lingering === true, selective: data.selective === true};
    if (!['','glow','shroud'].includes(choices.light) || !['','hinder','hurry'].includes(choices.pace)) throw new Error('Choose a valid Power Modifier.');
    if (choices.damage && (!['blast','bolt','burst','damagefield'].includes(corePowerId(item)) || covers(item,'damage'))) throw new Error('Use the power\'s native Damage modifier for this power.');
    for (const key of ['ap','heavyWeapon','range']) if (choices[key] && covers(item,key)) throw new Error(`Use the native ${key} modifier instead of adding it twice.`);
    if (choices.range && /touch|self|cone/i.test(String(item.system?.range))) throw new Error('Range cannot extend Touch, Self or Cone Template.');
    if (!item.system?.damage && (choices.damage || choices.ap || choices.heavyWeapon || choices.lingering)) throw new Error('This power has no damage formula.');
    return choices;
};
export const parsePowerDuration=item=>{
    const label=String(item?.system?.duration ?? '').trim();
    const instant=/^(instant(?:aneous)?|anl[ıi]k)$/i.test(label) || /until.*(?:next|following).*turn/i.test(label);
    const match=/^(\d+)\s*(rounds?|minutes?|hours?)?$/i.exec(label);
    return {label,instant,seconds:instant?6:match?Number(match[1])*(/hour/i.test(match[2])?3600:/minute/i.test(match[2])?60:6):null};
};
export const preparePowerCast = (item, selection = {}, {extraPP = 0, actionId = '', damageAction = '', shape = '', id, targets = []} = {}) => {
    if (item?.type !== 'power') throw new Error('Power Modifiers require a power.');
    const choices = normalizeChoices(item, selection);
    const effects = nativeModifiers(item), ids = selection.nativeIds ?? effects.filter(e=>!e.disabled).map(e=>e.id);
    if (!Array.isArray(ids) || ids.some(id=>!effects.some(effect=>effect.id===id))) throw new Error('A selected native Power Modifier is unavailable.');
    let castItem = item;
    if (effects.some(effect => Boolean(effect.disabled) !== !ids.includes(effect.id))) {
        if (typeof item.clone !== 'function') throw new Error('Native power preparation is unavailable.');
        castItem = item.clone({effects: values(item.effects).map(effect => ({...effect.toObject(),
            ...(effect.type === 'modifier' ? {disabled: !ids.includes(effect.id)} : {})}))}, {keepId:true});
        castItem.prepareData?.();
    }
    const nativeCost = effects.filter(effect=>ids.includes(effect.id)).reduce((sum,e)=>sum+integer(e.system?.cost,'Native modifier cost',-100,1000),0);
    const extra = integer(extraPP,'Extra PP',-1000,10000), base = integer(castItem.system.pp,'Power Point cost');
    const nativeAreaPaid=effects.some(effect=>ids.includes(effect.id) &&
        String(effect.name ?? '').toLowerCase().replace(/[^a-z]/g,'')==='areaeffect' && Number(effect.system?.cost)>=1);
    const areaCost = corePowerId(item) === 'blast' && shape === 'large' && !nativeAreaPaid ? 1 : 0;
    const modifierCost = choices.ap + choices.range + (choices.light ? 1 : 0) + (choices.pace ? 1 : 0) +
        (choices.damage ? 2 : 0) + (choices.fatigue ? 2 : 0) + (choices.heavyWeapon ? 2 : 0) + (choices.lingering ? 2 : 0) + (choices.selective ? 1 : 0) + areaCost;
    const action = castItem.system.actions?.additional?.[actionId];
    const override = action?.type === 'trait' ? integer(action.resourcesUsed,'Action PP cost') : 0;
    const cost = Math.max(0, (override > 0 ? override : base + nativeCost + extra) + modifierCost);
    const coreChoices=clone(choices);
    // Native modifier effects already paid their PP and prepared the item's
    // numeric data. Only their target-side rules need bridging here.
    for(const effect of effects.filter(effect=>ids.includes(effect.id))){
        const name=String(effect.name ?? '').toLowerCase().replace(/[^a-z]/g,'');
        if(name==='fatigue')choices.fatigue=true;
        if(name==='lingeringdamage')choices.lingering=true;
        if(['glow','shroud'].includes(name)){
            if(choices.light && choices.light!==name)throw new Error('Choose Glow or Shroud, not both.');
            choices.light=name;
        }
        if(['hinder','hurry'].includes(name)){
            if(choices.pace && choices.pace!==name)throw new Error('Choose Hinder or Hurry, not both.');
            choices.pace=name;
        }
    }
    const damageActions = Object.fromEntries(Object.entries(castItem.system.actions?.additional ?? {})
        .filter(([,action])=>action.type==='damage').map(([key,action])=>[key,{type:'damage',name:String(action.name ?? '').slice(0,160),
            override:String(action.override ?? ''),modifier:String(action.modifier ?? ''),ap:Number(action.ap) || 0,
            isHeavyWeapon:action.isHeavyWeapon===true}]));
    const selectedDamage=damageActions[action?.type==='damage' ? actionId : damageAction];
    const duration=parsePowerDuration(castItem);
    if(duration.seconds===null){
        if(selection.durationMode && !['rounds','nextTurn'].includes(selection.durationMode))throw new Error('Choose a valid effect duration.');
        duration.instant=selection.durationMode==='nextTurn';
        duration.seconds=duration.instant ? 6 : integer(selection.durationRounds ?? 5,'Effect duration',1,10000)*6;
    }
    const snapshot = {version:1, id: id ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        itemUuid:item.uuid, actorUuid:item.actor?.uuid, choices, coreChoices, cost, modifierCost, extraPP:extra,
        nativeNames: effects.filter(effect=>ids.includes(effect.id)).map(effect=>String(effect.name ?? '').slice(0,160)),
        damage:String(castItem.system.damage ?? ''), dmgMod:String(castItem.system.actions?.dmgMod ?? ''), damageActions,
        lingeringBaseDamage:String(selectedDamage?.override || castItem.system.damage || ''),
        lingeringAp:Math.max(0,Number(selectedDamage?.ap || castItem.system.ap || 0)+choices.ap*2),
        lingeringHeavyWeapon:selectedDamage?.isHeavyWeapon===true || castItem.system.isHeavyWeapon===true || choices.heavyWeapon,
        ap:Math.max(0,Number(castItem.system.ap) || 0) + choices.ap * 2,
        heavyWeapon:castItem.system.isHeavyWeapon === true || choices.heavyWeapon,
        range:String(castItem.system.range ?? ''), rangeMultiplier:choices.range + 1,
        damageUpgrade:choices.damage ? corePowerId(item) === 'damagefield' ? 'field' : 'die' : '',
        duration, innate:castItem.system.innate===true, targets:clone(targets), areaCost};
    const range=powerRangeProfile(castItem);
    snapshot.rangeLimit=range.distance===null ? null : range.distance*snapshot.rangeMultiplier;
    snapshot.rangeSquares=range.squares===null ? null : range.squares*snapshot.rangeMultiplier;
    if(choices.damage && !validateShotgunDamageFormula(powerDamageFormula(snapshot,snapshot.damage)).ok)
        throw new Error('The upgraded power damage is not a valid native damage formula.');
    if(choices.lingering) snapshot.lingeringFormula=getPowerLingeringFormula(powerDamageFormula(snapshot,snapshot.lingeringBaseDamage));
    return {item:castItem,snapshot};
};
export const powerDamageFormula = (snapshot, formula) => snapshot?.damageUpgrade === 'field' ? '2d6'
    : snapshot?.damageUpgrade === 'die' ? `(${formula})+1d6` : formula;
export const getPowerLingeringFormula=formula=>{
    if(typeof formula!=='string' || !/^[\d\sdD+xX()\-]+$/.test(formula) || !validateShotgunDamageFormula(formula).ok)
        throw new Error('Lingering Damage requires a plain base dice formula.');
    let dice=0;
    const result=formula.replace(/(\d*)d(\d+)(?:x)?/gi,(_match,count,faces)=>{
        const n=Number(count || 1),die=Number(faces);
        if(!Number.isInteger(n) || n<1 || n>100 || ![4,6,8,10,12].includes(die))throw new Error('Unsupported Lingering Damage dice.');
        dice++;return die===4 ? n>1 ? `${n-1}d4x` : '0' : `${n}d${die-2}x`;
    });
    if(!dice || !validateShotgunDamageFormula(result).ok)throw new Error('Lingering Damage requires base damage dice.');
    return result;
};
export const powerModifierLabels = state => {
    const c = state.coreChoices ?? state.choices;
    return [c.damage && `Damage ${state.damageUpgrade === 'field' ? '2d6' : '+1d6'} (+2 PP)`,
        c.ap && `AP ${c.ap*2} (+${c.ap} PP)`, c.heavyWeapon && 'Heavy Weapon (+2 PP)',
        c.range && `Range x${state.rangeMultiplier} (+${c.range} PP)`, c.light && `${c.light === 'glow' ? 'Glow' : 'Shroud'} (+1 PP)`,
        c.pace && `${c.pace === 'hinder' ? 'Hinder' : 'Hurry'} (+1 PP)`, c.fatigue && 'Fatigue (+2 PP)',
        c.lingering && 'Lingering Damage (+2 PP)', c.selective && 'Selective (+1 PP)', state.areaCost && 'Large Blast (+1 PP)',
        ...state.nativeNames].filter(Boolean);
};
export const renderPowerCastSummary = state => `<div class="swadetools-power-cast-summary"><strong>Power Modifiers:</strong> ${powerModifierLabels(state).map(escapePowerHTML).join(', ') || 'None'}<div>Total: ${state.cost} PP</div></div>`;
export const bindPowerModifierPreview = (html, item) => {
    const update = () => {
        const root = html[0] ?? html;
        const rounds=html.find('#power-mod-rounds')[0];
        if(rounds)rounds.disabled=html.find('#power-mod-expiry')[0]?.value==='nextTurn';
        try {
            const {snapshot} = preparePowerCast(item,readPowerModifiers(html,item),{extraPP:html.find('#extrapp')[0]?.value ?? 0,
                shape:html.find('#power-aoe-shape')[0]?.value ?? ''});
            const summary = root.querySelector?.('[data-power-preview]');
            if (summary) summary.innerHTML = `<strong>${snapshot.cost} PP</strong>${snapshot.damage ? ` | Damage: ${escapePowerHTML(powerDamageFormula(snapshot,snapshot.damage))}` : ''}${snapshot.ap ? ` | AP ${snapshot.ap}` : ''}`;
            html.find('span.swadetools-powercost').text?.(snapshot.cost);
        } catch (error) {
            const summary = root.querySelector?.('[data-power-preview]');
            if (summary) summary.textContent = error.message;
        }
    };
    html.on('change input','.swadetools-power-cast input,.swadetools-power-cast select,#extrapp,#power-aoe-shape',update);
    update();
};
export const frozenPowerTargets = (gameRef = globalThis.game) => values(gameRef?.user?.targets)
    .filter(token=>token.actor && !token.document?.hidden && token.visible !== false)
    .map(token=>({uuid:token.document?.uuid,actorUuid:token.actor.uuid})).filter(target=>/^Scene\.[^.]+\.Token\.[^.]+$/.test(target.uuid));

export const powerActivationCritical=(roll,actor)=>{
    const pool=roll?.terms?.[0]?.dice;
    const dice=pool ?? roll?.dice ?? [];
    const first=die=>Number(die?.results?.[0]?.result ?? die?.total);
    if(!dice.length)return false;
    const localized=globalThis.game?.i18n?.localize?.('SWADE.WildDie');
    const wild=dice.find(die=>/wild/i.test(String(die.options?.flavor ?? '')) ||
        localized && die.options?.flavor===localized);
    if(wild)return first(wild)===1 && dice.filter(die=>die!==wild).every(die=>first(die)===1);
    return actor?.isWildcard===true || pool?.length>=2 ? dice.length>=2 && first(dice[0])===1 && first(dice[1])===1 : first(dice[0])===1;
};

// Only plain declarative fields are restored from chat; no effect scripts are executed.
export const validatePowerCastSnapshot = state => {
    if (state?.version !== 1 || typeof state.id !== 'string' || !state.id || state.id.length > 100 || !state.itemUuid ||
        !state.choices || !Array.isArray(state.targets) || state.targets.length > 500 || !Array.isArray(state.nativeNames) ||
        typeof state.damage !== 'string' || state.damage.length > 1000 || !Number.isFinite(state.ap) || state.ap < 0 || state.ap > 10000 ||
        !Number.isSafeInteger(state.cost) || state.cost < 0 || state.cost > 20000 ||
        !['','die','field'].includes(state.damageUpgrade) || ![1,2,3].includes(state.rangeMultiplier) ||
        ![0,1,2,3].includes(state.choices.ap) || ![0,1,2].includes(state.choices.range) ||
        !['','glow','shroud'].includes(state.choices.light) || !['','hinder','hurry'].includes(state.choices.pace) ||
        ['damage','fatigue','heavyWeapon','lingering','selective'].some(key=>typeof state.choices[key]!=='boolean') ||
        state.nativeNames.length>100 || state.nativeNames.some(name=>typeof name!=='string' || name.length>160) ||
        state.targets.some(target=>!/^Scene\.[^.]+\.Token\.[^.]+$/.test(target.uuid) || typeof target.actorUuid!=='string') ||
        !Number.isFinite(state.duration?.seconds) || state.duration.seconds<0 || state.duration.seconds>36000000 ||
        typeof state.duration.instant!=='boolean' || typeof state.dmgMod!=='string' || state.dmgMod.length>1000 ||
        !state.damageActions || Object.keys(state.damageActions).length>100 || Object.values(state.damageActions).some(action=>
            action.type!=='damage' || typeof action.override!=='string' || action.override.length>1000 ||
            typeof action.modifier!=='string' || action.modifier.length>1000 || !Number.isFinite(action.ap)))
        throw new Error('The original Power Modifiers could not be verified.');
    if(state.choices.lingering && (typeof state.lingeringBaseDamage!=='string' || state.lingeringBaseDamage.length>1000 ||
        !Number.isFinite(state.lingeringAp) || state.lingeringAp<0 || state.lingeringAp>10000 ||
        state.lingeringFormula!==getPowerLingeringFormula(powerDamageFormula(state,state.lingeringBaseDamage))))
        throw new Error('The original Lingering Damage could not be verified.');
    return clone(state);
};

export const selectPowerTargets = async ({targetIds,sceneId}, runtime = {}) => {
    const canvas = runtime.canvasRef ?? globalThis.canvas;
    const Dialog = runtime.DialogClass ?? globalThis.Dialog;
    if (canvas?.scene?.id !== sceneId || !Dialog) throw new Error('Selective target selection is unavailable.');
    return new Promise(resolve => {
        let settled=false;
        const finish=value=>{if(!settled){settled=true;resolve(value);}};
        new Dialog({title:'Selective',content:`<div class="swadetools-selective-targets">${targetIds.map(id=>{
            const token=canvas.tokens.get(id);
            return `<label><input type="checkbox" data-power-target="${escapePowerHTML(id)}" checked>${escapePowerHTML(token?.name ?? id)}</label>`;
        }).join('')}</div>`,buttons:{ok:{label:'<i class="fas fa-check"></i> Confirm',callback:html=>{
            const root=html[0] ?? html;
            finish(Array.from(root.querySelectorAll('[data-power-target]:checked')).map(node=>node.dataset.powerTarget));
        }},cancel:{label:'<i class="fas fa-times"></i> Cancel',callback:()=>finish(null)}},close:()=>finish(null)}).render(true);
    });
};
