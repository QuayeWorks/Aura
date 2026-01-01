# Cleanup Report

## Deleted files
- `src/terrain/SmoothTerrain.js` – Not referenced anywhere in the project.
- `src/ui/MinimapViewport.js` – Legacy minimap stub; minimap remains disabled and no code imports it.

## Moved/renamed files
- `src/debug/DebugSettings.js` → `src/systems/DebugSettings.js`
- `src/menus/MainMenuUI.js` → `src/ui/MainMenuUI.js`
- `src/menus/GameUIState.js` → `src/ui/GameUIState.js`
- `src/ui_dom/AbilityTreePanel.js` → `src/ui/AbilityTreePanel.js`
- `src/ui_dom/CompassHUD.js` → `src/ui/CompassHUD.js`
- `src/ui_dom/DebugMenu.js` → `src/ui/DebugMenu.js`
- `src/ui_dom/DevPanel.js` → `src/ui/DevPanel.js`
- `src/ui_dom/HUD.js` → `src/ui/HUD.js`
- `src/ui_dom/LoadingOverlay.js` → `src/ui/LoadingOverlay.js`
- `src/ui_dom/NPCDialog.js` → `src/ui/NPCDialog.js`
- `src/ui_dom/hud.css` → `src/ui/hud.css`
- `src/ui_dom/debugMenu.css` → `src/ui/debugMenu.css`
- `src/terrain/terrainFieldWorker.js` → `src/workers/terrainFieldWorker.js`
- `src/terrain/workers/terrainMeshWorker.js` → `src/workers/terrainMeshWorker.js`
- `src/terrain/workers/mcTables.js` → `src/workers/mcTables.js`

## Risky items intentionally kept
- None; all removals were limited to files with no imports or runtime references.

## Notes on potential string-based references
- Worker entry points now live under `src/workers/` and the runtime URLs in `ChunkedPlanetTerrain` were updated to match. No asset paths were changed.
