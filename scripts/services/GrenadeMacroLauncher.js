// Backwards-compatible entry point for actions created by the grenade release.
export {
    default,
    launchAoeMacro as launchGrenadeMacro,
    isAoeItem
} from './AoeMacroLauncher.js';
export { isLegacyGrenadeItem as isGrenadeItem } from './AoeItemFlags.js';
