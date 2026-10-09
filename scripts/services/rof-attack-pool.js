/*
 * SWADE RoF Attack Pool and Damage Allocator
 * Foundry VTT 13 / SWADE 5.x / SWADE Tools 2.1.x
 *
 * Workflow:
 * 1. Select one attacker token and target every possible target.
 * 2. Select a ranged weapon, RoF, recoil, and a shared attack modifier.
 * 3. Roll RoF dice for the weapon's assigned skill plus the Wild Die.
 * 4. Optionally spend an Actor or GM Benny and reroll the whole pool.
 * 5. Keep the better whole pool and assign each result to any target.
 * 6. Choose Miss, Hit, or Raise for each result.
 * 7. Roll a separate SWADE Tools Damage card for every assigned hit.
 * 8. Spend ammunition once using the standard SWADE RoF table.
 *
 * The UI text is ASCII-only to avoid clipboard encoding problems.
 */

const ROF_AMMO_COST = Object.freeze({
  1: 1,
  2: 5,
  3: 10,
  4: 20,
  5: 40,
  6: 50,
});

// Match the classic SWADE Tools weapon panel without changing the user's
// global Foundry theme or the DialogV2 workflow and button callbacks.
const ROF_DIALOG_CLASSES = ["swadetools-rof-dialog", "themed", "theme-light"];

const CALLED_SHOT_ATTACK_PENALTY = Object.freeze({
  None: 0,
  Torso: 0,
  Arms: -2,
  Legs: -2,
  Head: -4,
});

const macroScope = typeof scope === "object" && scope ? scope : {};
const selectedToken =
  macroScope.token?.object ??
  macroScope.token ??
  (typeof token !== "undefined" ? token : null) ??
  canvas.tokens.controlled[0];
const actingActor =
  macroScope.actor ??
  (typeof actor !== "undefined" ? actor : null) ??
  selectedToken?.actor;

if (!actingActor || !selectedToken) {
  return ui.notifications.warn("Select the source token before attacking.");
}

if (!actingActor.isOwner) {
  return ui.notifications.error("You do not have permission to use this token.");
}

if (
  !game.modules.get("swade-tools")?.active ||
  typeof game.swadetools?.item !== "function"
) {
  return ui.notifications.error(
    "SWADE Tools 2.1.x must be active to roll damage with this macro."
  );
}

const possibleTargets = Array.from(game.user.targets ?? []).filter(
  (targetToken) => targetToken?.actor && targetToken?.document
);

const requestsInlineAoe = macroScope.rofSetup?.aoe === true;
if (!possibleTargets.length && !requestsInlineAoe) {
  return ui.notifications.warn(
    "Target the potential recipients before using the RoF damage allocator."
  );
}

const isRangedWeapon = (item) => {
  if (item?.type !== "weapon") return false;
  if (item.system?.isRanged === true) return true;
  return Boolean(String(item.system?.range ?? "").trim());
};

let contextualItem =
  macroScope.item ??
  macroScope.weapon ??
  (typeof item !== "undefined" ? item : null) ??
  null;
if (typeof contextualItem === "string") {
  contextualItem = await fromUuid(contextualItem);
}
if (!contextualItem && macroScope.itemUuid) {
  contextualItem = await fromUuid(macroScope.itemUuid);
}
if (contextualItem) {
  contextualItem =
    macroScope.weaponActor?.items?.get?.(contextualItem.id) ??
    contextualItem.actor?.items?.get?.(contextualItem.id) ??
    contextualItem.parent?.items?.get?.(contextualItem.id) ??
    actingActor.items.get(contextualItem.id) ??
    contextualItem;
}

let weaponActor =
  macroScope.weaponActor ??
  contextualItem?.actor ??
  (contextualItem?.parent?.items ? contextualItem.parent : null) ??
  actingActor;
if (typeof weaponActor === "string") {
  weaponActor = await fromUuid(weaponActor);
}
if (!weaponActor?.items) weaponActor = actingActor;

const rangedWeapons = weaponActor.items
  .filter(isRangedWeapon)
  .sort((left, right) => {
    const equippedDifference =
      Number(Number(right.system?.equipStatus) === 3) -
      Number(Number(left.system?.equipStatus) === 3);
    return equippedDifference || left.name.localeCompare(right.name);
  });

if (!rangedWeapons.length) {
  return ui.notifications.warn(
    `No ranged weapon was found on ${actingActor.name}.`
  );
}

const initialWeapon = isRangedWeapon(contextualItem)
  ? rangedWeapons.find((weapon) => weapon.id === contextualItem.id) ??
    rangedWeapons[0]
  : rangedWeapons[0];

const escapeHTML = (value) =>
  foundry.utils.escapeHTML(String(value ?? ""));

const SCROLLABLE_DIALOG_STYLE = [
  "max-height:calc(100vh - 10rem)",
  "max-height:calc(100dvh - 10rem)",
  "min-height:0",
  "overflow-y:auto",
  "overflow-x:hidden",
  "padding-right:0.5rem",
  "scrollbar-gutter:stable",
].join(";");

const getOptionalSetting = (scopeName, settingName, fallback) => {
  try {
    const fullKey = `${scopeName}.${settingName}`;
    if (
      game.settings.settings?.has &&
      !game.settings.settings.has(fullKey)
    ) {
      return fallback;
    }
    return game.settings.get(scopeName, settingName);
  } catch {
    return fallback;
  }
};

const normalizeRuleName = (value) =>
  String(value ?? "").trim().toLowerCase();

const normalizeSwid = (value) =>
  normalizeRuleName(value).replace(/[\s_]+/g, "-");

const findActorRuleItem = (
  swid,
  fallbackName,
  settingKey
) => {
  const configuredName = normalizeRuleName(
    getOptionalSetting(
      "swade-tools",
      settingKey,
      fallbackName
    )
  );
  const fallback = normalizeRuleName(fallbackName);

  return actingActor.items.find((actorItem) => {
    if (!["edge", "ability"].includes(actorItem.type)) return false;
    const itemSwid = normalizeSwid(actorItem.system?.swid);
    const itemName = normalizeRuleName(actorItem.name);
    return (
      itemSwid === swid ||
      itemName === fallback ||
      itemName === configuredName
    );
  }) ?? null;
};

const parseMinimumStrength = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/d\s*(\d+)/i) ?? text.match(/(\d+)/);
  if (!match) return null;
  const sides = Number(match[1]);
  return Number.isFinite(sides) && sides >= 4 ? sides : null;
};

const brawnyEdge = findActorRuleItem(
  "brawny",
  "Brawny",
  "BrawnySetting"
);
const soldierEdge = findActorRuleItem(
  "soldier",
  "Soldier",
  "SoldierSetting"
);
const minimumStrengthEdges = [brawnyEdge, soldierEdge].filter(Boolean);
const baseStrengthSides = Number(
  actingActor.system?.attributes?.strength?.die?.sides
);
const effectiveStrengthSides = Number.isFinite(baseStrengthSides)
  ? baseStrengthSides + minimumStrengthEdges.length * 2
  : null;
const effectiveStrengthLabel = Number.isFinite(effectiveStrengthSides)
  ? `d${baseStrengthSides}${
      minimumStrengthEdges.length
        ? " + " +
          minimumStrengthEdges.map((edgeItem) => edgeItem.name).join(" + ")
        : ""
    } = effective d${effectiveStrengthSides}`
  : "Strength unavailable";

const weaponOptions = rangedWeapons.map((weapon) => {
  const selected = weapon.id === initialWeapon.id ? "selected" : "";
  const rof = Math.max(1, Math.floor(Number(weapon.system?.rof ?? 1)));
  const shots = Number(weapon.system?.currentShots);
  const ammoLabel = Number.isFinite(shots) ? `; Ammo ${shots}` : "";
  return [
    '<option value="', weapon.id, '" ', selected, ">",
    escapeHTML(weapon.name), " (RoF ", rof, ammoLabel, ")",
    "</option>",
  ].join("");
}).join("");

