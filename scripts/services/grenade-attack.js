/*
 * SWADE AoE Attack - Automatic Item Damage
 * Foundry VTT V13 / SWADE 5.x / Sequencer 4.x
 *
 * Bundled script for the inventory's AoE explosion button. It can also be
 * copied into a world Script Macro and run directly from the hotbar.
 * The attack resolves automatically; its chat card offers a skill Benny Reroll.
 */

const PROJECTILE_EFFECT = "jb2a.throwable.throw.grenade.01.green";
const IMPACT_EFFECT = "jb2a.explosion.01.orange";

const macroScope = typeof scope === "object" && scope ? scope : {};
const poolAttack = macroScope.poolAttack ?? null;
const selectedToken =
  macroScope.token?.object ??
  macroScope.token ??
  (typeof token !== "undefined" ? token : null) ??
  canvas.tokens.controlled[0];
let actingActor =
  macroScope.operatorActor ?? macroScope.actor ??
  (typeof actor !== "undefined" ? actor : null) ??
  selectedToken?.actor;

if (!actingActor || !selectedToken) {
  return ui.notifications.warn("Select the token using the AoE weapon.");
}

if (!game.modules.get("sequencer")?.active || !globalThis.Sequencer?.Crosshair) {
  return ui.notifications.error(
    "SWADE AoE Attack requires the Sequencer module to be active."
  );
}

const aoeServices = macroScope.aoeServices ?? {
  ...await import(foundry.utils.getRoute("modules/swade-tools/scripts/services/AoeAttackProfile.js")),
  ...await import(foundry.utils.getRoute("modules/swade-tools/scripts/services/AoeResourceService.js")),
  ...await import(foundry.utils.getRoute("modules/swade-tools/scripts/services/AoeAttackDialog.js")),
  ...await import(foundry.utils.getRoute("modules/swade-tools/scripts/services/AoeAnimationService.js")),
  ...await import(foundry.utils.getRoute("modules/swade-tools/scripts/services/WeaponDamageModifier.js")),
};
const {isLegacyGrenadeItem, isAoeItem, getAoeItemSettings, resolveAoeSkill, aoeResource, showAoeAttackDialog,
  playAoeAnimation, withSuppressedAoeAutomation, isTrustedAoePoolAttack,
  prepareWeaponDamageModifier} = aoeServices;
const animationRuntime = {gameRef: game, hooksRef: Hooks,
  automatedAnimations: globalThis.AutomatedAnimations, sequencerRef: Sequencer,
  SequenceClass: typeof Sequence === "function" ? Sequence : undefined};

const getDamageActionFormula = (action) =>
  String(action?.override ?? action?.dmgOverride ?? "").trim();
const getItemDamageActions = (item) =>
  Object.entries(
    foundry.utils.getProperty(item, "system.actions.additional") ?? {}
  ).filter(([, action]) => action?.type === "damage");
