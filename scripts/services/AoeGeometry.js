/** Geometry-only AoE targeting. It never changes Foundry target rings. */
const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const EPSILON = 0.00001;

const tokenBounds = (token, gridSize) => {
    const document = token.document ?? token;
    const width = finite(token.w) ? Number(token.w) : finite(document.width) ? Number(document.width) * gridSize : 0;
    const height = finite(token.h) ? Number(token.h) : finite(document.height) ? Number(document.height) * gridSize : 0;
    const center = token.center ?? token.getCenterPoint?.();
    const x = finite(token.x) ? Number(token.x) : finite(document.x) ? Number(document.x)
        : finite(center?.x) ? Number(center.x) - width / 2 : NaN;
    const y = finite(token.y) ? Number(token.y) : finite(document.y) ? Number(document.y)
        : finite(center?.y) ? Number(center.y) - height / 2 : NaN;
    return {x, y, width, height};
};
const containsRectPoint = (rect, point) => point.x >= rect.x - EPSILON && point.x <= rect.x + rect.width + EPSILON &&
    point.y >= rect.y - EPSILON && point.y <= rect.y + rect.height + EPSILON;
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (a, b, point) => Math.abs(cross(a, b, point)) <= EPSILON &&
    point.x >= Math.min(a.x, b.x) - EPSILON && point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON && point.y <= Math.max(a.y, b.y) + EPSILON;
const intersects = (a, b, c, d) => {
    const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
    return (ac * ad < 0 && ca * cb < 0) || onSegment(a, b, c) || onSegment(a, b, d) ||
        onSegment(c, d, a) || onSegment(c, d, b);
};
const inPolygon = (point, polygon) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j], b = polygon[i];
        if (onSegment(a, b, point)) return true;
        if ((a.y > point.y) !== (b.y > point.y) &&
            point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
};
const polygonOverlapsRect = (polygon, rect) => {
    const corners = [{x: rect.x, y: rect.y}, {x: rect.x + rect.width, y: rect.y},
        {x: rect.x + rect.width, y: rect.y + rect.height}, {x: rect.x, y: rect.y + rect.height}];
    if (polygon.some(point => containsRectPoint(rect, point)) || corners.some(point => inPolygon(point, polygon))) return true;
    return polygon.some((point, i) => corners.some((corner, j) =>
        intersects(point, polygon[(i + 1) % polygon.length], corner, corners[(j + 1) % corners.length])));
};

/** Custom cones follow core flat/round and grid-template settings, not the SWADE rounded-cone preset. */
const getNativeCustomConeShape = template => {
    const document = template?.document ?? template;
    const flags = document?.flags?.['swade-tools'];
    if (document?.t !== 'cone' || flags?.templateType !== 'custom' || flags?.customShapeType !== 'cone' ||
        !(flags.powerAoeTemplate === true || flags.weaponAoeTemplate === true)) return null;
    const core = globalThis.foundry?.canvas?.placeables?.MeasuredTemplate;
    if (typeof core?.getConeShape === 'function') {
        try {
            // Read current document dimensions/direction instead of a possibly stale rendered object.
            return core.getConeShape(Number(document.distance), Number(document.direction ?? 0), Number(document.angle));
        } catch (error) {
            // Never substitute an approximate sector for a broken live scene/grid implementation.
            if (globalThis.canvas?.ready && globalThis.canvas?.scene) throw error;
            // Geometry-only fixtures and inactive canvases retain the deterministic fallback below.
        }
    }
    return template?.shape ?? document.object?.shape ?? null;
};

const nativeShapePoints = shape => {
    if (shape?.points?.length >= 6 && shape.points.length % 2 === 0) return shape.points;
    if (finite(shape?.radius) && Number(shape.radius) > 0) {
        return Array.from({length: 120}, (_, i) => {
            const radians = i * Math.PI / 60;
            return [Number(shape.x ?? 0) + Math.cos(radians) * Number(shape.radius),
                Number(shape.y ?? 0) + Math.sin(radians) * Number(shape.radius)];
        }).flat();
    }
    return null;
};

const circleOverlapsRect = (x, y, radius, rect) => {
    const closestX = Math.min(Math.max(x, rect.x), rect.x + rect.width);
    const closestY = Math.min(Math.max(y, rect.y), rect.y + rect.height);
    return radius >= 0 && Math.hypot(closestX - x, closestY - y) <= radius + EPSILON;
};

