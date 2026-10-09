## SWADE Tools 2.1.13 — Compact Controls & Configurable Shotgun Damage

New interface text remains English. **Experimental Unified RoF is still off
by default**; the GM enables it in SWADE Tools world settings for unified
RoF/Shotgun features. Back up the world and test between sessions first.

### Compact weapon controls

- Removed long AoE/Shotgun explanations in item Properties; checkboxes and gears remain.
- Separate **Damage Mod.** beside **Mod.**, available directly without Attack Options.
  Attack Mod affects attacks only; Damage Mod affects damage only, including
  native target damage, explicit damage actions and Benny rerolls.
- Shared right-hand vertical checkbox stack: Raise Damage, Recoil, The Drop,
  Ammunition. The Drop is available at every RoF and on AoE: +4 attack/+4 damage,
  without stacking on Benny or adding a second pool attack bonus.
- Removed the manual Vulnerable checkbox; automatic target detection remains.
- **Ammunition** starts checked on normal open. Unchecking does not spend ammo.
  AoE retains its configured Ammo/Item/None resource mode. Native/global ammo
  rules remain authoritative; no extra consumption is added.
- A fresh unified panel selects the weapon's own highest RoF: 3 opens at 3,
  4 at 4, 1 at 1. Optional Rapid Fire remains selectable, not auto-selected.
- Shift + left-click still restores the last submitted manual settings,
  including RoF, Damage Mod. and consumption. Raise/dynamic state is excluded.
- Internal damage-only automation dialogs retain their existing bridge.

### Shotgun damage by range

In **Properties → Enable Shotgun Rules → Shotgun Settings (gear)**, edit
separate Short/Medium/Long formulas for Shot and Slug.

- Defaults: Shot **3d6 / 2d6 / 1d6**, Slug **2d10 / 2d10 / 2d10**.
- Slug uses the Long formula at Extreme range; Shot cannot reach Extreme.
- Formulas and operator data references are validated before ammo; damage dice
  remain unrolled until damage is requested. Pools freeze the selected profile.
- Native Damage and Trait fields are never rewritten. Existing items need no migration.
- Shot +2, explicit preincluded-bonus control, Both Barrels restrictions and
  per-target range handling remain unchanged. Automatic Innocent Bystanders
  and simultaneous AoE+Shotgun damage profiles remain unsupported.

### Light RoF windows

Review Attack Pool, whole-pool Benny choice, target assignment and legacy setup
now use native Foundry light parchment styling. Global theme, attack results,
Benny rules and cancel-before-ammo behavior are unchanged.

### Verification and requirements

Foundry VTT 13 / SWADE 5.x. Sequencer is required for AoE placement; Automated
Animations integration remains verified against its 6.8.5 API.

Verification uses isolated mocked-Foundry gameplay and DOM tests plus headless
previews with installed Foundry styles. The user's live session was not accessed.
All 234 automated regression tests pass.