const getItemDamageFormula = (item) => {
  const actionFormula = getItemDamageActions(item)
    .map(([, action]) => getDamageActionFormula(action))
    .find(Boolean);
  return String(item?.system?.damage ?? "").trim() || actionFormula;
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
let weaponActor = macroScope.weaponActor ?? contextualItem?.actor ??
  (contextualItem?.parent?.items ? contextualItem.parent : null) ?? selectedToken.actor;
if (typeof weaponActor === "string") weaponActor = await fromUuid(weaponActor);
if (!weaponActor?.items) return ui.notifications.error("The AoE weapon's owner could not be found.");
if (!weaponActor.isOwner && !game.user.isGM) return ui.notifications.error("You do not own this AoE weapon.");
if (contextualItem) contextualItem = weaponActor.items.get(contextualItem.id) ?? contextualItem;
if (contextualItem && !isAoeItem(contextualItem)) return ui.notifications.warn("Enable AoE on this item's sheet before using an AoE attack.");

const grenades = weaponActor.items
  .filter(isAoeItem)
  .filter((candidate) => poolAttack || !isLegacyGrenadeItem(candidate) || Number(candidate.system.quantity ?? 1) > 0)
  .sort((a, b) => {
    const damageDifference =
      Number(Boolean(getItemDamageFormula(b))) -
      Number(Boolean(getItemDamageFormula(a)));
    return damageDifference || a.name.localeCompare(b.name);
  });

if (!grenades.length) {
  return ui.notifications.warn(`${weaponActor.name} has no usable AoE items. Enable AoE on the weapon's item sheet.`);
}

const initialGrenade = isAoeItem(contextualItem)
  ? weaponActor.items.get(contextualItem.id) ?? contextualItem
  : grenades.find((item) => getItemDamageFormula(item)) ?? grenades[0];

let weaponChoice = initialGrenade.id;
if (!contextualItem) {
  const weaponOptions = grenades.map((candidate) =>
    `<option value="${candidate.id}" ${candidate.id === initialGrenade.id ? "selected" : ""}>${foundry.utils.escapeHTML(candidate.name)}</option>`
  ).join("");
  try {
    const choice = await foundry.applications.api.DialogV2.prompt({
      window: {title: "Choose AoE Weapon"},
      content: `<div class="standard-form"><label>AoE Weapon</label><select name="grenadeId">${weaponOptions}</select></div>`,
      ok: {label: "Continue", callback: (_event, button) => button.form.elements.grenadeId.value},
      rejectClose: false, modal: false,
    });
    if (!choice) return;
    weaponChoice = choice;
  } catch { return; }
}
const grenade = weaponActor.items.get(weaponChoice);
if (!grenade) return ui.notifications.error("The selected AoE weapon could not be found.");
const selectedAoeSettings = getAoeItemSettings(grenade);
if (selectedAoeSettings.damageAction && grenade.system.actions?.additional?.[selectedAoeSettings.damageAction]?.type !== "damage") {
  return ui.notifications.warn("This item's configured AoE damage action no longer exists. Update AoE Settings before firing.");
}

// A mounted weapon always uses its assigned gunner/operator, never an
// arbitrary world actor and never a skill or operator picker.
if (weaponActor.type === "vehicle") {
  let assignedOperator = macroScope.operatorActor?.items && macroScope.operatorActor.type !== "vehicle"
    ? macroScope.operatorActor : null;
  try {
    assignedOperator ??= weaponActor.system.getCrewMemberForWeapon?.(grenade) ??
      weaponActor.system.operator ?? null;
  } catch (error) {
    console.warn("SWADE AoE Attack | Vehicle operator lookup failed", error);
  }
  if (!assignedOperator && typeof weaponActor.getDriver === "function") {
    try { assignedOperator = await weaponActor.getDriver(); } catch { /* try legacy reference */ }
  }
  if (!assignedOperator && weaponActor.system.driver?.id) {
    const reference = String(weaponActor.system.driver.id);
    assignedOperator = await fromUuid(reference).catch(() => null) ??
      game.actors?.get(reference.replace(/^Actor\./, "")) ?? null;
  }
  if (!assignedOperator || assignedOperator.type === "vehicle") {
    return ui.notifications.warn("Assign a gunner or operator to this vehicle before using its AoE weapon.");
  }
  actingActor = assignedOperator;
} else {
  actingActor = weaponActor;
}
if (!actingActor.isOwner && !game.user.isGM) return ui.notifications.error("You do not own this attack's operator.");
if (poolAttack || macroScope.skipConsumption) {
  if (!poolAttack || macroScope.skipConsumption !== true ||
      typeof isTrustedAoePoolAttack !== "function" ||
      !isTrustedAoePoolAttack(poolAttack, {item: grenade, weaponOwner: weaponActor,
        operatorActor: actingActor, token: selectedToken, point: macroScope.attackPoint})) {
    return ui.notifications.error("This AoE pool result is not authorized for this weapon, operator and blast point.");
  }
}
const nativeTrait = String(grenade.system.actions?.trait ?? "").trim();
if (!nativeTrait) return ui.notifications.warn("Set this item's Trait in its Properties before using AoE.");
const attackSkill = resolveAoeSkill(actingActor, grenade);
if (!attackSkill) return ui.notifications.warn(`${actingActor.name} does not have the item's assigned Trait (${nativeTrait}). Update its Properties or the actor's skills before using AoE.`);
const attackSkillName = String(attackSkill.name);
const rollData = actingActor.getRollData?.() ?? {};
const globalAttackModifiers = actingActor.system.stats?.globalMods ?? {};
const preparedAttackModifiers = [
  ...Array.from(attackSkill.system.effects ?? []),
  ...Array.from(globalAttackModifiers.trait ?? []),
  ...Array.from(globalAttackModifiers[attackSkill.system.attribute] ?? []),
  ...Array.from(globalAttackModifiers.attack ?? []),
].filter((modifier) => !modifier.ignore && String(modifier.value ?? "").trim());
const preparedAttackFormula = preparedAttackModifiers
  .map((modifier) => `(${String(modifier.value).trim()})`).join("+");
const itemTraitModifier = String(grenade.system.actions?.traitMod ?? "").trim();
const bennyTraitModifiers = Array.from(globalAttackModifiers.bennyTrait ?? [])
  .filter((modifier) => !modifier.ignore && String(modifier.value ?? "").trim());
// Validate saved expressions before ammunition is committed. This also catches
// a stale @field instead of silently evaluating it as zero after firing.
const validateAttackFormula = (formula) => {
  const missingReference = [...formula.matchAll(/@([A-Za-z0-9_.]+)/g)]
    .find(([, reference]) => foundry.utils.getProperty(rollData, reference) === undefined);
  if (missingReference) {
    ui.notifications.warn(`The AoE modifier references an unavailable field: @${missingReference[1]}. Update the item or actor effects before firing.`);
    return false;
  }
  const resolved = typeof Roll.replaceFormulaData === "function" ? Roll.replaceFormulaData(formula, rollData) : formula;
  if (typeof Roll.validate === "function" && !Roll.validate(resolved)) {
    ui.notifications.warn("An AoE attack modifier has an invalid roll formula. Update the item or actor effects before firing.");
    return false;
  }
  return true;
};
for (const formula of (poolAttack ? [] : [itemTraitModifier, preparedAttackFormula,
  bennyTraitModifiers.map((modifier) => `(${String(modifier.value).trim()})`).join("+")]).filter(Boolean)) {
  if (!validateAttackFormula(formula)) return;
}
const setup = macroScope.attackSetup ? {...macroScope.attackSetup} : await showAoeAttackDialog({
  item: grenade, weaponOwner: weaponActor, operatorActor: actingActor,
  attackSkill, settings: selectedAoeSettings,
  resource: aoeResource.describe(grenade, weaponActor, {
    consume: selectedAoeSettings.consume, legacyGrenade: isLegacyGrenadeItem(grenade), cost: selectedAoeSettings.ammoCost,
    mode: selectedAoeSettings.consumeMode,
  }),
});
if (!setup) return;
if (setup.theDrop !== undefined && typeof setup.theDrop !== "boolean") {
  return ui.notifications.warn("The Drop must be a checkbox value. Reopen the AoE attack panel.");
}
// A signed RoF candidate already includes its common +4 attack modifier. Its
// projectile still needs the separate +4 damage bonus, but never +4 attack again.
const theDropAttackBonus = !poolAttack && setup.theDrop === true ? 4 : 0;
const theDropDamageBonus = setup.theDrop === true ? 4 : 0;
const otherModifierFormula = String(setup.otherModifierFormula ?? setup.otherModifier ?? 0).trim() || "0";
if (!poolAttack && !validateAttackFormula(otherModifierFormula)) return;
const rawDamageModifier = String(setup.damageModifier ?? "").trim();
const preparedDamageModifier = prepareWeaponDamageModifier(rawDamageModifier, actingActor, {RollClass: Roll});
if (!preparedDamageModifier.ok) return ui.notifications.warn(preparedDamageModifier.reason);
const extraDamageModifier = [preparedDamageModifier.formula,
  theDropDamageBonus ? String(theDropDamageBonus) : ""].filter(Boolean)
  .map((formula, _index, values) => values.length > 1 ? `(${formula})` : formula).join("+");
// Like the native Mod. field, allow dice and @data expressions. Evaluate this
// attack-only modifier once, before ammunition; it stays fixed on Benny rerolls.
const otherModifierRoll = poolAttack || Number.isFinite(Number(otherModifierFormula)) ? null :
  await new Roll(otherModifierFormula, rollData).evaluate();
setup.otherModifier = poolAttack ? 0 :
  Number(otherModifierRoll?.total ?? otherModifierFormula) + Number(setup.situationalModifier ?? 0);
const resourceOptions = {
  consume: selectedAoeSettings.consumeMode !== "none" && setup.consume,
  mode: selectedAoeSettings.consumeMode,
  legacyGrenade: isLegacyGrenadeItem(grenade),
  cost: selectedAoeSettings.ammoCost,
};
const explainResourceFailure = (result) => ({
  permission: "You do not have permission to consume this item's configured resource.",
  insufficient: `${grenade.name}: not enough ${String(result.label ?? "ammunition").toLowerCase()} (${result.available}/${result.cost}).`,
  unsupported: result.source === "unsupported"
    ? `${grenade.name}: ${result.label}. Review Consume Ammunition / Consume Item in AoE Settings.`
    : "This item's resource API is unavailable. Disable consumption only if the GM will track it manually.",
  busy: "This resource is already being used by another attack. Please try again.",
  "update-failed": "The item's resource could not be updated.",
}[result.reason] ?? "The AoE item cannot expend its configured resource.");
const resourceValidation = poolAttack ? {ok: true, managed: false, consumed: 0} :
  await aoeResource.validate(grenade, weaponActor, resourceOptions);
if (!resourceValidation.ok) return ui.notifications.warn(explainResourceFailure(resourceValidation));

// Some SWADE setups keep the consumable grenade and its reusable throwing
// weapon profile as two separate Actor items. If the selected item has no
// damage, use the first grenade/throw profile that actually has damage.
const damageSourceItem = getItemDamageFormula(grenade)
  ? grenade
  : isLegacyGrenadeItem(grenade) && grenade.flags?.["swade-tools"]?.aoeEnabled !== true
    ? grenades.find((candidate) => isLegacyGrenadeItem(candidate) && getItemDamageFormula(candidate)) ?? grenade
    : grenade;

// A native consumable may be deleted when its last charge is spent. Keep the
// damage item available for SWADE Tools and the GM's Apply buttons.
if (damageSourceItem.id === grenade.id && resourceValidation.managed && resourceValidation.native &&
    resourceValidation.source === "consumable" &&
    grenade.type === "consumable" && grenade.system.destroyOnEmpty &&
    resourceValidation.available <= resourceValidation.cost) {
  return ui.notifications.warn("This AoE consumable would be deleted before damage can be resolved. Disable Destroy on Empty, use a persistent weapon profile, or let the GM track its consumption manually.");
}

const ranges = String(
  grenade.system.range || damageSourceItem.system.range || "5/10/20"
)
  .split("/")
  .map(Number)
  .filter(Number.isFinite);
const [shortRange = 5, mediumRange = shortRange * 2, longRange = shortRange * 4] =
  ranges;

const grenadeTemplateFlags = grenade.system.templates ?? {};
const templateFlags = Object.values(grenadeTemplateFlags).some(Boolean)
  ? grenadeTemplateFlags
  : damageSourceItem.system.templates ?? {};
const configuredBlastSize = selectedAoeSettings.blastSize;
const blastSizeKey = ["small", "medium", "large"].includes(configuredBlastSize)
  ? configuredBlastSize
  : templateFlags.large ? "large" : templateFlags.medium ? "medium" : "small";
const blastSize = blastSizeKey[0].toUpperCase() + blastSizeKey.slice(1);
const blastRadiusSquares = {small: 1, medium: 2, large: 3}[blastSizeKey];
const sceneDistance = Number(canvas.scene.grid.distance || 1);
const blastRadius = blastRadiusSquares * sceneDistance;

let cancelled = false;
const target = poolAttack ? macroScope.attackPoint : await Sequencer.Crosshair.show(
  {
    t: "circle",
    distance: blastRadius,
    borderColor: "#ff6b35",
    fillColor: "#ff6b35",
    fillAlpha: 0.2,
    gridHighlight: true,
    snap: {
      position:
        CONST.GRID_SNAPPING_MODES.CENTER |
        CONST.GRID_SNAPPING_MODES.VERTEX,
      resolution: 1,
    },
    label: {
      text: `${grenade.name} - ${blastSize} Blast`,
    },
    location: {
      obj: selectedToken,
      limitMaxRange: longRange,
      showRange: true,
      wallBehavior: Sequencer.Crosshair.PLACEMENT_RESTRICTIONS.ANYWHERE,
      displayRangePoly: true,
      rangePolyFillColor: 0xff6b35,
      rangePolyLineColor: 0xff6b35,
      rangePolyFillAlpha: 0.08,
      rangePolyLineAlpha: 0.5,
    },
  },
  {
    [Sequencer.Crosshair.CALLBACKS.CANCEL]: () => {
      cancelled = true;
    },
  }
);

if (
  cancelled ||
  !target ||
  !Number.isFinite(target.x) ||
  !Number.isFinite(target.y)
) {
  return;
}

// Ammunition belongs to the weapon's owner, not the selected gunner. Commit
// only after placement is accepted, once; chat Benny rerolls never revisit it.
if (!poolAttack) {
  const consumedResource = aoeResource.describe(grenade, weaponActor, resourceOptions).resource;
  const resourceSpent = await withSuppressedAoeAutomation([grenade, consumedResource],
    () => aoeResource.spend(grenade, weaponActor, resourceOptions),
    {...animationRuntime, trackConsumption: true});
  if (!resourceSpent.ok) return ui.notifications.warn(explainResourceFailure(resourceSpent));
}

const sourceCenter = selectedToken.center ?? {
  x: selectedToken.x + selectedToken.w / 2,
  y: selectedToken.y + selectedToken.h / 2,
};
const targetPoint = { x: target.x, y: target.y };
const gridSize = Number(
  canvas.grid?.size ??
  canvas.scene.grid.size ??
  canvas.dimensions?.size ??
  100
);
const straightLineDistance =
  (Math.hypot(
    targetPoint.x - sourceCenter.x,
    targetPoint.y - sourceCenter.y
  ) /
    gridSize) *
  sceneDistance;

let distance = straightLineDistance;
if (typeof canvas.grid?.measurePath === "function") {
  try {
    const measuredPath = canvas.grid.measurePath([sourceCenter, targetPoint]);
    const measuredDistance = Number(
      measuredPath?.distance ??
      measuredPath?.segments?.reduce(
        (sum, segment) => sum + Number(segment.distance ?? 0),
        0
      )
    );
    if (Number.isFinite(measuredDistance) && measuredDistance > 0) {
      distance = measuredDistance;
    }
  } catch {
    distance = straightLineDistance;
  }
}

const distanceUnits = String(canvas.scene.grid.units || "squares");
let rangeBand = "Short";
let rangePenalty = 0;
if (distance > mediumRange) {
  rangeBand = "Long";
  rangePenalty = -4;
} else if (distance > shortRange) {
  rangeBand = "Medium";
  rangePenalty = -2;
}

const woundValue = Number(actingActor.system.wounds?.value ?? 0);
const woundIgnored = Number(actingActor.system.wounds?.ignored ?? 0);
const fatigueValue = Number(actingActor.system.fatigue?.value ?? 0);
const fatigueIgnored = Number(actingActor.system.fatigue?.ignored ?? 0);
const woundPenalty = poolAttack ? 0 : -Math.max(0, woundValue - woundIgnored);
const fatiguePenalty = poolAttack ? 0 : -Math.max(0, fatigueValue - fatigueIgnored);
const skillModifier = poolAttack ? 0 : Number(attackSkill.system.die?.modifier ?? 0);
const itemModifierRoll = !poolAttack && itemTraitModifier
  ? await new Roll(itemTraitModifier, rollData).evaluate()
  : null;
const preparedModifierRoll = !poolAttack && preparedAttackFormula
  ? await new Roll(preparedAttackFormula, rollData).evaluate()
  : null;
const trademarkModifier = poolAttack ? 0 : Number(grenade.system.trademark ?? 0);
const baseThrowModifier = poolAttack ? Number(poolAttack.baseModifier) + rangePenalty :
  rangePenalty +
  woundPenalty +
  fatiguePenalty +
  skillModifier +
  Number(itemModifierRoll?.total ?? 0) +
  Number(preparedModifierRoll?.total ?? 0) +
  trademarkModifier +
  theDropAttackBonus +
  Number(setup.otherModifier ?? 0);

const traitSides = Number(attackSkill.system.die?.sides ?? 4);
const wildSides = Number(attackSkill.system["wild-die"]?.sides ?? 6);
const isWildCard = Boolean(actingActor.system.wildcard);

// Resolve the first attempt immediately. Later Benny rerolls change the skill
// on this same attack without creating another template or consuming ammunition.
const getGrenadeSetting = (namespace, key, fallback) => {
  try {
    return game.settings.get(namespace, key) ?? fallback;
  } catch {
    return fallback;
  }
};
const dumbLuckEnabled = Boolean(
  getGrenadeSetting("swade", "dumbLuck", false) ||
    getGrenadeSetting("swade-tools", "DumbLuckSetting", false)
);
const getAvailableBennies = (spender) => {
  const value = Number(
    spender?.bennies ?? spender?.system?.bennies?.value ?? 0
  );
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const rollGrenadeAthleticsAttempt = async (isBennyReroll = false) => {
  const traitRoll = await new Roll(`1d${traitSides}x`).evaluate();
  const wildRoll = isWildCard
    ? await new Roll(`1d${wildSides}x`).evaluate()
    : null;
  let bennyModifierRoll = null;
  if (isBennyReroll && bennyTraitModifiers.length) {
    const formula = bennyTraitModifiers
      .map((modifier) => `(${String(modifier.value).trim()})`)
      .join("+");
    bennyModifierRoll = await new Roll(
      formula,
      actingActor.getRollData?.() ?? {}
    ).evaluate();
  }
  // Start from the original modifiers every time: Elan and other prepared
  // Benny Trait effects apply once, never stack across successive rerolls.
  const totalModifier =
    baseThrowModifier + Number(bennyModifierRoll?.total ?? 0);
  const traitInitial = traitRoll.dice[0]?.results[0]?.result;
  const wildInitial = wildRoll?.dice[0]?.results[0]?.result;
  // Match SWADE's Extra confirmation: a natural 1 is always a failed
  // attempt, but only a further non-acing d6 result of 1 is a Critical Failure.
  const naturalOneFailure = !isWildCard && traitInitial === 1;
  const criticalConfirmationRoll = naturalOneFailure
    ? await new Roll("1d6", {}, {critfailConfirmationRoll: true}).evaluate()
    : null;
  const criticalFailure = isWildCard
    ? traitInitial === 1 && wildInitial === 1
    : naturalOneFailure && criticalConfirmationRoll.total === 1;
  const bestDie = wildRoll
    ? Math.max(traitRoll.total, wildRoll.total)
    : traitRoll.total;
  const chosenDie =
    wildRoll && wildRoll.total > traitRoll.total ? "Wild Die" : "Trait Die";
  return {
    traitRoll, wildRoll, bennyModifierRoll, criticalConfirmationRoll, totalModifier,
    criticalFailure, naturalOneFailure, bestDie, chosenDie,
    total: bestDie + totalModifier,
    isBennyReroll,
  };
};

const getAthleticsAttemptLabel = (attempt) =>
  attempt.criticalFailure
    ? "Critical Failure"
    : attempt.naturalOneFailure
      ? "Failure - Resolve Deviation"
      : attempt.total >= 8
      ? "Success with a Raise"
      : attempt.total >= 4
        ? "Success"
        : "Failure - Resolve Deviation";

const poolNaturalOneFailure = poolAttack && !isWildCard &&
  poolAttack.rawRoll.dice?.[0]?.results?.[0]?.result === 1;
let athleticsAttempt = poolAttack ? {
  traitRoll: poolAttack.source === "wild" ? null : poolAttack.rawRoll,
  wildRoll: poolAttack.source === "wild" ? poolAttack.rawRoll : null,
  bennyModifierRoll: null, criticalConfirmationRoll: null,
  totalModifier: baseThrowModifier,
  criticalFailure: poolAttack.criticalFailure,
  naturalOneFailure: Boolean(poolNaturalOneFailure),
  bestDie: poolAttack.rawTotal,
  chosenDie: poolAttack.source === "wild" ? "Wild Die" : "Trait Die",
  total: poolAttack.rawTotal + baseThrowModifier,
  isBennyReroll: false,
} : await rollGrenadeAthleticsAttempt();
const athleticsAttempts = [athleticsAttempt];
let athleticsReviewNote = "";
let athleticsDamageReviewNote = "";
let athleticsBenniesSpent = 0;
let athleticsRerollInProgress = false;
let grenadeThrowReady = false;

let {
  traitRoll, wildRoll, bennyModifierRoll, criticalConfirmationRoll, criticalFailure, naturalOneFailure,
  bestDie, chosenDie, total, totalModifier,
} = athleticsAttempt;
let success = !criticalFailure && !naturalOneFailure && total >= 4;
let raise = success && total >= 8;

const syncGrenadeAthleticsResult = () => {
  ({
    traitRoll, wildRoll, bennyModifierRoll, criticalConfirmationRoll, criticalFailure, naturalOneFailure,
    bestDie, chosenDie, total, totalModifier,
  } = athleticsAttempt);
  success = !criticalFailure && !naturalOneFailure && total >= 4;
  raise = success && total >= 8;
};

const getAthleticsHistoryHtml = () => athleticsAttempts.length > 1
  ? `<p style="margin:4px 0"><strong>Roll history:</strong> ${athleticsBenniesSpent} ${athleticsBenniesSpent === 1 ? "Benny" : "Bennies"} spent</p>
     <table style="font-size:11px;margin:4px 0"><thead><tr><th>Attempt</th><th>Trait</th><th>Wild</th><th>Mod.</th><th>Total</th>${isWildCard ? "" : "<th>Confirm d6</th>"}</tr></thead>
     <tbody>${athleticsAttempts.map((attempt, index) =>
       `<tr><td>${index === 0 ? "Initial" : `Benny ${index}`}${attempt === athleticsAttempt ? " (used)" : ""}</td>
        <td>${attempt.traitRoll.total}</td><td>${attempt.wildRoll?.total ?? "—"}</td>
        <td>${attempt.totalModifier}</td><td>${attempt.total}${attempt.criticalFailure ? " — Critical Failure" : attempt.naturalOneFailure ? " — Natural 1 failure" : ""}</td>${isWildCard ? "" : `<td>${attempt.criticalConfirmationRoll?.total ?? "—"}</td>`}</tr>`
     ).join("")}</tbody></table>`
  : "";


const grenadeBennyKey = foundry.utils.randomID();
const grenadeBennyRuntime = globalThis.__swadeGrenadeBennyRuntime ??= {
  handlers: new Map(),
  listening: false,
};
if (!grenadeBennyRuntime.listening) {
  grenadeBennyRuntime.listening = true;
  globalThis.document.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("button[data-grenade-benny]");
    if (!button || button.disabled) return;
    event.preventDefault();
    const reroll = grenadeBennyRuntime.handlers.get(button.dataset.grenadeBenny);
    if (!reroll) {
      ui.notifications.warn("This AoE attack's Benny reroll session has expired.");
      return;
    }
    try {
      await reroll(button.dataset.bennySource, button.dataset.grenadeMessage);
    } catch (error) {
      console.error("SWADE AoE Attack | Skill reroll failed", error);
      ui.notifications.error("The AoE skill reroll could not be completed.");
    }
  });
  Hooks.on("deleteChatMessage", (message) => {
    const key = message.flags?.world?.grenadeBennySession;
    const reroll = key ? grenadeBennyRuntime.handlers.get(key) : null;
    // A superseded card (including a stale pre-update document) must never
    // delete the shared session belonging to the current attack card.
    if (reroll && reroll.activeMessageId === message.id) {
      reroll.cleanup?.();
      grenadeBennyRuntime.handlers.delete(key);
    }
  });
}

