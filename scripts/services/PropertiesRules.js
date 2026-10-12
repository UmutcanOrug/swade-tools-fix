// Declarative, opt-in rules. Only the GM-owned world library is authoritative;
// item flags are deliberately not consulted by the combat evaluator.
const SCOPE = 'swade-tools';
export const PROPERTY_VERSION = 1;
export const PROPERTY_TRIGGERS = Object.freeze(['passive', 'hit', 'raise', 'damageApplied', 'wound']);
export const PROPERTY_TRAITS = Object.freeze(['agility', 'smarts', 'spirit', 'strength', 'vigor']);
export const PROPERTY_STATS = Object.freeze(['toughness', 'armor', 'parry', 'pace', 'running', 'attack', 'damage', 'ap']);
export const PROPERTY_ACTIONS = Object.freeze(Object.fromEntries([
    ['attackMod', 'Attack Modifier', 'passive', -20, 20],
    ['damageMod', 'Damage Modifier', 'passive', -20, 20],
    ['incomingRanged', 'Incoming Ranged Attack', 'passive', -20, 20],
    ['incomingMelee', 'Incoming Melee Attack', 'passive', -20, 20],
    ['cover', 'Cover / Ranged Avoidance', 'passive', -10, 0],
    ['soakMod', 'Soak Modifier', 'passive', -20, 20],
    ['minStrengthSteps', 'Minimum Strength Die Steps', 'passive', -5, 5],
    ['gangupIgnore', 'Ignore Gang-Up', 'passive', 0, 20],
    ['status', 'Apply Condition', 'effect', 1, 1],
    ['traitModifier', 'Attribute Roll Modifier', 'effect', -20, 20],
    ['traitSteps', 'Attribute Die Steps', 'effect', -5, 5],
    ['skillModifier', 'Skill Roll Modifier', 'effect', -20, 20],
    ['statModifier', 'Statistic Modifier', 'effect', -20, 20]
].map(([id, label, kind, valueMin, valueMax]) => [id, Object.freeze({id, label, kind, valueMin, valueMax})])));

const RULE_KEYS = new Set(['version', 'id', 'name', 'enabled', 'trigger', 'action', 'target', 'value', 'trait', 'skill', 'stat', 'status', 'duration', 'stack', 'group', 'frequency', 'conditions', 'resist']);
const PASSIVE_ACTIONS = Object.keys(PROPERTY_ACTIONS).filter(action => PROPERTY_ACTIONS[action].kind === 'passive');
const OUTGOING = new Set(['attackMod', 'damageMod', 'minStrengthSteps']);
const DEFENSIVE = new Set(['incomingRanged', 'incomingMelee', 'cover', 'soakMod', 'gangupIgnore']);
const ITEM_UUID = /^(?:Actor\.[\w-]+\.Item\.[\w-]+|Scene\.[\w-]+\.Token\.[\w-]+(?:\.Actor\.[\w-]+)?\.Item\.[\w-]+|Item\.[\w-]+|Compendium\.[\w-]+\.[\w-]+(?:\.Item)?\.[\w-]+)$/;
export const isPropertyItemUuid = value => typeof value === 'string' && value.length <= 240 && ITEM_UUID.test(value);

