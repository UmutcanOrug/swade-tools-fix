import {PROPERTY_VERSION, normalizeRule, validateRules, isPropertyItemUuid} from './PropertiesRules.js';

const SCOPE = 'swade-tools';
export const PROPERTY_LIBRARY_SCOPES = Object.freeze(['weapon', 'character']);
export const PROPERTY_LIBRARY_SCOPE_LABELS = Object.freeze({weapon: 'Weapon / Power', character: 'Edge / Ability / Character'});
export const normalizePropertyScope = value => {
    if (!PROPERTY_LIBRARY_SCOPES.includes(value)) throw new TypeError('Property library scope must be weapon or character.');
    return value;
};
export const getItemPropertyScope = item => ['weapon', 'power'].includes(item?.type) ? 'weapon' : 'character';
const WEAPON_PRESET_IDS = new Set(['attack-bonus', 'ranged-bonus', 'melee-bonus', 'damage-bonus',
    'weakening', 'slowing', 'distracted-hit', 'vulnerable-raise', 'shaken-hit', 'stun-hit', 'entangle-hit',
    'bound-raise', 'prone-hit', 'poison-wound', 'parry-debuff', 'armor-debuff', 'shooting-debuff']);
// Legacy custom catalogs did not store a scope. Preserve every rule and choose
// exactly one list: any triggered effect wins weapon scope; otherwise bearer
// effects/defenses win character scope, and pure outgoing bonuses are weapons.
export const inferPropertyPresetScope = rules => {
    if ((rules ?? []).some(rule => rule.trigger && rule.trigger !== 'passive')) return 'weapon';
    if (!(rules ?? []).length || (rules ?? []).some(rule => !['attackMod', 'damageMod'].includes(rule.action))) return 'character';
    return 'weapon';
};
export const isPropertyRuleInScope = (rule, scope) => normalizePropertyScope(scope) === 'character'
    ? rule?.trigger === 'passive'
    : ['attackMod', 'damageMod'].includes(rule?.action) || rule?.trigger !== 'passive';
export const getPropertyPresetScope = entry => entry?.scope === undefined
    ? inferPropertyPresetScope(entry?.rules) : normalizePropertyScope(entry.scope);
const copy = value => JSON.parse(JSON.stringify(value));
const gameOf = runtime => runtime.game ?? globalThis.game;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/u;
const assertId = (value, label = 'ID') => {
    if (typeof value !== 'string' || !idPattern.test(value)) throw new TypeError(`Invalid ${label}.`);
    return value;
};
const safeText = (value, fallback, max, label) => {
    value ??= fallback;
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new TypeError(`Invalid ${label}.`);
    return value.trim();
};
const plain = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object.`);
    return value;
};
const knownKeys = (value, allowed, label) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label}: unsupported field ${key}.`);
};
const preset = (id, name, category, aliases, rule, description = '') => Object.freeze({
    id: `builtin.${id}`, name, category, aliases: Object.freeze(aliases), description, scope: WEAPON_PRESET_IDS.has(id) ? 'weapon' : 'character',
    rules: Object.freeze([Object.freeze(normalizeRule({id, name, ...rule}))]), builtin: true
});

