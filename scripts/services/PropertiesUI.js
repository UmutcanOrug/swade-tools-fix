import {
    PROPERTY_ACTIONS, PROPERTY_TRIGGERS, PROPERTY_TRAITS, PROPERTY_STATS,
    normalizeRule, validateRules, isPropertiesEnabled, evaluatePropertyModifiers
} from './PropertiesRules.js';
import {
    getPropertyLibrary, getItemPropertyRules, saveItemPropertyRules,
    savePropertyPreset, removePropertyPreset, setPropertyFavorite,
    exportPropertyLibrary, importPropertyLibrary, normalizePropertyPreset, foldPropertySearch,
    PROPERTY_LIBRARY_SCOPES, PROPERTY_LIBRARY_SCOPE_LABELS, normalizePropertyScope,
    getItemPropertyScope, getPropertyPresetScope, isPropertyRuleInScope
} from './PropertiesLibrary.js';

const SUPPORTED_ITEMS = new Set(['weapon', 'power', 'edge', 'ability', 'hindrance', 'gear', 'armor', 'shield', 'ancestry', 'race']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const gameRef = runtime => runtime.game ?? globalThis.game;
const isGM = runtime => gameRef(runtime)?.user?.isGM === true;
const notify = (message, type = 'error', runtime = {}) => (runtime.ui ?? globalThis.ui)?.notifications?.[type]?.(message);
const asElement = value => value?.nodeType === 1 ? value : value?.[0] ?? value;
const titleCase = value => String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, char => char.toUpperCase());
const newId = () => `property-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
const uniqueRules = rules => validateRules(clone(rules).map(rule => ({...rule, id: newId()})));
const options = (values, current, labels = {}) => values.map(value => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(labels[value] ?? titleCase(value))}</option>`).join('');
const field = (label, control) => `<label class="st-property-field"><span>${escape(label)}</span>${control}</label>`;
const input = (name, value, extra = '') => `<input name="${escape(name)}" value="${escape(value)}" ${extra}>`;
const select = (name, values, value, labels = {}) => `<select name="${escape(name)}">${options(values, value, labels)}</select>`;
const number = (name, value, min = -100, max = 100, step = 1) => input(name, value, `type="number" min="${min}" max="${max}" step="${step}"`);
const check = (name, label, checked) => `<label class="st-property-check"><input type="checkbox" name="${escape(name)}"${checked ? ' checked' : ''}><span>${escape(label)}</span></label>`;
const button = (command, label, id = '', extra = '') => `<button type="button" data-property-command="${escape(command)}"${id !== '' && id !== null && id !== undefined ? ` data-property-id="${escape(id)}"` : ''} ${extra}>${escape(label)}</button>`;
const errorMessage = error => error?.message ?? 'The property could not be saved.';
const busy = async (element, operation, runtime) => {
    if (element?.disabled) return;
    if (element) element.disabled = true;
    try { return await operation(); }
    catch (error) { notify(errorMessage(error), 'error', runtime); }
    finally { if (element?.isConnected !== false) element.disabled = false; }
};

const dialogClass = runtime => runtime.DialogV2 ?? globalThis.foundry?.applications?.api?.DialogV2;
const waitDialog = (config, runtime) => {
    const Dialog = dialogClass(runtime);
    if (!Dialog?.wait) throw new Error('Properties & Effects requires Foundry V13 DialogV2.');
    return Dialog.wait({classes: ['dialog', 'themed', 'theme-light', 'swadetools-rof-dialog', 'swadetools-properties-dialog'], position: {width: 560},
        modal: false, rejectClose: false, ...config});
};
const waitValidatedDialog = (config, runtime) => {
    const Dialog = dialogClass(runtime);
    if (!Dialog) throw new Error('Properties & Effects requires Foundry V13 DialogV2.');
    return new Promise(resolve => {
        const invalid = Symbol('invalid-property');
        const {render, ...options} = config;
        const buttons = options.buttons.map(entry => ({...entry, callback: async (event, target, dialog) => {
            try { return await entry.callback?.(event, target, dialog); }
            catch (error) {
                const message = target.form.querySelector('[data-property-validation]');
                if (message) { message.hidden = false; message.textContent = errorMessage(error); }
                else notify(errorMessage(error), 'error', runtime);
                return invalid;
            }
        }}));
        const dialog = new Dialog({classes: ['dialog', 'themed', 'theme-light', 'swadetools-rof-dialog', 'swadetools-properties-dialog'],
            position: {width: 560}, modal: false, ...options, buttons, form: {closeOnSubmit: false},
            submit: async value => {
                if (value === invalid) return;
                resolve(value && typeof value === 'object' ? value : null);
                await dialog.close({submitted: true});
            }});
        dialog.addEventListener('render', event => render?.(event, dialog), {once: true});
        dialog.addEventListener('close', () => resolve(null), {once: true});
        dialog.render({force: true});
    });
};
const rootOf = dialog => asElement(dialog?.element)?.querySelector?.('[data-property-root]');
const actionEntries = (scope, legacy = false) => Object.entries(PROPERTY_ACTIONS).filter(([key, value]) => key !== 'grantEdge' && value?.supported !== false &&
    (!scope || legacy || scope === 'character' || ['attackMod', 'damageMod'].includes(key) || value.kind === 'effect'));
