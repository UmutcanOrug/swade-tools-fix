/*
 * SWADE Throw Grenade - Automatic Item Damage
 * Foundry VTT V13 / SWADE 5.x / Sequencer 4.x
 *
 * Create a world Script Macro with this code, then put its UUID in a
 * weapon Action whose Type is "Macro", or run it directly from the hotbar.
 */

const PROJECTILE_EFFECT = "jb2a.throwable.throw.grenade.01.green";
const IMPACT_EFFECT = "jb2a.explosion.01.orange";

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
  return ui.notifications.warn("Select the token throwing the grenade.");
}

if (!game.modules.get("sequencer")?.active || !globalThis.Sequencer?.Crosshair) {
  return ui.notifications.error(
    "SWADE Throw Grenade requires the Sequencer module to be active."
  );
}

const isGrenade = (item) => {
  if (!item || !["weapon", "consumable", "gear"].includes(item.type)) {
    return false;
  }
  const category = String(item.system.category ?? "");
  return (
    /grenade|throwable/i.test(category) ||
    /grenade|detonator/i.test(item.name)
  );
};

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
  return actionFormula || String(item?.system?.damage ?? "").trim();
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

const grenades = actingActor.items
  .filter(isGrenade)
  .filter((item) => Number(item.system.quantity ?? 1) > 0)
  .sort((a, b) => {
    const damageDifference =
      Number(Boolean(getItemDamageFormula(b))) -
      Number(Boolean(getItemDamageFormula(a)));
    return damageDifference || a.name.localeCompare(b.name);
  });

if (!grenades.length) {
  return ui.notifications.warn(`${actingActor.name} has no usable grenades.`);
}

const initialGrenade = isGrenade(contextualItem)
  ? actingActor.items.get(contextualItem.id) ?? contextualItem
  : grenades.find((item) => getItemDamageFormula(item)) ?? grenades[0];

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