/** Reproduce SWADE 5.x's native rounded-cone polygon, including its 3° arc steps. */
export const getAoeTemplatePolygon = (template, {gridSize = 100, sceneDistance = 1} = {}) => {
    const document = template?.document ?? template;
    if (!document || !(gridSize > 0) || !(sceneDistance > 0)) return [];
    const origin = {x: Number(document.x), y: Number(document.y)};
    const customCone = getNativeCustomConeShape(template);
    const nativePoints = nativeShapePoints(customCone) ?? template?.shape?.points ?? document.object?.shape?.points;
    if (nativePoints?.length >= 6 && nativePoints.length % 2 === 0) {
        return Array.from({length: nativePoints.length / 2}, (_, i) =>
            ({x: origin.x + Number(nativePoints[i * 2]), y: origin.y + Number(nativePoints[i * 2 + 1])}));
    }
    const direction = Number(document.direction ?? 0) * Math.PI / 180;
    const length = Number(document.distance) / sceneDistance * gridSize;
    const transform = (x, y) => ({x: origin.x + x * Math.cos(direction) - y * Math.sin(direction),
        y: origin.y + x * Math.sin(direction) + y * Math.cos(direction)});
    if (!(length > 0) || !finite(origin.x) || !finite(origin.y)) return [];
    if (document.t === 'ray') {
        const halfWidth = Number(document.width ?? sceneDistance) / sceneDistance * gridSize / 2;
        return [[0, -halfWidth], [length, -halfWidth], [length, halfWidth], [0, halfWidth]].map(([x, y]) => transform(x, y));
    }
    if (document.t !== 'cone') return [];
    if (Number(document.angle ?? 0) === 0) {
        const radius = gridSize * Number(document.width ?? 3) / 2;
        const arcCenter = length - radius;
        return [transform(0, 0), ...Array.from({length: 61}, (_, i) => {
            const angle = (-90 + i * 3) * Math.PI / 180;
            return transform(arcCenter + Math.cos(angle) * radius, Math.sin(angle) * radius);
        })];
    }
    const angle = Math.min(360, Math.max(0, Number(document.angle)));
    const steps = Math.max(1, Math.ceil(angle / 3));
    return [transform(0, 0), ...Array.from({length: steps + 1}, (_, i) => {
        const radians = (-angle / 2 + angle * i / steps) * Math.PI / 180;
        return transform(Math.cos(radians) * length, Math.sin(radians) * length);
    })];
};

/** Any part of the occupied token rectangle under the native template is affected. */
export const tokenOverlapsAoeTemplate = (template, token, options = {}) => {
    const document = template?.document ?? template;
    const gridSize = Number(options.gridSize ?? 100), sceneDistance = Number(options.sceneDistance ?? 1);
    if (!document || !token || !(gridSize > 0) || !(sceneDistance > 0)) return false;
    const rect = tokenBounds(token, gridSize);
    if (!finite(rect.x) || !finite(rect.y)) return false;
    if (document.t === 'circle') {
        const radius = Number(document.distance) / sceneDistance * gridSize;
        return circleOverlapsRect(Number(document.x), Number(document.y), radius, rect);
    }
    const nativeCone = getNativeCustomConeShape(template);
    if (finite(nativeCone?.radius) && Number(nativeCone.radius) > 0) return circleOverlapsRect(
        Number(document.x) + Number(nativeCone.x ?? 0), Number(document.y) + Number(nativeCone.y ?? 0),
        Number(nativeCone.radius), rect);
    const polygon = getAoeTemplatePolygon(template, {gridSize, sceneDistance});
    return polygon.length >= 3 && polygonOverlapsRect(polygon, rect);
};

export const collectAoeTemplateTargets = (template, tokens, options = {}) => Array.from(tokens ?? []).filter(token => {
    if (!token?.actor || token.document?.hidden || token.visible === false || token.isVisible === false) return false;
    if (options.excludeSource && options.sourceTokenUuid && token.document?.uuid === options.sourceTokenUuid) return false;
    if (options.excludeSource && options.sourceTokenId && (token.id ?? token.document?.id) === options.sourceTokenId) return false;
    return tokenOverlapsAoeTemplate(template, token, options);
});