// These are editable examples, not name-based automation. Adding a preset
// creates an explicitly approved rule; owning a similarly named Edge alone
// never enables it. Existing AoE and Fire configuration stays independent.
export const BUILTIN_PROPERTY_PRESETS = Object.freeze([
    preset('dodge', 'Dodge-like Ranged Avoidance', 'Defense', ['dodge', 'kaçınma', 'menzilli', 'sıyrılma', 'cover', 'siper'], {action: 'cover', value: -2, stack: 'best', group: 'cover'}, 'Cover-like avoidance: strongest protection only. Does not add a second native Dodge bonus.'),
    preset('improved-dodge', 'Improved Ranged Avoidance', 'Defense', ['improved dodge', 'gelişmiş kaçınma', 'cover'], {action: 'cover', value: -4, stack: 'best', group: 'cover'}),
    preset('ranged-defense', 'Incoming Ranged Attack −2', 'Defense', ['ranged', 'menzilli', 'savunma', 'penalty'], {action: 'incomingRanged', value: -2, stack: 'best', group: 'incoming-ranged'}, 'A direct incoming attack modifier, distinct from cover.'),
    preset('melee-defense', 'Incoming Melee Attack −2', 'Defense', ['melee', 'yakın', 'savunma', 'block'], {action: 'incomingMelee', value: -2, stack: 'best', group: 'incoming-melee'}),
    preset('light-cover', 'Light Cover', 'Defense', ['light cover', 'hafif siper'], {action: 'cover', value: -2, stack: 'best', group: 'cover'}),
    preset('medium-cover', 'Medium Cover', 'Defense', ['medium cover', 'orta siper'], {action: 'cover', value: -4, stack: 'best', group: 'cover'}),
    preset('heavy-cover', 'Heavy Cover', 'Defense', ['heavy cover', 'ağır siper'], {action: 'cover', value: -6, stack: 'best', group: 'cover'}),
    preset('ignore-gangup', 'Ignore 1 Gang-Up Bonus', 'Defense', ['gang up', 'gang-up', 'kalabalık', 'block'], {action: 'gangupIgnore', value: 1, stack: 'best', group: 'gangup-ignore'}),
    preset('ignore-gangup-two', 'Ignore 2 Gang-Up Bonus', 'Defense', ['improved block', 'kalabalık', 'gang up'], {action: 'gangupIgnore', value: 2, stack: 'best', group: 'gangup-ignore'}),
    preset('soak-bonus', 'Soak +2', 'Defense', ['soak', 'hasar emme', 'iron jaw', 'demir çene'], {action: 'soakMod', value: 2, stack: 'best', group: 'soak'}),
    preset('attack-bonus', 'Attack +1', 'Attack', ['attack', 'saldırı', 'isabet', 'bonus'], {action: 'attackMod', value: 1}),
    preset('ranged-bonus', 'Ranged Attack +1', 'Attack', ['shooting', 'atış', 'menzilli'], {action: 'attackMod', value: 1, conditions: {attackType: 'ranged'}}),
    preset('melee-bonus', 'Melee Attack +1', 'Attack', ['fighting', 'dövüş', 'yakın'], {action: 'attackMod', value: 1, conditions: {attackType: 'melee'}}),
    preset('damage-bonus', 'Damage +2', 'Attack', ['damage', 'hasar', 'silah'], {action: 'damageMod', value: 2}),
    preset('min-strength', 'Effective Strength +1 Die Step', 'Attack', ['minimum strength', 'brawny', 'güç', 'kuvvet', 'minimum'], {action: 'minStrengthSteps', value: 1, stack: 'best', group: 'minimum-strength'}, 'A minimum-strength adjustment, not a permanent attribute change.'),
    preset('weakening', 'Weakening Hit: Strength −1 Die Step', 'On Hit', ['weakness', 'weakening', 'zayıflatma', 'stat düşürme', 'strength'], {action: 'traitSteps', trigger: 'hit', trait: 'strength', value: -1, duration: {rounds: 2}, stack: 'refresh', group: 'weakening'}),
    preset('slowing', 'Slowing Hit: Agility −1 Die Step', 'On Hit', ['slow', 'yavaşlatma', 'agility', 'çeviklik'], {action: 'traitSteps', trigger: 'hit', trait: 'agility', value: -1, duration: {rounds: 2}, stack: 'refresh', group: 'slowing'}),
    preset('distracted-hit', 'Distracted on Hit', 'Conditions', ['distracted', 'dikkati dağılmış', 'dikkat'], {action: 'status', status: 'distracted', trigger: 'hit', duration: {rounds: 1}, stack: 'refresh', group: 'distracted'}),
    preset('vulnerable-raise', 'Vulnerable on Raise', 'Conditions', ['vulnerable', 'savunmasız', 'raise'], {action: 'status', status: 'vulnerable', trigger: 'raise', duration: {rounds: 1}, stack: 'refresh', group: 'vulnerable'}),
    preset('shaken-hit', 'Shaken on Hit', 'Conditions', ['shaken', 'sarsılmış'], {action: 'status', status: 'shaken', trigger: 'hit', resist: {enabled: true, trait: 'vigor'}, stack: 'unique', group: 'shaken'}),
    preset('stun-hit', 'Stun: Vigor Resistance', 'Conditions', ['stun', 'stunned', 'sersemletme', 'şok'], {action: 'status', status: 'stunned', trigger: 'hit', resist: {enabled: true, trait: 'vigor', modifier: -2}, stack: 'unique', group: 'stunned'}),
    preset('entangle-hit', 'Entangled on Hit', 'Conditions', ['entangled', 'dolanmış', 'ağ'], {action: 'status', status: 'entangled', trigger: 'hit', stack: 'unique', group: 'entangled'}),
    preset('bound-raise', 'Bound on Raise', 'Conditions', ['bound', 'bağlı', 'ağ'], {action: 'status', status: 'bound', trigger: 'raise', stack: 'unique', group: 'bound'}),
    preset('prone-hit', 'Knock Prone', 'Conditions', ['prone', 'yere düşürme', 'knockdown'], {action: 'status', status: 'prone', trigger: 'hit', resist: {enabled: true, trait: 'agility'}, stack: 'unique', group: 'prone'}),
    preset('poison-wound', 'Poison Wound: Vigor −2', 'On Wound', ['poison', 'zehir', 'wound', 'yara'], {action: 'traitModifier', trait: 'vigor', value: -2, trigger: 'wound', duration: {rounds: 3}, resist: {enabled: true, trait: 'vigor'}, stack: 'refresh', group: 'poison'}),
    preset('parry-debuff', 'Disrupt Parry −2', 'On Hit', ['parry', 'savuşturma', 'disrupt'], {action: 'statModifier', stat: 'parry', value: -2, trigger: 'hit', duration: {rounds: 1}, stack: 'refresh', group: 'parry-disruption'}),
    preset('armor-debuff', 'Armor Break −2', 'On Hit', ['armor', 'zırh', 'break', 'kırma'], {action: 'statModifier', stat: 'armor', value: -2, trigger: 'damageApplied', duration: {rounds: 2}, stack: 'refresh', group: 'armor-break'}),
    preset('shooting-debuff', 'Impair Shooting −2', 'On Hit', ['shooting', 'atış', 'skill', 'beceri'], {action: 'skillModifier', skill: 'Shooting', value: -2, trigger: 'hit', duration: {rounds: 1}, stack: 'refresh', group: 'impaired-shooting'}),
    preset('vigor-buff', 'Vigor +1 Die Step', 'Attributes', ['vigor', 'dayanıklılık', 'attribute', 'stat'], {action: 'traitSteps', trait: 'vigor', value: 1, trigger: 'passive', target: 'self', stack: 'best', group: 'vigor-buff'}),
    preset('strength-buff', 'Strength +1 Die Step', 'Attributes', ['strength', 'kuvvet', 'güç', 'attribute'], {action: 'traitSteps', trait: 'strength', value: 1, trigger: 'passive', target: 'self', stack: 'best', group: 'strength-buff'}),
    preset('spirit-buff', 'Spirit Rolls +2', 'Attributes', ['spirit', 'ruh', 'irade'], {action: 'traitModifier', trait: 'spirit', value: 2, trigger: 'passive', target: 'self'}),
    preset('toughness-buff', 'Toughness +2', 'Statistics', ['toughness', 'sağlamlık', 'dayanıklılık'], {action: 'statModifier', stat: 'toughness', value: 2, trigger: 'passive', target: 'self'}),
    preset('parry-buff', 'Parry +1', 'Statistics', ['parry', 'savuşturma'], {action: 'statModifier', stat: 'parry', value: 1, trigger: 'passive', target: 'self'}),
    preset('armor-buff', 'Armor +2', 'Statistics', ['armor', 'zırh'], {action: 'statModifier', stat: 'armor', value: 2, trigger: 'passive', target: 'self'}),
    preset('pace-buff', 'Pace +2', 'Statistics', ['pace', 'hız', 'hareket'], {action: 'statModifier', stat: 'pace', value: 2, trigger: 'passive', target: 'self'}),
    preset('running-buff', 'Running Modifier +2', 'Statistics', ['running', 'koşma', 'koşu'], {action: 'statModifier', stat: 'running', value: 2, trigger: 'passive', target: 'self'}),
    preset('shooting-buff', 'Shooting Rolls +1', 'Skills', ['shooting', 'atış', 'skill', 'beceri'], {action: 'skillModifier', skill: 'Shooting', value: 1, trigger: 'passive', target: 'self'}),
    preset('fighting-buff', 'Fighting Rolls +1', 'Skills', ['fighting', 'dövüş', 'skill', 'beceri'], {action: 'skillModifier', skill: 'Fighting', value: 1, trigger: 'passive', target: 'self'}),
    preset('athletics-buff', 'Athletics Rolls +1', 'Skills', ['athletics', 'atletizm', 'skill', 'beceri'], {action: 'skillModifier', skill: 'Athletics', value: 1, trigger: 'passive', target: 'self'}),
    preset('ap-buff', 'Armor Piercing +2', 'Statistics', ['ap', 'armor piercing', 'zırh delme'], {action: 'statModifier', stat: 'ap', value: 2, trigger: 'passive', target: 'self'})
]);