const hasInlineSetup = Object.hasOwn(macroScope, "rofSetup");
let setup;
if (hasInlineSetup) {
  const supplied = macroScope.rofSetup;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    return ui.notifications.error("The inline RoF setup is invalid. Reopen the weapon panel.");
  }
  const modifierValue = (value, namedValues, allowedValues) => {
    const normalized = typeof value === "string" && Object.hasOwn(namedValues, value)
      ? namedValues[value] : Number(value ?? 0);
    return allowedValues.includes(normalized) ? normalized : null;
  };
  const multiAction = modifierValue(supplied.multiAction, {}, [0, -2, -4]);
  const cover = modifierValue(supplied.cover,
    {None:0, Light:-2, Medium:-4, Heavy:-6, Total:-8}, [0, -2, -4, -6, -8]);
  const illumination = modifierValue(supplied.illumination,
    {None:0, Dim:-2, Dark:-4, Pitch:-6}, [0, -2, -4, -6]);
  const calledShot = supplied.calledShot ?? "None";
  const booleanFields = ["recoil", "theDrop", "forceVulnerable", "consumeAmmo", "aoe", "bothBarrels"];
  if (multiAction === null || cover === null || illumination === null ||
    !Object.hasOwn(CALLED_SHOT_ATTACK_PENALTY, calledShot) ||
    booleanFields.some((key) => supplied[key] !== undefined && typeof supplied[key] !== "boolean")) {
    return ui.notifications.error("The inline RoF modifiers are invalid. Reopen the weapon panel.");
  }
  const formula = supplied.otherModifierFormula ?? supplied.otherModifier ?? "0";
  if (!["string", "number"].includes(typeof formula) || String(formula).length > 256 ||
    typeof (supplied.damageModifier ?? "") !== "string") {
    return ui.notifications.error("The inline RoF roll formula is invalid. Reopen the weapon panel.");
  }
  setup = {
    ...supplied,
    rof:Number(supplied.rof),
    recoil:supplied.recoil ?? true,
    theDrop:supplied.theDrop ?? false,
    forceVulnerable:supplied.forceVulnerable ?? false,
    consumeAmmo:supplied.consumeAmmo ?? true,
    aoe:supplied.aoe ?? false,
    bothBarrels:supplied.bothBarrels ?? false,
    otherModifierFormula:String(formula).trim() || "0",
    multiAction, cover, illumination, calledShot,
    damageModifier:String(supplied.damageModifier ?? "").trim(),
  };
} else {
try {
  setup = await foundry.applications.api.DialogV2.prompt({
    classes: ROF_DIALOG_CLASSES,
    window: { title: "SWADE RoF Attack Pool" },
    position: { width: 520 },
    content: `
      <div class="standard-form"
           style="${SCROLLABLE_DIALOG_STYLE}">
        <div class="form-group">
          <label>Weapon</label>
          <div class="form-fields">
            <select name="weaponId">${weaponOptions}</select>
          </div>
          <p class="hint">
            Minimum Strength is checked automatically after weapon selection.
            Current Min Str Strength: ${escapeHTML(effectiveStrengthLabel)}.
          </p>
        </div>

        <div class="form-group">
          <label>Rate of Fire</label>
          <div class="form-fields">
            <input name="rof" type="number"
                   min="1" max="6" step="1"
                   value="${Math.max(
                     1,
                     Math.min(
                       6,
                       Math.floor(Number(initialWeapon.system?.rof ?? 1))
                     )
                   )}">
          </div>
          <p class="hint">
            Ammo cost: RoF 1/2/3/4/5/6 = 1/5/10/20/40/50.
          </p>
        </div>

        <div class="form-group">
          <label>Apply Recoil -2</label>
          <div class="form-fields">
            <input name="recoil" type="checkbox" checked>
          </div>
        </div>

        <div class="form-group">
          <label>The Drop</label>
          <div class="form-fields">
            <input name="theDrop" type="checkbox">
          </div>
          <p class="hint">
            Adds +4 to every attack die and +4 to every assigned damage roll.
          </p>
        </div>

        <div class="form-group">
          <label>Other Attack Modifier</label>
          <div class="form-fields">
            <input name="otherModifier" type="number"
                   value="0" step="1">
          </div>
          <p class="hint">
            Use this for manual extras such as Multi-Action or a GM modifier.
            Target Range, Prone, Cover, Dodge, Vulnerable and Scale are
            inspected separately after the dice are rolled.
          </p>
        </div>

        <div class="form-group">
          <label>Called Shot</label>
          <div class="form-fields">
            <select name="calledShot">
              <option value="None" selected>None</option>
              <option value="Torso">Torso (0)</option>
              <option value="Arms">Arms (-2 Attack)</option>
              <option value="Legs">Legs (-2 Attack)</option>
              <option value="Head">Head (-4 Attack / +4 Damage)</option>
            </select>
          </div>
          <p class="hint">
            The attack penalty is added to every attack skill die. Head also
            adds +4 damage through SWADE Tools.
          </p>
        </div>

        <div class="form-group">
          <label>Damage Modifier</label>
          <div class="form-fields">
            <input name="damageModifier" type="text"
                   value="" placeholder="+2 or +1d6x">
          </div>
          <p class="hint">
            Applied to every assigned damage roll, not to the attack roll.
          </p>
        </div>

        <div class="form-group">
          <label>Consume Ammo</label>
          <div class="form-fields">
            <input name="consumeAmmo" type="checkbox" checked>
          </div>
        </div>

        <p class="hint">
          Targets available for assignment: ${possibleTargets
            .map((targetToken) =>
              escapeHTML(targetToken.name || targetToken.actor?.name)
            )
            .join(", ")}
        </p>
      </div>
    `,
    ok: {
      label: "Roll Attack Pool",
      icon: "fa-solid fa-burst",
      callback: (_event, button) => ({
        weaponId: button.form.elements.weaponId.value,
        rof: button.form.elements.rof.valueAsNumber,
        recoil: button.form.elements.recoil.checked,
        theDrop: button.form.elements.theDrop.checked,
        forceVulnerable: false,
        otherModifier:
          button.form.elements.otherModifier.valueAsNumber || 0,
        calledShot: button.form.elements.calledShot.value,
        damageModifier:
          String(button.form.elements.damageModifier.value ?? "").trim(),
        consumeAmmo: button.form.elements.consumeAmmo.checked,
      }),
    },
    rejectClose: false,
    modal: false,
  });
} catch {
  return;
}
}

if (!setup) return;

const weapon = rangedWeapons.find(
  (candidate) => candidate.id === setup.weaponId
);
if (!weapon || !isRangedWeapon(weapon)) {
  return ui.notifications.error("The selected ranged weapon was not found.");
}
const weaponOwner =
  weapon.actor ??
  (weapon.parent?.items ? weapon.parent : null) ??
  weaponActor ??
  actingActor;
const mountedVehicle =
  macroScope.vehicle ??
  (weaponOwner?.type === "vehicle" ? weaponOwner : null);

const inlineContextChanged = () => (
  !contextualItem || weapon.uuid !== contextualItem.uuid ||
  setup.itemUuid !== weapon.uuid || setup.weaponId !== weapon.id ||
  setup.weaponActorUuid !== weaponOwner?.uuid || setup.actorUuid !== actingActor.uuid ||
  !weaponOwner?.isOwner || !actingActor?.isOwner || weaponOwner.items?.get?.(weapon.id) !== weapon ||
  (selectedToken.actor !== weaponOwner && selectedToken.actor?.uuid !== weaponOwner.uuid) ||
  (weapon.actor ?? weapon.parent)?.uuid !== weaponOwner.uuid ||
  String(setup.trait ?? "").trim() !== String(weapon.system?.actions?.trait ?? "").trim() ||
  !String(weapon.system?.actions?.trait ?? "").trim()
);
if (hasInlineSetup && inlineContextChanged()) {
  return ui.notifications.error("The inline RoF weapon, owner, or Trait changed. Reopen the weapon panel.");
}
const rofServices = macroScope.rofServices ?? {};
const isInlineAoe = hasInlineSetup && setup.aoe === true;
if (isInlineAoe && (typeof rofServices.isAoeItem !== "function" || !rofServices.isAoeItem(weapon) ||
  typeof rofServices.prepareAoePoolPoints !== "function" || typeof rofServices.launchAoeMacro !== "function" ||
  !rofServices.aoeResource?.describe || !rofServices.aoeResource?.validate || !rofServices.aoeResource?.spend ||
  typeof rofServices.getAoeItemSettings !== "function" || typeof rofServices.withSuppressedAoeAutomation !== "function")) {
  return ui.notifications.error("This weapon's combined AoE/RoF workflow is unavailable. Reopen the weapon panel.");
}

const configuredWeaponRof = Number(weapon.system?.rof ?? 1);
const baseWeaponMaxRof = Number.isFinite(configuredWeaponRof)
  ? Math.max(1, Math.floor(configuredWeaponRof)) : 1;
const selectedRof = hasInlineSetup ? Number(setup.rof) : Math.floor(Number(setup.rof));

if (
  !Number.isInteger(selectedRof) ||
  selectedRof < 1 ||
  selectedRof > 6
) {
  return ui.notifications.error("RoF must be between 1 and 6.");
}

if (hasInlineSetup && selectedRof === 1) {
  return ui.notifications.warn("RoF 1 uses the native single-fire attack. Reopen the weapon panel.");
}

const ammoCost = ROF_AMMO_COST[selectedRof];
if (!Number.isFinite(ammoCost)) {
  return ui.notifications.error(
    `No standard ammunition cost was found for RoF ${selectedRof}.`
  );
}
const initialAoeSettings = isInlineAoe ? JSON.stringify(rofServices.getAoeItemSettings(weapon)) : null;
const aoeResourceOptions = isInlineAoe ? {
  consume:setup.consumeAmmo,mode:JSON.parse(initialAoeSettings).consumeMode,
  legacyGrenade:rofServices.isLegacyGrenadeItem?.(weapon) ?? false,
  cost:ammoCost,ammoManagement:getOptionalSetting("swade", "ammoManagement", false),
} : null;

const configuredShootingSkill = String(
  getOptionalSetting("swade-tools", "shootingSkill", "Shooting")
).trim() || "Shooting";
const attackSkillReference = String(
  weapon.system?.actions?.trait ?? configuredShootingSkill
).trim() || configuredShootingSkill;
const normalizedAttackSkillReference =
  normalizeRuleName(attackSkillReference);
const normalizedAttackSkillSwid =
  normalizeSwid(attackSkillReference);
const attackSkillById = actingActor.items.get?.(attackSkillReference);
const attackSkill =
  (attackSkillById?.type === "skill" ? attackSkillById : null) ??
  actingActor.items.find((skillItem) => {
    if (skillItem.type !== "skill") return false;
    const swid = normalizeSwid(skillItem.system?.swid);
    const name = normalizeRuleName(skillItem.name);
    return (
      name === normalizedAttackSkillReference ||
      swid === normalizedAttackSkillSwid
    );
  });

if (!attackSkill) {
  return ui.notifications.error(
    `${actingActor.name} does not have the ${attackSkillReference} skill.`
  );
}

const rapidFireEdge = hasInlineSetup && (
  normalizeRuleName(attackSkill.name) === normalizeRuleName(configuredShootingSkill) ||
  normalizeSwid(attackSkill.system?.swid) === "shooting"
) ? findActorRuleItem("rapid-fire", "Rapid Fire", "RapidFireSetting") : null;
const weaponMaxRof = hasInlineSetup
  ? Math.min(6, baseWeaponMaxRof + (rapidFireEdge ? 1 : 0))
  : baseWeaponMaxRof;
if (selectedRof > weaponMaxRof) {
  return ui.notifications.error(
    `${weapon.name} supports at most RoF ${weaponMaxRof}${rapidFireEdge ? " (Rapid Fire)" : ""}.`
  );
}
const shotgunSettings = hasInlineSetup && typeof rofServices.getShotgunSettings === "function"
  ? rofServices.getShotgunSettings(weapon) : {enabled:false};
const isInlineShotgun = shotgunSettings.enabled === true;
let shotgunProfile = null;
if (isInlineShotgun) {
  if (isInlineAoe) return ui.notifications.warn("Shotgun rules and AoE cannot be combined on the same weapon profile.");
  shotgunProfile = rofServices.validateShotgunAttack?.(weapon, {
    mode:setup.shotgunMode ?? "shot",rangeBand:"short",rof:selectedRof,
    bothBarrels:setup.bothBarrels,targetCount:possibleTargets.length,
  });
  if (!shotgunProfile?.ok) return ui.notifications.warn(shotgunProfile?.reason ?? "The shotgun profile is unavailable.");
  const bands = getWeaponRangeBands();
  if (!bands || ![bands.short,bands.medium,bands.long].every((value) => Number.isFinite(value) && value > 0) ||
    bands.medium < bands.short || bands.long < bands.medium) {
    return ui.notifications.warn("Set valid Short/Medium/Long weapon ranges before using shotgun rules.");
  }
  if (shotgunProfile.mode === "shot" && !possibleTargets.some((targetToken) => measureTargetDistance(targetToken) <= bands.long)) {
    return ui.notifications.warn("Shot cannot reach any selected target. Use Slug or choose a target within Long range.");
  }
}
const shotgunAttackBonus = Number(shotgunProfile?.attackBonus ?? 0);

