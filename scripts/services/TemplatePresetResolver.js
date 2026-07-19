const SWADE_TEMPLATE_PRESETS=Object.freeze({
    small: 'sbt',
    medium: 'mbt',
    large: 'lbt',
    cone: 'swcone',
    stream: 'stream',
    sbt: 'sbt',
    mbt: 'mbt',
    lbt: 'lbt',
    swcone: 'swcone',
    swscone: 'swscone'
});

export function toSwadeTemplatePreset(type) {
    return SWADE_TEMPLATE_PRESETS[type] ?? type;
}

export {SWADE_TEMPLATE_PRESETS};