const actionKind = action => PROPERTY_ACTIONS[action]?.kind ?? 'passive';
const newRuleForScope = scope => scope === 'weapon'
    ? {action: 'status', status: 'distracted', value: 1, trigger: 'hit', target: 'target', duration: {rounds: 1}}
    : {action: 'attackMod', value: 0, trigger: 'passive', target: 'self'};
const scopeLabel = scope => PROPERTY_LIBRARY_SCOPE_LABELS[normalizePropertyScope(scope)];
const scopeHint = scope => scope === 'weapon'
    ? 'Weapon / Power properties: attack bonuses and effects triggered by this attack.'
    : 'Character properties: passive Edge, Ability and bearer bonuses.';
const scopedPresets = (library, scope) => (library?.presets ?? []).filter(entry => getPropertyPresetScope(entry) === scope);
const legacyRuleNotice = '<p class="st-property-notice">Previously saved cross-library properties are preserved. Editing them does not change their trigger or recipient automatically. New properties use this library only.</p>';

export const summarizePropertyRule = rule => {
    const action = PROPERTY_ACTIONS[rule?.action]?.label ?? titleCase(rule?.action);
    const qualifier = ['traitModifier', 'traitSteps'].includes(rule?.action) ? rule.trait
        : rule?.action === 'skillModifier' ? rule.skill : rule?.action === 'statModifier' ? rule.stat : rule?.action === 'status' ? rule.status : '';
    const value = typeof rule?.value === 'number' ? `${rule.value > 0 ? '+' : ''}${rule.value}` : '';
    const duration = rule?.duration?.rounds ? ` · ${rule.duration.rounds} round${rule.duration.rounds === 1 ? '' : 's'}` : '';
    return `${titleCase(rule?.trigger)} → ${action}${qualifier ? ` (${titleCase(qualifier)})` : ''}${rule?.action === 'status' ? '' : ` ${value}`}${duration}`.trim();
};

const rulesMarkup = (rules, editable = true) => rules.length ? rules.map((rule, index) => `<li class="st-property-rule${rule.enabled === false ? ' is-disabled' : ''}">
    <div class="st-property-rule-copy"><strong>${escape(rule.name)}</strong><small>${escape(summarizePropertyRule(rule))}</small></div>
    ${editable ? `<div class="st-property-row-actions">${button('toggle-rule', rule.enabled === false ? 'Off' : 'On', index, `aria-label="${rule.enabled === false ? 'Enable' : 'Disable'} ${escape(rule.name)}"`)}${button('edit-rule', 'Edit', index)}${button('remove-rule', '×', index, 'title="Remove property" aria-label="Remove property"')}</div>` : ''}</li>`).join('') : '<li class="st-property-empty">No properties. Add one from the searchable library or create a custom rule.</li>';

/** Pure markup; all user-authored strings are escaped before entering a dialog. */
export const renderPropertyLibrary = (library, {query = '', category = 'all', favoritesOnly = false, picker = false, scope = 'character'} = {}) => {
    normalizePropertyScope(scope);
    const fold = foldPropertySearch;
    const terms = fold(query).trim().split(/\s+/u).filter(Boolean);
    const favorites = new Set(library?.favorites ?? []), hidden = new Set(library?.hiddenPresets ?? []);
    const presets = scopedPresets(library, scope).filter(preset => !hidden.has(preset.id) &&
        (category === 'all' || preset.category === category) && (!favoritesOnly || favorites.has(preset.id)) &&
        terms.every(term => fold([preset.name, preset.category, preset.description, ...(preset.aliases ?? []), ...(preset.rules ?? []).map(summarizePropertyRule)].join(' ')).includes(term)))
        .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)) || a.name.localeCompare(b.name));
    return presets.length ? presets.map(preset => `<li class="st-property-preset">
        <div class="st-property-preset-heading"><strong>${escape(preset.name)}</strong><span class="st-property-category">${escape(preset.category)}</span></div>
        <div class="st-property-preset-description">${escape(preset.description ?? '')}</div>
        <small>${escape((preset.rules ?? []).map(summarizePropertyRule).join(' · '))}</small>
        ${(preset.rules ?? []).some(rule => !isPropertyRuleInScope(rule, scope)) ? '<small class="st-property-legacy">Saved legacy cross-library rule — preserved.</small>' : ''}
        <div class="st-property-row-actions">${button('favorite', favorites.has(preset.id) ? '★' : '☆', preset.id, `title="${favorites.has(preset.id) ? 'Remove favorite' : 'Add favorite'}" aria-label="${favorites.has(preset.id) ? 'Remove favorite' : 'Add favorite'} ${escape(preset.name)}"`)}
        ${picker ? button('choose-preset', 'Add', preset.id) : `${button('edit-preset', 'Edit', preset.id)}${button('duplicate-preset', 'Duplicate', preset.id)}${button('delete-preset', preset.builtin ? 'Hide' : 'Delete', preset.id)}`}</div>
    </li>`).join('') : '<li class="st-property-empty">No matches. Try a different word or category.</li>';
};