const weaponMinimumStrengthSides = parseMinimumStrength(
  weapon.system?.minStr
);
const minimumStrengthPenalty =
  !mountedVehicle &&
  Number.isFinite(weaponMinimumStrengthSides) &&
  Number.isFinite(effectiveStrengthSides) &&
  effectiveStrengthSides < weaponMinimumStrengthSides
    ? -Math.ceil(
        (weaponMinimumStrengthSides - effectiveStrengthSides) / 2
      )
    : 0;
const minimumStrengthSummary = Number.isFinite(
  weaponMinimumStrengthSides
)
  ? mountedVehicle
    ? `Mounted on ${mountedVehicle.name}; Min Str penalty 0`
    : `Min Str d${weaponMinimumStrengthSides}; ` +
      `${effectiveStrengthLabel}; penalty ${minimumStrengthPenalty}`
  : `Min Str not set; ${effectiveStrengthLabel}; penalty 0`;

const readResourceNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
};

const findAmmoItem = () => {
  let loadedAmmo = null;
  try {
    loadedAmmo = weapon.getFlag?.("swade", "loadedAmmo") ?? null;
  } catch (error) {
    console.warn("SWADE RoF Macro | Loaded ammo flag failed", error);
  }

  const references = [
    loadedAmmo,
    weapon.system?.loadedAmmo,
    weapon.system?.ammo,
  ];

  for (const reference of references) {
    if (!reference) continue;

    if (typeof reference === "object") {
      const referenceId = reference.id ?? reference._id;
      const embeddedById = referenceId
        ? weaponOwner.items?.get?.(referenceId)
        : null;
      if (embeddedById) return embeddedById;
      if (typeof reference.update === "function") return reference;

      const referenceName = String(reference.name ?? "").trim();
      if (referenceName) {
        const embeddedByName =
          weaponOwner.items?.getName?.(referenceName) ??
          weaponOwner.items?.find?.(
            (candidate) =>
              String(candidate.name ?? "").trim().toLowerCase() ===
              referenceName.toLowerCase()
          );
        if (embeddedByName) return embeddedByName;
      }
      continue;
    }

    const textReference = String(reference).trim();
    if (!textReference) continue;
    const embedded =
      weaponOwner.items?.get?.(textReference) ??
      weaponOwner.items?.getName?.(textReference) ??
      weaponOwner.items?.find?.(
        (candidate) =>
          String(candidate.name ?? "").trim().toLowerCase() ===
          textReference.toLowerCase()
      );
    if (embedded) return embedded;
  }

  return null;
};

const getAmmoItemResource = (ammoItem) => {
  if (!ammoItem) return null;

  const chargeValue = readResourceNumber(
    ammoItem.system?.charges?.value
  );
  if (chargeValue !== null) {
    return {
      item: ammoItem,
      path: "system.charges.value",
      value: chargeValue,
    };
  }

  const quantityValue = readResourceNumber(ammoItem.system?.quantity);
  if (quantityValue !== null) {
    return {
      item: ammoItem,
      path: "system.quantity",
      value: quantityValue,
    };
  }

  const defaultChargeValue = readResourceNumber(
    ammoItem.system?.charges?.default?.value
  );
  if (defaultChargeValue !== null) {
    return {
      item: ammoItem,
      path: "system.charges.default.value",
      value: defaultChargeValue,
    };
  }

  return null;
};

const inspectAmmo = () => {
  const reloadType = String(
    weapon.system?.reloadType ?? ""
  ).toLowerCase();
  const currentShots = readResourceNumber(
    weapon.system?.currentShots
  );
  const shots = readResourceNumber(weapon.system?.shots);
  const quantity = readResourceNumber(weapon.system?.quantity);
  const ammoItem = findAmmoItem();
  const ammoItemResource = getAmmoItemResource(ammoItem);
  const usesInventory = Boolean(
    weapon.usesAmmoFromInventory ??
    weapon.system?.usesAmmoFromInventory ??
    false
  );

  if (reloadType === "self" && shots !== null && quantity !== null) {
    const loadedShots = currentShots ?? 0;
    return {
      source: "self",
      available:
        shots * Math.max(0, quantity - 1) + loadedShots,
      currentShots: loadedShots,
      shots,
      quantity,
      reloadType,
      ammoItemResource,
    };
  }

  if (
    reloadType === "none" &&
    (usesInventory || (ammoItemResource && currentShots === null))
  ) {
    return {
      source: "inventory",
      available: ammoItemResource?.value ?? 0,
      currentShots,
      shots,
      quantity,
      reloadType,
      ammoItemResource,
    };
  }

  if (currentShots !== null) {
    return {
      source: "magazine",
      available: currentShots,
      currentShots,
      shots,
      quantity,
      reloadType,
      ammoItemResource,
    };
  }

  if (reloadType === "none" && !usesInventory) {
    return {
      source: "unlimited",
      available: Infinity,
      currentShots,
      shots,
      quantity,
      reloadType,
      ammoItemResource,
    };
  }

  if (ammoItemResource) {
    return {
      source: "inventory",
      available: ammoItemResource.value,
      currentShots,
      shots,
      quantity,
      reloadType,
      ammoItemResource,
    };
  }

  return {
    source: "unknown",
    available: 0,
    currentShots,
    shots,
    quantity,
    reloadType,
    ammoItemResource,
  };
};

const validateAmmo = () => {
  if (isInlineAoe) return rofServices.aoeResource.validate(weapon,weaponOwner,aoeResourceOptions);
  const inspected = inspectAmmo();
  if (!setup.consumeAmmo || (hasInlineSetup && getOptionalSetting("swade", "ammoManagement", true) === false)) {
    return { ok: true, managed: false, ...inspected };
  }

  let systemApiAccepted = null;
  if (
    typeof weapon.canExpendResources === "function" &&
    typeof weapon.consume === "function"
  ) {
    try {
      systemApiAccepted =
        weapon.canExpendResources(ammoCost) !== false;
    } catch (error) {
      console.warn(
        "SWADE RoF Macro | Ammo API validation failed; using fallback",
        error
      );
      systemApiAccepted = false;
    }
  }

  if (systemApiAccepted === true) {
    return { ok: true, managed: true, ...inspected };
  }
  if (hasInlineSetup && systemApiAccepted === false) {
    return {ok:false,managed:false,apiRejected:true,...inspected};
  }

  return {
    ok: inspected.available >= ammoCost,
    managed: false,
    apiRejected: systemApiAccepted === false,
    ...inspected,
  };
};

const consumeFallbackAmmo = async (validation) => {
  if (validation.source === "unlimited") return;

  if (validation.source === "magazine") {
    await weapon.update({
      "system.currentShots": Math.max(
        0,
        Number(validation.currentShots) - ammoCost
      ),
    });
    return;
  }

  if (validation.source === "inventory") {
    const resource = validation.ammoItemResource;
    if (!resource?.item || !resource.path) {
      throw new Error("Inventory ammunition could not be resolved.");
    }
    await resource.item.update({
      [resource.path]: Math.max(0, resource.value - ammoCost),
    });
    return;
  }

  if (validation.source === "self") {
    const remaining = Math.max(0, validation.available - ammoCost);
    const shotsPerItem = Math.max(1, Number(validation.shots) || 1);
    const newQuantity =
      remaining > 0 ? Math.ceil(remaining / shotsPerItem) : 0;
    const newCurrentShots =
      remaining > 0
        ? remaining - shotsPerItem * Math.max(0, newQuantity - 1)
        : 0;
    await weapon.update({
      "system.quantity": newQuantity,
      "system.currentShots": newCurrentShots,
    });
    return;
  }

  throw new Error("No writable ammunition source was found.");
};

let ammoValidation = validateAmmo();
if (!ammoValidation.ok) {
  const visibleAmmo = Number.isFinite(ammoValidation.available)
    ? ammoValidation.available
    : "unknown";
  const magazineAmmo =
    ammoValidation.currentShots === null
      ? "n/a"
      : ammoValidation.currentShots;
  const inventoryAmmo =
    ammoValidation.ammoItemResource?.value ?? "n/a";
  return ui.notifications.error(
    `${weapon.name}: ${ammoCost} ${isInlineAoe && aoeResourceOptions.mode === "item" ? "items" : "rounds"} required; ${visibleAmmo} available ` +
    `(magazine ${magazineAmmo}, inventory ${inventoryAmmo}).`
  );
}

const woundValue = Number(actingActor.system.wounds?.value ?? 0);
const woundIgnored = Number(actingActor.system.wounds?.ignored ?? 0);
const fatigueValue = Number(actingActor.system.fatigue?.value ?? 0);
const fatigueIgnored = Number(actingActor.system.fatigue?.ignored ?? 0);
const woundPenalty = -Math.max(0, woundValue - woundIgnored);
const fatiguePenalty = -Math.max(0, fatigueValue - fatigueIgnored);
const skillModifier = Number(attackSkill.system.die?.modifier ?? 0);
const recoilPenalty =
  selectedRof > 1 && setup.recoil === true ? -2 : 0;