const getGrenadeBennyControlsHtml = () => {
  if (poolAttack) return `<div class="swadetools-aoe-pool-result" style="font-size:11px;margin-top:4px">Pool result ${poolAttack.candidateIndex + 1}: ${foundry.utils.escapeHTML(poolAttack.label)}. Benny rerolls were resolved on the complete pool.</div>`;
  if (criticalFailure && !dumbLuckEnabled) {
    return '<div style="font-size:11px;margin-top:4px" title="Critical Failure rerolls require Dumb Luck.">Benny locked (Critical Failure)</div>';
  }
  const disabled = !grenadeThrowReady || athleticsRerollInProgress
    ? "disabled"
    : "";
  const actorBennies = getAvailableBennies(actingActor);
  const gmBennies = game.user.isGM ? getAvailableBennies(game.user) : 0;
  const buttons = [];
  if (actingActor.isOwner && actorBennies > 0 && typeof actingActor.spendBenny === "function") {
    buttons.push(`<button type="button" data-grenade-benny="${grenadeBennyKey}"
      data-grenade-message="${throwMessage?.id ?? ""}" data-benny-source="actor" style="height:24px;line-height:20px;font-size:12px;margin:0" title="Reroll this attack skill only; no additional ammunition or items are consumed." ${disabled}><i class="fa-solid fa-dice"></i>
      Benny Reroll (${actorBennies})</button>`);
  }
  if (game.user.isGM && gmBennies > 0 && typeof game.user.spendBenny === "function") {
    buttons.push(`<button type="button" data-grenade-benny="${grenadeBennyKey}"
      data-grenade-message="${throwMessage?.id ?? ""}" data-benny-source="gm" style="height:24px;line-height:20px;font-size:12px;margin:0" title="Spend a GM Benny to reroll this attack skill only." ${disabled}><i class="fa-solid fa-dice"></i>
      GM Reroll (${gmBennies})</button>`);
  }
  return buttons.length
    ? `<div class="swadetools-aoe-bennies" style="display:flex;gap:4px;margin-top:4px">${buttons.join("")}</div>`
    : '<div style="font-size:11px;margin-top:4px">No Bennies.</div>';
};