const libraryMarkup = (library, {picker = false, query = '', scope = 'character'} = {}) => {
    const categories = [...new Set(scopedPresets(library, scope).map(preset => preset.category))].sort();
    return `<section class="st-properties" data-property-root>
        ${picker ? `<p class="st-property-scope-heading">${escape(scopeLabel(scope))}</p>` : `<nav class="st-property-scopes" aria-label="Separate property libraries">${PROPERTY_LIBRARY_SCOPES.map(value => button('switch-scope', scopeLabel(value), value, `aria-pressed="${scope === value}"`)).join('')}</nav>`}
        <p class="st-property-hint" data-property-scope-hint>${escape(scopeHint(scope))}</p>
        <div class="st-property-search"><input type="search" data-property-search value="${escape(query)}" placeholder="${scope === 'weapon' ? 'Search attack or on-hit property…' : 'Search Edge, Ability or passive property…'}" aria-label="Search property library" autofocus>
        <select data-property-category aria-label="Property category">${options(['all', ...categories], 'all', {all: 'All categories'})}</select></div>
        <div class="st-property-toolbar"><label class="st-property-check"><input type="checkbox" data-property-favorites><span>Favorites</span></label><span data-property-count></span>
        ${button('new-preset', '+ New preset')}${!picker ? `${button('import-library', 'Import both')}${button('export-library', 'Export both')}` : button('new-custom', '+ Custom property')}</div>
        <ul class="st-property-list" data-property-preset-list>${renderPropertyLibrary(library, {picker, query, scope})}</ul>
        <details class="st-property-details"><summary>More Details</summary><p class="st-property-hint">Presets are editable templates, not complete automation for every official Edge. Adding a preset copies its properties to the item; later library edits do not alter existing items. Native Edge behavior is not automatically replaced: do not add a second copy of an already implemented bonus. Built-in presets can be edited or hidden. JSON import accepts data only, never scripts.</p>${!picker ? button('show-hidden', 'Restore hidden presets') : ''}</details>
    </section>`;
};

const confirm = async (title, message, runtime) => Boolean(await waitDialog({window: {title}, content: `<div class="st-properties" data-property-root><p>${escape(message)}</p></div>`,
    buttons: [{action: 'confirm', label: 'Confirm', callback: () => true}, {action: 'cancel', label: 'Cancel', default: true, callback: () => false}]}, runtime));

const showExport = async runtime => {
    const json = exportPropertyLibrary(runtime);
    const download = runtime.saveDataToFile ?? globalThis.saveDataToFile;
    if (download) { download(json, 'application/json', 'swade-tools-property-library.json'); return; }
    await waitDialog({window: {title: 'Export Properties Libraries'}, content: `<section class="st-properties" data-property-root><p class="st-property-hint">Copy this data to a .json file. This bundle contains both separate libraries, with each preset's library preserved.</p><textarea rows="14" readonly>${escape(json)}</textarea></section>`, buttons: [{action: 'close', label: 'Close'}]}, runtime);
};

const showImport = async runtime => {
    if (!isGM(runtime)) return;
    const result = await waitDialog({window: {title: 'Import Properties Libraries'}, content: `<section class="st-properties" data-property-root>
        <p class="st-property-notice">Import applies to both separate libraries, not just the selected tab. Replace replaces both catalogs. Preset library assignments are preserved; older templates are assigned to one library without discarding rules.</p>
        <label class="st-property-field"><span>Choose a JSON file or paste its contents</span><input type="file" accept=".json,application/json" data-property-import-file></label>
        <textarea name="libraryJson" rows="11" maxlength="1000000" placeholder="Paste library JSON"></textarea>${check('replace', 'Replace both catalogs instead of merging', false)}
        ${check('includeAssignments', 'Also restore assigned item properties (exact item UUIDs)', false)}
        <p class="st-property-hint">Item assignments are unchanged unless explicitly enabled above. Invalid rules or script fields are rejected.</p></section>`,
        render: (_event, dialog) => {
            const root = rootOf(dialog);
            root?.querySelector('[data-property-import-file]')?.addEventListener('change', async event => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 1000000) { notify('The library file must be smaller than 1 MB.', 'error', runtime); return; }
                try { root.querySelector('[name="libraryJson"]').value = await file.text(); }
                catch (error) { notify(errorMessage(error), 'error', runtime); }
            });
        }, buttons: [{action: 'import', label: 'Import', callback: (_event, target) => ({json: target.form.elements.libraryJson.value, replace: target.form.elements.replace.checked,
            includeAssignments: target.form.elements.includeAssignments.checked})}, {action: 'cancel', label: 'Cancel', callback: () => false}]}, runtime);
    if (result && isGM(runtime)) {
        const data = JSON.parse(result.json);
        if (!result.includeAssignments && data && typeof data === 'object') data.assignments = result.replace ? getPropertyLibrary(runtime).assignments : {};
        await importPropertyLibrary(JSON.stringify(data), {replace: result.replace}, runtime);
        notify('Properties library imported.', 'info', runtime);
    }
};

const readRuleForm = (form, original) => {
    const elements = form.elements, value = name => elements[name]?.value ?? '', checked = name => elements[name]?.checked === true;
    const numeric = name => Number(value(name));
    const conditions = {attackType: value('attackType'), weaponType: value('weaponType')};
    for (const [name, key] of [['minRange', 'minRange'], ['maxRange', 'maxRange']]) if (value(name).trim() !== '') conditions[key] = numeric(name);
    const rule = {...clone(original), name: value('name'), enabled: checked('enabled'), trigger: value('trigger'), action: value('action'),
        target: value('target'), value: numeric('value'), trait: value('trait'), skill: value('skill'), stat: value('stat'), status: value('status'),
        duration: {rounds: numeric('rounds'), expiry: value('expiry')}, stack: value('stack'), group: value('group') || original.group, frequency: value('frequency'), conditions,
        resist: {enabled: checked('resistEnabled'), trait: value('resistTrait'), modifier: numeric('resistModifier'), tn: numeric('resistTn')}};
    return normalizeRule(rule);
};

