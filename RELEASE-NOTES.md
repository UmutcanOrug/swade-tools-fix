## SWADE Tools 2.1.12 — Last Settings & Experimental Unified RoF

Experimental Unified RoF is a new world setting, **disabled by default**.
The GM must enable it to test the unified panel and Shotgun Rules. Turning it
off returns to the existing panels. New interface text is English.

Back up the world and test between sessions on a separate scene. Verification
uses isolated mocked-Foundry gameplay and DOM checks, including a headless
panel preview. The user's live Foundry session was not accessed.

### Shift + left-click

Normal click stays clean. Shift + left-click opens the last submitted manual
weapon settings; it never automatically rolls or fires. Browser-session memory
is separated by user, owner actor, scene-qualified firing token, item and
operator. Refresh clears it. Raise Damage and dynamic combat state are excluded.
Internal damage-only dialogs cannot capture or restore attack settings.

### Compact unified weapon panel

- RoF selector and Recoil remain in the normal classic SWADE Tools dialog.
- RoF 1 keeps native single fire; RoF 2+ enters the existing pool without a
  second setup panel. Whole-pool Benny review and target assignment remain.
- Rapid Fire extends the selector for Shooting only. Custom Traits such as
  Gunnery are supported. Additional action buttons keep their native behavior.

### Explicit Shotgun item settings

- Properties: Enable Shotgun Rules + Shotgun Settings gear, alongside AoE.
- Shot: +2 attack; 3d6/2d6/1d6 at Short/Medium/Long; no Extreme Shot damage.
- Slug: 2d10 without the Shot bonus, including Extreme range.
- Explicit preincluded +2 option prevents duplicate Trait Modifier bonuses.
- Optional Both Barrels: one Shot attack, one target, RoF 1, +4 damage and two
  shells. It is not a multi-die attack. Slug + Both Barrels is unsupported.
- Native single fire requires one target; pools support multiple recipients.
  Native damage uses the saved mode and the actual target range.
- AP, Raise die, item/global damage modifiers and native Benny flags remain.
  Item Damage and Trait Modifier fields are never rewritten.
- Automatic Innocent Bystanders and special shell profiles are not included.

### AoE + RoF, including grenade launchers

- Item name/image and explosion icon open the same unified panel.
- Review/Benny the pool, then place a blast point per usable result. Canceling
  any point aborts the volley before ammo/templates/damage. Bennies already
  spent during pool review are not refunded.
- Configured Ammo/Item/None consumption is respected. RoF 2+ spends once using
  the standard table: RoF 2/3/4/5/6 costs 5/10/20/40/50 uses. Single AoE retains
  saved Uses per Attack. Ammo follows SWADE's global ammunition setting.
- Each projectile uses its frozen pool result, adds point-specific range once,
  and retains independent native target damage and one animation dispatch.
  Individual projectile cards do not offer another Benny reroll.
- AoE and Shotgun damage profiles are alternatives, not simultaneous rules.
- Ambiguous/wrong firing tokens, ownership changes, invalid formulas and stale
  settings are checked before spending. Player target rings are never changed.

### Requirements

Foundry VTT 13 / SWADE 5.x. Sequencer is required for AoE placement.
Automated Animations retains its verified 6.8.5 API integration; optional JB2A
assets are not required for damage resolution. Use persistent weapon profiles
and disable Destroy on Empty if native consumption would delete the damage item.
