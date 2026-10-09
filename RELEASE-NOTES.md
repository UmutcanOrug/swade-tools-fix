## SWADE Tools 2.1.11 — Compact AoE Cards & Automated Animations

- Compact item icon/name, skill status, one combined dice/result bar and target
  rows replace large headings and verbose default attack text.
- Only nonzero modifiers are visible. Range, blast, damage/AP and reroll history
  are in closed `Details`; important GM damage-review warnings stay visible.
- Benny rerolls post a fresh attack card and fade the previous one. They retain
  the same attack without another round, item, blast template or animation.
- Automated Animations support uses its official API, verified against 6.8.5.
  It receives the AoE item, source token, actual template and explicit target/hit
  arrays without changing the player's target rings.
- Scoped workflow guards prevent native resource use and independent damage
  cards from duplicating the attack animation. Unrelated AA workflows and
  persistent item animation flags are untouched.
- AA's disabled/unmatched behavior is respected. Without AA, the existing
  optional JB2A/Sequencer grenade or explosion effect remains.
- Optional animation failures never block attack or damage resolution.

### Animation setup

Configure the AoE item's Automated Animations entry as a Template animation
or a suitable template preset for an explosion at the placed blast area.
The item's custom AA settings and Auto Recognition are used; an unconfigured
or disabled AA item does not receive a hardcoded replacement animation.

### Existing AoE workflow retained

- Generalized the grenade attack into a per-item AoE workflow for grenades,
  HE rounds, grenade launchers and vehicle-mounted weapons.
- English `Enable AoE`, `AoE Settings` and explosion controls.
- Save blast size, damage action and ammunition options on the item.
- Vehicle attacks use the assigned gunner/operator's skill and Bennies while
  keeping the weapon, ammunition and firing position on the vehicle.
- Ammo consumption uses SWADE's resource API. A tank gun's quantity is never
  used as its shell count. Benny rerolls do not spend additional ammunition.
- Attacks resolve immediately. The chat card offers an optional Benny reroll;
  no `Use Result` confirmation is required.
- Blast targets are listed and passed directly to independent SWADE Tools
  damage cards, without changing the player's target rings.
- The damage-only bridge preserves normal SWADE Tools cards without prompting
  for a missing native Trait, and supports named gear/consumable damage actions.
- Extra operators confirm natural-1 critical failures with a non-acing d6,
  matching SWADE; prepared attack effects remain fixed across Benny rerolls.

### Requirements and limits

Foundry VTT 13 / SWADE 5.x. Sequencer is required for AoE placement; missing
JB2A animation assets do not block attack or damage resolution. Ranged ammo
consumption follows the SWADE ammunition-management setting. Set the mounted
weapon's crew member/operator before firing.

When using native consumable ammunition charges, disable Destroy on Empty or
use a persistent weapon profile for the final charge, so the GM's damage item
is not deleted before use. Consume Item retains a zero-quantity profile for
damage resolution rather than deleting it.

Use Benny rerolls before the GM applies damage. If damage was already rolled
and the attack later gains a Raise or changes outcome, the attack card warns
the GM to review the existing damage; it is not silently rolled/applied again.

The release is covered by isolated native-DOM and gameplay regression tests.
It has not been tested inside the user's active Foundry session.
