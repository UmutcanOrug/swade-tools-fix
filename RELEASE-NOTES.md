## SWADE Tools 2.1.17 — Cone Weapons, Optional Evade & Burning

All new interface text is English. Back up the world and update between sessions.
Reload every connected client, including the GM. Existing items retain their
previous blast behavior; Automatic Evade and Enable Fire are opt-in.

### Flamethrower setup

On the weapon's Properties tab, enable AoE and open its gear button. Set
**Template Shape → Cone Template**, **Template Origin → Firing Token**, and
enable **Automatic Evade** and **Enable Fire** as desired. Keep Shooting (or your
custom skill) in the native Trait field. Set native damage, Heavy Weapon, ammo
and minimum Strength on the item normally; a standard flamethrower uses 3d6.
Initial Fire Damage and Maximum Fire Damage are separate d6 counts, default 3.

- Weapons now support Cone, Small Cone and Stream, with token-anchored aiming
  or free placement. Free templates rotate with the mouse wheel; Shift uses
  larger steps. Confirmation aborts if the firing token moved during preview.
- Partially covered weapon targets count, using native SWADE rounded-cone
  geometry. Token-origin cones exclude their source. The native range label
  `Cone Template` does not acquire invented Short/Medium/Long penalties.
- Failed cones and streams have no target effect: no damage and no blast
  deviation button. Benny or GM attack corrections remain available. Successful
  attacks use the existing independent native SWADE Tools target damage cards.
- Automatic Evade is available to every AoE weapon, defaults to Agility -2,
  includes native attribute penalties and Improved Dodge, and is resolved once
  per affected target. Evaded targets cannot receive attack damage or ignition.
  Compact defense cards allow GM Hit/Evaded adjudication; the GM moves evading
  tokens manually. Missing Agility requires GM adjudication, not an invented die.
- An active GM is required for automated Evade and fire. One elected GM runs
  them, including when viewing a different scene. Missing GM/context holds the
  defense safely rather than silently treating the target as hit.
- Enable Fire requests the GM's flammability decision on an affected target:
  Not Flammable, Flammable (6), Very Flammable (4–6), or Volatile (2–6). Remember
  the actor's setting for future hits if desired; compact Flammability controls
  can change it later. Ignition uses a plain d6 and causes immediate fire damage.
- A persistent Burning effect rolls current fire damage at the start of the
  victim's combat turn, then a plain d6: 6 raises intensity to the configured
  maximum; 1 lowers it or extinguishes fire below 1d6. Other results continue.
  Fire damage can Ace. Compact cards provide Adjust Fire and Extinguish controls.
- Fire damage totals are reported, not automatically applied as wounds. Armor
  applies normally and the GM applies the damage manually. No inventory hazard
  items are created. Existing effects and normal weapon workflows are unchanged.
- Defense/ignition results survive Benny replacement cards; ammo and fire checks
  are not repeated. Turn replay, multiple GM clients and simultaneous targets
  have duplicate guards. Whisper/blind visibility is preserved for defense/fire.
- Existing RoF AoE weapons continue to work, and directional RoF placement keeps
  its signed direction without requiring numeric blast-weapon ranges.

Validated with 398 automated tests, local independent-client/geometry checks,
the installed Foundry V13 server HTML sanitizer, and 320 px chat-card previews.
The live Foundry game was not accessed or modified. Evade reference:
[Pinnacle's SWADE conversion guide](https://s3-us-west-2.amazonaws.com/peg-swade/SWEX_to_SWADE.pdf).

---

## SWADE Tools 2.1.16 — GM Chat Deviation Resolution

All new interface text is English. Back up the world and update between sessions.
Reload every connected client. Includes the 2.1.15 GM correction fix and Power
**Template Origin → Place Freely** setting described below.

- The player still chooses the intended blast area and rolls the attack normally.
  A failed attack holds damage, leaving skill Benny rerolls and GM **+** available.
- Failed grenade / weapon AoE cards now offer a GM-only **Resolve Deviation**
  button. The GM clicks it, places the actual blast area, and left-clicks to
  confirm. Right-click cancels without moving the template or rolling damage.
  Deviation direction and distance are GM rulings, not automatic scatter dice.
- Confirmation moves the existing template, recalculates visible area targets
  and rolls one native SWADE Tools damage card per target. A failed attack stays
  failed; affected targets read **Blast**, not Hit/Raise. The GM applies wounds.
- No extra ammunition/item is consumed, no attack is repeated, no target rings
  change and the original animation is not replayed. Empty areas never inherit
  the player's selected targets. Critical/natural-one failures do not gain Raise
  damage just because their actual blast location was resolved.
- GM chat placement works from a separate client, without depending on the
  original firing player's live macro. Native template-drag resolution remains
  GM-only while that original macro session is active.
- Resolved blast location and targets survive fresh Benny cards. Later Benny or
  GM corrections never move a resolved blast back or automatically repeat its
  damage; changed results show a compact GM review reminder.
- Cross-client transaction guards prevent simultaneous Benny, GM correction or
  target clicks from duplicating the automatic damage workflow. Obsolete cards,
  cancelled placement, unavailable context and scene changes abort safely.

Validated with 327 automated tests, independent-client race regressions, the
installed Foundry V13 server HTML sanitizer, and a local compact-card preview.
No live Foundry game was accessed or modified.

---

## SWADE Tools 2.1.15 — Reliable AoE GM Corrections & Free Power Origins

All new interface text is English. Back up the world and update between sessions.
Reload every connected client after updating.

### Grenade / weapon AoE GM corrections

- Fixes the card showing **Success / 4** while its target remained **Miss** after
  GM **+4**. Foundry removes HTML comments when saving chat messages; updates now
  use persistent element regions instead of comment delimiters.
- Total, Hit/Raise/Miss rows, clickable native damage and the deviation reminder
  stay synchronized, including on already-saved 2.1.14 cards. On an old stuck
  card, the GM can reopen **+** and reapply the same modifier after reloading;
  it replaces the previous GM value rather than stacking or spending resources.
- Correcting an attack does not throw again, spend ammunition/items, replay
  animation, roll damage automatically or apply wounds. Click the successful
  target to roll native damage. Existing critical-failure safeguards remain.
- Flat and expanded template-update flags both suppress the stale deviation
  handler while a GM correction is being synchronized.

### Power template origins

- Power **Properties → Enable AoE → settings gear → Template Origin** adds
  **Casting Token** (the existing default) and **Place Freely**.
- **Place Freely** lets Cone, Small Cone and Stream originate away from the
  caster. Blast circles already allow free placement and remain unchanged.
- During free directional placement, use the **mouse wheel** to rotate 5°;
  **Shift + wheel** rotates 15° on square grids or 30° on hex grids. Left-click
  confirms and right-click cancels. This does not take over the middle button.
- Numeric Power range is checked from the caster to the chosen origin. Native
  shape dimensions, target geometry, PP bookkeeping and target-ring selection
  are preserved. A caster inside a freely placed area is not automatically
  excluded. Temporary rotation controls are removed on success, cancel or error.

Validated with 306 automated regression tests, the installed Foundry V13 server
HTML sanitizer, and a local compact-card browser preview. No live Foundry game
was accessed or modified.

---

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