export const renderPropertyRuleEditor = (rule, {scope, legacy = false} = {}) => {
    if (scope) normalizePropertyScope(scope);
    const actions = actionEntries(scope, legacy), triggers = !scope || legacy ? PROPERTY_TRIGGERS
        : scope === 'character' ? ['passive'] : actionKind(rule.action) === 'effect' ? PROPERTY_TRIGGERS.filter(value => value !== 'passive') : ['passive'];
    return `<section class="st-properties" data-property-root>
    ${scope ? `<p class="st-property-scope-heading">${escape(scopeLabel(scope))}</p>` : ''}${legacy ? legacyRuleNotice : ''}
    <div class="st-property-grid">${field('Name', input('name', rule.name, 'maxlength="100" required'))}${field('Action', select('action', actions.map(([key]) => key), rule.action, Object.fromEntries(actions.map(([key, value]) => [key, value.label]))))}
    ${field('Trigger', select('trigger', triggers, rule.trigger))}${field('Value', number('value', rule.value))}
    <div data-property-specific="traitModifier traitSteps">${field('Attribute', select('trait', PROPERTY_TRAITS, rule.trait))}</div>
    <div data-property-specific="skillModifier">${field('Skill name', input('skill', rule.skill, 'maxlength="100" placeholder="Shooting"'))}</div>
    <div data-property-specific="statModifier">${field('Stat', select('stat', PROPERTY_STATS, rule.stat))}</div>
    <div data-property-specific="status">${field('Condition', input('status', rule.status, 'maxlength="100" list="st-property-statuses" placeholder="distracted"'))}<datalist id="st-property-statuses">${['distracted', 'vulnerable', 'shaken', 'stunned', 'prone', 'entangled', 'bound'].map(status => `<option value="${status}"></option>`).join('')}</datalist></div></div>
    ${check('enabled', 'Enabled', rule.enabled !== false)}<p class="st-property-hint" data-property-action-hint></p>
    <details class="st-property-details"><summary>More Details</summary><div class="st-property-grid">
    ${field('Recipient', select('target', ['self', 'target'], rule.target))}${field('Stacking', select('stack', ['sum', 'best', 'unique', 'refresh'], rule.stack))}
    ${field('Shared group', input('group', rule.group, 'maxlength="80" placeholder="Optional shared rule key"'))}${field('Frequency', select('frequency', ['attack', 'target', 'hit'], rule.frequency))}
    ${field('Duration (rounds)', number('rounds', rule.duration?.rounds ?? 0, 0, 100))}${field('Expires at', select('expiry', ['turnStart', 'turnEnd'], rule.duration?.expiry ?? 'turnEnd'))}
    ${field('Attack type', select('attackType', ['any', 'ranged', 'melee'], rule.conditions?.attackType ?? 'any'))}${field('Item type', select('weaponType', ['any', 'weapon', 'power'], rule.conditions?.weaponType ?? 'any'))}
    ${field('Minimum range', input('minRange', rule.conditions?.minRange ?? '', 'type="number" min="0" step="0.1" placeholder="Any"'))}${field('Maximum range', input('maxRange', rule.conditions?.maxRange ?? '', 'type="number" min="0" step="0.1" placeholder="Any"'))}</div>
    ${check('resistEnabled', 'Allow a resistance roll', rule.resist?.enabled)}<div class="st-property-grid" data-property-resistance>
    ${field('Resistance attribute', select('resistTrait', PROPERTY_TRAITS, rule.resist?.trait ?? 'vigor'))}${field('Resistance modifier', number('resistModifier', rule.resist?.modifier ?? 0, -20, 20))}${field('Resistance TN', number('resistTn', rule.resist?.tn ?? 4, 2, 20))}</div>
    <p class="st-property-hint">0 rounds = until removed. Same group controls duplicate properties. Passive rules change calculations; triggered effects require the matching attack event. Resistance and duration apply only to triggered effects. No JavaScript or arbitrary data paths are accepted.</p></details>
    <p class="st-property-error" data-property-validation role="alert" hidden></p></section>`;
};