export const normalizePropertyPreset = raw => {
    plain(raw, 'Preset'); knownKeys(raw, ['id', 'name', 'category', 'aliases', 'description', 'rules', 'builtin', 'scope'], 'Preset');
    const id = assertId(raw.id, 'preset ID');
    const rules = validateRules(raw.rules ?? []), builtin = BUILTIN_PROPERTY_PRESETS.find(entry => entry.id === id);
    const scope = raw.scope === undefined ? builtin?.scope ?? inferPropertyPresetScope(rules) : normalizePropertyScope(raw.scope);
    if (builtin && builtin.scope !== scope) throw new TypeError('Built-in presets must remain in their original library. Duplicate the preset to create a separate custom template.');
    const aliases = raw.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 30) throw new TypeError('Preset aliases must be an array of at most 30 names.');
    return {
        id, name: safeText(raw.name, 'Property Preset', 100, 'preset name'), category: safeText(raw.category, 'Custom', 60, 'category'),
        aliases: aliases.map(alias => safeText(alias, '', 100, 'alias')), description: safeText(raw.description, '', 1000, 'description'),
        rules, scope, builtin: Boolean(builtin)
    };
};

const empty = () => ({version: PROPERTY_VERSION, presets: [], assignments: {}, favorites: [], hiddenPresets: []});
export const normalizePropertyLibrary = raw => {
    plain(raw, 'Properties Library'); knownKeys(raw, ['version', 'presets', 'assignments', 'favorites', 'hiddenPresets'], 'Properties Library');
    if (raw.version !== PROPERTY_VERSION) throw new TypeError('Unsupported Properties Library version.');
    const presets = raw.presets ?? [], assignments = plain(raw.assignments ?? {}, 'Assignments');
    if (!Array.isArray(presets) || presets.length > 500 || Object.keys(assignments).length > 1000) throw new TypeError('Properties Library is too large.');
    const normalized = empty(), seen = new Set();
    for (const rawPreset of presets) {
        const entry = normalizePropertyPreset(rawPreset);
        if (seen.has(entry.id)) throw new TypeError(`Duplicate preset ID: ${entry.id}.`);
        seen.add(entry.id); normalized.presets.push(entry);
    }
    for (const [uuid, rules] of Object.entries(assignments)) {
        if (!isPropertyItemUuid(uuid)) throw new TypeError(`Invalid assignment UUID: ${uuid}.`);
        normalized.assignments[uuid] = validateRules(rules);
    }
    for (const key of ['favorites', 'hiddenPresets']) {
        if (!Array.isArray(raw[key] ?? []) || (raw[key]?.length ?? 0) > 1000) throw new TypeError(`Invalid ${key}.`);
        normalized[key] = [...new Set((raw[key] ?? []).map(id => assertId(id, key)))];
    }
    return normalized;
};

