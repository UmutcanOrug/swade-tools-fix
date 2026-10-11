// Foundry expands dotted keys recursively when saving document updates. Token
// UUIDs therefore cannot be used verbatim as keys in a persisted flag map.
const targetUuid = /^Scene\.[^.]+\.Token\.[^.]+$/;
export const aoeTargetResultKey = uuid => encodeURIComponent(String(uuid)).replace(/\./g, '%2E');

export const getAoeTargetResult = (results, uuid) => {
    if (!results || typeof uuid !== 'string') return undefined;
    const saved = results[aoeTargetResultKey(uuid)] ?? results[uuid];
    if (saved !== undefined) return saved;
    // Read results already expanded by Foundry in 2.1.17 without re-rolling.
    return uuid.split('.').reduce((value, part) =>
        value && Object.hasOwn(value, part) ? value[part] : undefined, results);
};

export const withAoeTargetResult = (results, uuid, result) => {
    const safe = {};
    for (const key of Object.keys(results ?? {})) {
        let decoded;
        try { decoded = decodeURIComponent(key); } catch { continue; }
        if (targetUuid.test(decoded)) safe[aoeTargetResultKey(decoded)] =
            getAoeTargetResult(results, decoded);
    }
    for (const [sceneId, scene] of Object.entries(results?.Scene ?? {})) {
        for (const [tokenId, value] of Object.entries(scene?.Token ?? {})) {
            const legacyUuid = `Scene.${sceneId}.Token.${tokenId}`;
            if (targetUuid.test(legacyUuid)) safe[aoeTargetResultKey(legacyUuid)] ??= value;
        }
    }
    safe[aoeTargetResultKey(uuid)] = result;
    return safe;
};
