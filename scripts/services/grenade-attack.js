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
};
const {isLegacyGrenadeItem, isAoeItem, getAoeItemSettings, getAoeSkills, resolveAoeSkill, listAoeOperators, aoeResource} = aoeServices;

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
  .filter((candidate) => !isLegacyGrenadeItem(candidate) || Number(candidate.system.quantity ?? 1) > 0)
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

let driverActor = null;
const directInventoryAttack = contextualItem && isAoeItem(contextualItem) &&
  macroScope.promptAoeSetup !== true;
const explicitlySuppliedOperator = macroScope.operatorActor?.items &&
  macroScope.operatorActor.type !== "vehicle" ? macroScope.operatorActor : null;
if (weaponActor.type === "vehicle") {
  try {
    driverActor = weaponActor.system.getCrewMemberForWeapon?.(initialGrenade) ??
      weaponActor.system.operator ?? null;
  } catch (error) {
    console.warn("SWADE AoE Attack | Vehicle operator lookup failed", error);
  }
  if (!driverActor && weaponActor.system.driver?.id) {
    const driverReference = String(weaponActor.system.driver.id);
    driverActor = await fromUuid(driverReference).catch(() => null) ??
      game.actors.get(driverReference.replace(/^Actor\./, "")) ?? null;
  }
}
if (weaponActor.type === "vehicle" && directInventoryAttack) {
  const assignedOperator = explicitlySuppliedOperator ?? driverActor;
  if (!assignedOperator || assignedOperator.type === "vehicle") {
    return ui.notifications.warn("Assign a gunner or operator to this vehicle before using its AoE weapon. Shift-click AoE to choose one for this attack.");
  }
  if ((!assignedOperator.isOwner && !game.user.isGM) || !getAoeSkills(assignedOperator).length) {
    return ui.notifications.warn("The assigned vehicle gunner is unavailable or has no attack skills. Assign an owned gunner or Shift-click AoE to choose one.");
  }
}
const operators = listAoeOperators({
  weaponOwner: weaponActor,
  preferredActor: explicitlySuppliedOperator ??
    (actingActor.type === "vehicle" ? driverActor : actingActor),
  driverActor,
  actors: game.actors,
  isGM: game.user.isGM,
});
if (!operators.length) return ui.notifications.error("No owned actor with attack skills is available. Assign a vehicle gunner/operator first.");
const initialOperator = operators[0];
const skillOptions = operators.map((operator) => `<optgroup label="${foundry.utils.escapeHTML(operator.name)}">${getAoeSkills(operator).map((skill) => {
  return `<option value="${operator.uuid}|${skill.id}">${foundry.utils.escapeHTML(skill.name)} (d${Number(skill.system.die?.sides ?? 4)})</option>`;
}).join("")}</optgroup>`).join("");

const options = grenades
  .map((item) => {
    const selected = item.id === initialGrenade.id ? "selected" : "";
    const quantity = Number(item.system.quantity ?? 1);
    const damageFormula = getItemDamageFormula(item);
    const damageSummary = damageFormula
      ? `; ${foundry.utils.escapeHTML(damageFormula)}`
      : "; NO DAMAGE";
    return `<option value="${item.id}" ${selected}>${foundry.utils.escapeHTML(
      item.name
    )} (x${quantity}${damageSummary})</option>`;
  })
  .join("");

const initialAoeSettings = getAoeItemSettings(initialGrenade);
let setup = directInventoryAttack
  ? {grenadeId: initialGrenade.id, attackSkill: "auto", otherModifier: Number(initialAoeSettings.attackModifier ?? 0),
     consume: initialAoeSettings.consume}
  : null;
