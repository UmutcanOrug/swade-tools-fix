const SCOPE = 'swade-tools';
const FLAMMABILITY_FLAG = 'aoeFlammability';

export const AOE_ACTOR_FLAMMABILITY = Object.freeze({
    none: 0,
    flammable: 6,
    very: 4,
    volatile: 2
});

const LABELS = Object.freeze({
    none: 'Not Flammable',
    flammable: 'Flammable (6)',
    very: 'Very Flammable (4–6)',
    volatile: 'Volatile (2–6)'
});

export const getAoeActorFlammability = actor => {
    const value = typeof actor?.getFlag === 'function'
        ? actor.getFlag(SCOPE, FLAMMABILITY_FLAG)
        : actor?.flags?.[SCOPE]?.[FLAMMABILITY_FLAG];
    return Object.hasOwn(AOE_ACTOR_FLAMMABILITY, value) ? value : 'flammable';
};

const asElement = html => html?.nodeType === 1 ? html : html?.[0] ?? html;

export const bindAoeActorTweaksControl = (sheet, html, runtime = {}) => {
    const actor = sheet?.document;
    const root = asElement(html ?? sheet?.element);
    const documentRef = runtime.document ?? globalThis.document;
    if (actor?.documentName !== 'Actor' || actor.type === 'group' || !documentRef?.createElement) return;
    const host = root?.matches?.('[data-tab="traits"]') ? root
        : root?.querySelector?.('[data-tab="traits"]');
    if (!host) return;

    let group = host.querySelector('[data-swade-tools-aoe-flammability]');
    if (!group) {
        group = documentRef.createElement('div');
        group.className = 'form-group slim';
        group.dataset.swadeToolsAoeFlammability = '';
        const label = documentRef.createElement('label');
        const select = documentRef.createElement('select');
        select.id = `${actor.uuid ?? actor.id ?? 'actor'}-swade-tools-aoe-flammability`;
        select.name = `flags.${SCOPE}.${FLAMMABILITY_FLAG}`;
        select.setAttribute('aria-label', 'Flammability');
        label.htmlFor = select.id;
        label.textContent = 'Flammability';
        for (const [value, text] of Object.entries(LABELS)) {
            const option = documentRef.createElement('option');
            option.value = value;
            option.textContent = text;
            select.append(option);
        }
        const fields = documentRef.createElement('div');
        fields.className = 'form-fields';
        fields.append(select);
        group.append(label, fields);
        host.prepend(group);
    }

    const select = group.querySelector('select');
    select.value = getAoeActorFlammability(actor);
    select.disabled = actor.isOwner !== true || sheet.isEditable === false;
    // This named field is intentionally submitted by native Save Changes.
    // SWADE Tweaks expands all form fields, including flags, without filtering
    // this module's namespace. Do not write on change or replace token actors
    // with their world actor: cancel and unlinked-token editing stay native.
};

const registeredHooks = new WeakSet();
export const registerAoeActorControls = (runtime = {}) => {
    const hooks = runtime.Hooks ?? globalThis.Hooks;
    if (!hooks?.on || registeredHooks.has(hooks)) return;
    registeredHooks.add(hooks);
    hooks.on('renderSwadeActorTweaks', (sheet, html) => bindAoeActorTweaksControl(sheet, html, runtime));
};