const theDropAttackBonus = setup.theDrop === true ? 4 : 0;
const theDropDamageBonus = setup.theDrop === true ? 4 : 0;
const inlineModifierRolls = [];
const inlineModifierEntries = [];
const inlineRollData = hasInlineSetup ? actingActor.getRollData?.() ?? {} : {};
const shotgunDamageByRange = new Map();
let preparedInlineDamageModifier = '';
const validateInlineFormula = (formula) => {
  for (const [, reference] of formula.matchAll(/@([A-Za-z0-9_.]+)/g)) {
    const value = foundry.utils.getProperty(inlineRollData, reference);
    if (reference.split('.').some(part => !part || ['__proto__','constructor','prototype'].includes(part)) ||
      value === undefined || value === null || typeof value === 'object') {
      throw new Error(`Unavailable roll field: @${reference}.`);
    }
  }
  const resolved = typeof Roll.replaceFormulaData === "function"
    ? Roll.replaceFormulaData(formula, inlineRollData) : formula;
  if (typeof Roll.validate === "function" && !Roll.validate(resolved)) {
    throw new Error("Invalid attack or damage modifier formula.");
  }
};
const evaluateInlineModifier = async (label, formula) => {
  const expression = String(formula ?? "").trim();
  if (!expression) return 0;
  validateInlineFormula(expression);
  let value = Number(expression);
  if (!Number.isFinite(value)) {
    const roll = await new Roll(expression, inlineRollData).evaluate();
    inlineModifierRolls.push(roll);
    value = Number(roll.total);
  }
  if (!Number.isFinite(value)) throw new Error("A modifier did not produce a finite total.");
  if (value) inlineModifierEntries.push({label, formula:expression, value});
  return value;
};
const prepareInlineDamageFormula = formula => {
  validateInlineFormula(formula);
  const resolved=String(typeof Roll.replaceFormulaData==='function'
    ? Roll.replaceFormulaData(formula,inlineRollData) : formula).replace(/D(?=\d)/g,'d');
  if (!Roll.validate(rofServices.nativeWeaponDamageFormula(resolved))) {
    throw new Error('This damage formula is not supported by native SWADE Tools.');
  }
  return resolved;
};
let otherModifier = Number(setup.otherModifier ?? 0);
let inlinePreparedModifier = 0;
const multiActionPenalty = hasInlineSetup ? setup.multiAction : 0;
const aoeSituationalPenalty = isInlineAoe ? setup.cover + setup.illumination : 0;
if (hasInlineSetup) {
  try {
    const globalModifiers = actingActor.system?.stats?.globalMods ?? {};
    const preparedModifiers = [
      {label:"Item", value:weapon.system?.actions?.traitMod},
      {label:"Trademark", value:weapon.system?.trademark},
      ...Array.from(attackSkill.system?.effects ?? []),
      ...Array.from(globalModifiers.trait ?? []),
      ...Array.from(globalModifiers[attackSkill.system?.attribute] ?? []),
      ...Array.from(globalModifiers.attack ?? []),
    ].filter((modifier) => modifier && !modifier.ignore && String(modifier.value ?? "").trim());
    // Validate every expression before evaluating any dice or committing ammo.
    for (const formula of [setup.otherModifierFormula, setup.damageModifier,
      ...preparedModifiers.map((modifier) => String(modifier.value))].filter(Boolean)) {
      validateInlineFormula(formula);
    }
    if (setup.damageModifier) preparedInlineDamageModifier=prepareInlineDamageFormula(setup.damageModifier);
    if (isInlineShotgun) {
      // Validate and freeze the selected ammunition profile before any attack
      // dice, Benny or ammo. Damage dice remain unrolled until each hit.
      for (const rangeBand of ['short','medium','long','extreme']) {
        const formula=rofServices.getShotgunDamage(weapon, {
          mode:shotgunProfile.mode,bothBarrels:false,rangeBand,
        });
        if (!formula) continue;
        shotgunDamageByRange.set(rangeBand,prepareInlineDamageFormula(formula));
      }
    }
    otherModifier = await evaluateInlineModifier("Mod.", setup.otherModifierFormula);
    for (const modifier of preparedModifiers) {
      inlinePreparedModifier += await evaluateInlineModifier(String(modifier.label ?? "Effect"), modifier.value);
    }
  } catch (error) {
    return ui.notifications.error(`RoF setup: ${error.message} Reopen the weapon panel or update the item's effects.`);
  }
}
const calledShot = Object.hasOwn(
  CALLED_SHOT_ATTACK_PENALTY,
  setup.calledShot
)
  ? setup.calledShot
  : "None";
const calledShotPenalty =
  CALLED_SHOT_ATTACK_PENALTY[calledShot];
// Native SWADE Tools accepts resolved formulas, not raw @data references.
// Resolve data here without rolling damage dice; each target rolls its own.
const damageModifier = hasInlineSetup ? preparedInlineDamageModifier : String(setup.damageModifier ?? "").trim();
const commonModifier =
  woundPenalty +
  fatiguePenalty +
  skillModifier +
  recoilPenalty +
  minimumStrengthPenalty +
  theDropAttackBonus +
  otherModifier +
  multiActionPenalty +
  inlinePreparedModifier +
  aoeSituationalPenalty +
  shotgunAttackBonus +
  calledShotPenalty;

const attackSkillSides = Math.max(
  4,
  Number(attackSkill.system.die?.sides ?? 4)
);
const wildSides = Math.max(
  4,
  Number(attackSkill.system["wild-die"]?.sides ?? 6)
);
const isWildCard = Boolean(actingActor.system.wildcard);
const bennyTraitModifiers = Array.from(
  actingActor.system?.stats?.globalMods?.bennyTrait ?? []
).filter((modifier) => (!hasInlineSetup || !modifier?.ignore) && Number.isFinite(Number(modifier?.value)));
const bennyTraitBonus = bennyTraitModifiers.reduce(
  (total, modifier) => total + Number(modifier.value),
  0
);
const bennyTraitSummary = bennyTraitModifiers.length
  ? bennyTraitModifiers
      .map((modifier) => {
        const value = Number(modifier.value);
        const label = String(modifier.label ?? "Benny Trait");
        return `${label} ${value >= 0 ? "+" : ""}${value}`;
      })
      .join(", ")
  : "None";
const dumbLuckEnabled = Boolean(
  getOptionalSetting("swade", "dumbLuck", false)
);

const selectUsableResults = (poolCandidates) =>
  [...poolCandidates]
    .sort(
      (left, right) =>
        right.total - left.total ||
        Number(left.source === "wild") -
          Number(right.source === "wild")
    )
    .slice(0, selectedRof);

const rollAttackPool = async ({
  attemptNumber,
  isBennyReroll,
}) => {
  const attemptModifier =
    commonModifier + (isBennyReroll ? bennyTraitBonus : 0);
  const [attackSkillRolls, wildRoll] = await Promise.all([
    Promise.all(
      Array.from(
        { length: selectedRof },
        () => new Roll(`1d${attackSkillSides}x`).evaluate()
      )
    ),
    isWildCard
      ? new Roll(`1d${wildSides}x`).evaluate()
      : Promise.resolve(null),
  ]);

  const attemptCandidates = attackSkillRolls.map((roll, index) => ({
    id: `skill-${index}`,
    label: `${attackSkill.name} Die ${index + 1}`,
    source: "skill",
    roll,
    rawTotal: Number(roll.total ?? 0),
    modifier: attemptModifier,
    total: Number(roll.total ?? 0) + attemptModifier,
  }));

  if (wildRoll) {
    attemptCandidates.push({
      id: "wild-die",
      label: "Wild Die",
      source: "wild",
      roll: wildRoll,
      rawTotal: Number(wildRoll.total ?? 0),
      modifier: attemptModifier,
      total: Number(wildRoll.total ?? 0) + attemptModifier,
    });
  }

  const attemptUsableResults =
    selectUsableResults(attemptCandidates);
  const oneCount = attemptCandidates.filter(
    (candidate) => candidate.rawTotal === 1
  ).length;
  const wildDieIsOne = attemptCandidates.some(
    (candidate) =>
      candidate.source === "wild" && candidate.rawTotal === 1
  );
  const majorityAreOne =
    oneCount > attemptCandidates.length / 2;
  const criticalFailure = isWildCard
    ? wildDieIsOne && majorityAreOne
    : majorityAreOne;

  return {
    attemptNumber,
    isBennyReroll,
    candidates: attemptCandidates,
    usableResults: attemptUsableResults,
    criticalFailure,
  };
};

const formatPoolTotals = (pool) =>
  pool.usableResults
    .map((candidate) => candidate.total)
    .join(", ");