if (!setup) try {
  setup = await foundry.applications.api.DialogV2.prompt({
    window: { title: "AoE Attack" },
    content: `
      <div class="standard-form">
        <div class="form-group">
          <label>AoE Weapon</label>
          <div class="form-fields">
            <select name="grenadeId">${options}</select>
          </div>
        </div>
        <div class="form-group">
          <label>${weaponActor.type === "vehicle" ? "Operator / Attack Skill" : "Attack Skill"}</label>
          <div class="form-fields"><select name="attackSkill"><option value="auto" selected>Weapon Default (assigned Trait)</option>${skillOptions}</select></div>
          <p class="hint">Default: the weapon's assigned Trait. Any skill, including Gunnery, can be selected.</p>
        </div>
        <div class="form-group">
          <label>Other Modifier</label>
          <div class="form-fields">
            <input name="otherModifier" type="number" value="${Number(initialAoeSettings.attackModifier ?? 0)}" step="1">
          </div>
          <p class="hint">Range and Wound/Fatigue penalties are calculated automatically.</p>
        </div>
        <div class="form-group">
          <label>Consume Ammunition</label>
          <div class="form-fields">
            <input name="consume" type="checkbox" ${initialAoeSettings.consume ? "checked" : ""}>
          </div>
        </div>
      </div>
    `,
    ok: {
      label: "Choose Target",
      callback: (event, button) => ({
        grenadeId: button.form.elements.grenadeId.value,
        attackSkill: button.form.elements.attackSkill.value,
        otherModifier:
          button.form.elements.otherModifier.valueAsNumber || 0,
        consume: button.form.elements.consume.checked,
      }),
    },
    rejectClose: false,
    modal: false,
  });
} catch {
  return;
}

if (!setup) return;

const grenade = weaponActor.items.get(setup.grenadeId);
if (!grenade) {
  return ui.notifications.error("The selected AoE weapon could not be found.");
}

const [operatorUuid, attackSkillId] = String(setup.attackSkill ?? "").split("|");
const selectedAoeSettings = getAoeItemSettings(grenade);
if (selectedAoeSettings.damageAction && grenade.system.actions?.additional?.[selectedAoeSettings.damageAction]?.type !== "damage") {
  return ui.notifications.warn("This item's configured AoE damage action no longer exists. Update AoE Settings before firing.");
}
let defaultOperator = initialOperator;
if (setup.attackSkill === "auto" && weaponActor.type === "vehicle") {
  try {
    const gunner = explicitlySuppliedOperator ?? weaponActor.system.getCrewMemberForWeapon?.(grenade) ??
      weaponActor.system.operator ?? driverActor;
    defaultOperator = operators.find((operator) => operator.uuid === gunner?.uuid) ??
      (directInventoryAttack ? null : initialOperator);
  } catch (error) {
    console.warn("SWADE AoE Attack | Default gunner lookup failed", error);
  }
}
actingActor = setup.attackSkill === "auto"
  ? defaultOperator
  : operators.find((operator) => operator.uuid === operatorUuid);
const attackSkill = actingActor && resolveAoeSkill(actingActor, grenade,
  setup.attackSkill === "auto" ? (selectedAoeSettings.skill || null) : attackSkillId);
