// Keep an AoE shot's resource owner separate from its operator. In particular,
// a mounted gun's quantity is the number of guns, never its ammunition count.
const pendingResources = new Set();
const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
};
const optionalSetting = (key, fallback = false) => {
    try { return globalThis.game?.settings?.get('swade', key) ?? fallback; }
    catch { return fallback; }
};
const getFlag = (item, key) => item?.getFlag?.('swade-tools', key) ??
    item?.flags?.['swade-tools']?.[key];
const findAmmo = (item, owner) => {
    const name = String(item.system?.ammo ?? '').trim();
    if (!name) return null;
    return owner?.items?.getName?.(name) ??
        Array.from(owner?.items?.contents ?? owner?.items ?? []).find(ammo => ammo.name === name) ?? null;
};
const consumableAvailability = item => {
    const charges = item?.system?.charges?.default ?? item?.system?.charges;
    const quantity = number(item?.system?.quantity);
    const maximum = number(charges?.max);
    const current = number(charges?.value);
    return maximum > 0 ? Math.max(0, quantity - 1) * maximum + current : quantity;
};
const isHandThrown = (item, owner, options) => {
    if (owner?.type === 'vehicle' || item?.type !== 'weapon') return false;
    const category = String(item.system?.category ?? '');
    const trait = String(item.system?.actions?.trait ?? '').trim().toLowerCase();
    return options.legacyGrenade === true && (
        /throwable|thrown/i.test(category) || trait === 'athletics'
    );
};

export const describeAoeResource = (item, owner = item?.actor ?? item?.parent, options = {}) => {
    const requested = options.consume ?? getFlag(item, 'aoeConsume') ?? true;
    const cost = Math.max(1, Math.floor(number(options.cost ?? getFlag(item, 'aoeAmmoCost'), 1)));
    const base = { source: 'unmanaged', cost: 0, available: Infinity, managed: false,
        label: 'No ammunition is consumed', native: false, resource: item };
    if (!requested || !item) return base;

    if (item.type === 'consumable') {
        const charges = item.system?.charges?.default ?? item.system?.charges;
        const native = number(charges?.max) > 0 && typeof item.consume === 'function';
        return { ...base, source: native ? 'consumable' : 'quantity', cost, managed: true,
            available: native ? consumableAvailability(item) : number(item.system?.quantity),
            label: native ? 'Consumable charges' : 'Item quantity', native };
    }
    if (item.type === 'gear') {
        return { ...base, source: 'quantity', cost, managed: true,
            available: number(item.system?.quantity), label: 'Item quantity' };
    }
    if (item.type !== 'weapon') return base;

    const reload = String(item.system?.reloadType ?? '').toLowerCase();
    const ammoManagement = options.ammoManagement ?? optionalSetting('ammoManagement');
    // Older worlds often model a thrown grenade with a zero-shot weapon
    // profile. Retain its quantity-based use, but never apply that fallback to
    // a mounted grenade launcher or tank cannon.
    if (isHandThrown(item, owner, options) && (reload !== 'self' || !ammoManagement)) {
        return { ...base, source: 'quantity', cost, managed: true,
            available: number(item.system?.quantity), label: 'Thrown item quantity' };
    }
    if (!ammoManagement) {
        return { ...base, label: 'SWADE ammunition management is disabled' };
    }
    const native = typeof item.consume === 'function' && typeof item.canExpendResources === 'function';
    if (reload === 'self') {
        return { ...base, source: 'self', cost, managed: true, native,
            available: number(item.system?.shots) * Math.max(0, number(item.system?.quantity) - 1) + number(item.system?.currentShots),
            label: 'Self-consuming weapon uses' };
    }
    const usesInventory = Boolean(item.usesAmmoFromInventory ?? item.system?.usesAmmoFromInventory);
    if (reload === 'none') {
        if (!usesInventory) return { ...base, source: 'unlimited', label: 'Unlimited ammunition' };
        const ammo = findAmmo(item, owner);
        return { ...base, source: 'inventory', cost, managed: true, native, resource: ammo ?? item,
            available: ammo?.type === 'consumable' ? consumableAvailability(ammo) : number(ammo?.system?.quantity),
            label: ammo ? `${ammo.name} ammunition` : 'Linked ammunition is missing' };
    }
    return { ...base, source: 'magazine', cost, managed: true, native,
        available: number(item.system?.currentShots), label: 'Loaded ammunition' };
};

export const validateAoeResources = (item, owner = item?.actor ?? item?.parent, options = {}) => {
    const plan = describeAoeResource(item, owner, options);
    if (!plan.managed) return { ...plan, ok: true, consumed: 0 };
    if (item.isOwner === false || owner?.isOwner === false) {
        return { ...plan, ok: false, consumed: 0, reason: 'permission' };
    }
    if (plan.available < plan.cost) {
        return { ...plan, ok: false, consumed: 0, reason: 'insufficient' };
    }
    if (plan.source === 'quantity') {
        return { ...plan, ok: typeof item.update === 'function', consumed: 0,
            reason: typeof item.update === 'function' ? undefined : 'unsupported' };
    }
    if (!plan.native) return { ...plan, ok: false, consumed: 0, reason: 'unsupported' };
    try {
        if (typeof item.canExpendResources === 'function' && item.canExpendResources(plan.cost) === false) {
            return { ...plan, ok: false, consumed: 0, reason: 'insufficient' };
        }
    } catch {
        return { ...plan, ok: false, consumed: 0, reason: 'unsupported' };
    }
    return { ...plan, ok: true, consumed: 0 };
};

export const commitAoeResources = async (item, owner = item?.actor ?? item?.parent, options = {}) => {
    const validation = validateAoeResources(item, owner, options);
    if (!validation.ok || !validation.managed) return validation;
    const key = validation.resource?.uuid ?? validation.resource?.id ?? item.uuid ?? item.id;
    if (pendingResources.has(key)) return { ...validation, ok: false, reason: 'busy' };
    pendingResources.add(key);
    try {
        const current = validateAoeResources(item, owner, options);
        if (!current.ok) return current;
        if (current.source === 'quantity') {
            await item.update({ 'system.quantity': current.available - current.cost });
        } else {
            // SWADE handles currentShots, reload procedure and linked ammo.
            // Its consume() resolves void; it must not be compared with true.
            await item.consume(current.cost);
        }
        return { ...current, consumed: current.cost };
    } catch (error) {
        console.error('SWADE Tools | AoE ammunition consumption failed', error);
        return { ...validation, ok: false, consumed: 0, reason: 'update-failed' };
    } finally {
        pendingResources.delete(key);
    }
};

export const aoeResource = Object.freeze({
    describe: describeAoeResource,
    validate: validateAoeResources,
    spend: commitAoeResources,
});
export default aoeResource;