const bindRuleEditor = (root, {scope, legacy = false} = {}) => {
    const form = root?.closest('form');
    if (!form) return;
    const update = () => {
        const action = form.elements.action.value, effect = actionKind(action) === 'effect';
        const trigger = form.elements.trigger;
        const allowedTriggers = !scope || legacy ? PROPERTY_TRIGGERS
            : scope === 'character' || !effect ? ['passive'] : PROPERTY_TRIGGERS.filter(value => value !== 'passive');
        // Rebuild when switching between an outgoing weapon modifier and a
        // triggered weapon effect. Opposite-library triggers never appear.
        if (scope && !legacy && Array.from(trigger.options).map(option => option.value).join() !== allowedTriggers.join())
            trigger.innerHTML = options(allowedTriggers, allowedTriggers.includes(trigger.value) ? trigger.value : allowedTriggers[0]);
        for (const option of trigger.options) option.disabled = !allowedTriggers.includes(option.value) || (!effect && option.value !== 'passive');
        if (!effect || scope === 'character' && !legacy) trigger.value = 'passive';
        for (const container of root.querySelectorAll('[data-property-specific]')) container.hidden = !container.dataset.propertySpecific.split(' ').includes(action);
        const meta = PROPERTY_ACTIONS[action] ?? {};
        form.elements.value.min = String(meta.valueMin ?? -100); form.elements.value.max = String(meta.valueMax ?? 100);
        form.elements.value.closest('label').hidden = action === 'status';
        if (action === 'status') form.elements.value.value = '1';
        root.querySelector('[data-property-action-hint]').textContent = effect
            ? (trigger.value === 'passive' ? 'Native passive effect on the bearer. Requires unrestricted conditions and no resistance.' : 'Applied to the selected recipient after this event. Base character data stays unchanged.')
            : 'Calculated while this source is active. Existing native behavior is not applied twice.';
        if (trigger.value === 'passive') form.elements.target.value = 'self';
        form.elements.target.disabled = trigger.value === 'passive';
        form.elements.rounds.disabled = trigger.value === 'passive';
        form.elements.expiry.disabled = trigger.value === 'passive';
        if (trigger.value === 'passive') form.elements.rounds.value = '0';
        if (scope === 'character' && !legacy && effect) {
            form.elements.attackType.value = 'any'; form.elements.weaponType.value = 'any';
            form.elements.minRange.value = ''; form.elements.maxRange.value = '';
        }
        form.elements.resistEnabled.disabled = !effect || trigger.value === 'passive';
        if (form.elements.resistEnabled.disabled) form.elements.resistEnabled.checked = false;
        const resist = root.querySelector('[data-property-resistance]');
        resist.hidden = form.elements.resistEnabled.disabled || !form.elements.resistEnabled.checked;
    };
    form.elements.action.addEventListener('change', () => {
        if (actionKind(form.elements.action.value) === 'effect') {
            form.elements.trigger.value = scope === 'character' && !legacy ? 'passive' : 'hit';
            form.elements.target.value = scope === 'character' && !legacy ? 'self' : 'target';
            if (form.elements.action.value === 'status') {
                form.elements.value.value = '1';
                if (!form.elements.status.value) form.elements.status.value = 'distracted';
            }
        }
        update();
    });
    form.elements.trigger.addEventListener('change', update);
    form.elements.resistEnabled.addEventListener('change', update);
    update();
};

const showRuleEditor = async (source = {}, runtime = {}, {scope = 'character'} = {}) => {
    if (!isGM(runtime)) return null;
    normalizePropertyScope(scope);
    const original = normalizeRule({id: newId(), name: 'New property', ...newRuleForScope(scope), ...source});
    const legacy = Object.keys(source).length > 0 && !isPropertyRuleInScope(original, scope);
    // A normal wait() resolves on every submit, even invalid ones. Use native
    // DialogV2 with closeOnSubmit:false so validation stays in the same form.
    return waitValidatedDialog({window: {title: 'Edit Property'}, content: renderPropertyRuleEditor(original, {scope, legacy}),
        render: (_event, dialog) => bindRuleEditor(rootOf(dialog), {scope, legacy}),
        buttons: [{action: 'save', label: 'Save Property', callback: (_event, target) => {
            if (!isGM(runtime)) return null;
            const rule = readRuleForm(target.form, original);
            if (!legacy && !isPropertyRuleInScope(rule, scope)) throw new TypeError('This property belongs to the other library.');
            return rule;
        }},
            {action: 'cancel', label: 'Cancel', callback: () => null}]}, runtime);
};

const editRules = async (root, rules, changed, runtime, scope) => {
    root.addEventListener('click', event => {
        const control = event.target.closest?.('[data-property-command]');
        if (!control || !root.contains(control)) return;
        const command = control.dataset.propertyCommand;
        if (!['edit-rule', 'remove-rule', 'toggle-rule', 'new-rule'].includes(command)) return;
        event.preventDefault(); event.stopPropagation();
        void busy(control, async () => {
            if (!isGM(runtime)) return;
            const index = Number(control.dataset.propertyId);
            if (command === 'new-rule') { const result = await showRuleEditor({}, runtime, {scope}); if (result) rules.push(result); }
            else if (Number.isInteger(index) && index >= 0 && index < rules.length) {
                if (command === 'remove-rule') rules.splice(index, 1);
                else if (command === 'toggle-rule') rules[index] = {...rules[index], enabled: rules[index].enabled === false};
                else { const result = await showRuleEditor(rules[index], runtime, {scope}); if (result) rules[index] = result; }
            }
            changed();
        }, runtime);
    });
};