const getPoolTableHTML = (pool) => {
  const usableIds = new Set(
    pool.usableResults.map((candidate) => candidate.id)
  );
  const rows = pool.candidates.map((candidate) => `
    <tr>
      <td>${escapeHTML(candidate.label)}</td>
      <td>${candidate.rawTotal}</td>
      <td>
        ${candidate.modifier >= 0 ? "+" : ""}${candidate.modifier}
      </td>
      <td><strong>${candidate.total}</strong></td>
      <td>${usableIds.has(candidate.id) ? "Usable" : "Discarded"}</td>
    </tr>
  `).join("");

  return `
    <table>
      <thead>
        <tr>
          <th>Die</th>
          <th>Raw</th>
          <th>Mod</th>
          <th>Total</th>
          <th>Pool</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
};

const getActorBennies = () => {
  const value = Number(
    actingActor.bennies ??
      actingActor.system?.bennies?.value ??
      0
  );
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const getGmBennies = () => {
  if (!game.user.isGM) return 0;
  const value = Number(game.user.bennies ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const reviewAttackPool = async (pool, statusText) => {
  const actorBennies = isWildCard ? getActorBennies() : 0;
  const gmBennies = getGmBennies();
  const rerollLocked =
    pool.criticalFailure && !dumbLuckEnabled;
  const buttons = [
    {
      action: "continue",
      label: "Continue to Target Assignment",
      icon: "fa-solid fa-crosshairs",
      default: true,
    },
  ];

  if (!rerollLocked && actorBennies > 0) {
    buttons.unshift({
      action: "actor-benny",
      label: `Actor Benny Reroll (${actorBennies})`,
      icon: "fa-solid fa-dice",
    });
  }
  if (!rerollLocked && gmBennies > 0) {
    buttons.unshift({
      action: "gm-benny",
      label: `GM Benny Reroll (${gmBennies})`,
      icon: "fa-solid fa-dice",
    });
  }

  const rerollHint = rerollLocked
    ? "Critical Failure: Benny reroll is locked unless Dumb Luck is enabled."
    : actorBennies > 0 || gmBennies > 0
      ? `A Benny rerolls every ${attackSkill.name} die and the Wild Die. After the roll, you choose the previous or rerolled whole pool; results from different attempts are never mixed.`
      : "No available Benny source. Continue with this pool.";

  return foundry.applications.api.DialogV2.wait({
    classes: ROF_DIALOG_CLASSES,
    window: {
      title: `${weapon.name} - Review RoF Attack Pool`,
    },
    position: { width: 720 },
    content: `
      <div class="standard-form"
           style="${SCROLLABLE_DIALOG_STYLE}">
        <p>
          <strong>Current usable totals:</strong>
          ${escapeHTML(formatPoolTotals(pool))}
        </p>
        ${
          statusText
            ? `<p><strong>${escapeHTML(statusText)}</strong></p>`
            : ""
        }
        ${getPoolTableHTML(pool)}
        <p class="hint">${escapeHTML(rerollHint)}</p>
        ${
          bennyTraitModifiers.length
            ? `<p class="hint">Benny reroll modifier: ${escapeHTML(
                bennyTraitSummary
              )}</p>`
            : ""
        }
        <p class="hint">
          Closing this window cancels before ammunition is consumed.
          This window is non-modal, so chat and the canvas remain usable.
        </p>
      </div>
    `,
    buttons,
    rejectClose: false,
    modal: false,
  });
};

const chooseBennyPool = async (previousPool, rerolledPool) =>
  foundry.applications.api.DialogV2.wait({
    classes: ROF_DIALOG_CLASSES,
    window: {
      title: `${weapon.name} - Choose Benny Result`,
    },
    position: { width: 760 },
    content: `
      <div class="standard-form"
           style="${SCROLLABLE_DIALOG_STYLE}">
        <p>
          Benny has already been spent. Choose which complete attack pool
          to use. The macro will not decide by highest single die and will
          not mix dice between the two pools.
        </p>

        <section style="margin-bottom:1rem">
          <h3>
            Previous Pool:
            ${escapeHTML(formatPoolTotals(previousPool))}
          </h3>
          ${getPoolTableHTML(previousPool)}
        </section>

        <section>
          <h3>
            Benny Reroll:
            ${escapeHTML(formatPoolTotals(rerolledPool))}
          </h3>
          ${getPoolTableHTML(rerolledPool)}
        </section>

        <p class="hint">
          Closing this window keeps the previous pool. The window is
          non-modal, so chat and the canvas remain usable.
        </p>
      </div>
    `,
    buttons: [
      {
        action: "keep-previous",
        label: "Keep Previous Pool",
        icon: "fa-solid fa-rotate-left",
        default: true,
      },
      {
        action: "use-reroll",
        label: "Use Benny Reroll",
        icon: "fa-solid fa-dice",
      },
    ],
    close: () => "keep-previous",
    rejectClose: false,
    modal: false,
  });

let attackPool = await rollAttackPool({
  attemptNumber: 1,
  isBennyReroll: false,
});
attackPool.selectionNote = "Initial pool";
const poolAttempts = [attackPool];
let poolReviewStatus = "";

while (true) {
  const poolAction = await reviewAttackPool(
    attackPool,
    poolReviewStatus
  );
  if (!poolAction) return;
  if (poolAction === "continue") break;

  const spender =
    poolAction === "gm-benny" ? game.user : actingActor;
  const availableBennies =
    poolAction === "gm-benny"
      ? getGmBennies()
      : getActorBennies();
  if (
    availableBennies < 1 ||
    typeof spender?.spendBenny !== "function"
  ) {
    ui.notifications.warn(
      "That Benny source is no longer available."
    );
    poolReviewStatus =
      "Benny was not spent; the current pool is unchanged.";
    continue;
  }

  const spent = await spender.spendBenny();
  if (spent !== true) {
    ui.notifications.warn("Benny could not be spent.");
    poolReviewStatus =
      "Benny was not spent; the current pool is unchanged.";
    continue;
  }

  const rerolledPool = await rollAttackPool({
    attemptNumber: poolAttempts.length + 1,
    isBennyReroll: true,
  });
  poolAttempts.push(rerolledPool);
  const previousPool = attackPool;
  const poolChoice = await chooseBennyPool(
    previousPool,
    rerolledPool
  );
  const useReroll = poolChoice === "use-reroll";
  rerolledPool.selectionNote = useReroll
    ? "Chosen by player"
    : "Rejected by player";
  if (useReroll) attackPool = rerolledPool;

  poolReviewStatus = useReroll
    ? `Benny attempt ${rerolledPool.attemptNumber} ` +
      `[${formatPoolTotals(rerolledPool)}] was chosen by the player.`
    : `Previous pool [${formatPoolTotals(previousPool)}] was kept ` +
      `instead of Benny attempt ${rerolledPool.attemptNumber} ` +
      `[${formatPoolTotals(rerolledPool)}].`;
}

const candidates = attackPool.candidates;
const usableResults = attackPool.usableResults;

let aoePlacements = null;
if (isInlineAoe) {
  aoePlacements = await rofServices.prepareAoePoolPoints({actor:actingActor,item:weapon,
    weaponOwner,token:selectedToken,candidates:usableResults,setup});
  if (!Array.isArray(aoePlacements) || !aoePlacements.length) return;
  const seen = new Set();
  if (aoePlacements.length !== usableResults.length || aoePlacements.some((placement) => {
    const index = placement?.candidateIndex;
    const valid = Number.isInteger(index) && index >= 0 && index < usableResults.length && !seen.has(index) &&
      Number.isFinite(placement.attackPoint?.x) && Number.isFinite(placement.attackPoint?.y);
    seen.add(index);
    return !valid;
  })) return ui.notifications.error("AoE placements were incomplete. No ammunition was consumed.");
}

if (hasInlineSetup) {
  if (inlineContextChanged()) return ui.notifications.error("The weapon, owner, or Trait changed during the attack. No ammunition was consumed.");
  ammoValidation = validateAmmo();
  if (!ammoValidation.ok) return ui.notifications.warn("Ammunition changed during the attack. Reload or reopen the weapon panel; no shots were consumed.");
  if (isInlineAoe && (!rofServices.isAoeItem(weapon) ||
    JSON.stringify(rofServices.getAoeItemSettings(weapon)) !== initialAoeSettings)) {
    return ui.notifications.warn("AoE settings changed during the attack. No ammunition or items were consumed.");
  }
}

let poolAmmoSpent = 0;
if (setup.consumeAmmo && (isInlineAoe || !hasInlineSetup || getOptionalSetting("swade", "ammoManagement", true) !== false)) {
  try {
    if (isInlineAoe) {
      const consumedResource = rofServices.aoeResource.describe(weapon,weaponOwner,aoeResourceOptions).resource;
      const result = await rofServices.withSuppressedAoeAutomation([weapon,consumedResource],
        () => rofServices.aoeResource.spend(weapon,weaponOwner,aoeResourceOptions),
        {gameRef:game,hooksRef:Hooks,trackConsumption:true});
      if (!result.ok) return ui.notifications.warn("The AoE pool resource could not be consumed. No projectiles were resolved.");
      poolAmmoSpent = Number(result.consumed ?? 0);
    } else if (
      ammoValidation.managed &&
      typeof weapon.consume === "function"
    ) {
      await weapon.consume(ammoCost);
      poolAmmoSpent = ammoCost;
    } else {
      await consumeFallbackAmmo(ammoValidation);
      poolAmmoSpent = ammoCost;
    }
  } catch (error) {
    console.error("SWADE RoF Macro | Ammo consumption failed", error);
    return ui.notifications.error(
      `${weapon.name}: ammunition could not be consumed; damage resolution was stopped.`
    );
  }
}

const modifierParts = [
  `Wounds ${woundPenalty >= 0 ? "+" : ""}${woundPenalty}`,
  `Fatigue ${fatiguePenalty >= 0 ? "+" : ""}${fatiguePenalty}`,
  `Skill (${attackSkill.name}) ${skillModifier >= 0 ? "+" : ""}${
    skillModifier
  }`,
  `Recoil ${recoilPenalty >= 0 ? "+" : ""}${recoilPenalty}`,
  `Min Str ${minimumStrengthPenalty >= 0 ? "+" : ""}${
    minimumStrengthPenalty
  }`,
  `The Drop ${theDropAttackBonus >= 0 ? "+" : ""}${
    theDropAttackBonus
  }`,
  `Other ${otherModifier >= 0 ? "+" : ""}${otherModifier}`,
  ...(hasInlineSetup ? [
    `Multi-Action ${multiActionPenalty >= 0 ? "+" : ""}${multiActionPenalty}`,
    ...inlineModifierEntries.filter((modifier) => modifier.label !== "Mod.")
      .map((modifier) => `${modifier.label} ${modifier.value >= 0 ? "+" : ""}${modifier.value}`),
    ...(isInlineAoe && setup.cover ? [`Cover ${setup.cover}`] : []),
    ...(isInlineAoe && setup.illumination ? [`Illumination ${setup.illumination}`] : []),
    ...(isInlineShotgun ? [`Shotgun ${shotgunProfile.mode} ${shotgunAttackBonus >= 0 ? "+" : ""}${shotgunAttackBonus}`] : []),
  ] : []),
  `Called Shot ${calledShot} ${
    calledShotPenalty >= 0 ? "+" : ""
  }${calledShotPenalty}`,
  ...(bennyTraitModifiers.length
    ? [`Benny reroll ${bennyTraitSummary}`]
    : []),
].join(", ");

const resultRows = candidates.map((candidate) => {
  const kept = usableResults.some((result) => result.id === candidate.id);
  const resultColor = kept ? "#1b7f3a" : "#777777";
  return `
    <tr>
      <td>${escapeHTML(candidate.label)}</td>
      <td>${candidate.rawTotal}</td>
      <td>
        ${candidate.modifier >= 0 ? "+" : ""}${candidate.modifier}
      </td>
      <td style="font-weight:bold;color:${resultColor}">
        ${candidate.total}
      </td>
      <td>${kept ? "Usable" : "Discarded"}</td>
    </tr>
  `;
}).join("");

const rerollHistoryRows = poolAttempts.map((pool) => `
  <tr>
    <td>${pool.attemptNumber}</td>
    <td>${pool.isBennyReroll ? "Benny reroll" : "Initial roll"}</td>
    <td>${escapeHTML(formatPoolTotals(pool))}</td>
    <td>
      ${
        pool === attackPool
          ? "Final pool"
          : escapeHTML(pool.selectionNote ?? "Not kept")
      }
    </td>
  </tr>
`).join("");

const attackPoolMessage = await ChatMessage.create({
  user: game.user.id,
  speaker: ChatMessage.getSpeaker({
    actor: actingActor,
    token: selectedToken.document,
  }),
  rolls: [...inlineModifierRolls, ...poolAttempts.flatMap((pool) =>
    pool.candidates.map((candidate) => candidate.roll)
  )],
  content: `
    <h2>${escapeHTML(weapon.name)} - RoF ${selectedRof}</h2>
    <p>
      <strong>${isInlineAoe && aoeResourceOptions.mode === "item" ? "Items spent" : "Ammo spent"}:</strong>
      ${setup.consumeAmmo ? poolAmmoSpent : "Disabled"}
    </p>
    <p>
      <strong>Attack skill:</strong>
      ${escapeHTML(attackSkill.name)}
    </p>
    <p>
      <strong>Base common modifier:</strong>
      ${commonModifier >= 0 ? "+" : ""}${commonModifier}
    </p>
    <p>
      <strong>Benny rerolls:</strong>
      ${Math.max(0, poolAttempts.length - 1)}
      (final pool: attempt ${attackPool.attemptNumber})
    </p>
    <p>
      <strong>Benny reroll modifier:</strong>
      ${escapeHTML(bennyTraitSummary)}
    </p>
    <p>
      <strong>Minimum Strength:</strong>
      ${escapeHTML(minimumStrengthSummary)}
    </p>
    <p>
      <strong>Damage modifier:</strong>
      ${escapeHTML(
        [
          damageModifier || null,
          theDropDamageBonus ? "The Drop +4" : null,
        ].filter(Boolean).join(", ") || "None"
      )}
    </p>
    <p><small>${escapeHTML(modifierParts)}</small></p>
    <table>
      <thead>
        <tr>
          <th>Die</th>
          <th>Raw</th>
          <th>Mod</th>
          <th>Total</th>
          <th>Pool</th>
        </tr>
      </thead>
      <tbody>${resultRows}</tbody>
    </table>
    ${
      poolAttempts.length > 1
        ? `
          <h3>Benny Reroll History</h3>
          <table>
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Type</th>
                <th>Usable Totals</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>${rerollHistoryRows}</tbody>
          </table>
        `
        : ""
    }
    <p>
      <small>
        The best ${selectedRof} result(s) are available for manual target
        assignment. Target-specific modifiers are decided in the next step.
      </small>
    </p>
  `,
});

if (isInlineAoe) {
  const poolId = attackPoolMessage.id;
  let completed = 0;
  for (const placement of aoePlacements) {
    const candidate = usableResults[placement.candidateIndex];
    const launched = await rofServices.launchAoeMacro(actingActor, weapon, {
      operatorActor:actingActor,token:selectedToken,skipConsumption:true,attackPoint:placement.attackPoint,
      attackSetup:{...setup,damageModifier},poolAttack:{rawRoll:candidate.roll,baseModifier:candidate.modifier,
        criticalFailure:attackPool.criticalFailure,candidateIndex:placement.candidateIndex,poolId,
        weaponUuid:weapon.uuid,weaponActorUuid:weaponOwner.uuid,operatorActorUuid:actingActor.uuid,
        disableBenny:true,source:candidate.source,label:candidate.label},
    });
    if (launched !== false) completed += 1;
  }
  ui.notifications.info(`${weapon.name}: ${completed}/${aoePlacements.length} AoE projectiles resolved from the RoF pool.`);
  return;
}

const targetByUuid = new Map(
  possibleTargets.map((targetToken) => [
    targetToken.document.uuid,
    targetToken,
  ])
);

const getBaseTargetName = (targetToken) =>
  String(
    targetToken.name || targetToken.actor?.name || "Unknown"
  ).trim();

const formatSignedModifier = (value) => {
  const numeric = Number(value) || 0;
  return `${numeric >= 0 ? "+" : ""}${numeric}`;
};

const localizeModifierLabel = (label) => {
  const text = String(label ?? "Modifier");
  try {
    return game.i18n.localize(text) || text;
  } catch {
    return text;
  }
};

const getSystemModifier = (
  group,
  key,
  fallbackLabel,
  fallbackValue
) => {
  const configured =
    CONFIG.SWADE?.rollModifiers?.[group]?.modifiers?.[key];
  const value = Number(configured?.value ?? fallbackValue);
  return {
    label: configured?.label ?? fallbackLabel,
    value: Number.isFinite(value) ? value : Number(fallbackValue) || 0,
  };
};

const hasTokenStatus = (targetToken, statusId) => {
  const targetDocument = targetToken.document ?? targetToken;
  try {
    if (targetDocument.hasStatusEffect?.(statusId)) return true;
  } catch {
    // Continue with Active Effect and actor status fallbacks.
  }

  const hasEffect = targetToken.actor?.effects?.some((effect) =>
    effect.statuses?.has?.(statusId)
  );
  if (hasEffect) return true;

  if (statusId === "vulnerable") {
    return targetToken.actor?.system?.status?.isVulnerable === true;
  }
  return false;
};

function getTokenCenter(tokenOrDocument) {
  return tokenOrDocument?.getCenterPoint?.() ??
    tokenOrDocument?.object?.center ?? tokenOrDocument?.center ?? null;
}

function measureTargetDistance(targetToken) {
  const sourceDocument = selectedToken.document ?? selectedToken;
  const targetDocument = targetToken.document ?? targetToken;
  const sourceCenter = getTokenCenter(sourceDocument);
  const targetCenter = getTokenCenter(targetDocument);
  if (!sourceCenter || !targetCenter) return 0;

  const scene = targetDocument.parent ?? canvas.scene;
  try {
    const measured = scene?.grid?.measurePath?.([
      sourceCenter,
      targetCenter,
    ]);
    const distance = Number(measured?.distance);
    if (Number.isFinite(distance)) return distance;
  } catch {
    // Use the grid-distance fallback below.
  }

  const pixelDistance = Math.hypot(
    targetCenter.x - sourceCenter.x,
    targetCenter.y - sourceCenter.y
  );
  const gridSize = Number(canvas.dimensions?.size) || 1;
  const gridDistance = Number(canvas.dimensions?.distance) || 1;
  return (pixelDistance / gridSize) * gridDistance;
};

function getWeaponRangeBands() {
  const nativeRange = weapon.range;
  if (
    nativeRange &&
    typeof nativeRange === "object" &&
    ["short", "medium", "long"].every((key) =>
      Number.isFinite(Number(nativeRange[key]))
    )
  ) {
    return {
      short: Number(nativeRange.short),
      medium: Number(nativeRange.medium),
      long: Number(nativeRange.long),
    };
  }

  const parts = String(weapon.system?.range ?? "")
    .split("/")
    .map((part) => Number(String(part).trim()));
  if (
    parts.length >= 3 &&
    parts.slice(0, 3).every(Number.isFinite)
  ) {
    return {
      short: parts[0],
      medium: parts[1],
      long: parts[2],
    };
  }
  return null;
};

const weaponRangeBands = getWeaponRangeBands();
const configuredEdgeNameCache = new Map();

const findNamedEdge = (targetActor, swid, fallbackName, settingKey) => {
  if (!configuredEdgeNameCache.has(settingKey)) {
    configuredEdgeNameCache.set(
      settingKey,
      normalizeRuleName(
        getOptionalSetting(
          "swade-tools",
          settingKey,
          fallbackName
        )
      )
    );
  }
  const configuredName = configuredEdgeNameCache.get(settingKey);

  return targetActor?.items?.find((targetItem) => {
    if (!["edge", "ability"].includes(targetItem.type)) return false;
    const itemSwid = normalizeSwid(targetItem.system?.swid);
    const itemName = normalizeRuleName(targetItem.name);
    return (
      itemSwid === swid ||
      itemName === normalizeRuleName(fallbackName) ||
      itemName === configuredName
    );
  });
};

const collectRegionAttackModifiers = (targetToken) => {
  const targetDocument = targetToken.document ?? targetToken;
  const coverCandidates = [];
  const illuminationCandidates = [];
  const regions = Array.from(targetDocument.regions ?? []);

  for (const region of regions) {
    const behaviors = Array.from(region.behaviors ?? []);
    for (const behavior of behaviors) {
      if (
        behavior.disabled ||
        behavior.type !== "attackModifiers"
      ) {
        continue;
      }

      const coverKey = behavior.system?.cover;
      if (coverKey) {
        coverCandidates.push(
          getSystemModifier(
            "cover",
            coverKey,
            `Cover: ${coverKey}`,
            0
          )
        );
      }

      const illuminationKey = behavior.system?.illumination;
      if (illuminationKey) {
        illuminationCandidates.push(
          getSystemModifier(
            "illumination",
            illuminationKey,
            `Illumination: ${illuminationKey}`,
            0
          )
        );
      }
    }
  }

  return { coverCandidates, illuminationCandidates };
};

const collectTargetAttackProfile = (targetToken) => {
  const targetActor = targetToken.actor;
  const targetDocument = targetToken.document ?? targetToken;
  const distance = measureTargetDistance(targetToken);
  const additionalMods = [];
  const coverCandidates = [];
  const ignoredMods = [];

  const isProne = hasTokenStatus(targetToken, "prone");
  if (isProne && distance >= 3) {
    coverCandidates.push({
      label: "SWADE.Cover.MediumProne",
      value: -4,
    });
  } else if (isProne) {
    ignoredMods.push({
      label: "Prone",
      value: 0,
      reason: "inside 3 units",
    });
  }

  const regionModifiers = collectRegionAttackModifiers(targetToken);
  coverCandidates.push(...regionModifiers.coverCandidates);
  if (hasInlineSetup && setup.cover) {
    coverCandidates.push({label:"Manual Cover", value:setup.cover});
  }
  if (hasInlineSetup && setup.illumination) {
    regionModifiers.illuminationCandidates.push({label:"Manual Illumination", value:setup.illumination});
  }
  const bestIllumination = regionModifiers.illuminationCandidates
    .filter((modifier) => Number(modifier.value) !== 0)
    .sort(
      (left, right) =>
        Number(left.value) - Number(right.value)
    )[0];

  for (const targetItem of targetActor?.items ?? []) {
    const rawCover = Number(targetItem.system?.cover);
    const isReadied =
      targetItem.isReadied === true ||
      Number(targetItem.system?.equipStatus) === 3;
    if (!isReadied || !Number.isFinite(rawCover) || rawCover === 0) {
      continue;
    }

    const coverValue = rawCover > 0 ? -rawCover : rawCover;
    if (coverValue < 0) {
      coverCandidates.push({
        label: targetItem.name || "Cover",
        value: coverValue,
      });
    }
  }

  const dodgeItem = findNamedEdge(
    targetActor,
    "dodge",
    "Dodge",
    "DodgeSetting"
  );
  if (dodgeItem) {
    coverCandidates.push({
      label: dodgeItem.name || "Dodge",
      value: -2,
    });
  }

  const combatAcrobat = findNamedEdge(
    targetActor,
    "combat-acrobat",
    "Combat Acrobat",
    "CombatAcrobatSetting"
  );
  if (combatAcrobat && targetActor?.system?.encumbered !== true) {
    additionalMods.push({
      label: combatAcrobat.name || "Combat Acrobat",
      value: -1,
    });
  }

  const rangeBands = weaponRangeBands;
  if (rangeBands) {
    if (distance > rangeBands.long) {
      additionalMods.push(
        getSystemModifier(
          "range",
          "extreme",
          "Extreme Range",
          -8
        )
      );
    } else if (distance > rangeBands.medium) {
      additionalMods.push(
        getSystemModifier("range", "long", "Long Range", -4)
      );
    } else if (distance > rangeBands.short) {
      additionalMods.push(
        getSystemModifier(
          "range",
          "medium",
          "Medium Range",
          -2
        )
      );
    }
  }

  const isVulnerable =
    setup.forceVulnerable === true ||
    hasTokenStatus(targetToken, "vulnerable");
  if (isVulnerable) {
    additionalMods.push(
      getSystemModifier(
        "trait",
        "targetVulnerable",
        "Target is Vulnerable",
        2
      )
    );
  }

  const attackerScale = Number(
    (selectedToken.actor ?? actingActor).system?.stats?.scale ?? 0
  );
  const defenderScale = Number(
    targetActor?.system?.stats?.scale ?? 0
  );
  if (
    Number.isFinite(attackerScale) &&
    Number.isFinite(defenderScale) &&
    attackerScale !== defenderScale
  ) {
    additionalMods.push({
      label: "SWADE.ScaleDifference",
      value: defenderScale - attackerScale,
    });
  }

  const bestCover = coverCandidates
    .filter((modifier) => Number(modifier.value) !== 0)
    .sort(
      (left, right) =>
        Number(left.value) - Number(right.value)
    )[0];

  const bestNonStackingMods = {
    bestCover,
    bestIllumination,
  };

  try {
    Hooks.call(
      "swadeCalculateDefaultAttackMods",
      selectedToken.document ?? selectedToken,
      targetDocument,
      attackSkill,
      weapon,
      true,
      false,
      additionalMods,
      bestNonStackingMods
    );
  } catch (error) {
    console.warn(
      "SWADE RoF Macro | External target modifiers failed",
      error
    );
  }

  const effectiveMods = [
    ...additionalMods,
    ...Object.values(bestNonStackingMods).filter(Boolean),
  ]
    .map((modifier) => ({
      label: localizeModifierLabel(modifier.label),
      value: Number(modifier.value),
    }))
    .filter((modifier) =>
      Number.isFinite(modifier.value) && modifier.value !== 0
    );

  const uniqueMods = [];
  const seenModifiers = new Set();
  for (const modifier of effectiveMods) {
    const key = `${modifier.label}|${modifier.value}`;
    if (seenModifiers.has(key)) continue;
    seenModifiers.add(key);
    uniqueMods.push(modifier);
  }

  const effectiveCover = bestNonStackingMods.bestCover;
  for (const candidate of coverCandidates) {
    const isEffective =
      effectiveCover &&
      String(candidate.label) === String(effectiveCover.label) &&
      Number(candidate.value) === Number(effectiveCover.value);
    if (!isEffective) {
      ignoredMods.push({
        label: localizeModifierLabel(candidate.label),
        value: Number(candidate.value),
        reason: "does not stack with better Cover",
      });
    }
  }

  const total = uniqueMods.reduce(
    (sum, modifier) => sum + modifier.value,
    0
  );

  return {
    distance,
    total,
    modifiers: uniqueMods,
    ignoredMods,
    isProne,
    isVulnerable,
    ...(isInlineShotgun ? {shotgunDamage:shotgunDamageByRange.get(
      !weaponRangeBands || distance > weaponRangeBands.long ? "extreme" :
        distance > weaponRangeBands.medium ? "long" : distance > weaponRangeBands.short ? "medium" : "short",
    )} : {}),
  };
};

const targetAttackProfiles = new Map(
  possibleTargets.map((targetToken) => [
    targetToken.document.uuid,
    collectTargetAttackProfile(targetToken),
  ])
);

const targetNameCounts = new Map();
for (const targetToken of possibleTargets) {
  const nameKey = getBaseTargetName(targetToken).toLowerCase();
  targetNameCounts.set(
    nameKey,
    (targetNameCounts.get(nameKey) ?? 0) + 1
  );
}

const targetNameIndexes = new Map();
const targetDisplayNames = new Map();
const targetMarkerLabels = new Map();
for (const targetToken of possibleTargets) {
  const baseName = getBaseTargetName(targetToken);
  const nameKey = baseName.toLowerCase();
  const duplicateCount = targetNameCounts.get(nameKey) ?? 1;
  const duplicateIndex = (targetNameIndexes.get(nameKey) ?? 0) + 1;
  targetNameIndexes.set(nameKey, duplicateIndex);

  const displayName =
    duplicateCount > 1
      ? `${baseName} #${duplicateIndex}`
      : baseName;
  targetDisplayNames.set(targetToken.document.uuid, displayName);
  targetMarkerLabels.set(
    targetToken.document.uuid,
    duplicateCount > 1 ? `TARGET #${duplicateIndex}` : "TARGET"
  );
}