let setup;
try {
  setup = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Throw Grenade" },
    content: `
      <div class="standard-form">
        <div class="form-group">
          <label>Grenade</label>
          <div class="form-fields">
            <select name="grenadeId">${options}</select>
          </div>
        </div>
        <div class="form-group">
          <label>Other Modifier</label>
          <div class="form-fields">
            <input name="otherModifier" type="number" value="0" step="1">
          </div>
          <p class="hint">Range and Wound/Fatigue penalties are calculated automatically.</p>
        </div>
        <div class="form-group">
          <label>Consume One Grenade</label>
          <div class="form-fields">
            <input name="consume" type="checkbox" checked>
          </div>
        </div>
      </div>
    `,
    ok: {
      label: "Choose Target",
      callback: (event, button) => ({
        grenadeId: button.form.elements.grenadeId.value,
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

const grenade = actingActor.items.get(setup.grenadeId);
if (!grenade) {
  return ui.notifications.error("The selected grenade could not be found.");
}

// Some SWADE setups keep the consumable grenade and its reusable throwing
// weapon profile as two separate Actor items. If the selected item has no
// damage, use the first grenade/throw profile that actually has damage.
const damageSourceItem = getItemDamageFormula(grenade)
  ? grenade
  : grenades.find((item) => getItemDamageFormula(item)) ?? grenade;

const athletics = actingActor.items.find(
  (item) => item.type === "skill" && item.name === "Athletics"
);
if (!athletics) {
  return ui.notifications.error(
    `${actingActor.name} does not have the Athletics skill.`
  );
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
const blastSize = templateFlags.large
  ? "Large"
  : templateFlags.medium
    ? "Medium"
    : "Small";
const blastRadiusSquares = templateFlags.large
  ? 3
  : templateFlags.medium
    ? 2
    : 1;
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
const skillModifier = Number(athletics.system.die?.modifier ?? 0);
const totalModifier =
  rangePenalty +
  woundPenalty +
  fatiguePenalty +
  skillModifier +
  Number(setup.otherModifier ?? 0);

const traitSides = Number(athletics.system.die?.sides ?? 4);
const wildSides = Number(athletics.system["wild-die"]?.sides ?? 6);
const isWildCard = Boolean(actingActor.system.wildcard);

const traitRoll = await new Roll(`1d${traitSides}x`).evaluate();
const wildRoll = isWildCard
  ? await new Roll(`1d${wildSides}x`).evaluate()
  : null;

const traitInitial = traitRoll.dice[0]?.results[0]?.result;
const wildInitial = wildRoll?.dice[0]?.results[0]?.result;
const criticalFailure = isWildCard
  ? traitInitial === 1 && wildInitial === 1
  : traitInitial === 1;

const bestDie = wildRoll
  ? Math.max(traitRoll.total, wildRoll.total)
  : traitRoll.total;
const chosenDie =
  wildRoll && wildRoll.total > traitRoll.total ? "Wild Die" : "Trait Die";
const total = bestDie + totalModifier;
const success = !criticalFailure && total >= 4;
const raise = success && total >= 8;

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

// A failed throw may require moving the red template for deviation. Refresh
// the chat-card name list once when this specific template is moved.
if (!success && templateDocument) {
  let updateTemplateHookId;
  let deleteTemplateHookId;
  let cleanupTimer;
  const cleanupDeviationTargeting = () => {
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
      if (document.id !== templateDocument.id) return;
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
}

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

const animationPathsExist = [PROJECTILE_EFFECT, IMPACT_EFFECT].every(
  databasePathExists
);

if (animationPathsExist && templateDocument) {
  const templateTarget = templateDocument.object ?? {
    x: templateDocument.x,
    y: templateDocument.y,
  };

  await new Sequence()
    .effect()
    .file(PROJECTILE_EFFECT)
    .atLocation(selectedToken)
    .stretchTo(templateTarget)
    .waitUntilFinished()
    .effect()
    .file(IMPACT_EFFECT)
    .atLocation(templateTarget)
    .size(blastRadiusSquares * 2, { gridUnits: true })
    .waitUntilFinished(250)
    .play();
} else {
  ui.notifications.warn(
    "Grenade resolved, but the configured JB2A projectile or explosion path was not found."
  );
}

if (setup.consume) {
  const quantity = Number(grenade.system.quantity ?? 1);
  if (quantity > 0) {
    await grenade.update({ "system.quantity": Math.max(0, quantity - 1) });
  }
}

const resultLabel = criticalFailure
  ? "Critical Failure"
  : raise
    ? "Success with a Raise"
    : success
      ? "Success"
      : "Failure - Resolve Deviation";
const resultColor = success ? "#1b7f3a" : "#a61b1b";
const baseDamage = String(damageSourceItem.system.damage ?? "").trim();
const additionalActions =
  foundry.utils.getProperty(damageSourceItem, "system.actions.additional") ?? {};
const damageActionEntries = Object.entries(additionalActions).filter(
  ([, action]) => action?.type === "damage"
);
const configuredDamageActions = damageActionEntries.filter(([, action]) =>
  getDamageActionFormula(action)
);
const selectedDamageActionEntry =
  configuredDamageActions.find(([, action]) =>
    /damage|hasar/i.test(String(action?.name ?? ""))
  ) ??
  configuredDamageActions[0] ??
  damageActionEntries[0] ??
  null;
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
const damageLine = damage
  ? `
    <p><strong>Damage${
      selectedDamageAction?.name
        ? ` (${foundry.utils.escapeHTML(selectedDamageAction.name)})`
        : ""
    }:</strong> ${foundry.utils.escapeHTML(damage)}; AP ${ap}${
      raise ? `; Raise bonus ${raiseDamageFormula}` : ""
    }${damageSourceLine}</p>
    <p><small>The SWADE damage roll is made automatically from the selected grenade item.</small></p>
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
  flavor: `Athletics Trait Die (d${traitSides})`,
});
const wildRollHtml = wildRoll
  ? await wildRoll.render({
      flavor: `Athletics Wild Die (d${wildSides})`,
    })
  : "";
const modifierParts = [
  `Range ${rangePenalty >= 0 ? "+" : ""}${rangePenalty}`,
  `Wounds ${woundPenalty >= 0 ? "+" : ""}${woundPenalty}`,
  `Fatigue ${fatiguePenalty >= 0 ? "+" : ""}${fatiguePenalty}`,
  `Skill ${skillModifier >= 0 ? "+" : ""}${skillModifier}`,
  `Other ${Number(setup.otherModifier ?? 0) >= 0 ? "+" : ""}${Number(
    setup.otherModifier ?? 0
  )}`,
].join(", ");

throwMessage = await ChatMessage.create({
  user: game.user.id,
  speaker: ChatMessage.getSpeaker({
    actor: actingActor,
    token: selectedToken.document,
  }),
  rolls: [traitRoll, wildRoll].filter(Boolean),
  content: `
    <h2>${foundry.utils.escapeHTML(grenade.name)}</h2>
    <p><strong>Athletics:</strong> ${total}
      <span style="color:${resultColor};font-weight:bold">(${resultLabel})</span>
    </p>
    ${traitRollHtml}
    ${wildRollHtml}
    <p><strong>Used:</strong> ${chosenDie} ${bestDie} ${totalModifier >= 0 ? "+" : ""}${totalModifier} = ${total}</p>
    <p><strong>Range:</strong> ${distance.toFixed(1)} ${foundry.utils.escapeHTML(
      distanceUnits
    )}, ${rangeBand} (${rangePenalty})</p>
    <p><strong>Total Modifier:</strong> ${totalModifier >= 0 ? "+" : ""}${totalModifier}</p>
    <p><small>${modifierParts}</small></p>
    <p><strong>Blast:</strong> ${blastSize} Blast Template</p>
    <p data-grenade-targets><strong>Targets:</strong> ${getBlastTargetNamesHtml(
      blastTargets
    )}</p>
    ${damageLine}
    ${failureLine}
  `,
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

  if (raise) {
    additionalMods.push({
      label: game.i18n.localize("SWADE.BonusDamage"),
      value: raiseDamageFormula,
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
    const damageActionKey = damageOverride
      ? String(selectedDamageActionEntry?.[0] ?? "")
      : "";

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
    await game.swadetools.item(actingActor, damageSourceItem.id);
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

  let damageWorkflowStarted = false;
  runGrenadeDamageForTargets = async (targetsForDamage) => {
    if (damageWorkflowStarted) return;
    damageWorkflowStarted = true;

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
          `SWADE Throw Grenade | SWADE Tools damage failed for ${
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
