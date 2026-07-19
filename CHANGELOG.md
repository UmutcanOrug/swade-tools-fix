# Changelog

## 2.2.0-beta.2

- Replaced the separate built-in RoF mode buttons in the SWADE Tools weapon
  dialog with one `RoF` button.
- The new button finds the SWADE RoF Attack Pool macro in the current world
  and launches it with the open weapon, owning actor and selected token.
- Added clear warnings for a missing owner token or missing RoF macro.

## 2.2.0

- Preserved the native SWADE actor sheet and added non-destructive module
  controls.
- Added SWADE-native message bridging for target and damage automation.
- Added explicit RoF 1–6 attack modes and correct standard ammunition costs.
- Delegated weapon resource validation, consumption and reload to the SWADE
  item APIs.
- Fixed SWADE 5 macro-action arguments and current Resist action field names.
- Added item resolution profiles for template targeting, area defense,
  opposed rolls and thrown templates/grenades.
- Added configurable Edge/Hindrance/Ability attack modifier rules through
  `swadeCalculateDefaultAttackMods`.
- Reworked template automation so Athletics TN 4 is opt-in rather than being
  forced on every template.
- Added target-specific damage/Soak contexts for multi-target rolls.
- Removed direct `eval` use from modifier parsing.
- Added Turkish localization and usage documentation.
- Added initial Node tests for RoF costs and weapon resource consumption.
- Fixed native SWADE template preset IDs (`sbt`, `mbt`, `lbt`, `swcone`) and
  prevented native template buttons from bypassing activation rolls.
- Split ammunition preflight and commit so failed or cancelled custom rolls
  spend no ammunition; added native RoF action cost normalization.
- Added automatic Power Point transactions, No Power Points activation
  penalties and idempotent PP handling.
- Added GM-authoritative socket requests for defense rolls on unowned targets.
- Added a repeat-last-weapon-attack control with UUID-based target restoration.
- Added type-aware gear/consumable validation and template workflow states.
- Added combined linked damage item/action selection and resource quantity.
- Added loaded-ammunition damage modifiers for magazine, battery and loose-ammo
  items in both native and SWADE Tools damage rolls.
- Snapshotted the loaded-ammunition damage profile on the attack message so a
  later reload cannot change that attack's damage.
- Routed deviation confirmation through one scene GM and handled mixed
  melee/ranged weapons without consuming ammunition for their melee attack.
- Expanded tests for attack-die extraction, Power Points and template presets.