const targetOptions = possibleTargets.map((targetToken) => {
  const targetUuid = targetToken.document.uuid;
  const targetName =
    targetDisplayNames.get(targetUuid) ??
    getBaseTargetName(targetToken);
  const targetModifier =
    targetAttackProfiles.get(targetUuid)?.total ?? 0;
  return `
    <option value="${escapeHTML(targetUuid)}">
      ${escapeHTML(
        `${targetName} [Target Mod ${formatSignedModifier(
          targetModifier
        )}]`
      )}
    </option>
  `;
}).join("");

const getTargetProfileHTML = (profile) => {
  if (!profile) {
    return "<small>Select a target to inspect its modifiers.</small>";
  }

  const applied = profile.modifiers.length
    ? profile.modifiers
        .map(
          (modifier) =>
            `${escapeHTML(modifier.label)} ` +
            `${formatSignedModifier(modifier.value)}`
        )
        .join("; ")
    : "None";

  const ignored = profile.ignoredMods.length
    ? `
      <br><span style="opacity:0.75">
        Not stacked: ${profile.ignoredMods
          .map(
            (modifier) =>
              `${escapeHTML(modifier.label)} ` +
              `${formatSignedModifier(modifier.value)} ` +
              `(${escapeHTML(modifier.reason)})`
          )
          .join("; ")}
      </span>
    `
    : "";

  return `
    <small>
      <strong>Detected:</strong> ${applied}<br>
      <strong>Target total:</strong>
      ${formatSignedModifier(profile.total)}
      ${ignored}
    </small>
  `;
};

