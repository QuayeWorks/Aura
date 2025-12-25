/* global BABYLON */
// src/Menus/MainMenuUI.js
// Centralized UI creation for main menu, settings, HUD, and loading overlay.

function createModernButton(label, accentColor, onClick) {
    const btn = new BABYLON.GUI.Rectangle("btn_" + label);
    btn.height = "56px";
    btn.thickness = 0;
    btn.cornerRadius = 18;
    btn.color = "transparent";
    btn.background = "rgba(6, 12, 30, 0.95)";
    btn.hoverCursor = "pointer";

    // Inner fill (slight contrast)
    const fill = new BABYLON.GUI.Rectangle();
    fill.thickness = 0;
    fill.width = 0.98;
    fill.height = 0.9;
    fill.cornerRadius = 16;
    fill.background = "rgba(18, 30, 70, 0.98)";
    btn.addControl(fill);

    const stack = new BABYLON.GUI.StackPanel();
    stack.isVertical = false;
    stack.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;

    // Central neon bar (like your current design, but slimmer)
    const accent = new BABYLON.GUI.Rectangle();
    accent.width = "4px";
    accent.height = "70%";
    accent.thickness = 0;
    accent.cornerRadius = 4;
    accent.background = accentColor;
    accent.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;

    const text = new BABYLON.GUI.TextBlock();
    text.text = label;
    text.color = "#f5fbff";
    text.fontSize = 24;
    text.fontStyle = "normal";
    text.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    text.paddingLeft = "12px";

    stack.addControl(accent);
    stack.addControl(text);
    fill.addControl(stack);

    // Hover states
    btn.onPointerEnterObservable.add(() => {
        fill.background = "rgba(30, 52, 110, 0.98)";
        accent.height = "80%";
    });
    btn.onPointerOutObservable.add(() => {
        fill.background = "rgba(18, 30, 70, 0.98)";
        accent.height = "70%";
    });

    if (onClick) {
        btn.onPointerUpObservable.add(onClick);
    }

    return btn;
}


/**
 * Main menu panel: title, subtitle, Play, Settings.
 * @param {BABYLON.GUI.AdvancedDynamicTexture} ui
 * @param {Object} callbacks
 *   - onPlay(): called when Play is clicked
 *   - onSettings(): called when Settings is clicked
 * @returns {BABYLON.GUI.Rectangle} mainMenuPanel
 */
export function createMainMenu(ui, callbacks = {}) {
    const { onPlay, onSettings, onContinue } = callbacks;

    const mainMenuPanel = new BABYLON.GUI.Rectangle("mainMenu");
    mainMenuPanel.width = "440px";
    mainMenuPanel.height = "400px";
    mainMenuPanel.cornerRadius = 24;
    mainMenuPanel.thickness = 0;
    mainMenuPanel.background = "rgba(4, 8, 20, 0.96)";
    mainMenuPanel.color = "white";
    mainMenuPanel.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    mainMenuPanel.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;

    // Soft neon glow, a bit subtler than before
    mainMenuPanel.shadowBlur = 28;
    mainMenuPanel.shadowOffsetX = 0;
    mainMenuPanel.shadowOffsetY = 0;
    mainMenuPanel.shadowColor = "rgba(0, 255, 180, 0.35)";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "86%";
    stack.isVertical = true;
    mainMenuPanel.addControl(stack);

    // Tiny top label, like a modern "chip"
    const chip = new BABYLON.GUI.TextBlock();
    chip.text = "QuayeWorks • HXH build";
    chip.height = "26px";
    chip.color = "#8ca8ff";
    chip.fontSize = 14;
    chip.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    chip.textVerticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    chip.alpha = 0.9;
    stack.addControl(chip);

    const spacerTop = new BABYLON.GUI.Rectangle();
    spacerTop.height = "10px";
    spacerTop.thickness = 0;
    spacerTop.background = "transparent";
    stack.addControl(spacerTop);

    // Title – clean, with subtle neon outline (Hunter x Hunter vibe)
    const title = new BABYLON.GUI.TextBlock();
    title.text = "Aura Hunter Lite";
    title.height = "52px";
    title.color = "#f8fff7";
    title.fontSize = 34;
    title.outlineColor = "#00ff99";
    title.outlineWidth = 2;
    title.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "Planet Prototype";
    subtitle.height = "32px";
    subtitle.color = "#9fe0ff";
    subtitle.fontSize = 18;
    subtitle.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    subtitle.alpha = 0.9;
    stack.addControl(subtitle);

    const spacer1 = new BABYLON.GUI.Rectangle();
    spacer1.height = "30px";
    spacer1.thickness = 0;
    spacer1.background = "transparent";
    stack.addControl(spacer1);

    // Continue button – only shown when a save exists
    const continueBtn = createModernButton("Continue", "#00ffa9", () => {
        if (onContinue) onContinue();
    });
    continueBtn.isVisible = false;
    continueBtn.isEnabled = false;
    stack.addControl(continueBtn);

    const spacerMid = new BABYLON.GUI.Rectangle();
    spacerMid.height = "8px";
    spacerMid.thickness = 0;
    spacerMid.background = "transparent";
    stack.addControl(spacerMid);

    // Play button – main CTA, green like Gon’s vibe
    const playBtn = createModernButton("New Game", "#00ffa9", () => {
        if (onPlay) onPlay();
    });
    stack.addControl(playBtn);

    const spacer2 = new BABYLON.GUI.Rectangle();
    spacer2.height = "12px";
    spacer2.thickness = 0;
    spacer2.background = "transparent";
    stack.addControl(spacer2);

    // Settings button – secondary, cooler blue
    const settingsBtn = createModernButton("Settings", "#3f8cff", () => {
        if (onSettings) onSettings();
    });
    stack.addControl(settingsBtn);

    const spacer3 = new BABYLON.GUI.Rectangle();
    spacer3.height = "32px";
    spacer3.thickness = 0;
    spacer3.background = "transparent";
    stack.addControl(spacer3);

    // Bottom hint – like a subtle “press Esc for menu” style line
    const footer = new BABYLON.GUI.TextBlock();
    footer.text = "Press Esc to return to menu";
    footer.height = "26px";
    footer.color = "#6b7cff";
    footer.fontSize = 14;
    footer.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    footer.alpha = 0.8;
    stack.addControl(footer);

    mainMenuPanel.setContinueVisible = (isVisible) => {
        continueBtn.isVisible = !!isVisible;
        continueBtn.isEnabled = !!isVisible;
    };
    mainMenuPanel.continueButton = continueBtn;

    ui.addControl(mainMenuPanel);
    return mainMenuPanel;
}