const readStored = runtime => {
    try {
        const raw = gameOf(runtime)?.settings?.get(SCOPE, 'propertiesLibrary');
        return raw ? normalizePropertyLibrary(raw) : empty();
    } catch { return empty(); }
};

export const getPropertyLibrary = (runtime = {}) => {
    const stored = readStored(runtime), merged = new Map(BUILTIN_PROPERTY_PRESETS.map(entry => [entry.id, copy(entry)]));
    for (const entry of stored.presets) merged.set(entry.id, entry);
    for (const id of stored.hiddenPresets) merged.delete(id);
    return {...stored, presets: [...merged.values()]};
};

const assertGm = runtime => {
    if (gameOf(runtime)?.user?.isGM !== true) throw new Error('Only the GM can change the Properties Library or approve item properties.');
    if (!gameOf(runtime)?.settings?.set) throw new Error('Properties settings are unavailable.');
};
export const savePropertyLibrary = async (library, runtime = {}) => {
    assertGm(runtime);
    const normalized = normalizePropertyLibrary(library);
    const previous = readStored(runtime);
    const serverTime = Number(gameOf(runtime)?.time?.serverTime);
    const now = Number(typeof runtime.now === 'function' ? runtime.now() :
        Number.isFinite(serverTime) && serverTime > 0 ? Math.ceil(serverTime) : Date.now());
    if (!Number.isSafeInteger(now) || now <= 0 || now > 8640000000000000) throw new TypeError('Properties approval time is unavailable.');
    // Approval is bound to this exact item/rule configuration, never to a
    // timestamp supplied by an imported preset. Historical chat must not gain
    // newly-enabled automatic effects when its cards are rendered again.
    const configuration = rule => JSON.stringify({...rule, automaticAcceptSince: 0});
    for (const [uuid, rules] of Object.entries(normalized.assignments)) {
        for (const rule of rules) {
            if (!rule.automaticAccept) {rule.automaticAcceptSince = 0; continue;}
            const old = previous.assignments[uuid]?.find(candidate => candidate.id === rule.id);
            rule.automaticAcceptSince = old?.automaticAccept === true && old.automaticAcceptSince > 0 &&
                configuration(old) === configuration(rule) ? old.automaticAcceptSince : now;
        }
    }
    await gameOf(runtime).settings.set(SCOPE, 'propertiesLibrary', normalized);
    return getPropertyLibrary(runtime);
};