const plain = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object.`);
    return value;
};
const keys = (value, allowed, label, strict) => {
    if (strict) for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label}: unsupported field ${key}.`);
};
const text = (value, fallback, max, label) => {
    const result = value === undefined ? fallback : value;
    if (typeof result !== 'string' || result.length > max || /[\u0000-\u001f]/u.test(result)) throw new TypeError(`${label} must be text of at most ${max} characters.`);
    return result.trim();
};
const number = (value, fallback, min, max, label) => {
    const result = value === undefined ? fallback : value;
    if (typeof result !== 'number' || !Number.isFinite(result) || !Number.isInteger(result) || result < min || result > max) throw new TypeError(`${label} must be an integer from ${min} to ${max}.`);
    return result;
};
const choice = (value, fallback, options, label) => {
    const result = value === undefined ? fallback : value;
    if (!options.includes(result)) throw new TypeError(`${label}: unsupported value ${result}.`);
    return result;
};
const bool = (value, fallback, label) => {
    if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${label} must be true or false.`);
    return value ?? fallback;
};
const identifier = (value, fallback, label) => {
    const result = text(value, fallback, 80, label);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(result)) throw new TypeError(`${label} must use letters, digits, dots, colons, hyphens or underscores.`);
    return result;
};
let nextRuleId = 0;
const newId = () => `rule-${Date.now().toString(36)}-${(++nextRuleId).toString(36)}`;

export const normalizeRule = (raw, {strict = true} = {}) => {
    plain(raw, 'Property'); keys(raw, RULE_KEYS, 'Property', strict);
    if (raw.version !== undefined && raw.version !== PROPERTY_VERSION) throw new TypeError('Unsupported property version.');
    const action = choice(raw.action, 'attackMod', Object.keys(PROPERTY_ACTIONS), 'Action');
    const effect = PROPERTY_ACTIONS[action].kind === 'effect';
    const trigger = choice(raw.trigger, effect ? 'hit' : 'passive', PROPERTY_TRIGGERS, 'Trigger');
    if (!effect && trigger !== 'passive') throw new TypeError('Numeric passive properties require the passive trigger.');
    const id = identifier(raw.id, newId(), 'Property ID');
    const conditionsRaw = plain(raw.conditions ?? {}, 'Conditions');
    keys(conditionsRaw, new Set(['attackType', 'weaponType', 'minRange', 'maxRange']), 'Conditions', strict);
    const conditions = {
        attackType: choice(conditionsRaw.attackType, 'any', ['any', 'ranged', 'melee'], 'Attack Type'),
        weaponType: choice(conditionsRaw.weaponType, 'any', ['any', 'weapon', 'power'], 'Item Type')
    };
    for (const bound of ['minRange', 'maxRange']) {
        const value = conditionsRaw[bound];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) throw new TypeError('Range bounds must be finite non-negative numbers.');
        conditions[bound] = value;
    }
    if (conditions.minRange !== undefined && conditions.maxRange !== undefined && conditions.minRange > conditions.maxRange) throw new TypeError('Minimum range cannot exceed maximum range.');
    const durationRaw = plain(raw.duration ?? {}, 'Duration');
    keys(durationRaw, new Set(['rounds', 'expiry']), 'Duration', strict);
    if (trigger === 'passive' && durationRaw.rounds !== undefined && durationRaw.rounds !== 0) throw new TypeError('Passive properties last while their source is active; timed duration requires a triggered effect.');
    const resistRaw = plain(raw.resist ?? {}, 'Resistance');
    keys(resistRaw, new Set(['enabled', 'trait', 'modifier', 'tn']), 'Resistance', strict);
    const trait = choice(raw.trait, 'vigor', PROPERTY_TRAITS, 'Attribute');
    const skill = text(raw.skill, '', 100, 'Skill');
    // Native @Skill{...} adapters use brackets as syntax, not literal names.
    if (/[{}\[\]@<>]/u.test(skill)) throw new TypeError('Skill names cannot contain native adapter syntax.');
    const stat = choice(raw.stat, 'toughness', PROPERTY_STATS, 'Statistic');
    const status = text(raw.status, '', 80, 'Condition');
    if (status && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(status)) throw new TypeError('Invalid condition identifier.');
    if (action === 'status' && !status) throw new TypeError('Choose a condition for this property.');
    if (action === 'skillModifier' && !skill) throw new TypeError('Choose a skill for this property.');
    const target = choice(raw.target, effect && trigger !== 'passive' ? 'target' : 'self', ['self', 'target'], 'Target');
    if (trigger === 'passive' && target !== 'self') throw new TypeError('Passive properties must target their bearer.');
    if (effect && trigger === 'passive' && (conditions.attackType !== 'any' || conditions.weaponType !== 'any' || conditions.minRange !== undefined || conditions.maxRange !== undefined || resistRaw.enabled === true)) throw new TypeError('Passive native effects cannot depend on an attack context or resistance.');
    return {
        version: PROPERTY_VERSION, id, name: text(raw.name, PROPERTY_ACTIONS[action].label, 100, 'Name'),
        enabled: bool(raw.enabled, true, 'Enabled'), trigger, action,
        target,
        value: number(raw.value, action === 'status' ? 1 : 0, PROPERTY_ACTIONS[action].valueMin, PROPERTY_ACTIONS[action].valueMax, 'Value'),
        trait, skill, stat, status,
        duration: {rounds: number(durationRaw.rounds, 0, 0, 100, 'Rounds'), expiry: choice(durationRaw.expiry, 'turnEnd', ['turnStart', 'turnEnd'], 'Expiry')},
        stack: choice(raw.stack, 'sum', ['sum', 'best', 'unique', 'refresh'], 'Stacking'),
        group: identifier(raw.group, `${action}:${id}`, 'Stacking Group'),
        frequency: choice(raw.frequency, 'target', ['attack', 'target', 'hit'], 'Frequency'),
        conditions,
        resist: {
            enabled: bool(resistRaw.enabled, false, 'Resistance Enabled'),
            trait: choice(resistRaw.trait, 'vigor', PROPERTY_TRAITS, 'Resistance Attribute'),
            modifier: number(resistRaw.modifier, 0, -20, 20, 'Resistance Modifier'),
            tn: number(resistRaw.tn, 4, 1, 20, 'Resistance TN')
        }
    };
};

export const validateRules = rules => {
    if (!Array.isArray(rules) || rules.length > 100) throw new TypeError('Properties must be an array with at most 100 entries.');
    const result = rules.map(rule => normalizeRule(rule));
    const ids = new Set();
    for (const rule of result) {
        if (ids.has(rule.id)) throw new TypeError(`Duplicate property ID: ${rule.id}.`);
        ids.add(rule.id);
    }
    return result;
};

export const isPropertiesEnabled = (runtime = {}) => {
    try { return (runtime.game ?? globalThis.game)?.settings?.get(SCOPE, 'propertiesEnabled') === true; }
    catch { return false; }
};

const getAssignments = runtime => {
    try {
        const library = (runtime.game ?? globalThis.game)?.settings?.get(SCOPE, 'propertiesLibrary');
        if (library?.version !== PROPERTY_VERSION || !library.assignments || typeof library.assignments !== 'object' || Array.isArray(library.assignments)) return {};
        return library.assignments;
    } catch { return {}; }
};
const itemsOf = actor => Array.isArray(actor?.items) ? actor.items : Array.from(actor?.items?.values?.() ?? actor?.items ?? []);
const equipped = item => item?.isReadied === true || Number(item?.system?.equipStatus) === 3;
const actorFrom = target => target?.actor ?? target?.document?.actor ?? target;

export const collectPropertyRules = (actor, item, runtime = {}) => {
    if (!isPropertiesEnabled(runtime)) return [];
    const assignments = getAssignments(runtime), result = [], seen = new Set();
    const sourceItems = [...itemsOf(actor), ...(item ? [item] : [])];
    for (const source of sourceItems) {
        if (!isPropertyItemUuid(source?.uuid) || seen.has(source.uuid) || source.disabled === true || source.isSuppressed === true || source.system?.disabled === true) continue;
        seen.add(source.uuid);
        if (!Object.hasOwn(assignments, source.uuid)) continue;
        let rules;
        try { rules = validateRules(assignments[source.uuid]); } catch { continue; }
        const current = source.uuid === item?.uuid;
        const physical = ['weapon', 'armor', 'shield', 'gear'].includes(source.type);
        if (!current && physical && !equipped(source)) continue;
        if (!current && source.type === 'power') continue;
        for (const rule of rules) {
            // Edge/ability/armor attachments may intentionally trigger when
            // their bearer attacks. A different weapon's on-hit attachment
            // belongs to that weapon alone.
            if (!current && source.type === 'weapon' && rule.trigger !== 'passive') continue;
            // A second equipped weapon may defend its bearer, but its offensive
            // attachment must not improve an unrelated weapon or power.
            if (!current && source.type === 'weapon' && !DEFENSIVE.has(rule.action) && PROPERTY_ACTIONS[rule.action].kind !== 'effect') continue;
            result.push({...rule, sourceUuid: source.uuid, sourceName: source.name ?? 'Property', sourceType: source.type ?? ''});
        }
    }
    return result;
};

export const getPropertyConditionResult = (rule, context = {}) => {
    if (context.isAoe || context.isAoE || context.aoe || context.attackType === 'aoe') return {matches: false, reason: 'AoE remains on its existing rules pipeline.'};
    if (rule.enabled === false) return {matches: false, reason: 'Property disabled.'};
    const conditions = rule.conditions ?? {};
    if (conditions.attackType && conditions.attackType !== 'any' && conditions.attackType !== context.attackType) return {matches: false, reason: 'Different attack type.'};
    const itemType = context.item?.type ?? context.weaponType;
    if (conditions.weaponType && conditions.weaponType !== 'any' && conditions.weaponType !== itemType) return {matches: false, reason: 'Different item type.'};
    if (conditions.minRange !== undefined || conditions.maxRange !== undefined) {
        if (!Number.isFinite(context.range)) return {matches: false, reason: 'Target range is unavailable.'};
        if (conditions.minRange !== undefined && context.range < conditions.minRange) return {matches: false, reason: 'Below minimum range.'};
        if (conditions.maxRange !== undefined && context.range > conditions.maxRange) return {matches: false, reason: 'Beyond maximum range.'};
    }
    return {matches: true, reason: 'Conditions matched.'};
};

export const evaluatePropertyModifiers = (context = {}, runtime = {}) => {
    const enabled = isPropertiesEnabled(runtime) && !(context.isAoe || context.isAoE || context.aoe || context.attackType === 'aoe');
    const totals = Object.fromEntries(PASSIVE_ACTIONS.map(action => [action, 0]));
    const contributions = [];
    if (!enabled) return {enabled: false, totals, contributions, applied: [], ignored: []};
    const outgoing = collectPropertyRules(context.actor, context.item, runtime);
    const defensiveActor = actorFrom(context.target) ?? context.actor;
    const defensive = context.target ? collectPropertyRules(defensiveActor, null, runtime) : outgoing;
    const candidates = [...outgoing.filter(rule => OUTGOING.has(rule.action) || PROPERTY_ACTIONS[rule.action].kind === 'effect'), ...defensive.filter(rule => DEFENSIVE.has(rule.action))];
    const groups = new Map();
    for (const rule of candidates) {
        const entry = {...rule, applied: false, reason: ''};
        contributions.push(entry);
        // Integration-only semantic bridge. This callback is never loaded
        // from declarative data; it prevents native rules already included by
        // an existing calculator from winning a best-only family twice.
        const ignoredReason = runtime.ignorePropertyRule?.(rule, context);
        if (ignoredReason) { entry.reason = String(ignoredReason); continue; }
        if (rule.trigger !== 'passive') { entry.reason = `Triggered effect: ${rule.trigger}; preview does not execute effects.`; continue; }
        if (PROPERTY_ACTIONS[rule.action].kind === 'effect') { entry.reason = 'Managed as a native passive effect; not added again to attack totals.'; continue; }
        const condition = getPropertyConditionResult(rule, context);
        if (!condition.matches) { entry.reason = condition.reason; continue; }
        if ((rule.action === 'incomingRanged' || rule.action === 'cover') && context.attackType !== 'ranged') { entry.reason = 'Requires a ranged attack.'; continue; }
        if (rule.action === 'incomingMelee' && context.attackType !== 'melee') { entry.reason = 'Requires a melee attack.'; continue; }
        const key = `${rule.action}|${rule.group}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    }
    for (const entries of groups.values()) {
        const strongest = [...entries].sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.value - b.value || `${a.sourceUuid}:${a.id}`.localeCompare(`${b.sourceUuid}:${b.id}`));
        const mode = entries.some(rule => rule.stack === 'best') ? 'best' : entries.some(rule => ['unique', 'refresh'].includes(rule.stack)) ? 'unique' : 'sum';
        const winners = mode === 'sum' ? entries : [strongest[0]];
        for (const entry of entries) {
            entry.applied = winners.includes(entry);
            entry.reason = entry.applied ? (mode === 'sum' ? 'Added.' : `Strongest in ${entry.group}.`) : `Not stacked: ${entry.group}.`;
            if (entry.applied) totals[entry.action] += entry.value;
        }
    }
    return {enabled: true, totals, contributions, applied: contributions.filter(rule => rule.applied), ignored: contributions.filter(rule => !rule.applied)};
};
