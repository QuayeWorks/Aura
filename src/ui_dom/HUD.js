// src/ui_dom/HUD.js
// Lightweight DOM HUD overlay (health, Nen, abilities, level/XP, debug).

function createBar(labelText, className) {
    const wrapper = document.createElement("div");
    wrapper.className = `hud-bar ${className}`;

    const fill = document.createElement("div");
    fill.className = "fill";
    wrapper.appendChild(fill);

    const text = document.createElement("div");
    text.className = "hud-bar-label";
    text.textContent = labelText;
    wrapper.appendChild(text);

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
    metaRow.className = "hud-row hud-meta-row";
    const levelText = document.createElement("div");
    const xpText = document.createElement("div");
    const skillText = document.createElement("div");
    metaRow.appendChild(levelText);
    metaRow.appendChild(xpText);
    metaRow.appendChild(skillText);
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

    const infoColumn = document.createElement("div");
    infoColumn.className = "hud-info-column";

    const tokensRow = document.createElement("div");
    tokensRow.className = "hud-row hud-economy";
    tokensRow.textContent = "Tokens: 0";
    infoColumn.appendChild(tokensRow);

    const questRow = document.createElement("div");
    questRow.className = "hud-row hud-quest";
    questRow.textContent = "Quests: -";
    infoColumn.appendChild(questRow);

    const multiplayerRow = document.createElement("div");
    multiplayerRow.className = "hud-row hud-mp";
    multiplayerRow.textContent = "Players: 1";
    infoColumn.appendChild(multiplayerRow);

    hudPanel.appendChild(infoColumn);

    const interactionPrompt = document.createElement("div");
    interactionPrompt.className = "hud-interaction hud-hidden";
    interactionPrompt.textContent = "";

    const audioToggle = document.createElement("div");
    audioToggle.className = "audio-toggle";
    audioToggle.textContent = "Audio: On (M)";
    audioToggle.style.pointerEvents = "auto";

    root.appendChild(hudPanel);
    root.appendChild(debugPanel);
    root.appendChild(audioToggle);
    root.appendChild(interactionPrompt);

    let gameplayVisible = true;
    let debugVisible = false;
    let flashCooldown = null;
    let audioToggleHandler = null;
    let audioMuted = false;

    function setGameplayVisible(isVisible) {
        gameplayVisible = !!isVisible;
        hudPanel.classList.toggle("hud-hidden", !gameplayVisible);
    }

    function setDebugVisible(isVisible) {
        debugVisible = !!isVisible;
        debugPanel.classList.toggle("hud-hidden", !debugVisible);
    }

    window.addEventListener("keydown", (ev) => {
        if (ev.code === "KeyM") {
            if (audioToggleHandler) audioToggleHandler();
        }
    });

    audioToggle.addEventListener("click", () => {
        if (audioToggleHandler) audioToggleHandler();
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
            skillPoints = 0,
            abilityState = {},
            nenRegen = 0,
            stats = {},
            tokens = 0,
            questLine = "",
            interactionPromptText = "",
            multiplayerCount = 1
        } = values || {};

        const healthPct = Math.max(0, Math.min(1, health / maxHealth));
        const nenPct = Math.max(0, Math.min(1, nen / maxNen));
        healthBar.fill.style.width = `${(healthPct * 100).toFixed(1)}%`;
        nenBar.fill.style.width = `${(nenPct * 100).toFixed(1)}%`;
        healthBar.text.textContent = `Health ${health.toFixed(0)} / ${maxHealth.toFixed(0)}`;
        nenBar.text.textContent = `Nen ${nen.toFixed(0)} / ${maxNen.toFixed(0)}`;

        levelText.textContent = `Lv ${level}`;
        xpText.textContent = `XP ${currentXP.toFixed(0)} / ${xpToNext.toFixed(0)}`;
        skillText.textContent = `SP ${skillPoints}`;

        const sprint = abilityState.sprint || {};
        const jump = abilityState.jump || {};
        const carve = abilityState.carve || {};

        sprintTile.classList.toggle("active", !!sprint.active);
        sprintTile.textContent = sprint.active ? "Sprint (Active)" : "Shift – Sprint";
        const sprintCd = document.createElement("div");
        sprintCd.className = "cooldown-text";
        sprintCd.textContent = sprint.requested && !sprint.active ? "No Nen" : "Nen drain";
        sprintTile.appendChild(sprintCd);

        jumpTile.classList.toggle("active", !!jump.active);
        jumpTile.textContent = jump.active ? "Q – Jump Buff" : "Q – Enhance Jump";
        const jumpCd = document.createElement("div");
        jumpCd.className = "cooldown-text";
        jumpCd.textContent = jump.active
            ? `Ends in ${formatSeconds(jump.durationRemaining)}`
            : jump.cooldownRemaining > 0
                ? `CD ${formatSeconds(jump.cooldownRemaining)}`
                : "Ready";
        jumpTile.appendChild(jumpCd);

        carveTile.classList.toggle("active", !!carve.active);
        carveTile.textContent = carve.active ? "E – Carve Buff" : "E – Enhance Carve";
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

        tokensRow.textContent = `Tokens: ${tokens}`;
        questRow.textContent = questLine ? `Quest: ${questLine}` : "Quests: -";
        multiplayerRow.textContent = `Players: ${multiplayerCount}`;
        if (interactionPromptText) {
            interactionPrompt.textContent = interactionPromptText;
            interactionPrompt.classList.remove("hud-hidden");
        } else {
            interactionPrompt.classList.add("hud-hidden");
        }
    }

    function setAudioMuted(isMuted) {
        audioMuted = !!isMuted;
        audioToggle.textContent = audioMuted ? "Audio: Muted (M)" : "Audio: On (M)";
    }

    function setAudioToggleHandler(cb) {
        audioToggleHandler = cb;
    }

    return {
        update,
        flashNenBar,
        setGameplayVisible,
        setDebugVisible,
        setAudioMuted,
        setAudioToggleHandler,
        setInteractionPrompt: (text) => {
            interactionPrompt.textContent = text || "";
            interactionPrompt.classList.toggle("hud-hidden", !text);
        },
        setQuestLine: (text) => {
            questRow.textContent = text ? `Quest: ${text}` : "Quests: -";
        },
        setTokens: (value) => {
            tokensRow.textContent = `Tokens: ${value ?? 0}`;
        },
        setMultiplayerCount: (count) => {
            multiplayerRow.textContent = `Players: ${count ?? 1}`;
        }
    };
}