const assignmentRows = usableResults.map((result, index) => {
  const defaultOutcome =
    result.total >= 8 ? "raise" : result.total >= 4 ? "hit" : "miss";
  return `
    <tr>
      <td>
        <strong>${escapeHTML(result.label)}</strong><br>
        <small>
          ${result.rawTotal}
          ${commonModifier >= 0 ? "+" : ""}${commonModifier}
          = ${result.total}<br>
          <span data-final-total="${index}">
            Target Final: select target
          </span>
        </small>
      </td>
      <td>
        <div style="display:flex;gap:0.35rem;align-items:center">
          <select name="target-${index}" style="flex:1">
            <option value="">Unassigned</option>
            ${targetOptions}
          </select>
          <button
            type="button"
            data-show-target="${index}"
            title="Show selected target on map"
            style="flex:0 0 38px">
            <i class="fa-solid fa-location-crosshairs"></i>
          </button>
        </div>
        <div
          data-target-profile="${index}"
          style="margin-top:0.3rem;line-height:1.25">
          <small>Select a target to inspect its modifiers.</small>
        </div>
      </td>
      <td>
        <select name="outcome-${index}">
          <option value="miss" ${
            defaultOutcome === "miss" ? "selected" : ""
          }>Miss / No Damage</option>
          <option value="hit" ${
            defaultOutcome === "hit" ? "selected" : ""
          }>Hit</option>
          <option value="raise" ${
            defaultOutcome === "raise" ? "selected" : ""
          }>Hit with Raise</option>
        </select>
      </td>
    </tr>
  `;
}).join("");

let assignments;
try {
  assignments = await foundry.applications.api.DialogV2.prompt({
    classes: ROF_DIALOG_CLASSES,
    window: { title: `${weapon.name} - Assign RoF Results` },
    position: { width: 940 },
    content: `
      <div class="standard-form"
           style="${SCROLLABLE_DIALOG_STYLE}">
        <p>
          Assign each result to a target; the same target can receive more than one result.
          Identically named targets are numbered. Use the location button to find a target
          on the map. Range, Cover and other detected modifiers appear below each target.
          You can adjust the final Hit or Raise outcome manually.
        </p>
        <table>
          <thead>
            <tr>
              <th>Attack Result</th>
              <th>Target</th>
              <th>Damage Result</th>
            </tr>
          </thead>
          <tbody>${assignmentRows}</tbody>
        </table>
        <p class="hint">
          Continue creates a separate SWADE Tools damage card for each Hit.
          The attack has already been fired; closing this window does not refund ammunition.
        </p>
      </div>
    `,
    render: (_event, dialog) => {
      const root =
        dialog.element?.querySelector
          ? dialog.element
          : dialog.element?.[0];
      if (!root?.querySelectorAll) return;

      const updateTargetRow = (rowIndex) => {
        const result = usableResults[Number(rowIndex)];
        const targetSelect = root.querySelector(
          `[name="target-${rowIndex}"]`
        );
        const outcomeSelect = root.querySelector(
          `[name="outcome-${rowIndex}"]`
        );
        const profileContainer = root.querySelector(
          `[data-target-profile="${rowIndex}"]`
        );
        const finalTotalContainer = root.querySelector(
          `[data-final-total="${rowIndex}"]`
        );
        if (!result || !targetSelect || !outcomeSelect) return;

        const targetUuid = targetSelect.value;
        const profile = targetAttackProfiles.get(targetUuid);
        if (profileContainer) {
          profileContainer.innerHTML =
            getTargetProfileHTML(profile);
        }

        if (!profile) {
          if (finalTotalContainer) {
            finalTotalContainer.textContent =
              "Target Final: select target";
          }
          return;
        }

        const adjustedTotal = result.total + profile.total;
        if (finalTotalContainer) {
          finalTotalContainer.textContent =
            `Target Final: ${result.total} ` +
            `${formatSignedModifier(profile.total)} = ` +
            `${adjustedTotal}`;
        }
        outcomeSelect.value =
          adjustedTotal >= 8
            ? "raise"
            : adjustedTotal >= 4
              ? "hit"
              : "miss";
      };

      usableResults.forEach((_result, rowIndex) => {
        const targetSelect = root.querySelector(
          `[name="target-${rowIndex}"]`
        );
        targetSelect?.addEventListener("change", () =>
          updateTargetRow(rowIndex)
        );
        updateTargetRow(rowIndex);
      });

      for (const showButton of root.querySelectorAll(
        "[data-show-target]"
      )) {
        showButton.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();

          const rowIndex = showButton.dataset.showTarget;
          const targetSelect = root.querySelector(
            `[name="target-${rowIndex}"]`
          );
          const targetUuid = targetSelect?.value;
          const targetToken = targetByUuid.get(targetUuid);
          if (!targetToken) {
            ui.notifications.warn(
              "Select a target in this row first."
            );
            return;
          }

          const center =
            targetToken.center ??
            targetToken.getCenterPoint?.();
          if (!center) return;

          const currentScale =
            Number(canvas.stage?.scale?.x) || 1;
          const viewScale = Math.max(0.85, currentScale);
          const viewportWidth =
            Number(canvas.screenDimensions?.[0]) ||
            Number(window.innerWidth) ||
            1200;
          const leftSideOffset =
            (viewportWidth * 0.22) / viewScale;

          await canvas.animatePan({
            x: center.x + leftSideOffset,
            y: center.y,
            scale: viewScale,
            duration: 350,
          });

          if (
            typeof canvas.interface?.createScrollingText ===
            "function"
          ) {
            void canvas.interface.createScrollingText(
              center,
              targetMarkerLabels.get(targetUuid) ?? "TARGET",
              {
                duration: 1800,
                distance: 30,
                jitter: 0,
                textStyle: {
                  fill: "#ffcc33",
                  fontSize: 42,
                  fontWeight: "bold",
                },
              }
            );
          }
        });
      }
    },
    ok: {
      label: "Roll Assigned Damage",
      icon: "fa-solid fa-crosshairs",
      callback: (_event, button) =>
        usableResults.map((result, index) => {
          const targetUuid =
            button.form.elements[`target-${index}`].value;
          const targetProfile =
            targetAttackProfiles.get(targetUuid) ?? null;
          return {
            result,
            targetUuid,
            targetProfile,
            adjustedTotal:
              result.total + Number(targetProfile?.total ?? 0),
            outcome:
              button.form.elements[`outcome-${index}`].value,
          };
        }),
    },
    rejectClose: false,
    modal: false,
  });
} catch {
  return;
}

