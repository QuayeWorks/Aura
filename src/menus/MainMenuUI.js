// src/Menus/MainMenuUI.js
// Centralized UI creation for main menu, settings, HUD, and loading overlay.

function createModernButton(label, accentColor, onClick) {
    const btn = new BABYLON.GUI.Button("btn_" + label);
    btn.height = "50px";
    btn.cornerRadius = 12;
    btn.thickness = 0;
    btn.background = "rgba(25, 40, 80, 0.95)";
    btn.color = "white";

    const stack = new BABYLON.GUI.StackPanel();
    stack.isVertical = false;
    stack.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;

    const leftAccent = new BABYLON.GUI.Rectangle();
    leftAccent.width = "6px";
    leftAccent.height = "60%";
    leftAccent.thickness = 0;
    leftAccent.background = accentColor;
    leftAccent.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;

    const text = new BABYLON.GUI.TextBlock();
    text.text = label;
    text.color = "white";
    text.fontSize = 22;
    text.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;

    stack.addControl(leftAccent);
    stack.addControl(text);
    btn.addControl(stack);

    btn.onPointerEnterObservable.add(() => {
        btn.background = "rgba(40, 70, 130, 0.95)";
    });
    btn.onPointerOutObservable.add(() => {
        btn.background = "rgba(25, 40, 80, 0.95)";
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
    const { onPlay, onSettings } = callbacks;

    const mainMenuPanel = new BABYLON.GUI.Rectangle("mainMenu");
    mainMenuPanel.width = "420px";
    mainMenuPanel.height = "380px";
    mainMenuPanel.cornerRadius = 16;
    mainMenuPanel.thickness = 0;
    mainMenuPanel.background = "rgba(10, 10, 25, 0.9)";
    mainMenuPanel.color = "white";
    mainMenuPanel.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    mainMenuPanel.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;

    mainMenuPanel.shadowBlur = 20;
    mainMenuPanel.shadowOffsetX = 0;
    mainMenuPanel.shadowOffsetY = 0;
    mainMenuPanel.shadowColor = "rgba(0, 255, 200, 0.7)";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "90%";
    stack.isVertical = true;
    mainMenuPanel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Aura Hunter Lite";
    title.height = "50px";
    title.color = "white";
    title.fontSize = 32;
    title.outlineColor = "#00ffa9";
    title.outlineWidth = 2;
    title.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "Planet Prototype";
    subtitle.height = "30px";
    subtitle.color = "#9eeaff";
    subtitle.fontSize = 18;
    subtitle.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(subtitle);

    const spacer1 = new BABYLON.GUI.Rectangle();
    spacer1.height = "24px";
    spacer1.thickness = 0;
    spacer1.background = "transparent";
    stack.addControl(spacer1);

    const playBtn = createModernButton("Play", "#00ffa9", () => {
        if (onPlay) onPlay();
    });
    stack.addControl(playBtn);

    const spacer2 = new BABYLON.GUI.Rectangle();
    spacer2.height = "10px";
    spacer2.thickness = 0;
    spacer2.background = "transparent";
    stack.addControl(spacer2);

    const settingsBtn = createModernButton("Settings", "#3f8cff", () => {
        if (onSettings) onSettings();
    });
    stack.addControl(settingsBtn);

    const spacer3 = new BABYLON.GUI.Rectangle();
    spacer3.height = "30px";
    spacer3.thickness = 0;
    spacer3.background = "transparent";
    stack.addControl(spacer3);

    const footer = new BABYLON.GUI.TextBlock();
    footer.text = "QuayeWorks • HXH build";
    footer.height = "30px";
    footer.color = "#666dff";
    footer.fontSize = 14;
    footer.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(footer);

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

    return { hudPanel, playerInfoText, lodInfoText };
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
