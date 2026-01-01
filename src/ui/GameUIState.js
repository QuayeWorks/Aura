/* global BABYLON */
// src/ui/GameUIState.js
// Centralized UI state + visual theme handling for the game.

export function createUIStateHelpers({
    scene,
    GameState,
    getGameState,
    setGameState,
    mainMenuPanel,
    settingsPanel,
    hudPanel,
    loadingOverlay,
    playerInfoText,
    lodInfoText,
    setFirefliesVisible
}) {
    function applyMenuVisuals() {
        if (!scene) return;

        scene.clearColor = new BABYLON.Color4(0.01, 0.01, 0.04, 1.0);
        scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
    }

    function applyGameVisuals() {
        if (!scene) return;

        scene.clearColor = new BABYLON.Color4(0.1, 0.15, 0.25, 1.0);
        scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
        scene.fogColor = new BABYLON.Color3(0.1, 0.15, 0.25);
        scene.fogDensity = 3e-5;
    }

    function showMainMenu() {
        setGameState(GameState.MENU);

        if (mainMenuPanel) mainMenuPanel.isVisible = true;
        if (settingsPanel) settingsPanel.isVisible = false;
        if (hudPanel) hudPanel.isVisible = false;
        if (playerInfoText) playerInfoText.isVisible = false;
        if (lodInfoText) lodInfoText.isVisible = false;
        if (loadingOverlay) loadingOverlay.isVisible = false;

        if (setFirefliesVisible) setFirefliesVisible(true);
        applyMenuVisuals();
    }

    function showSettings() {
        setGameState(GameState.SETTINGS);

        if (mainMenuPanel) mainMenuPanel.isVisible = false;
        if (settingsPanel) settingsPanel.isVisible = true;
        if (hudPanel) hudPanel.isVisible = false;
        if (playerInfoText) playerInfoText.isVisible = false;
        if (lodInfoText) lodInfoText.isVisible = false;
        if (loadingOverlay) loadingOverlay.isVisible = false;

        if (setFirefliesVisible) setFirefliesVisible(true);
        applyMenuVisuals();
    }

    return {
        applyMenuVisuals,
        applyGameVisuals,
        showMainMenu,
        showSettings
    };
}
