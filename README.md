# SWADE Tools

## Compatibility 
SWADE Tools v2 is only compatible with with Foundry v13 and SWADE system v5

## Last settings and experimental unified RoF (2.1.12)

Normal weapon clicks open a clean panel. **Shift + left-click** on its name,
image or AoE explosion icon restores the last submitted manual values without
firing. Session-only memory is separated by user, weapon owner, scene-qualified
source token, item and operator. Refresh clears it. Raise Damage, targets,
wounds, fatigue, range results and ammunition counts are never remembered.

The GM can enable **Experimental Unified RoF** in SWADE Tools world settings.
It is **off by default**; leaving it off preserves the previous panels.
When enabled, the normal compact weapon panel has a RoF selector, Recoil and
closed Attack Options. RoF 1 uses native single fire; RoF 2+ keeps the existing
whole-pool Benny review and target assignment, without a second setup window.
Rapid Fire extends the selector for Shooting only. Additional action buttons
retain their native behavior. Turning the setting off restores the old panels.

### Opt-in Shotgun Rules

In weapon Properties, enable **Enable Shotgun Rules** and open its gear.
The experimental world setting above must also be enabled. Set the native
Trait, Short/Medium/Long ranges and ammunition fields first.

- Shot adds +2 attack and uses 3d6/2d6/1d6 at Short/Medium/Long, with no Extreme.
- Slug uses 2d10 without the Shot bonus and supports Extreme range.
- If Trait Modifier already includes +2 Shot, explicitly enable **Shot +2
  already included in Trait Modifier** to prevent duplicate bonuses.
- Enable **Double-barrel weapon** only when appropriate. Supported Both Barrels
  is one Shot attack, one target, RoF 1, +4 damage and two shells; it is not RoF 2.
- Single-fire Shotgun requires exactly one target. Pools support multiple
  recipients and use each target's range for native damage.

Native item Damage and Trait Modifier are never rewritten. Both Barrels with
Slug, automatic Innocent Bystanders and special shell profiles are not included.

### AoE + RoF

Enable AoE on a ranged weapon such as a grenade launcher and set its native
Trait, including Gunnery. Its name/image and explosion icon open the same
unified panel. At RoF 2+, review/Benny the pool, then place a blast per usable
result. Canceling **any** placement aborts the whole volley before ammunition,
templates or damage. Already-spent Bennies are not refunded.

RoF 2+ spends the configured Ammo/Item resource once using the standard table:
RoF 2/3/4/5/6 costs 5/10/20/40/50 uses. Single AoE retains saved Uses per Attack.
Each projectile reuses its pool die and common modifier, adds its blast point's
range once, and resolves independent damage and animation. No individual
projectile Benny buttons appear after pool review. Target rings stay unchanged.
AoE and Shotgun damage profiles are alternatives and cannot both be enabled
on the same item.

Back up the world and test on a separate scene between sessions before opting
in. Verification uses isolated mocked-Foundry gameplay and DOM tests, not the
user's live installation.

## Configurable AoE attacks

1. Set the weapon's normal `Trait` field to its skill name, such as `Gunnery`.
   AoE uses this field directly; there is no separate skill selector or override.
2. In item Properties, enable `Enable AoE` and open `AoE Settings` (the gear
   icon) to save its Small/Medium/Large blast, damage action and ammunition options.
   There is no duplicate checkbox or settings gear in the inventory row.
   Choose `Consume Ammunition` for loaded/linked rounds or `Consume Item` for
   grenade inventory quantity. These options are mutually exclusive; leave both
   off for no automatic consumption. `Uses per Attack` controls the amount spent.
3. Click the weapon's name or its explosion icon. The AoE attack panel always
   opens, using the normal SWADE Tools layout, item information and situational
   modifiers. Click its skill/AoE button, then place the blast area. No Shift-click
   or second `Use Result` confirmation is required.
4. If needed, click `Benny Reroll` on its attack chat card before the GM applies
   damage. It rerolls the same attack without consuming another round.

For tank HE, keep the weapon on the vehicle, assign its gunner/operator, and
configure the weapon's loaded or linked ammunition using SWADE's normal item
fields. The firing origin and ammunition belong to the vehicle; skill, wounds
and Bennies belong to its operator. No gun quantity is spent as ammunition.

Sequencer is required for placement. If optional JB2A animation assets are
missing, the attack still resolves. Blast targets are listed in chat and each
gets a native SWADE Tools damage card; the player's target rings are unchanged.
If an already-rolled attack gains a Raise on a later Benny reroll, the GM is
warned to review the existing damage bonus rather than receiving duplicate
damage cards. Reroll buttons are available in the throwing/firing user's
current browser session.

