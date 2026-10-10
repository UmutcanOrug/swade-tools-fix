## SWADE Tools 2.1.14 — Power Areas, GM Attack Corrections & Compact RoF Chat

All new interface text is English. Back up the world and update between sessions.

### Power AoE

- Powers now have **Properties → Enable AoE** and an adjacent settings gear.
- Choose Small/Medium/Large Blast, Small Cone, Cone or Stream. The native Power
  panel retains its casting Trait, Extra PP, Power Modifiers and Raise Damage.
- Casting places the area before the native activation roll; cancelling spends
  no PP and rolls no dice. Sequencer must be active for placement.
- Frozen area targets appear on native SWADE Tools cards without changing target
  rings. Click a successful target to roll native damage; the GM applies wounds.
- Power casting and Benny retain native PP bookkeeping. Damage-only area rolls
  and innate-power damage do not cast again or spend additional PP.
- GM correction of a failed Power activation settles only the remaining native
  PP cost before enabling target damage; critical failures cannot be overridden.
- Uses native SWADE rounded cone/stream geometry, not grenade scatter or weapon
  range bands. Automated Animations receives the actual placed template; no
  circular grenade fallback is forced on cone/stream powers.

### AoE attack cards

- GM **+** can adjust a grenade/weapon AoE attack from a separate GM client.
  A corrected successful target becomes clickable to roll native damage,
  including Raise damage. The correction itself never rolls/applies damage.
- Adjustments and target damage do not repeat ammunition, item use or animation.
  Critical failures/natural-one failures remain failures. Existing damage cards
  remain unchanged; a changed result can show a short GM review reminder.
- Scene-qualified targets are preserved; empty areas do not inherit selected
  targets, and hidden/missing tokens are not exposed by area recollection.

### RoF consistency and compact chat

- Pooled attacks now use the same nearest-grid-cell/elevation distance helper as
  native single shots, and honor the existing **Ignore Range** world setting.
- Regression checks cover **24/48/96 at distance 15** with RoF 3 and three targets,
  with and without Brawny: this is Short range, with no range penalty. Brawny
  continues to affect the Minimum Strength calculation, not weapon range.
- Compact RoF chat keeps the weapon header, usable dice and assigned targets
  visible; detailed modifiers, resource accounting and pool history are folded
  into **Details**. Attack/assignment/damage mechanics are unchanged.

Validated with automated native-adapter/geometry/chat/range regression tests
and a local UI preview. No live Foundry game was accessed or modified.

---

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