const showPresetEditor = async (source, runtime, scope) => {
    if (!isGM(runtime)) return;
    normalizePropertyScope(scope);
    const preset = clone(source ?? {id: newId(), name: 'New preset', category: 'Custom', description: '', aliases: [], rules: [], scope});
    const rules = preset.rules ?? [];
    const result = await waitValidatedDialog({window: {title: 'Edit Library Preset'}, content: `<section class="st-properties" data-property-root>
        <p class="st-property-scope-heading">${escape(scopeLabel(scope))}</p>
        ${rules.some(rule => !isPropertyRuleInScope(rule, scope)) ? legacyRuleNotice : ''}
        <div class="st-property-grid">${field('Name', input('presetName', preset.name, 'maxlength="100" required'))}${field('Category', input('presetCategory', preset.category, 'maxlength="60" required'))}</div>
        ${field('Short description', input('presetDescription', preset.description, 'maxlength="1000"'))}
        <ul class="st-property-rules" data-property-rules>${rulesMarkup(rules)}</ul><div class="st-property-toolbar">${button('new-rule', '+ Property')}</div>
        <details class="st-property-details"><summary>More Details</summary>${field('Search aliases (comma separated)', input('presetAliases', preset.aliases?.join(', '), 'maxlength="1000"'))}<p class="st-property-hint">Use aliases for alternate names or another language. Editing a built-in preset changes this world only.</p></details><p class="st-property-error" data-property-validation role="alert" hidden></p></section>`,
        render: (_event, dialog) => {
            const root = rootOf(dialog);
            if (root) void editRules(root, rules, () => { root.querySelector('[data-property-rules]').innerHTML = rulesMarkup(rules); }, runtime, scope);
        }, buttons: [{action: 'save', label: 'Save Preset', callback: (_event, target) => normalizePropertyPreset({...preset, name: target.form.elements.presetName.value,
            category: target.form.elements.presetCategory.value, description: target.form.elements.presetDescription.value,
            aliases: target.form.elements.presetAliases.value.split(',').map(value => value.trim()).filter(Boolean), rules: validateRules(rules), scope})}, {action: 'cancel', label: 'Cancel', callback: () => null}]}, runtime);
    if (result && isGM(runtime)) return savePropertyPreset(result, runtime);
};

/** Open the searchable, categorized world library, optionally selecting a copy for an item. */
export const showPropertiesLibrary = async (config = {}, runtime = {}) => {
    if (!isGM(runtime)) { notify('Only the GM can edit the Properties Library.', 'warn', runtime); return null; }
    const picker = config.picker === true;
    let scope = normalizePropertyScope(config.scope ?? (picker ? 'weapon' : 'character'));
    let selection = null;
    const library = getPropertyLibrary(runtime);
    await waitDialog({window: {title: picker ? `Add Property — ${scopeLabel(scope)}` : 'Properties & Effects — Separate Libraries'}, content: libraryMarkup(library, {picker, query: config.query ?? '', scope}),
        render: (_event, dialog) => {
            const root = rootOf(dialog);
            if (!root) return;
            const refresh = () => {
                const current = getPropertyLibrary(runtime);
                const categories = [...new Set(scopedPresets(current, scope).map(preset => preset.category))].sort();
                const categoryControl = root.querySelector('[data-property-category]');
                const category = ['all', ...categories].includes(categoryControl.value) ? categoryControl.value : 'all';
                categoryControl.innerHTML = options(['all', ...categories], category, {all: 'All categories'});
                const query = root.querySelector('[data-property-search]').value;
                const favoritesOnly = root.querySelector('[data-property-favorites]').checked;
                root.querySelector('[data-property-preset-list]').innerHTML = renderPropertyLibrary(current, {query, category, favoritesOnly, picker, scope});
                const count = root.querySelectorAll('.st-property-preset').length;
                root.querySelector('[data-property-count]').textContent = `${count} preset${count === 1 ? '' : 's'}`;
                root.querySelector('[data-property-search]').placeholder = scope === 'weapon' ? 'Search attack or on-hit property…' : 'Search Edge, Ability or passive property…';
                root.querySelector('[data-property-scope-hint]').textContent = scopeHint(scope);
                for (const control of root.querySelectorAll('[data-property-command="switch-scope"]')) control.setAttribute('aria-pressed', String(control.dataset.propertyId === scope));
            };
            root.querySelector('[data-property-search]').addEventListener('input', refresh);
            root.querySelector('[data-property-category]').addEventListener('change', refresh);
            root.querySelector('[data-property-favorites]').addEventListener('change', refresh);
            root.addEventListener('click', event => {
                const control = event.target.closest?.('[data-property-command]');
                if (!control || !root.contains(control)) return;
                event.preventDefault(); event.stopPropagation();
                void busy(control, async () => {
                    if (!isGM(runtime)) return;
                    const command = control.dataset.propertyCommand, id = control.dataset.propertyId;
                    if (command === 'switch-scope') {
                        if (picker) return;
                        scope = normalizePropertyScope(id);
                        root.querySelector('[data-property-search]').value = '';
                        root.querySelector('[data-property-category]').value = 'all';
                        refresh(); return;
                    }
                    // Recheck scope at the action boundary. A stale or forged
                    // opposite-library ID cannot bypass a locked item picker.
                    const data = getPropertyLibrary(runtime), preset = data.presets.find(entry => entry.id === id && getPropertyPresetScope(entry) === scope);
                    if (command === 'choose-preset' && preset) { selection = uniqueRules(preset.rules); await dialog.close(); return; }
                    if (command === 'new-custom') { const rule = await showRuleEditor({}, runtime, {scope}); if (rule) { selection = [rule]; await dialog.close(); } return; }
                    if (command === 'favorite' && preset) await setPropertyFavorite(id, !data.favorites.includes(id), runtime);
                    else if (command === 'new-preset') await showPresetEditor(null, runtime, scope);
                    else if (command === 'edit-preset' && preset) await showPresetEditor(preset, runtime, scope);
                    else if (command === 'duplicate-preset' && preset) await showPresetEditor({...clone(preset), id: newId(), name: `${preset.name} Copy`, builtin: false, rules: uniqueRules(preset.rules)}, runtime, scope);
                    else if (command === 'delete-preset' && preset && await confirm(preset.builtin ? 'Hide Preset' : 'Delete Preset', `Existing items are unchanged. ${preset.builtin ? 'Hide' : 'Delete'} “${preset.name}”?`, runtime)) await removePropertyPreset(id, runtime);
                    else if (command === 'show-hidden') {
                        const {savePropertyLibrary} = await import('./PropertiesLibrary.js');
                        // Restore only the visible library, not the other list.
                        const {BUILTIN_PROPERTY_PRESETS} = await import('./PropertiesLibrary.js');
                        const scopedIds = new Set(BUILTIN_PROPERTY_PRESETS.filter(entry => entry.scope === scope).map(entry => entry.id));
                        await savePropertyLibrary({...data, hiddenPresets: data.hiddenPresets.filter(id => !scopedIds.has(id))}, runtime);
                    } else if (command === 'import-library') await showImport(runtime);
                    else if (command === 'export-library') await showExport(runtime);
                    refresh();
                }, runtime);
            });
            refresh();
        }, buttons: [{action: 'close', label: picker ? 'Cancel' : 'Close'}]}, runtime);
    return selection;
};

