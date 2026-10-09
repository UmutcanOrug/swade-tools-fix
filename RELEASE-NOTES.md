## SWADE Tools 2.1.10 — Native-style AoE Attack Panel

- Clicking an AoE-enabled weapon's name opens its AoE panel in place of the
  ordinary SWADE Tools weapon dialog. The explosion shortcut opens the same panel.
- The panel opens every time; Shift-click is no longer needed. It uses the
  native SWADE Tools layout and situational modifiers.
- Removed the inventory-row AoE checkbox and settings gear. Enable AoE and
  its settings remain in item Properties; enabled inventory items show only
  the explosion shortcut.
- Skill names come directly from the weapon's normal Trait field. There is
  no AoE skill picker, and stale saved AoE skill overrides are ignored.
- Added mutually exclusive Consume Ammunition and Consume Item settings.
  Leave both off to spend nothing; Uses per Attack sets the quantity. A grenade
  can now explicitly spend its own inventory quantity instead of loaded ammo.

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
