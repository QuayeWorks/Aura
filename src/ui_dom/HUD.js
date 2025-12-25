// src/ui_dom/HUD.js
// Lightweight DOM HUD overlay (health, Nen, abilities, level/XP, debug).

function createBar(labelText, className) {
    const wrapper = document.createElement("div");
    wrapper.className = `hud-bar ${className}`;

    const fill = document.createElement("div");
    fill.className = "fill";
    wrapper.appendChild(fill);

    const text = document.createElement("div");
    text.className = "hud-row";
    text.style.marginTop = "-18px";
    text.style.padding = "0 6px";
    text.style.mixBlendMode = "screen";
    text.textContent = labelText;

    return { wrapper, fill, text };
}

function formatSeconds(value) {
    if (!value || value <= 0) return "Ready";
    return `${value.toFixed(1)}s`;
}

export function createDomHUD() {
    let root = document.getElementById("hud-root");
    if (!root) {
        root = document.createElement("div");
        root.id = "hud-root";
        document.body.appendChild(root);
    }

    const hudPanel = document.createElement("div");
    hudPanel.className = "hud-panel hud-hidden";

    const healthBar = createBar("Health", "health");
    const nenBar = createBar("Nen", "nen");

    hudPanel.appendChild(healthBar.wrapper);
    hudPanel.appendChild(nenBar.wrapper);

    const metaRow = document.createElement("div");
    metaRow.className = "hud-row";
    metaRow.style.marginBottom = "6px";
    const levelText = document.createElement("div");
    const xpText = document.createElement("div");
    metaRow.appendChild(levelText);
    metaRow.appendChild(xpText);
    hudPanel.appendChild(metaRow);

    const abilityGrid = document.createElement("div");
    abilityGrid.className = "ability-grid";
    const sprintTile = document.createElement("div");
    sprintTile.className = "ability-tile";
    const jumpTile = document.createElement("div");
    jumpTile.className = "ability-tile";
    const carveTile = document.createElement("div");
    carveTile.className = "ability-tile";
    abilityGrid.appendChild(sprintTile);
    abilityGrid.appendChild(jumpTile);
    abilityGrid.appendChild(carveTile);
    hudPanel.appendChild(abilityGrid);

    const debugPanel = document.createElement("div");
    debugPanel.id = "hud-debug-panel";
    debugPanel.classList.add("hud-hidden");

    root.appendChild(hudPanel);
    root.appendChild(debugPanel);

    let gameplayVisible = true;
    let debugVisible = false;
    let flashCooldown = null;

    function setGameplayVisible(isVisible) {
        gameplayVisible = !!isVisible;
        hudPanel.classList.toggle("hud-hidden", !gameplayVisible);
    }

    function setDebugVisible(isVisible) {
        debugVisible = !!isVisible;
        debugPanel.classList.toggle("hud-hidden", !debugVisible);
    }

    window.addEventListener("keydown", (ev) => {
        if (ev.code === "F1") {
            setGameplayVisible(!gameplayVisible);
        }
        if (ev.code === "F2") {
            setDebugVisible(!debugVisible);
        }
    });

    function flashNenBar() {
        nenBar.wrapper.classList.add("flash");
        if (flashCooldown) clearTimeout(flashCooldown);
        flashCooldown = setTimeout(() => {
            nenBar.wrapper.classList.remove("flash");
        }, 300);
    }

    let lastUpdate = 0;
    function update(values) {
        const now = performance.now();
        if (now - lastUpdate < 80) return;
        lastUpdate = now;

        const {
            health = 0,
            maxHealth = 1,
            nen = 0,
            maxNen = 1,
            level = 1,
            currentXP = 0,
            xpToNext = 1,
            abilityState = {},
            nenRegen = 0,
            stats = {}
        } = values || {};

        const healthPct = Math.max(0, Math.min(1, health / maxHealth));
        const nenPct = Math.max(0, Math.min(1, nen / maxNen));
        healthBar.fill.style.width = `${(healthPct * 100).toFixed(1)}%`;
        nenBar.fill.style.width = `${(nenPct * 100).toFixed(1)}%`;
        healthBar.text.textContent = `Health ${health.toFixed(0)} / ${maxHealth.toFixed(0)}`;
        nenBar.text.textContent = `Nen ${nen.toFixed(0)} / ${maxNen.toFixed(0)}`;
        if (!healthBar.text.parentElement) hudPanel.appendChild(healthBar.text);
        if (!nenBar.text.parentElement) hudPanel.appendChild(nenBar.text);

        levelText.textContent = `Lv ${level}`;
        xpText.textContent = `XP ${currentXP.toFixed(0)} / ${xpToNext.toFixed(0)}`;

        const sprint = abilityState.sprint || {};
        const jump = abilityState.jump || {};
        const carve = abilityState.carve || {};

        sprintTile.textContent = sprint.active ? "Sprint (Active)" : "Shift – Sprint";
        sprintTile.classList.toggle("active", !!sprint.active);
        const sprintCd = document.createElement("div");
        sprintCd.className = "cooldown-text";
        sprintCd.textContent = sprint.requested && !sprint.active ? "No Nen" : "Nen drain";
        sprintTile.appendChild(sprintCd);

        jumpTile.textContent = jump.active ? "Q – Jump Buff" : "Q – Enhance Jump";
        jumpTile.classList.toggle("active", !!jump.active);
        const jumpCd = document.createElement("div");
        jumpCd.className = "cooldown-text";
        jumpCd.textContent = jump.active
            ? `Ends in ${formatSeconds(jump.durationRemaining)}`
            : jump.cooldownRemaining > 0
                ? `CD ${formatSeconds(jump.cooldownRemaining)}`
                : "Ready";
        jumpTile.appendChild(jumpCd);

        carveTile.textContent = carve.active ? "E – Carve Buff" : "E – Enhance Carve";
        carveTile.classList.toggle("active", !!carve.active);
        const carveCd = document.createElement("div");
        carveCd.className = "cooldown-text";
        carveCd.textContent = carve.active
            ? `Ends in ${formatSeconds(carve.durationRemaining)}`
            : carve.cooldownRemaining > 0
                ? `CD ${formatSeconds(carve.cooldownRemaining)}`
                : "Ready";
        carveTile.appendChild(carveCd);

        const heat = values?.carveHeat || {};
        const heatPercent = heat.threshold ? Math.min(1, heat.value / heat.threshold) : 0;
        const heatLine = heat.threshold
            ? `Carve heat: ${(heatPercent * 100).toFixed(0)}%${heat.lockoutRemaining > 0 ? " (lockout)" : ""}`
            : "Carve heat: -";

        debugPanel.textContent = `Power: ${stats.power ?? "-"}\n` +
            `Agility: ${stats.agility ?? "-"}\n` +
            `Focus: ${stats.focus ?? "-"}\n` +
            `Nen regen: ${nenRegen.toFixed(1)} /s\n` +
            heatLine;
    }

    return {
        update,
        flashNenBar,
        setGameplayVisible,
        setDebugVisible
    };
}