const previewMarkup = result => `<section class="st-properties" data-property-root>
    <p class="st-property-hint">Read-only preview. No dice, resources, character changes or effects are created.${result.enabled === false ? ' Properties & Effects is currently disabled.' : ''}</p>
    <div class="st-property-grid">${Object.entries(result.totals ?? {}).filter(([, value]) => value !== 0).map(([key, value]) => `<div class="st-property-total"><span>${escape(PROPERTY_ACTIONS[key]?.label ?? titleCase(key))}</span><strong>${value > 0 ? '+' : ''}${escape(value)}</strong></div>`).join('') || '<p>No modifiers apply in this context.</p>'}</div>
    <ul class="st-property-rules">${(result.contributions ?? []).map(rule => `<li class="st-property-rule"><div class="st-property-rule-copy"><strong>${escape(rule.name)} <span class="st-property-tag ${rule.applied ? 'is-applied' : ''}">${rule.applied ? 'Applied' : 'Ignored'}</span></strong><small>${escape(rule.sourceName ?? '')} · ${escape(summarizePropertyRule(rule))}</small><small>${escape(rule.reason ?? '')}</small></div></li>`).join('')}</ul></section>`;

export const showPropertiesPreview = async (item, runtime = {}, draftRules) => {
    const actor = item?.actor ?? item?.parent;
    const nativeGame = gameRef(runtime), library = getPropertyLibrary(runtime);
    const previewLibrary = draftRules ? {...library, assignments: {...library.assignments, [item.uuid]: validateRules(draftRules)}} : library;
    const previewRuntime = {...runtime, game: {user: nativeGame?.user, settings: {
        get: (scope, key) => scope === 'swade-tools' && key === 'propertiesLibrary' ? previewLibrary : nativeGame?.settings?.get(scope, key)
    }}};
    const targets = Array.from((runtime.canvas ?? globalThis.canvas)?.tokens?.placeables ?? []).filter(token => token?.actor);
    const targetKeys = targets.map(token => token.document?.uuid ?? token.id);
    const context = {actor, item, attackType: 'ranged', range: 0};
    const result = evaluatePropertyModifiers(context, previewRuntime);
    await waitDialog({window: {title: `${item?.name ?? 'Item'} — Properties Preview`}, content: `<section class="st-properties" data-property-root>
        <div class="st-property-grid">${field('Attack type', select('previewAttackType', ['ranged', 'melee'], 'ranged'))}${field('Range', number('previewRange', 0, 0, 100000, .1))}
        ${field('Target', select('previewTarget', ['', ...targetKeys], '', Object.fromEntries([['', 'No target / bearer'], ...targets.map((token, index) => [targetKeys[index], token.name ?? token.actor.name])])))}
        <div data-property-preview-ledger>${previewMarkup(result)}</div></section>`,
        render: (_event, dialog) => {
            const root = rootOf(dialog); if (!root) return;
            const form = root.closest('form');
            const update = () => {
                const index = targetKeys.indexOf(form.elements.previewTarget.value);
                const evaluation = evaluatePropertyModifiers({...context, attackType: form.elements.previewAttackType.value,
                    range: Number(form.elements.previewRange.value), target: index >= 0 ? targets[index] : undefined}, previewRuntime);
                root.querySelector('[data-property-preview-ledger]').innerHTML = previewMarkup(evaluation);
            };
            for (const name of ['previewAttackType', 'previewRange', 'previewTarget']) form.elements[name].addEventListener('change', update);
        }, buttons: [{action: 'close', label: 'Close'}]}, runtime);
};