if (!actingActor || !attackSkill) return ui.notifications.error("The selected operator or attack skill could not be found.");
if (!actingActor.isOwner && !game.user.isGM) return ui.notifications.error("You do not own this attack's operator.");
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
for (const formula of [itemTraitModifier, preparedAttackFormula,
  bennyTraitModifiers.map((modifier) => `(${String(modifier.value).trim()})`).join("+")].filter(Boolean)) {
  const missingReference = [...formula.matchAll(/@([A-Za-z0-9_.]+)/g)]
    .find(([, reference]) => foundry.utils.getProperty(rollData, reference) === undefined);
  if (missingReference) return ui.notifications.warn(`The AoE modifier references an unavailable field: @${missingReference[1]}. Update the item or actor effects before firing.`);
  const resolved = typeof Roll.replaceFormulaData === "function" ? Roll.replaceFormulaData(formula, rollData) : formula;
  if (typeof Roll.validate === "function" && !Roll.validate(resolved)) {
    return ui.notifications.warn("An AoE attack modifier has an invalid roll formula. Update the item or actor effects before firing.");
  }
}
const resourceOptions = {
  consume: setup.consume,
  legacyGrenade: isLegacyGrenadeItem(grenade),
  cost: selectedAoeSettings.ammoCost,
};
const explainResourceFailure = (result) => ({
  permission: "You do not have permission to consume this weapon's ammunition.",
  insufficient: `${grenade.name}: not enough ${String(result.label ?? "ammunition").toLowerCase()} (${result.available}/${result.cost}).`,
  unsupported: "This item's ammunition API is unavailable. Turn off Consume Ammunition only if the GM will track it manually.",
  busy: "This ammunition is already being used by another attack. Please try again.",
  "update-failed": "The weapon's ammunition could not be updated.",
}[result.reason] ?? "The AoE weapon cannot expend ammunition.");
const resourceValidation = await aoeResource.validate(grenade, weaponActor, resourceOptions);
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
if (damageSourceItem.id === grenade.id && resourceValidation.managed &&
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
const target = await Sequencer.Crosshair.show(
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
const resourceSpent = await aoeResource.spend(grenade, weaponActor, resourceOptions);
if (!resourceSpent.ok) return ui.notifications.warn(explainResourceFailure(resourceSpent));

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
const woundPenalty = -Math.max(0, woundValue - woundIgnored);
const fatiguePenalty = -Math.max(0, fatigueValue - fatigueIgnored);
const skillModifier = Number(attackSkill.system.die?.modifier ?? 0);
const itemModifierRoll = itemTraitModifier
  ? await new Roll(itemTraitModifier, rollData).evaluate()
  : null;
const preparedModifierRoll = preparedAttackFormula
  ? await new Roll(preparedAttackFormula, rollData).evaluate()
  : null;
const trademarkModifier = Number(grenade.system.trademark ?? 0);
const baseThrowModifier =
  rangePenalty +
  woundPenalty +
  fatiguePenalty +
  skillModifier +
  Number(itemModifierRoll?.total ?? 0) +
  Number(preparedModifierRoll?.total ?? 0) +
  trademarkModifier +
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

let athleticsAttempt = await rollGrenadeAthleticsAttempt();
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
  ? `<details><summary>${foundry.utils.escapeHTML(attackSkillName)} attempts — ${athleticsBenniesSpent} ${athleticsBenniesSpent === 1 ? "Benny" : "Bennies"} spent</summary>
     <table><thead><tr><th>Attempt</th><th>Trait</th><th>Wild</th><th>Modifier</th><th>Total</th>${isWildCard ? "" : "<th>Confirm d6</th>"}</tr></thead>
     <tbody>${athleticsAttempts.map((attempt, index) =>
       `<tr><td>${index === 0 ? "Initial" : `Benny ${index}`}${attempt === athleticsAttempt ? " (used)" : ""}</td>
        <td>${attempt.traitRoll.total}</td><td>${attempt.wildRoll?.total ?? "—"}</td>
        <td>${attempt.totalModifier}</td><td>${attempt.total}${attempt.criticalFailure ? " — Critical Failure" : attempt.naturalOneFailure ? " — Natural 1 failure" : ""}</td>${isWildCard ? "" : `<td>${attempt.criticalConfirmationRoll?.total ?? "—"}</td>`}</tr>`
     ).join("")}</tbody></table></details>`
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
      await reroll(button.dataset.bennySource);
    } catch (error) {
      console.error("SWADE AoE Attack | Skill reroll failed", error);
      ui.notifications.error("The AoE skill reroll could not be completed.");
    }
  });
  Hooks.on("deleteChatMessage", (message) => {
    const key = message.flags?.world?.grenadeBennySession;
    if (key) {
      grenadeBennyRuntime.handlers.get(key)?.cleanup?.();
      grenadeBennyRuntime.handlers.delete(key);
    }
  });
}