AoE attack cards use a compact weapon header, one dice/result bar, short
target rows and Benny buttons. Only nonzero modifiers are shown. Range, blast,
damage/AP and reroll history remain available in the closed `Details` section.
A Benny reroll posts a fresh attack card and fades the previous one, while
retaining the same attack, resource spend, template and damage workflow.
An important GM damage-review warning stays visible after a changed result.

With Automated Animations enabled (API verified against 6.8.5), the attack
uses that AoE item's animation configuration/Auto Recognition and passes the
placed blast template directly. Configure a Template animation or a suitable
template preset in AA for an explosion at the blast area. AA's disabled or
unmatched animations are respected; no hardcoded explosion is substituted.
Native ammunition use and the independent target damage cards do not trigger
additional AA animations during this attack. Attack Benny rerolls do not
replay the animation. Without AA, the existing optional JB2A/Sequencer effect
remains the fallback. Animation errors never block attack or damage resolution.

Update this fork using its stable Foundry manifest:
https://github.com/UmutcanOrug/swade-tools-fix/releases/latest/download/module.json

## Buy me a coffee
If you like the module and want to buy me a coffee: https://ko-fi.com/lipefl

## About the Module
A series of automations and quality of life improvements to use with SWADE system.

### Automation on Combat
- Detect targets in combat, **show hit/raise, damage and soak rolls**. All calculations automatically, just click to apply/roll.
- Automatic Situational modifiers for targets: **Distance, Gang Up, Ranged in Melee, Scale** etc. It's shown hidden by default, always if you want.
- Auto **Remove/Roll Status during combat**, no need to check or confirm
- **Min Str** affects damage dice (for Strength) and also trait rolls based on armor equipped or ranged weapon. Edges like Soldier are detected automatically.
- **Conviction support**: At the end of conviction, you are asked if you want to spend a benny to keep it active for another round.
- **Auto detect egdes/abilities** for bonus on rolls based on their names (support to some settings, allow to change names).
- Suport for **Cover** through items.
- **Out of control** will roll the table automatically for vehicle combat
- Suport for **setting rules** based on the swade system config
- **GM benny** will be used from directly from NPC if they have it, or from GM pool. Automatically!

### Automations to spare the GM
- **Auto Update Max Wounds** based on Wildcard/Extra and Size
- **Automatically link (and unlink) tokens** if the actor is wildcard (or not)
- **Auto Update Token** width/height based on Size.
- PCs are **friendly**, NPCs are **hostile** by default

### User Friendly for beginners
- **Simpler rolls**: by default, a simple dialog box with modifier when rolling Attributes and Skills. Same principle is applied to weapons and powers: a dialog box instead of sending to chat. The only player seeing it is the player using it.
- **More visible icons** for status, wound and fatigue
- **Clean and simple roll in the chat**. With tiny button to rerrol with benny or free reroll. For the GM, extra buttons to add modifier (after roll), re-targeting or calculate raises.
- **Template buttons for powers** directly, with just one click
- Asks when a weapon/power don't have a **defined trait** and redefine it for the roll
- Visible **Critical Failure** in the chat 

### Macros
- Easier **Boost/Lower Trait**
- Mark all PCs as **Friendly** and NPCs as **Hostile**. For those who haven't been using SWADE Tools.
- **Attack macro** to simplify for the GM
- **Roll once for all selected**, using the same trait

### Add More Things (if you want)
- Suport for **Called Shots**
- Quick select Aditional Modifiers: **Multi-Actions, Cover, Illumination**

### Missing something?
Open an issue: https://github.com/lipefl/swade-tools/issues

## Screenshots
![](https://i.imgur.com/K94IRoK.jpg)

![](https://i.imgur.com/2Y5tLRv.jpg)

![](https://i.imgur.com/IHdNOCA.jpg)

![](https://i.imgur.com/9On5gNC.jpg)

![](https://i.imgur.com/ibkM5Fa.jpg)

![](https://i.imgur.com/2mWd5oI.jpg)

![](https://i.imgur.com/h71BtgJ.jpg)

![](https://i.imgur.com/xJRCMxe.jpg)

![](https://i.imgur.com/1Ld0v0X.jpg)

![](https://i.imgur.com/yl7yhZz.jpg)

![](https://i.imgur.com/D46Aybk.jpg)

![](https://i.imgur.com/BexudNg.jpg)

## Translation
If you want your language handled by gitlocalize.com (a much easier interface), please open an issue.

## Last Update
Check The Releases!
For versions previous to v1.12, check: https://github.com/lipefl/swade-tools/blob/main/UPDATEHISTORY.md

## Installation Link
https://raw.githubusercontent.com/lipefl/swade-tools/main/module.json

## Internal helper functions

async game.swadetools.attribute(actor,attribute)  => attribute dialog

async game.swadetools.skill(actor,skillItemId) => skill dialog

async game.swadetools.run(actor) => run dialog

game.swadetools.item(actor,itemId) => item dialog