// Serialize edits originating from this client so rapid favorites/assignment
// changes do not overwrite one another. World settings remain GM-only.
let writeTail = Promise.resolve();
const editLibrary = (edit, runtime) => {
    assertGm(runtime);
    const result = writeTail.catch(() => {}).then(async () => {
        const library = getPropertyLibrary(runtime);
        edit(library);
        return savePropertyLibrary(library, runtime);
    });
    writeTail = result;
    return result;
};

export const getItemPropertyRules = (item, runtime = {}) => {
    const uuid = typeof item === 'string' ? item : item?.uuid;
    if (!isPropertyItemUuid(uuid)) return [];
    const library = readStored(runtime);
    return Object.hasOwn(library.assignments, uuid) ? copy(library.assignments[uuid]) : [];
};
export const saveItemPropertyRules = async (item, rules, runtime = {}) => {
    assertGm(runtime);
    const uuid = typeof item === 'string' ? item : item?.uuid;
    if (!isPropertyItemUuid(uuid)) throw new TypeError('Choose a saved item before approving properties.');
    const normalized = validateRules(rules);
    await editLibrary(library => {
        if (normalized.length) library.assignments[uuid] = normalized;
        else delete library.assignments[uuid];
    }, runtime);
    return getItemPropertyRules(uuid, runtime);
};