const getGrenadeBennyControlsHtml = () => {
  if (criticalFailure && !dumbLuckEnabled) {
    return "<p><small>Critical Failure: Benny rerolls require the Dumb Luck setting.</small></p>";
  }
  const disabled = !grenadeThrowReady || athleticsRerollInProgress
    ? "disabled"
    : "";
  const actorBennies = getAvailableBennies(actingActor);
  const gmBennies = game.user.isGM ? getAvailableBennies(game.user) : 0;
  const buttons = [];
  if (actingActor.isOwner && actorBennies > 0 && typeof actingActor.spendBenny === "function") {
    buttons.push(`<button type="button" data-grenade-benny="${grenadeBennyKey}"
      data-benny-source="actor" ${disabled}><i class="fa-solid fa-dice"></i>
      Benny Reroll (${actorBennies})</button>`);
  }
  if (game.user.isGM && gmBennies > 0 && typeof game.user.spendBenny === "function") {
    buttons.push(`<button type="button" data-grenade-benny="${grenadeBennyKey}"
      data-benny-source="gm" ${disabled}><i class="fa-solid fa-dice"></i>
      GM Benny Reroll (${gmBennies})</button>`);
  }
  return buttons.length
    ? `<div style="display:flex;gap:4px">${buttons.join("")}</div>
       <p><small>Reroll ${foundry.utils.escapeHTML(attackSkillName)} only. No additional ammunition is consumed.
       Use before the GM applies damage. These controls work in the attacking player's current session.</small></p>`
    : "<p><small>No Bennies available for an attack reroll.</small></p>";
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
const getBlastTargetNamesHtml = (targets) => {
  const names = getBlastTargetNames(targets);
  return names.length
    ? names.map((name) => foundry.utils.escapeHTML(name)).join(", ")
    : "None";
};
const updateBlastTargetText = async (targets) => {
  if (!throwMessage) return;
  const wrapper = globalThis.document.createElement("div");
  wrapper.innerHTML = throwMessage.content;
  const targetLine = wrapper.querySelector("[data-grenade-targets]");
  if (!targetLine) return;
  targetLine.innerHTML = `<strong>Targets:</strong> ${getBlastTargetNamesHtml(
    targets
  )}`;
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

const databasePathExists = (path) => {
  try {
    if (typeof Sequencer.Database?.entryExists === "function") {
      return Sequencer.Database.entryExists(path);
    }
    if (typeof Sequencer.Database?.getEntry === "function") {
      return Boolean(Sequencer.Database.getEntry(path));
    }
  } catch {
    return false;
  }
  return true;
};

const useThrownProjectile = isLegacyGrenadeItem(grenade) &&
  /athletics/i.test(attackSkillName);
const animationPathsExist = databasePathExists(IMPACT_EFFECT) &&
  (!useThrownProjectile || databasePathExists(PROJECTILE_EFFECT));

if (animationPathsExist && templateDocument) {
  const templateTarget = templateDocument.object ?? {
    x: templateDocument.x,
    y: templateDocument.y,
  };

  const animation = new Sequence();
  if (useThrownProjectile) animation.effect()
    .file(PROJECTILE_EFFECT).atLocation(selectedToken)
    .stretchTo(templateTarget).waitUntilFinished();
  await animation.effect()
    .file(IMPACT_EFFECT)
    .atLocation(templateTarget)
    .size(blastRadiusSquares * 2, { gridUnits: true })
    .waitUntilFinished(250)
    .play();
} else {
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
const damageLine = damage
  ? `
    <p><strong>Damage${
      selectedDamageAction?.name
        ? ` (${foundry.utils.escapeHTML(selectedDamageAction.name)})`
        : ""
    }:</strong> ${foundry.utils.escapeHTML(damage)}; AP ${ap}${
      raise ? `; Raise bonus ${raiseDamageFormula}` : ""
    }${damageSourceLine}</p>
    <p><small>The SWADE damage roll is made automatically from the selected AoE item.</small></p>
  `
  : `
    <p><strong>Damage:</strong> No direct damage is configured on this item.</p>
    <p><strong>@UUID[${grenade.uuid}]{Open ${foundry.utils.escapeHTML(
      grenade.name
    )}}</strong></p>
  `;
const failureLine = success
  ? ""
  : `<p><strong>Deviation:</strong> The red template marks the intended point. Move it using your table's SWADE deviation result before applying the rolled damage.</p>`;
const traitRollHtml = await traitRoll.render({
  flavor: `${attackSkillName} Trait Die (d${traitSides})`,
});
const wildRollHtml = wildRoll
  ? await wildRoll.render({
      flavor: `${attackSkillName} Wild Die (d${wildSides})`,
    })
  : "";
const extraConfirmationHtml = criticalConfirmationRoll
  ? `${await criticalConfirmationRoll.render({
      flavor: "Extra Critical Failure Confirmation (d6)",
    })}<p><small>${criticalFailure ? "Confirmed Critical Failure." : "Critical Failure not confirmed. The natural 1 remains a failed attack regardless of modifiers."}</small></p>`
  : "";
const modifierParts = [
  `Range ${rangePenalty >= 0 ? "+" : ""}${rangePenalty}`,
  `Wounds ${woundPenalty >= 0 ? "+" : ""}${woundPenalty}`,
  `Fatigue ${fatiguePenalty >= 0 ? "+" : ""}${fatiguePenalty}`,
  `Skill ${skillModifier >= 0 ? "+" : ""}${skillModifier}`,
  `Item ${Number(itemModifierRoll?.total ?? 0) >= 0 ? "+" : ""}${Number(itemModifierRoll?.total ?? 0)}`,
  `Trademark ${trademarkModifier >= 0 ? "+" : ""}${trademarkModifier}`,
  ...(preparedModifierRoll ? [`Effects ${preparedModifierRoll.total >= 0 ? "+" : ""}${preparedModifierRoll.total}`] : []),
  `Other ${Number(setup.otherModifier ?? 0) >= 0 ? "+" : ""}${Number(
    setup.otherModifier ?? 0
  )}`,
  ...(bennyModifierRoll
    ? [`Benny ${bennyModifierRoll.total >= 0 ? "+" : ""}${bennyModifierRoll.total}`]
    : []),
].join(", ");
const preparedEffectsSummary = preparedAttackModifiers.map((modifier) =>
  `${String(modifier.label ?? "Effect")}: ${String(modifier.value)}`
).join(", ");

return `
    <h2>${foundry.utils.escapeHTML(grenade.name)}</h2>
    ${weaponActor.type === "vehicle" ? `<p><strong>Operator:</strong> ${foundry.utils.escapeHTML(actingActor.name)}; <strong>Vehicle:</strong> ${foundry.utils.escapeHTML(weaponActor.name)}</p>` : ""}
    <p><strong>${foundry.utils.escapeHTML(attackSkillName)}:</strong> ${total}
      <span style="color:${resultColor};font-weight:bold">(${resultLabel})</span>
    </p>
    ${traitRollHtml}
    ${wildRollHtml}
    ${extraConfirmationHtml}
    ${getAthleticsHistoryHtml()}
    <p><strong>Used:</strong> ${chosenDie} ${bestDie} ${totalModifier >= 0 ? "+" : ""}${totalModifier} = ${total}</p>
    <p><strong>Range:</strong> ${distance.toFixed(1)} ${foundry.utils.escapeHTML(
      distanceUnits
    )}, ${rangeBand} (${rangePenalty})</p>
    <p><strong>Total Modifier:</strong> ${totalModifier >= 0 ? "+" : ""}${totalModifier}</p>
    <p><small>${modifierParts}</small></p>
    ${preparedEffectsSummary ? `<p><small>Prepared effects: ${foundry.utils.escapeHTML(preparedEffectsSummary)}</small></p>` : ""}
    <p><strong>Blast:</strong> ${blastSize} Blast Template</p>
    <p data-grenade-targets><strong>Targets:</strong> ${getBlastTargetNamesHtml(
      blastTargets
    )}</p>
    ${damageLine}
    ${failureLine}
    ${athleticsReviewNote ? `<p><small>${foundry.utils.escapeHTML(athleticsReviewNote)}</small></p>` : ""}
    ${athleticsDamageReviewNote ? `<p style="color:#a61b1b"><strong>${foundry.utils.escapeHTML(athleticsDamageReviewNote)}</strong></p>` : ""}
    ${getGrenadeBennyControlsHtml()}
  `;
};

const updateGrenadeThrowMessage = async () => {
  if (!throwMessage) return;
  await throwMessage.update({
    rolls: [traitRoll, wildRoll, criticalConfirmationRoll, itemModifierRoll, preparedModifierRoll, bennyModifierRoll].filter(Boolean).map((roll) => roll.toJSON()),
    content: await renderGrenadeThrowContent(),
  });
};

throwMessage = await ChatMessage.create({
  user: game.user.id,
  speaker: ChatMessage.getSpeaker({
    actor: actingActor,
    token: selectedToken.document,
  }),
  rolls: [traitRoll, wildRoll, criticalConfirmationRoll, itemModifierRoll, preparedModifierRoll, bennyModifierRoll].filter(Boolean),
  flags: { world: { grenadeBennySession: grenadeBennyKey } },
  content: await renderGrenadeThrowContent(),
});

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
        await rollDamageWithSwadeTools([targetToken]);
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
const rerollGrenadeAthletics = async (source) => {
  if (!grenadeThrowReady || athleticsRerollInProgress) return;
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

    if (athleticsAttempt !== previousAttempt) {
      // Updating the existing template is not another throw. In particular,
      // animation and grenade quantity are never touched by this callback.
      cleanupDeviationTargeting();
      const templateStillExists = canvas.scene.templates?.has(templateDocument.id) !== false;
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
      await updateGrenadeThrowMessage();
      if (success && templateStillExists && typeof runGrenadeDamageForTargets === "function") {
        // The damage workflow has its own one-shot guard. A failed throw can
        // now roll its pending damage, but existing damage is never duplicated.
        await runGrenadeDamageForTargets(blastTargets);
      }
    }
  } finally {
    athleticsRerollInProgress = false;
    await updateGrenadeThrowMessage();
  }
};

rerollGrenadeAthletics.cleanup = () => cleanupDeviationTargeting();
grenadeBennyRuntime.handlers.set(grenadeBennyKey, rerollGrenadeAthletics);
grenadeThrowReady = true;
await updateGrenadeThrowMessage();