/**
 * Settings panel: LOD slider, Back.
 * @param {BABYLON.GUI.AdvancedDynamicTexture} ui
 * @param {Object} options
 *   - onBack(): called when Back is clicked
 *   - onLodChange(value): called when LOD slider changes (0..5)
 * @returns {BABYLON.GUI.Rectangle} settingsPanel
 */
export function createSettingsMenu(ui, options = {}) {
    const { onBack, onLodChange } = options;

    const settingsPanel = new BABYLON.GUI.Rectangle("settingsMenu");
    settingsPanel.width = "480px";
    settingsPanel.height = "420px";
    settingsPanel.cornerRadius = 16;
    settingsPanel.thickness = 0;
    settingsPanel.background = "rgba(10, 10, 25, 0.95)";
    settingsPanel.color = "white";
    settingsPanel.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    settingsPanel.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    settingsPanel.isVisible = false;

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "90%";
    stack.isVertical = true;
    settingsPanel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Settings";
    title.height = "50px";
    title.color = "white";
    title.fontSize = 26;
    title.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "Planet rendering";
    subtitle.height = "30px";
    subtitle.color = "#9eeaff";
    subtitle.fontSize = 18;
    subtitle.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(subtitle);

    const spacerTop = new BABYLON.GUI.Rectangle();
    spacerTop.height = "20px";
    spacerTop.thickness = 0;
    stack.addControl(spacerTop);

    const lodHeader = new BABYLON.GUI.TextBlock();
    lodHeader.text = "LOD quality: 5";
    lodHeader.height = "26px";
    lodHeader.color = "white";
    lodHeader.fontSize = 18;
    lodHeader.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    stack.addControl(lodHeader);

    const lodSlider = new BABYLON.GUI.Slider();
    lodSlider.minimum = 0;
    lodSlider.maximum = 5;
    lodSlider.value = 5;
    lodSlider.height = "20px";
    lodSlider.width = "100%";
    lodSlider.color = "#00ffa9";
    lodSlider.background = "#30334a";
    lodSlider.borderColor = "#555a88";
    lodSlider.thumbWidth = 18;
    lodSlider.onValueChangedObservable.add((v) => {
        const value = Math.round(v);
        lodHeader.text = "LOD quality: " + value.toString();
        if (onLodChange) onLodChange(value);
    });
    stack.addControl(lodSlider);

    const spacerMid2 = new BABYLON.GUI.Rectangle();
    spacerMid2.height = "24px";
    spacerMid2.thickness = 0;
    stack.addControl(spacerMid2);

    const backBtn = createModernButton("Back", "#777777", () => {
        if (onBack) onBack();
    });
    backBtn.height = "44px";
    stack.addControl(backBtn);

    ui.addControl(settingsPanel);
    return settingsPanel;
}