if (!assignments) return;

const resolvedAssignments = assignments
  .filter((assignment) => assignment.targetUuid)
  .map((assignment) => ({
    ...assignment,
    targetToken: targetByUuid.get(assignment.targetUuid),
  }))
  .filter((assignment) => assignment.targetToken);

if (resolvedAssignments.length) {
  const resolutionRows = resolvedAssignments.map((assignment) => {
    const targetName =
      targetDisplayNames.get(assignment.targetUuid) ??
      getBaseTargetName(assignment.targetToken);
    const outcomeLabel =
      assignment.outcome === "raise"
        ? "Hit with Raise"
        : assignment.outcome === "hit"
          ? "Hit"
          : "Miss / No Damage";
    return `
      <div style="margin:0.45rem 0;padding:0.4rem;border-top:1px solid #777">
        <strong>${escapeHTML(targetName)}: ${outcomeLabel}</strong><br>
        <small>
          ${escapeHTML(assignment.result.label)}:
          ${assignment.result.total}
          ${formatSignedModifier(assignment.targetProfile?.total ?? 0)}
          = ${assignment.adjustedTotal}
        </small><br>
        ${getTargetProfileHTML(assignment.targetProfile)}
      </div>
    `;
  }).join("");

  await attackPoolMessage.update({
    content: `
      ${attackPoolMessage.content}
      <h3>Target Resolution</h3>
      ${resolutionRows}
    `,
  });
}

const damageAssignments = resolvedAssignments.filter((assignment) => {
  if (!["hit", "raise"].includes(assignment.outcome)) return false;
  if (isInlineShotgun && !assignment.targetProfile?.shotgunDamage) {
    ui.notifications.warn(`${assignment.targetToken.name || "Target"}: Shot cannot deal damage beyond Long range.`);
    return false;
  }
  return true;
});

if (!damageAssignments.length) {
  return ui.notifications.info(
    `${weapon.name}: no Hits were assigned for damage.`
  );
}

const waitForElement = async (getter, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = getter();
    if (element) return element;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
};

const waitForSwadeToolsDialog = (timeoutMs = 5000) =>
  new Promise((resolve) => {
    let finished = false;
    let timer;
    let renderHookId;

    const cleanup = (dialogInfo = null) => {
      if (finished) return;
      finished = true;
      if (renderHookId !== undefined) {
        Hooks.off("renderDialog", renderHookId);
      }
      if (timer !== undefined) clearTimeout(timer);
      resolve(dialogInfo);
    };

    renderHookId = Hooks.on("renderDialog", (dialog, html) => {
      if (String(dialog.title ?? "") !== String(weapon.name)) return;
      const root =
        html?.querySelector ? html : html?.[0] ?? dialog.element?.[0];
      if (!root?.querySelectorAll) return;

      const hasDamageButton = Array.from(
        root.querySelectorAll("button[data-button]")
      ).some(
        (button) =>
          button.dataset.button === "mainDamage" ||
          /^(damage|hasar)$/i.test(
            String(button.textContent ?? "").trim()
          )
      );
      if (!hasDamageButton) return;
      cleanup({ dialog, root });
    });

    timer = setTimeout(() => cleanup(null), timeoutMs);
  });

const injectTargetIntoNextSwadeToolsDamage = (
  targetToken,
  timeoutMs = 8000
) =>
  new Promise((resolve) => {
    let finished = false;
    let timer;
    let preCreateHookId;

    const cleanup = (message = null) => {
      if (finished) return;
      finished = true;
      if (preCreateHookId !== undefined) {
        Hooks.off("preCreateChatMessage", preCreateHookId);
      }
      if (timer !== undefined) clearTimeout(timer);
      resolve(message);
    };

    preCreateHookId = Hooks.on(
      "preCreateChatMessage",
      (message, data, _options, userId) => {
        if (userId && userId !== game.user.id) return;
        const swadeToolsFlags =
          message.flags?.["swade-tools"] ??
          data.flags?.["swade-tools"];
        if (swadeToolsFlags?.rolltype !== "damage") return;
        if (swadeToolsFlags?.itemroll !== weapon.id) return;

        message.updateSource({
          "flags.swade-tools.usetarget": targetToken.id,
        });
        cleanup(message);
      }
    );

    timer = setTimeout(() => cleanup(null), timeoutMs);
  });

const findDamageButton = (root) =>
  Array.from(root.querySelectorAll("button")).find(
    (button) => button.dataset.button === "mainDamage"
  ) ??
  Array.from(root.querySelectorAll("button")).find((button) =>
    /^(damage|hasar)$/i.test(String(button.textContent ?? "").trim())
  ) ??
  null;

const combineDamageModifiers = (...values) => {
  const modifiers = values
    .map((value) => String(value ?? "").trim())
    .filter((value) => value && value !== "0");

  if (!modifiers.length) return "0";

  const numericModifiers = modifiers.map(Number);
  if (numericModifiers.every(Number.isFinite)) {
    return String(
      numericModifiers.reduce((total, value) => total + value, 0)
    );
  }

  return modifiers
    .map((value, index) => {
      if (index === 0) return value.replace(/^\+/, "");
      return /^[+-]/.test(value) ? value : `+${value}`;
    })
    .join("");
};

const rollSwadeToolsDamage = async (assignment) => {
  const dialogPromise = waitForSwadeToolsDialog();
  if (hasInlineSetup) {
    await game.swadetools.item(weaponOwner, weapon.id, actingActor, {damageOnly:true,
      ...(isInlineShotgun ? {damageOverride:assignment.targetProfile.shotgunDamage} : {}),
    });
  } else await game.swadetools.item(weaponOwner, weapon.id);
  const dialogInfo = await dialogPromise;

  if (!dialogInfo?.root) {
    throw new Error("SWADE Tools item dialog was not rendered.");
  }

  const raiseCheckbox = dialogInfo.root.querySelector("#raise");
  if (raiseCheckbox) {
    raiseCheckbox.checked = assignment.outcome === "raise";
  }

  const calledShotSelect =
    dialogInfo.root.querySelector("#calledshots");
  let calledShotHandledBySwadeTools = false;
  if (calledShot !== "None" && calledShotSelect) {
    const matchingOption = Array.from(calledShotSelect.options).find(
      (option) => option.value === calledShot
    );
    if (matchingOption) {
      calledShotSelect.value = calledShot;
      calledShotHandledBySwadeTools = true;
    }
  }

  const damageModifierInput = dialogInfo.root.querySelector("#mod");
  if (damageModifierInput) {
    const headDamageFallback =
      calledShot === "Head" && !calledShotHandledBySwadeTools
        ? 4
        : "";
    damageModifierInput.value = combineDamageModifiers(
      damageModifierInput.value,
      damageModifier,
      theDropDamageBonus,
      headDamageFallback
    );
  }

  const damageButton = findDamageButton(dialogInfo.root);
  if (!damageButton) {
    throw new Error("SWADE Tools Damage button was not found.");
  }

  const targetInjectionPromise =
    injectTargetIntoNextSwadeToolsDamage(assignment.targetToken);
  damageButton.click();
  const damageMessage = await targetInjectionPromise;

  if (!damageMessage) {
    throw new Error("SWADE Tools did not create a damage message.");
  }

  await waitForElement(
    () => game.messages?.get(damageMessage.id) ?? null,
    3000
  );
  return damageMessage;
};

let completedDamageRolls = 0;
for (const assignment of damageAssignments) {
  try {
    await rollSwadeToolsDamage(assignment);
    completedDamageRolls += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    console.error(
      `SWADE RoF Macro | Damage failed for ${
        assignment.targetToken.name ||
        assignment.targetToken.actor?.name ||
        "Unknown"
      }`,
      error
    );
    ui.notifications.error(
      `${weapon.name}: SWADE Tools damage failed for ${
        assignment.targetToken.name ||
        assignment.targetToken.actor?.name ||
        "Unknown"
      }.`
    );
  }
}

ui.notifications.info(
  `${weapon.name}: ${completedDamageRolls}/${damageAssignments.length} SWADE Tools Damage roll completed.`
);
