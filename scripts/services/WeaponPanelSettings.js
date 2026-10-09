const FIELD_IDS = Object.freeze({
    modifier: 'mod', multiaction: 'multiaction', cover: 'cover',
    illumination: 'illumination', calledshots: 'calledshots', rof: 'rof',
    recoil: 'rof-recoil', drop: 'rof-drop', vulnerable: 'rof-vulnerable',
    damageModifier: 'rof-damage-modifier', consumeAmmo: 'rof-consume-ammo',
    shotgunMode: 'shotgun-mode', bothBarrels: 'shotgun-both-barrels',
});
const CHECKBOXES = new Set(['recoil', 'drop', 'vulnerable', 'consumeAmmo', 'bothBarrels']);
const elementFor = (html, id) => html?.find?.(`#${id}`)?.[0] ??
    (html?.nodeType === 1 ? html : html?.[0])?.querySelector?.(`#${id}`);

export const readWeaponPanelSettings = html => {
    const values = {};
    for (const [field, id] of Object.entries(FIELD_IDS)) {
        const element = elementFor(html, id);
        if (element) values[field] = CHECKBOXES.has(field)
            ? Boolean(element.checked && !(field==='consumeAmmo' && element.disabled)) : String(element.value ?? '');
    }
    return values;
};

export const restoreWeaponPanelSettings = (html, saved, {maxRof = 6} = {}) => {
    if (!saved) return;
    for (const [field, id] of Object.entries(FIELD_IDS)) {
        if (!(field in saved)) continue;
        const element = elementFor(html, id);
        if (!element) continue;
        if (CHECKBOXES.has(field)) {
            element.checked = saved[field] === true;
            continue;
        }
        let value = String(saved[field]);
        if (field === 'rof' && (!Number.isInteger(Number(value)) ||
            Number(value) < 1 || Number(value) > maxRof)) value = '1';
        if (element.options && !Array.from(element.options).some(option => option.value === value)) continue;
        element.value = value;
    }
    // Raise belongs to one attack's result, not a reusable preference.
    const raise = elementFor(html, 'raise');
    if (raise) raise.checked = false;
};

export const toInlineRofSetup = values => ({
    rof: Number(values.rof ?? 1),
    recoil: values.recoil === true,
    theDrop: values.drop === true,
    forceVulnerable: values.vulnerable === true,
    otherModifierFormula: String(values.modifier ?? '').trim() || '0',
    multiAction: Number(values.multiaction ?? 0),
    cover: values.cover ?? 'None',
    illumination: values.illumination ?? 'None',
    calledShot: values.calledshots ?? 'Torso',
    damageModifier: String(values.damageModifier ?? '').trim(),
    consumeAmmo: values.consumeAmmo !== false,
    shotgunMode: values.shotgunMode ?? 'shot',
    bothBarrels: values.bothBarrels === true,
});

export const bindUnifiedRofControls = (html, saved) => {
    const select = elementFor(html, 'rof');
    if (!select) return;
    const recoil = elementFor(html, 'rof-recoil');
    const root = html?.nodeType === 1 ? html : html?.[0];
    let previous = Number(select.value);
    const update = initial => {
        const multiple = Number(select.value) > 1;
        if (recoil) {
            recoil.disabled = !multiple;
            if (!multiple) recoil.checked = false;
            else if (!initial && previous === 1) recoil.checked = true;
            else if (initial && saved?.recoil === undefined) recoil.checked = true;
        }
        const options = root?.querySelector?.('[data-unified-rof-options]');
        if (options) options.hidden = !multiple && !root?.querySelector?.('#shotgun-mode') &&
            !root?.querySelector?.('[data-aoe-consumption]');
        for (const group of root?.querySelectorAll?.('[data-rof-multiple-only]') ?? []) group.hidden = !multiple;
        const barrels = elementFor(html, 'shotgun-both-barrels');
        if (barrels) {
            barrels.disabled = multiple || elementFor(html, 'shotgun-mode')?.value !== 'shot';
            if (barrels.disabled) barrels.checked = false;
        }
        const damageLabel=root?.querySelector?.('[data-shotgun-damage]');
        if (damageLabel) damageLabel.textContent=elementFor(html,'shotgun-mode')?.value==='slug'
            ? '2d10' : `3d6 / 2d6 / 1d6${barrels?.checked ? ' +4' : ''}`;
        previous = Number(select.value);
    };
    select.addEventListener('change', () => update(false));
    elementFor(html, 'shotgun-mode')?.addEventListener('change', () => update(false));
    elementFor(html, 'shotgun-both-barrels')?.addEventListener('change', () => update(false));
    update(true);
};