/**
 * HUD: player info + LOD info text blocks.
 * @returns {{hudPanel: BABYLON.GUI.Rectangle, playerInfoText: BABYLON.GUI.TextBlock, lodInfoText: BABYLON.GUI.TextBlock}}
 */
export function createHud(ui) {
    const hudPanel = new BABYLON.GUI.Rectangle("hudPanel");
    hudPanel.thickness = 0;
    hudPanel.background = "transparent";
    hudPanel.width = 1.0;
    hudPanel.height = 1.0;
    hudPanel.isPointerBlocker = false;
    hudPanel.isVisible = false;
    ui.addControl(hudPanel);

    const playerInfoText = new BABYLON.GUI.TextBlock("playerInfo");
    playerInfoText.text = "";
    playerInfoText.color = "white";
    playerInfoText.fontSize = 18;
    playerInfoText.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    playerInfoText.textVerticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    playerInfoText.paddingLeft = "12px";
    playerInfoText.paddingTop = "10px";
    playerInfoText.isVisible = false;
    hudPanel.addControl(playerInfoText);

    const lodInfoText = new BABYLON.GUI.TextBlock("lodInfo");
    lodInfoText.text = "";
    lodInfoText.color = "#9eeaff";
    lodInfoText.fontSize = 16;
    lodInfoText.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    lodInfoText.textVerticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    lodInfoText.paddingLeft = "12px";
    lodInfoText.paddingTop = "40px";
    lodInfoText.isVisible = false;
    hudPanel.addControl(lodInfoText);

    const sunMoonInfoText = new BABYLON.GUI.TextBlock("sunMoonInfo");
    sunMoonInfoText.text = "";
    sunMoonInfoText.color = "#ffddaa";
    sunMoonInfoText.fontSize = 15;
    sunMoonInfoText.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    sunMoonInfoText.textVerticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    sunMoonInfoText.paddingLeft = "12px";
    sunMoonInfoText.paddingTop = "70px";
    sunMoonInfoText.isVisible = false;
    hudPanel.addControl(sunMoonInfoText);

    return { hudPanel, playerInfoText, lodInfoText, sunMoonInfoText };
}


/**
 * Loading overlay: progress bar + text.
 * @returns {{loadingOverlay: BABYLON.GUI.Rectangle, loadingBarFill: BABYLON.GUI.Rectangle, loadingPercentText: BABYLON.GUI.TextBlock}}
 */
export function createLoadingOverlay(ui) {
    const loadingOverlay = new BABYLON.GUI.Rectangle("loadingOverlay");
    loadingOverlay.width = "50%";
    loadingOverlay.height = "100px";
    loadingOverlay.cornerRadius = 16;
    loadingOverlay.thickness = 0;
    loadingOverlay.background = "rgba(10, 10, 25, 0.9)";
    loadingOverlay.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    loadingOverlay.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_BOTTOM;
    loadingOverlay.paddingBottom = "40px";
    loadingOverlay.isVisible = false;

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "90%";
    stack.isVertical = true;
    loadingOverlay.addControl(stack);

    const loadingPercentText = new BABYLON.GUI.TextBlock("loadingPercent");
    loadingPercentText.text = "Generating planet: 0%";
    loadingPercentText.height = "30px";
    loadingPercentText.color = "white";
    loadingPercentText.fontSize = 20;
    loadingPercentText.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(loadingPercentText);

    const barBack = new BABYLON.GUI.Rectangle("loadingBarBack");
    barBack.height = "18px";
    barBack.width = "100%";
    barBack.thickness = 0;
    barBack.cornerRadius = 9;
    barBack.background = "rgba(40, 40, 70, 0.9)";
    stack.addControl(barBack);

    const loadingBarFill = new BABYLON.GUI.Rectangle("loadingBarFill");
    loadingBarFill.height = 1.0;
    loadingBarFill.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    loadingBarFill.width = "0%";
    loadingBarFill.thickness = 0;
    loadingBarFill.cornerRadius = 9;
    loadingBarFill.background = "#00ffa9";
    barBack.addControl(loadingBarFill);

    ui.addControl(loadingOverlay);

    return { loadingOverlay, loadingBarFill, loadingPercentText };
}