export const searchPropertyPresets = (query = '', category = 'all', runtime = {}, scope = 'character') => {
    normalizePropertyScope(scope);
    const needle = foldPropertySearch(query).trim();
    const words = needle.split(/\s+/u).filter(Boolean), library = getPropertyLibrary(runtime);
    return library.presets.filter(entry => {
        if (entry.scope !== scope) return false;
        if (category && category !== 'all' && category !== '*' && entry.category !== category) return false;
        const haystack = foldPropertySearch([entry.name, entry.category, entry.description, ...entry.aliases, ...entry.rules.map(rule => `${rule.name} ${rule.action} ${rule.trait} ${rule.stat} ${rule.skill} ${rule.status}`)].join(' '));
        return words.every(word => haystack.includes(word));
    }).sort((a, b) => Number(library.favorites.includes(b.id)) - Number(library.favorites.includes(a.id)) || a.name.localeCompare(b.name));
};
export const foldPropertySearch = value => String(value ?? '').toLocaleLowerCase('tr')
    .normalize('NFKD').replace(/[\u0300-\u036f]/gu,'').replace(/ı/gu,'i');

export const savePropertyPreset = async (raw, runtime = {}) => {
    assertGm(runtime);
    const existing = getPropertyLibrary(runtime).presets.find(entry => entry.id === raw?.id);
    const entry = normalizePropertyPreset(raw?.scope === undefined && existing ? {...raw, scope: existing.scope} : raw);
    await editLibrary(library => {
        const index = library.presets.findIndex(presetEntry => presetEntry.id === entry.id);
        if (index < 0) library.presets.push(entry); else library.presets[index] = entry;
        library.hiddenPresets = library.hiddenPresets.filter(id => id !== entry.id);
    }, runtime);
    return entry;
};
export const removePropertyPreset = async (id, runtime = {}) => {
    assertGm(runtime); assertId(id, 'preset ID');
    return editLibrary(library => {
        library.presets = library.presets.filter(entry => entry.id !== id);
        if (BUILTIN_PROPERTY_PRESETS.some(entry => entry.id === id)) library.hiddenPresets.push(id);
        library.favorites = library.favorites.filter(favorite => favorite !== id);
    }, runtime);
};
export const setPropertyFavorite = async (id, favorite = true, runtime = {}) => {
    assertGm(runtime); assertId(id, 'preset ID');
    return editLibrary(library => {
        if (!library.presets.some(entry => entry.id === id)) throw new TypeError('Preset not found.');
        library.favorites = library.favorites.filter(value => value !== id);
        if (favorite) library.favorites.push(id);
    }, runtime);
};
export const exportPropertyLibrary = (runtime = {}) => JSON.stringify(getPropertyLibrary(runtime), null, 2);
export const importPropertyLibrary = async (json, {replace = false} = {}, runtime = {}) => {
    assertGm(runtime);
    if (typeof json !== 'string' || json.length > 2000000) throw new TypeError('Import must be JSON text of at most 2 MB.');
    const imported = normalizePropertyLibrary(JSON.parse(json));
    if (replace) return savePropertyLibrary(imported, runtime);
    return editLibrary(library => {
        const merged = new Map(library.presets.map(entry => [entry.id, entry]));
        for (const entry of imported.presets) merged.set(entry.id, entry);
        library.presets = [...merged.values()];
        Object.assign(library.assignments, imported.assignments);
        library.favorites = [...new Set([...library.favorites, ...imported.favorites])];
        library.hiddenPresets = [...new Set([...library.hiddenPresets, ...imported.hiddenPresets])];
    }, runtime);
};
