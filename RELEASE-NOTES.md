## SWADE Tools 2.1.9 — Configurable AoE Attacks

- Generalized the grenade attack into a per-item AoE workflow for grenades,
  HE rounds, grenade launchers and vehicle-mounted weapons.
- Added English `Enable AoE` / `AoE` checkboxes, an `AoE Settings` button and
  an explosion shortcut in the inventory and item sheets.
- Save the attack skill (including custom Gunnery skills), blast size,
  damage action and ammunition options on the item.
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

For an AoE consumable's final charge, disable Destroy on Empty or use a
persistent weapon profile so the GM's damage item is not deleted before use.

Use Benny rerolls before the GM applies damage. If damage was already rolled
and the attack later gains a Raise or changes outcome, the attack card warns
the GM to review the existing damage; it is not silently rolled/applied again.

The release is covered by isolated native-DOM and gameplay regression tests.
It has not been tested inside the user's active Foundry session.