const templateColor = success ? "#ff6b35" : "#d62828";
const templateData = {
  t: "circle",
  author: game.user.id,
  x: target.x,
  y: target.y,
  distance: blastRadius,
  direction: 0,
  fillColor: templateColor,
  borderColor: templateColor,
  flags: {
    world: {
      grenadeItemUuid: grenade.uuid,
      aoeItemUuid: grenade.uuid,
      aoeWeaponActorUuid: weaponActor.uuid,
      aoeAttackSkillUuid: attackSkill.uuid,
      throwerActorUuid: actingActor.uuid,
      throwSucceeded: success,
      pendingDeviation: !success,
    },
  },
};

const [templateDocument] = await canvas.scene.createEmbeddedDocuments(
  "MeasuredTemplate",
  [templateData]
);

let throwMessage = null;
const getBlastTargetNames = (targets) =>
  targets.map(
    (targetToken) => targetToken.name || targetToken.actor?.name || "Unknown"
  );
const getBlastTargetsHtml = (targets) => {
  const names = getBlastTargetNames(targets);
  const status = success ? "Hit" : "Blast";
  const borderColor = success ? "#1b7f3a" : "#8a6d3b";
  return `<div style="font-size:11px;margin-bottom:2px"><strong>Targets:</strong>${names.length ? "" : " None"}</div>${names.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:3px">${names.map((name) =>
      `<div class="swadetools-aoe-target" style="flex:1 1 140px;border:1px solid ${borderColor};border-radius:3px;padding:2px 5px;font-size:12px;line-height:17px;overflow-wrap:anywhere"><i class="fa-solid fa-bullseye" aria-hidden="true"></i> ${foundry.utils.escapeHTML(name)}: <strong>${status}</strong></div>`
    ).join("")}</div>`
    : ""}`;
};
const updateBlastTargetText = async (targets) => {
  if (!throwMessage) return;
  const wrapper = globalThis.document.createElement("div");
  wrapper.innerHTML = throwMessage.content;
  const targetLine = wrapper.querySelector("[data-grenade-targets]");
  if (!targetLine) return;
  targetLine.innerHTML = getBlastTargetsHtml(targets);
  await throwMessage.update({ content: wrapper.innerHTML });
};

const collectTokensInBlast = (centerX, centerY, notificationLabel) => {
  const radiusPixels =
    (blastRadius / Math.max(sceneDistance, Number.EPSILON)) * gridSize;
  const blastTargets = canvas.tokens.placeables.filter((candidate) => {
    if (!candidate.actor || candidate.isVisible === false) return false;
    const candidateCenter = candidate.center ?? candidate.getCenterPoint?.();
    if (!candidateCenter) return false;
    return (
      Math.hypot(
        Number(candidateCenter.x) - Number(centerX),
        Number(candidateCenter.y) - Number(centerY)
      ) <= radiusPixels + 0.5
    );
  });

  const targetCount = blastTargets.length;
  ui.notifications.info(
    `${notificationLabel}: ${targetCount} token${targetCount === 1 ? "" : "s"} inside the blast.`
  );
  return blastTargets;
};

let blastTargets = collectTokensInBlast(
  Number(templateDocument.x),
  Number(templateDocument.y),
  `${grenade.name} blast`
);
let deviationDamageTargets = null;
let runGrenadeDamageForTargets = null;
let damageWorkflowStarted = false;
let suppressDeviationUpdate = false;
let cleanupDeviationTargeting = () => {};

// A failed throw may require moving the red template for deviation. Refresh
// the chat-card name list once when this specific template is moved.
const armGrenadeDeviation = () => {
  cleanupDeviationTargeting();
  let updateTemplateHookId;
  let deleteTemplateHookId;
  let cleanupTimer;
  cleanupDeviationTargeting = () => {
    if (updateTemplateHookId !== undefined) {
      Hooks.off("updateMeasuredTemplate", updateTemplateHookId);
    }
    if (deleteTemplateHookId !== undefined) {
      Hooks.off("deleteMeasuredTemplate", deleteTemplateHookId);
    }
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
  };

  updateTemplateHookId = Hooks.on(
    "updateMeasuredTemplate",
    async (document, changes) => {
      if (document.id !== templateDocument.id || suppressDeviationUpdate || success) return;
      if (!("x" in changes) && !("y" in changes)) return;
      blastTargets = collectTokensInBlast(
        Number(document.x),
        Number(document.y),
        `${grenade.name} deviated blast`
      );
      await updateBlastTargetText(blastTargets);
      deviationDamageTargets = [...blastTargets];
      if (typeof runGrenadeDamageForTargets === "function") {
        await runGrenadeDamageForTargets(deviationDamageTargets);
      }
      cleanupDeviationTargeting();
    }
  );
  deleteTemplateHookId = Hooks.on("deleteMeasuredTemplate", (document) => {
    if (document.id === templateDocument.id) cleanupDeviationTargeting();
  });
  cleanupTimer = setTimeout(cleanupDeviationTargeting, 5 * 60 * 1000);
};
if (!success && templateDocument) armGrenadeDeviation();

const useThrownProjectile = isLegacyGrenadeItem(grenade) &&
  /athletics/i.test(attackSkillName);
// No flags.swade.origin: AA must not also animate createMeasuredTemplate.
const animationResult = await playAoeAnimation({sourceToken: selectedToken,
  item: grenade, templateDocument, targets: blastTargets, success,
  throwProjectile: useThrownProjectile, blastDiameter: blastRadiusSquares * 2,
  projectileEffect: PROJECTILE_EFFECT, impactEffect: IMPACT_EFFECT}, animationRuntime);
if (animationResult.reason === "missing-assets") {
  ui.notifications.warn(
    "AoE attack resolved, but the configured JB2A projectile or explosion path was not found."
  );
}

let resultLabel = criticalFailure
  ? "Critical Failure"
  : raise
    ? "Success with a Raise"
    : success
      ? "Success"
      : "Failure - Resolve Deviation";
let resultColor = success ? "#1b7f3a" : "#a61b1b";
const baseDamage = String(damageSourceItem.system.damage ?? "").trim();
const additionalActions =
  foundry.utils.getProperty(damageSourceItem, "system.actions.additional") ?? {};
const damageActionEntries = Object.entries(additionalActions).filter(
  ([, action]) => action?.type === "damage"
);
const configuredDamageActions = damageActionEntries.filter(([, action]) =>
  getDamageActionFormula(action)
);
const savedDamageActionKey = selectedAoeSettings.damageAction;
const selectedDamageActionEntry =
  (savedDamageActionKey ? damageActionEntries.find(([key]) => key === savedDamageActionKey) : null) ??
  (baseDamage ? null : configuredDamageActions.find(([, action]) =>
    /damage|hasar/i.test(String(action?.name ?? ""))
  ) ?? configuredDamageActions[0] ?? damageActionEntries[0] ?? null);
const selectedDamageAction = selectedDamageActionEntry?.[1] ?? null;
const damageOverride = getDamageActionFormula(selectedDamageAction);
const damage = damageOverride || baseDamage;

// Match SWADE's own item damage action: base AP plus the actor's global AP
// modifiers, the item's damage modifier, and the item's configured Raise die.
let ap = Number(
  selectedDamageAction?.ap ?? damageSourceItem.system.ap ?? 0
);
for (const modifier of actingActor.system.stats?.globalMods?.ap ?? []) {
  ap += Number(modifier.value ?? 0);
}
const isHeavyDamage = Boolean(
  damageSourceItem.system.isHeavyWeapon || selectedDamageAction?.isHeavyWeapon
);

const bonusDamageDice = Number(damageSourceItem.system.bonusDamageDice ?? 1);
const bonusDamageSides = Number(damageSourceItem.system.bonusDamageDie ?? 6);
const raiseDamageFormula = `+${bonusDamageDice}d${bonusDamageSides}x`;
const damageSourceLine =
  damageSourceItem.id !== grenade.id
    ? `<br><small>Damage source: ${foundry.utils.escapeHTML(
        damageSourceItem.name
      )}</small>`
    : "";
const renderGrenadeThrowContent = async () => {
  const escape = foundry.utils.escapeHTML;
  const signed = (value) => `${value >= 0 ? "+" : ""}${value}`;
  const compactResultLabel = criticalFailure ? "Critical Failure" : raise ? "Raise" : success ? "Success" : "Failure";
  const modifierParts = [
    ["Pool", poolAttack ? poolAttack.baseModifier : 0],
    ["Range", rangePenalty], ["Wounds", woundPenalty], ["Fatigue", fatiguePenalty],
    ["Skill", skillModifier], ["Item", Number(itemModifierRoll?.total ?? 0)],
    ["Trademark", trademarkModifier], ["Effects", Number(preparedModifierRoll?.total ?? 0)],
    ["The Drop", theDropAttackBonus],
    ["Other", Number(setup.otherModifier ?? 0)], ["Benny", Number(bennyModifierRoll?.total ?? 0)],
  ].filter(([, value]) => value !== 0).map(([label, value]) => `${label} ${signed(value)}`).join(", ");
  const preparedEffectsSummary = (poolAttack ? [] : preparedAttackModifiers).map((modifier) =>
    `${String(modifier.label ?? "Effect")}: ${String(modifier.value)}`
  ).join(", ");
  const situationalSummary = setup.modifierParts ? [
    ["Mod.", setup.modifierParts.modifier], ["Multi-Action", setup.modifierParts.multiAction],
    ["Cover", setup.modifierParts.cover], ["Illumination", setup.modifierParts.illumination],
  ].filter(([, value]) => String(value ?? "").trim() && Number(value) !== 0)
    .map(([label, value]) => `${label} ${value}`).join("; ") : "";
  // Keep plain Roll documents on the message, but render their dice together
  // once. Foundry skips automatic Roll HTML when custom child HTML is present.
  const dieResultsHtml = (roll, sides, role) => {
    if (!roll) return "";
    const used = chosenDie === `${role} Die`;
    const results = roll.dice.flatMap((die) => die.results)
      .filter((result) => result.active !== false && !result.discarded);
    const values = results.length ? results.map((result) => result.result) : [roll.total];
    const hint = escape(`${role}: ${roll.formula} = ${roll.total}${used ? " (used)" : ""}`);
    return `<li style="font-size:10px;align-self:center;opacity:${used ? "1" : ".65"}">${role}</li>${values.map((value) =>
      `<li class="die" title="${hint}" style="background-image:url(icons/svg/d${sides}-grey.svg);background-size:contain;background-repeat:no-repeat;background-position:center;width:28px;height:28px;flex:0 0 28px;list-style:none;opacity:${used ? "1" : ".6"}"><label style="display:block;text-align:center;line-height:28px;font-weight:${used ? "bold" : "normal"};color:${used ? resultColor : "inherit"}">${escape(value)}</label></li>`
    ).join("")}`;
  };
  const damageLine = damage
    ? `<div><strong>Damage${selectedDamageAction?.name ? ` (${escape(selectedDamageAction.name)})` : ""}:</strong> ${escape(damage)}; AP ${ap}${raise ? `; Raise bonus ${raiseDamageFormula}` : ""}${damageSourceLine}</div>`
    : `<div><strong>Damage:</strong> No direct damage is configured on this item.</div>`;
  const confirmationDetails = criticalConfirmationRoll
    ? `<div><strong>Extra confirmation:</strong> d6 = ${criticalConfirmationRoll.total}. ${criticalFailure ? "Confirmed Critical Failure." : "Critical Failure not confirmed. The natural 1 remains a failed attack regardless of modifiers."}</div>` : "";
  const gmReview = athleticsDamageReviewNote
    ? `<div data-aoe-gm-review style="color:#a61b1b;font-size:12px;margin:4px 0"><strong>GM: ${raise && /gained a Raise/.test(athleticsDamageReviewNote) ? `review existing damage and its ${raiseDamageFormula} Raise bonus.` : "review existing damage and blast result."}</strong></div>` : "";
  return `<article class="swade chat-card swadetools-pseudocard swadetools-aoe-card">
    <header class="card-header flexrow" style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
      <img src="${escape(grenade.img || "icons/svg/explosion.svg")}" alt="${escape(grenade.name)}" width="32" height="32" style="flex:0 0 32px;object-fit:contain;border:0">
      <strong style="font-size:15px;line-height:18px">${escape(grenade.name)}</strong>
    </header>
    <div class="swadetools-aoe-skill" style="font-size:12px;line-height:18px"><strong>${escape(attackSkillName)}:</strong> <span style="color:${resultColor};font-weight:bold">${compactResultLabel}</span></div>
    ${athleticsAttempts.length > 1 && athleticsAttempts.at(-1) !== athleticsAttempt ? `<div style="font-size:11px;line-height:16px">Previous result kept (reroll ${athleticsAttempts.at(-1).total}${athleticsAttempts.at(-1).naturalOneFailure ? ", natural 1" : ""}).</div>` : ""}
    ${modifierParts ? `<div class="swadetools-aoe-modifiers" style="font-size:11px;line-height:16px">${escape(modifierParts)}</div>` : ""}
    <div class="dice-roll" style="margin:3px 0"><div class="dice-result">
      <div class="dice-formula" style="padding:2px"><ol class="formula-list" style="display:flex;align-items:center;justify-content:center;gap:4px;list-style:none;margin:0;padding:0">${dieResultsHtml(traitRoll, traitSides, "Trait")}${dieResultsHtml(wildRoll, wildSides, "Wild")}${totalModifier ? `<li style="font-size:12px" title="Total Modifier">${signed(totalModifier)}</li>` : ""}</ol></div>
      <div class="dice-total" style="font-size:20px;line-height:26px;color:${resultColor}">${total}</div>
    </div></div>
    <div data-grenade-targets style="margin:4px 0">${getBlastTargetsHtml(blastTargets)}</div>
    ${success ? "" : '<div style="font-size:11px;margin:4px 0"><strong>Deviation:</strong> GM: move the red template to resolve.</div>'}
    ${gmReview}
    ${getGrenadeBennyControlsHtml()}
    <details class="swadetools-aoe-details" style="font-size:11px;margin-top:4px">
      <summary style="cursor:pointer">Details</summary>
      ${weaponActor.type === "vehicle" ? `<div><strong>Operator:</strong> ${escape(actingActor.name)}; <strong>Vehicle:</strong> ${escape(weaponActor.name)}</div>` : ""}
      <div><strong>Range:</strong> ${distance.toFixed(1)} ${escape(distanceUnits)}, ${rangeBand} (${rangePenalty})</div>
      <div><strong>Blast:</strong> ${blastSize} Blast Template</div>
      ${damageLine}
      <div><strong>Used:</strong> ${chosenDie} ${bestDie} ${signed(totalModifier)} = ${total}; ${resultLabel}</div>
      ${totalModifier ? `<div><strong>Total Modifier:</strong> ${signed(totalModifier)}</div>` : ""}
      ${situationalSummary ? `<div>Other Modifiers: ${escape(situationalSummary)}</div>` : ""}
      ${preparedEffectsSummary ? `<div>Prepared effects: ${escape(preparedEffectsSummary)}</div>` : ""}
      ${confirmationDetails}
      ${getAthleticsHistoryHtml()}
      ${athleticsReviewNote ? `<div>${escape(athleticsReviewNote)}</div>` : ""}
      ${athleticsDamageReviewNote ? `<div>${escape(athleticsDamageReviewNote)}</div>` : ""}
    </details>
  </article>`;
};

const getGrenadeThrowRolls = () => {
  const latestAttempt = athleticsAttempts.at(-1);
  return [...new Set([
    traitRoll, wildRoll, criticalConfirmationRoll, itemModifierRoll, preparedModifierRoll, otherModifierRoll, bennyModifierRoll,
    // A lower reroll still happened. Preserve its dice record on the new
    // card even when the effective result keeps the earlier higher dice.
    ...(latestAttempt !== athleticsAttempt ? [latestAttempt.traitRoll, latestAttempt.wildRoll,
      latestAttempt.criticalConfirmationRoll, latestAttempt.bennyModifierRoll] : []),
  ].filter(Boolean))];
};
const updateGrenadeThrowMessage = async () => {
  if (!throwMessage) return;
  await throwMessage.update({
    rolls: getGrenadeThrowRolls().map((roll) => roll.toJSON()),
    content: await renderGrenadeThrowContent(),
  });
};

const createGrenadeThrowMessage = async (previousMessage = null) => ChatMessage.create({
  user: game.user.id,
  speaker: ChatMessage.getSpeaker({
    actor: actingActor,
    token: selectedToken.document,
  }),
  rolls: getGrenadeThrowRolls(),
  flags: { world: { ...(poolAttack ? {aoePoolId: poolAttack.poolId,
      aoePoolCandidate: poolAttack.candidateIndex} : {grenadeBennySession: grenadeBennyKey}),
    ...(previousMessage ? {aoePreviousMessage: previousMessage.id} : {}),
  } },
  content: await renderGrenadeThrowContent(),
});
const supersedeGrenadeThrowMessage = async (previousMessage, previousContent) => {
  if (!previousMessage) return;
  const passiveContent = previousContent.replace(
    /<div class="swadetools-aoe-bennies"[^>]*>[\s\S]*?<\/div>/g, ""
  );
  await previousMessage.update({
    "flags.world.grenadeBennySession": null,
    "flags.world.aoeSuperseded": true,
    "flags.world.aoeSupersededBy": throwMessage.id,
    content: `<div class="swadetools-aoe-superseded" data-aoe-superseded style="opacity:.5;filter:grayscale(1)">${passiveContent}</div><div style="font-size:11px;margin-top:3px">Superseded by Benny reroll.</div>`,
  });
};
throwMessage = await createGrenadeThrowMessage();

// Use SWADE Tools' own item dialog and Damage button. Blast token IDs are
// written directly into the damage message, so no Foundry target rings are
// created or changed on the player's client.
if (damage) {
  const additionalMods = [];
  const damageActionModifier = String(
    selectedDamageAction?.modifier ?? ""
  ).trim();
  const itemDamageModifier = String(
    foundry.utils.getProperty(
      damageSourceItem,
      "system.actions.dmgMod"
    ) ?? ""
  ).trim();

  if (damageActionModifier) {
    additionalMods.push({
      label:
        String(selectedDamageAction?.name ?? "").trim() ||
        game.i18n.localize("SWADE.Dmg"),
      value: damageActionModifier,
    });
  }

  if (itemDamageModifier) {
    additionalMods.push({
      label: itemDamageModifier.startsWith("@")
        ? ""
        : `${damageSourceItem.name} ${game.i18n.localize("SWADE.ItemDmgMod")}`,
      value: itemDamageModifier,
    });
  }

  if (extraDamageModifier) {
    additionalMods.push({label: game.i18n.localize("SWADE.Additional"),
      value: extraDamageModifier});
  }

  const postDamageMessage = async (damageRoll, targetsForDamage) => {
    damageRoll.ap = ap;
    damageRoll.isHeavyWeapon = isHeavyDamage;
    const apLabel = game.i18n.localize("SWADE.Ap");
    const damageLabel = game.i18n.localize("SWADE.Dmg");
    const raiseLabel = raise ? ` - ${resultLabel}` : "";
    const singleTargetName =
      targetsForDamage.length === 1
        ? targetsForDamage[0].name ||
          targetsForDamage[0].actor?.name ||
          "Unknown"
        : "";
    const targetLabel = singleTargetName
      ? ` -> ${foundry.utils.escapeHTML(singleTargetName)}`
      : "";
    const damageMessage = await damageRoll.toMessage({
      flavor: `${grenade.name} ${damageLabel}${targetLabel} - ${apLabel} ${ap}${raiseLabel}`,
      speaker: ChatMessage.getSpeaker({
        actor: actingActor,
        token: selectedToken.document,
      }),
      flags: {
        swade: {
          targets: targetsForDamage.map((targetToken) => ({
            name: targetToken.name || targetToken.actor?.name || "Unknown",
            uuid: targetToken.document.uuid,
          })),
        },
      },
    });
    if (damageMessage?.id && typeof damageRoll.setMessageId === "function") {
      damageRoll.setMessageId(damageMessage.id);
    }
    return damageMessage;
  };

  const createDirectDamageRoll = async (targetsForDamage) => {
    const DamageRollClass = CONFIG.Dice?.DamageRoll;
    if (typeof DamageRollClass !== "function") {
      throw new Error("CONFIG.Dice.DamageRoll is unavailable.");
    }

    const directModifiers = [
      ...(actingActor.system.stats?.globalMods?.damage ?? []),
      ...additionalMods,
      ...(raise ? [{
        label: game.i18n.localize("SWADE.BonusDamage"),
        value: raiseDamageFormula,
      }] : []),
    ];

    if (
      game.settings.get("swade", "enableConviction") &&
      foundry.utils.getProperty(
        actingActor.system,
        "details.conviction.active"
      )
    ) {
      directModifiers.push({
        label: game.i18n.localize("SWADE.Conv"),
        value: "+1d6x",
      });
    }

    if (actingActor.hasJoker) {
      directModifiers.push({
        label: game.i18n.localize("SWADE.Joker"),
        value: actingActor.getFlag("swade", "jokerBonus") ?? 2,
      });
    }

    const modifierFormula = directModifiers
      .filter((modifier) => !modifier.ignore)
      .map((modifier) => {
        const rawValue = String(modifier.value ?? "").trim();
        if (!rawValue) return "";
        const signedValue = rawValue.startsWith("@")
          ? `+${rawValue}`
          : /^[+-]/.test(rawValue)
            ? rawValue
            : `+${rawValue}`;
        const label = String(modifier.label ?? "")
          .replace(/[\[\]]/g, "")
          .trim();
        return label ? `${signedValue}[${label}]` : signedValue;
      })
      .join("");

    const directDamageRoll = new DamageRollClass(
      `${damage}${modifierFormula}`,
      actingActor.getRollData?.() ?? {},
      {
        acing: true,
        modifiers: directModifiers,
      }
    );
    await postDamageMessage(directDamageRoll, targetsForDamage);
    return directDamageRoll;
  };

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
        if (String(dialog.title ?? "") !== String(damageSourceItem.name)) return;
        const root = html?.querySelector ? html : html?.[0] ?? dialog.element?.[0];
        if (!root?.querySelectorAll) return;
        const hasDamageButton = Array.from(
          root.querySelectorAll("button[data-button]")
        ).some(
          (button) =>
            button.dataset.button === "mainDamage" ||
            (selectedDamageActionEntry && button.dataset.button === String(selectedDamageActionEntry[0])) ||
            /^(damage|hasar)$/i.test(String(button.textContent ?? "").trim())
        );
        if (!hasDamageButton) return;
        cleanup({ dialog, root });
      });
      timer = setTimeout(() => cleanup(null), timeoutMs);
    });

  const injectBlastTargetsIntoNextSwadeToolsDamage = (
    targetsForDamage,
    timeoutMs = 8000
  ) =>
    new Promise((resolve) => {
      const targetIds = targetsForDamage
        .map((targetToken) => targetToken.id)
        .filter(Boolean)
        .join(",");
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
            message.flags?.["swade-tools"] ?? data.flags?.["swade-tools"];
          if (swadeToolsFlags?.rolltype !== "damage") return;
          if (swadeToolsFlags?.itemroll !== damageSourceItem.id) return;

          // SWADE Tools reads this comma-separated list before calculating
          // Toughness, AP, Shaken and Wounds. No Foundry target rings are used.
          message.updateSource({
            "flags.swade-tools.usetarget": targetIds,
          });
          cleanup(message);
        }
      );
      timer = setTimeout(() => cleanup(null), timeoutMs);
    });

  const findDialogDamageButton = (root) => {
    const buttons = Array.from(root.querySelectorAll("button"));
    const damageActionKey = String(selectedDamageActionEntry?.[0] ?? "");

    if (damageActionKey) {
      const actionButton = buttons.find(
        (button) => button.dataset.button === damageActionKey
      );
      if (actionButton) return actionButton;
    }

    return (
      buttons.find((button) => button.dataset.button === "mainDamage") ??
      buttons.find((button) =>
        /^(damage|hasar)$/i.test(String(button.textContent ?? "").trim())
      ) ??
      null
    );
  };

  const prepareSwadeToolsDamageDialog = (root) => {
    const raiseCheckbox = root.querySelector("#raise");
    if (raiseCheckbox) raiseCheckbox.checked = raise;

    const damageModifierInput = root.querySelector("#mod");
    if (damageModifierInput && extraDamageModifier) {
      const existing = String(damageModifierInput.value ?? "").trim();
      damageModifierInput.value = existing
        ? `(${existing})+(${extraDamageModifier})` : extraDamageModifier;
    }

    const damageActionKey = String(selectedDamageActionEntry?.[0] ?? "");
    const damageActionSelect = root.querySelector("#actiondmg");
    if (
      damageActionKey &&
      damageActionSelect &&
      Array.from(damageActionSelect.options ?? []).some(
        (option) => option.value === damageActionKey
      )
    ) {
      damageActionSelect.value = damageActionKey;
    }
  };

  const swadeToolsIsAvailable =
    game.modules.get("swade-tools")?.active &&
    typeof game.swadetools?.item === "function";

  const rollDamageWithSwadeTools = async (targetsForDamage) => {
    if (!swadeToolsIsAvailable) {
      throw new Error("SWADE Tools item API is unavailable.");
    }

    const dialogPromise = waitForSwadeToolsDialog();
    await game.swadetools.item(weaponActor, damageSourceItem.id, actingActor, {damageOnly: true});
    const dialogInfo = await dialogPromise;
    if (!dialogInfo?.root) {
      throw new Error("The SWADE Tools item dialog was not rendered.");
    }

    prepareSwadeToolsDamageDialog(dialogInfo.root);
    const damageButton = findDialogDamageButton(dialogInfo.root);
    if (!damageButton) {
      throw new Error("The SWADE Tools Damage button was not found.");
    }

    const targetInjectionPromise =
      injectBlastTargetsIntoNextSwadeToolsDamage(targetsForDamage);
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

  runGrenadeDamageForTargets = async (targetsForDamage) => {
    if (damageWorkflowStarted) return;

    const uniqueTargets = Array.from(
      new Map(
        targetsForDamage
          .filter((targetToken) => targetToken?.actor && targetToken?.document)
          .map((targetToken) => [targetToken.document.uuid, targetToken])
      ).values()
    );

    if (!uniqueTargets.length) {
      ui.notifications.warn(`${grenade.name}: no blast targets found.`);
      return;
    }

    if (!swadeToolsIsAvailable) {
      ui.notifications.error(
        `${grenade.name}: SWADE Tools is not active; damage was not rolled.`
      );
      return;
    }

    damageWorkflowStarted = true;
    let completed = 0;
    for (const targetToken of uniqueTargets) {
      try {
        // Open SWADE Tools for one target at a time. Each click creates a
        // separate SWADE Tools damage roll/card and only that target ID is
        // injected into the card.
        await withSuppressedAoeAutomation([grenade, damageSourceItem],
          () => rollDamageWithSwadeTools([targetToken]), animationRuntime);
        completed += 1;

        // Give the previous SWADE Tools Dialog/chat workflow time to close
        // before opening the next target's independent damage dialog.
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (targetDamageError) {
        console.error(
          `SWADE AoE Attack | SWADE Tools damage failed for ${
            targetToken.name || targetToken.actor?.name || "Unknown"
          }`,
          targetDamageError
        );
        ui.notifications.error(
          `${grenade.name}: SWADE Tools damage failed for ${
            targetToken.name || targetToken.actor?.name || "Unknown"
          }.`
        );
      }
    }

    ui.notifications.info(
      `${grenade.name}: ${completed}/${uniqueTargets.length} independent SWADE Tools damage rolls completed.`
    );
  };

  if (success) {
    await runGrenadeDamageForTargets(blastTargets);
  } else if (deviationDamageTargets) {
    await runGrenadeDamageForTargets(deviationDamageTargets);
  }
}

if (success) {
  ui.notifications.info(`${grenade.name}: ${resultLabel}.`);
} else {
  ui.notifications.warn(`${grenade.name}: ${resultLabel}. Move the template for deviation.`);
}

// Optional chat-card rerolls never re-enter the one-shot throw above.
const rerollGrenadeAthletics = async (source, messageId) => {
  if (poolAttack || !grenadeThrowReady || athleticsRerollInProgress || !throwMessage || messageId !== throwMessage.id) return;
  const spender = source === "gm" ? game.user : actingActor;
  const rerollLocked = criticalFailure && !dumbLuckEnabled;
  if (
    !["actor", "gm"].includes(source) || rerollLocked ||
    (source === "gm" && !game.user.isGM) ||
    (source === "actor" && !actingActor.isOwner) ||
    getAvailableBennies(spender) < 1 ||
    typeof spender?.spendBenny !== "function"
  ) {
    ui.notifications.warn(rerollLocked
      ? "Critical Failure: Benny rerolls require the Dumb Luck setting."
      : "That Benny source is no longer available.");
    await updateGrenadeThrowMessage();
    return;
  }

  athleticsRerollInProgress = true;
  try {
    const previousMessage = throwMessage;
    const previousContent = throwMessage.content;
    await updateGrenadeThrowMessage();
    const spent = await spender.spendBenny();
    if (spent !== true) {
      athleticsReviewNote = "The Benny could not be spent. The current result is unchanged.";
      return;
    }
    athleticsBenniesSpent += 1;
    const previousAttempt = athleticsAttempt;
    const previousSuccess = success;
    const previousRaise = raise;
    const rerolledAttempt = await rollGrenadeAthleticsAttempt(true);
    athleticsAttempts.push(rerolledAttempt);
    if (
      rerolledAttempt.criticalFailure ||
      athleticsAttempt.criticalFailure ||
      (!rerolledAttempt.naturalOneFailure && (
        athleticsAttempt.naturalOneFailure ||
        rerolledAttempt.total > athleticsAttempt.total
      ))
    ) {
      athleticsAttempt = rerolledAttempt;
      athleticsReviewNote = `Benny reroll: ${rerolledAttempt.total}
        (${getAthleticsAttemptLabel(rerolledAttempt)}). This result is now used.`;
    } else {
      athleticsReviewNote = `Benny reroll: ${rerolledAttempt.total}.
        The previous higher result (${athleticsAttempt.total}) is kept.`;
    }
    syncGrenadeAthleticsResult();
    resultLabel = getAthleticsAttemptLabel(athleticsAttempt);
    resultColor = success ? "#1b7f3a" : "#a61b1b";

    let templateStillExists = canvas.scene.templates?.has(templateDocument.id) !== false;
    if (athleticsAttempt !== previousAttempt) {
      // Updating the existing template is not another throw. In particular,
      // animation and grenade quantity are never touched by this callback.
      cleanupDeviationTargeting();
      if (templateStillExists) {
        const color = success ? "#ff6b35" : "#d62828";
        const changes = {
          fillColor: color,
          borderColor: color,
          "flags.world.throwSucceeded": success,
          "flags.world.pendingDeviation": !success,
        };
        if (success && !previousSuccess) {
          changes.x = target.x;
          changes.y = target.y;
        }
        suppressDeviationUpdate = true;
        try {
          await templateDocument.update(changes);
        } finally {
          suppressDeviationUpdate = false;
        }
        blastTargets = collectTokensInBlast(
          Number(templateDocument.x), Number(templateDocument.y),
          `${grenade.name} rerolled blast`
        );
        if (!success) armGrenadeDeviation();
      } else {
        athleticsReviewNote += " The blast template was removed, so its position was not updated.";
      }

      if (damageWorkflowStarted && (success !== previousSuccess || raise !== previousRaise)) {
        // Do not update native damage cards: SWADE Tools does not persist
        // whether the GM already applied them, and re-rendering can re-enable
        // their Apply button. Keep existing damage and flag the changed throw.
        athleticsDamageReviewNote = raise && !previousRaise
          ? `${attackSkillName} gained a Raise after damage was rolled. GM: review the existing damage and its ${raiseDamageFormula} Raise bonus before applying it. Damage was not rerolled.`
          : `${attackSkillName} changed after damage was rolled. GM: review the final result and blast location before applying the existing damage. Damage was not rerolled.`;
      }
    }
    // Native-style reroll presentation: each paid roll gets a fresh attack
    // card. Only this card can use the shared, same-attack Benny session.
    throwMessage = await createGrenadeThrowMessage(previousMessage);
    rerollGrenadeAthletics.activeMessageId = throwMessage.id;
    await supersedeGrenadeThrowMessage(previousMessage, previousContent);
    if (athleticsAttempt !== previousAttempt && success && templateStillExists && typeof runGrenadeDamageForTargets === "function") {
      // The damage workflow has its own one-shot guard. A failed throw can
      // now roll its pending damage, but existing damage is never duplicated.
      await runGrenadeDamageForTargets(blastTargets);
    }
  } finally {
    athleticsRerollInProgress = false;
    await updateGrenadeThrowMessage();
  }
};

rerollGrenadeAthletics.activeMessageId = throwMessage.id;
rerollGrenadeAthletics.cleanup = () => {
  grenadeThrowReady = false;
  cleanupDeviationTargeting();
};
if (!poolAttack) {
  grenadeBennyRuntime.handlers.set(grenadeBennyKey, rerollGrenadeAthletics);
  grenadeThrowReady = true;
}
await updateGrenadeThrowMessage();