/** Draft editor: only Save writes; Cancel leaves item data untouched. */
export const showItemProperties = async (item, runtime = {}) => {
    if (!item || !SUPPORTED_ITEMS.has(item.type)) return;
    const editable = isGM(runtime) && item.isOwner !== false;
    const rules = clone(getItemPropertyRules(item, runtime));
    const scope = getItemPropertyScope(item);
    const result = await waitDialog({window: {title: `${item.name} — Properties & Effects`}, content: `<section class="st-properties" data-property-root>
        <p class="st-property-scope-heading">${escape(scopeLabel(scope))}</p>
        ${!isPropertiesEnabled(runtime) ? '<p class="st-property-notice">Disabled in world settings. Saved properties remain dormant.</p>' : ''}
        ${rules.some(rule => !isPropertyRuleInScope(rule, scope)) ? legacyRuleNotice : ''}
        <ul class="st-property-rules" data-property-rules>${rulesMarkup(rules, editable)}</ul>
        <div class="st-property-toolbar">${editable ? `${button('add-from-library', '+ Add Property')}${button('new-rule', '+ Custom')}` : ''}${button('preview', 'Preview / Test')}${isGM(runtime) ? button('open-library', 'Library') : ''}</div>
        <details class="st-property-details"><summary>More Details</summary><p class="st-property-hint">Item properties are independent copies of library templates. Passive rules require the source to be active. Triggered effects occur only at their configured event. AoE, Evade and Fire keep their existing settings.</p></details></section>`,
        render: (_event, dialog) => {
            const root = rootOf(dialog); if (!root) return;
            const refresh = () => { root.querySelector('[data-property-rules]').innerHTML = rulesMarkup(rules, editable); };
            if (editable) void editRules(root, rules, refresh, runtime, scope);
            root.addEventListener('click', event => {
                const control = event.target.closest?.('[data-property-command]');
                if (!control || !root.contains(control)) return;
                const command = control.dataset.propertyCommand;
                if (!['add-from-library', 'preview', 'open-library'].includes(command)) return;
                event.preventDefault(); event.stopPropagation();
                void busy(control, async () => {
                    if (command === 'preview') { await showPropertiesPreview(item, runtime, rules); return; }
                    if (!editable || !isGM(runtime)) return;
                    if (command === 'open-library') await showPropertiesLibrary({scope}, runtime);
                    else { const additions = await showPropertiesLibrary({picker: true, scope}, runtime); if (additions?.length) { rules.push(...additions); refresh(); } }
                }, runtime);
            });
        }, buttons: editable ? [{action: 'save', label: 'Save Properties', callback: () => validateRules(rules)}, {action: 'cancel', label: 'Cancel', callback: () => null}] : [{action: 'close', label: 'Close'}]}, runtime);
    if (editable && Array.isArray(result) && isGM(runtime)) {
        await saveItemPropertyRules(item, result, runtime);
        notify('Item properties saved.', 'info', runtime);
    }
};

export const bindPropertiesItemSheetControl = (sheet, html, runtime = {}) => {
    const root = asElement(html ?? sheet?.element), item = sheet?.item ?? (sheet?.document?.documentName === 'Item' ? sheet.document : null);
    if (!root?.querySelector || !item || !SUPPORTED_ITEMS.has(item.type)) return;
    const existing = root.querySelector('[data-swade-tools-properties-control]');
    if (!isPropertiesEnabled(runtime) || !isGM(runtime)) { existing?.remove(); return; }
    // Native navigation has the same data-tab as its panel. Never attach a
    // property editor to the navigation anchor or static tab strip.
    const panelSelector = 'section[data-tab="properties"], div.tab[data-tab="properties"]';
    const host = root.matches?.('section[data-tab="properties"]') ? root : root.querySelector(panelSelector);
    const documentRef = runtime.document ?? globalThis.document;
    if (!host || !documentRef?.createElement) return;
    const control = existing ?? documentRef.createElement('div');
    if (!existing) {
        control.dataset.swadeToolsPropertiesControl = '';
        control.className = 'form-group st-properties-sheet-control';
        const label = documentRef.createElement('span'); label.textContent = 'Properties & Effects';
        const open = documentRef.createElement('button'); open.type = 'button'; open.dataset.swadeToolsPropertiesOpen = '';
        open.title = 'Properties & Effects'; open.setAttribute('aria-label', 'Open Properties & Effects');
        const icon = documentRef.createElement('i'); icon.className = 'fa-solid fa-gear'; open.append(icon);
        const count = documentRef.createElement('span'); count.dataset.swadeToolsPropertiesCount = '';
        control.append(label, count, open); host.prepend(control);
        open.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            void busy(open, async () => {
                if (!isGM(runtime) || sheet.isEditable === false || item.isOwner === false || !isPropertiesEnabled(runtime)) return;
                await showItemProperties(item, runtime);
                count.textContent = String(getItemPropertyRules(item, runtime).length);
            }, runtime);
        });
    }
    control.querySelector('[data-swade-tools-properties-count]').textContent = String(getItemPropertyRules(item, runtime).length);
    control.querySelector('[data-swade-tools-properties-open]').disabled = sheet.isEditable === false || item.isOwner === false;
};

const registeredHooks = new WeakSet();
export const registerPropertiesItemControls = (runtime = {}) => {
    const hooks = runtime.Hooks ?? globalThis.Hooks;
    if (!hooks?.on || registeredHooks.has(hooks)) return;
    registeredHooks.add(hooks);
    hooks.on('renderItemSheet', (sheet, html) => bindPropertiesItemSheetControl(sheet, html, runtime));
    hooks.on('renderApplicationV2', (sheet, html) => {
        if (sheet?.item || sheet?.document?.documentName === 'Item') bindPropertiesItemSheetControl(sheet, html, runtime);
    });
};

const MenuBase = globalThis.foundry?.applications?.api?.ApplicationV2 ?? class {};
export class PropertiesLibraryMenu extends MenuBase {
    static DEFAULT_OPTIONS = {id: 'swade-tools-properties-library-menu', window: {title: 'Properties & Effects Library'}};
    async render() { await showPropertiesLibrary(); return this; }
}
