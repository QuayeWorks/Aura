/* global BABYLON */
// src/main.js
// Babylon + GUI come from global scripts in index.html
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";
import { DayNightSystem } from "./daynight/DayNightSystem.js";
import {
    createMainMenu,
    createSettingsMenu,
    createHud,
    createLoadingOverlay
} from "./menus/MainMenuUI.js";
import { createUIStateHelpers } from "./menus/GameUIState.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

// Planet radius in world units (meters, conceptually)
const PLANET_RADIUS_UNITS = 32400;

// Game state machine
const GameState = {
    MENU: "MENU",
    SETTINGS: "SETTINGS",
    LOADING: "LOADING",
    PLAYING: "PLAYING"
};

let gameState = GameState.MENU;

// World references
let scene = null;
let terrain = null;
let player = null;
let dayNightSystem = null;


// Camera + environment
let mainCamera = null;
let firefliesRoot = null;

// UI
let ui = null;
let mainMenuPanel = null;
let settingsPanel = null;
let hudPanel = null;
let loadingOverlay = null;
let loadingBarFill = null;
let loadingPercentText = null;
let playerInfoText = null;
let lodInfoText = null;
let sunMoonInfoText = null;
let uiState = null;

// Timing
let lastFrameTime = performance.now();

function createScene() {
    scene = new BABYLON.Scene(engine);

    // Start with a dark, night-like background for the main menu
    applyMenuVisuals();

    // Collisions stay enabled for world meshes / player, but we won't use them on the camera
    scene.collisionsEnabled = true;

    // Camera
    mainCamera = new BABYLON.ArcRotateCamera(
        "mainCamera",
        Math.PI * 1.3,
        Math.PI / 3,
        PLANET_RADIUS_UNITS * 0.08,
        new BABYLON.Vector3(0, 0, 0),
        scene
    );
    mainCamera.attachControl(canvas, true);

    // Camera constraints to avoid flipping / clipping
    mainCamera.allowUpsideDown = false;
    mainCamera.lowerBetaLimit = 0.15;
    mainCamera.upperBetaLimit = Math.PI / 2.1;
    mainCamera.checkCollisions = false;      // IMPORTANT: let limits, not collisions, control it
    mainCamera.lowerRadiusLimit = PLANET_RADIUS_UNITS * 0.001;
    mainCamera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.002;
    mainCamera.panningSensibility = 0;       // avoid accidental panning weirdness

    // Lights for menu + in-game
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.0, 1.0, 0.0),
        scene
    );
    // We want illumination only from the sun + moon system,
    // so keep these "legacy" lights effectively disabled.
    hemi.intensity = 0.1;
    hemi.groundColor = new BABYLON.Color3(0.05, 0.05, 0.1);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1.0, -0.3),
        scene
    );
    dir.intensity = 0.1;

    // --- Fireflies / menu ambiance ---
    createFireflies();

    // --- Day/Night cycle (24 minutes = full day) ---
    dayNightSystem = new DayNightSystem(scene, {
        planetRadius: PLANET_RADIUS_UNITS,
        dayLengthSeconds: 24 * 60,
        startTimeOfDay: 0.875, // ~9pm
        orbitUpDirection: new BABYLON.Vector3(0, 0, 1) // +Z is "up" for your spawn latitude
    });



    // --- UI ---
    ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    // Main menu
    mainMenuPanel = createMainMenu(ui, {
        onPlay: () => startGame(),
        onSettings: () => showSettings()
    });

    // Settings menu
    settingsPanel = createSettingsMenu(ui, {
        onBack: () => showMainMenu(),
        onLodChange: (value) => {
            if (terrain && terrain.setLodLevel) {
                terrain.setLodLevel(value);
            }
        }
    });

    // HUD
    {
        const hud = createHud(ui);
        hudPanel = hud.hudPanel;
        playerInfoText = hud.playerInfoText;
        lodInfoText = hud.lodInfoText;
        sunMoonInfoText = hud.sunMoonInfoText;
    }

    // Loading overlay
    {
        const loading = createLoadingOverlay(ui);
        loadingOverlay = loading.loadingOverlay;
        loadingBarFill = loading.loadingBarFill;
        loadingPercentText = loading.loadingPercentText;
    }

    // Hook up centralized UI state helpers
    uiState = createUIStateHelpers({
        scene,
        GameState,
        getGameState: () => gameState,
        setGameState: (value) => {
            gameState = value;
        },
        mainMenuPanel,
        settingsPanel,
        hudPanel,
        loadingOverlay,
        playerInfoText,
        lodInfoText,
        setFirefliesVisible
    });

    // Start in menu
    showMainMenu();




    // Carve with left mouse button while playing
    scene.onPointerObservable.add((pointerInfo) => {
        if (!terrain) return;
        if (gameState !== GameState.PLAYING) return;

        if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
            if (pointerInfo.event.button === 0) {
                const pick = scene.pick(
                    pointerInfo.event.clientX,
                    pointerInfo.event.clientY
                );
                if (pick && pick.hit) {
                    terrain.carveSphere(pick.pickedPoint, 70.0);
                }
            }
        }
    });

    return scene;
}

// --------------------
// Visual themes
// --------------------
function applyMenuVisuals() {
    if (uiState && uiState.applyMenuVisuals) {
        uiState.applyMenuVisuals();
    }
}


function applyGameVisuals() {
    if (uiState && uiState.applyGameVisuals) {
        uiState.applyGameVisuals();
    }
}


// --------------------
// Fireflies
// --------------------
function createFireflies() {
    firefliesRoot = new BABYLON.TransformNode("firefliesRoot", scene);

    const fireflyMat = new BABYLON.StandardMaterial("fireflyMat", scene);
    fireflyMat.emissiveColor = new BABYLON.Color3(0.8, 0.9, 1.0);
    fireflyMat.alpha = 0.9;
    fireflyMat.disableLighting = true;

    const radius = PLANET_RADIUS_UNITS * 0.05;
    const count = 80;

    for (let i = 0; i < count; i++) {
        const orb = BABYLON.MeshBuilder.CreateSphere(
            "firefly" + i,
            { diameter: PLANET_RADIUS_UNITS * 0.0015, segments: 6 },
            scene
        );
        orb.material = fireflyMat;
        orb.parent = firefliesRoot;

        const angle = Math.random() * Math.PI * 2;
        const y = (Math.random() * 2 - 1) * radius * 0.4;
        const r = radius * (0.4 + Math.random() * 0.6);

        orb.position.x = Math.cos(angle) * r;
        orb.position.y = y;
        orb.position.z = Math.sin(angle) * r;

        const phase = Math.random() * Math.PI * 2;
        orb.metadata = { phase, baseY: orb.position.y };
        orb.isPickable = false;
    }

    scene.registerBeforeRender(() => {
        if (!firefliesRoot) return;
        const t = performance.now() * 0.001;

        firefliesRoot.rotation.y = t * 0.05;

        firefliesRoot.getChildMeshes().forEach((orb) => {
            const phase = orb.metadata?.phase || 0;
            const baseY = orb.metadata?.baseY ?? orb.position.y;
            const bob = Math.sin(t * 2.0 + phase) * PLANET_RADIUS_UNITS * 0.0002;
            orb.position.y = baseY + bob;
        });
    });
}

function setFirefliesVisible(isVisible) {
    if (!firefliesRoot) return;
    firefliesRoot.setEnabled(isVisible);
}

// --------------------
// State transitions
// --------------------
function showMainMenu() {
    if (uiState && uiState.showMainMenu) {
        uiState.showMainMenu();
    }
}


function showSettings() {
    if (uiState && uiState.showSettings) {
        uiState.showSettings();
    }
}


function startGame() {
    if (gameState === GameState.LOADING || gameState === GameState.PLAYING) {
        return;
    }

    gameState = GameState.LOADING;

    if (mainMenuPanel) mainMenuPanel.isVisible = false;
    if (settingsPanel) settingsPanel.isVisible = false;
    if (hudPanel) hudPanel.isVisible = true;
    // no loading overlay – jump straight into the game
    if (playerInfoText) playerInfoText.isVisible = false;
    if (lodInfoText) lodInfoText.isVisible = false;

    setFirefliesVisible(true);
    applyMenuVisuals();

    if (!terrain) {
        terrain = new ChunkedPlanetTerrain(scene, {
            chunkCountX: 16,
            chunkCountZ: 16,
            baseChunkResolution: 128,
            isoLevel: 0,
            radius: PLANET_RADIUS_UNITS
        });

        terrain.onInitialBuildDone = () => {
            console.log("Initial planet build complete.");

            // Create player on planet surface
            player = new PlanetPlayer(scene, terrain, {
                planetRadius: PLANET_RADIUS_UNITS + 500,
                walkSpeed: 2,
                runSpeed: 55,
                height: 2,
                radius: 0.35
            });

            if (mainCamera && player && player.mesh) {
                // Let the player use this camera for movement direction
                player.attachCamera(mainCamera);

                // Reset camera constraints & orientation after attach
                mainCamera.allowUpsideDown = false;
                mainCamera.lowerBetaLimit = 0.15;
                mainCamera.upperBetaLimit = Math.PI / 2.1;
                mainCamera.checkCollisions = false;
                mainCamera.lowerRadiusLimit = PLANET_RADIUS_UNITS * 0.001;
                mainCamera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.002;

                mainCamera.radius = PLANET_RADIUS_UNITS * 0.02;
            }

            // Switch to playing visuals
            applyGameVisuals();
            setFirefliesVisible(false);

            // loading overlay is no longer used
            if (playerInfoText) playerInfoText.isVisible = true;
            if (lodInfoText) lodInfoText.isVisible = true;
            if (hudPanel) hudPanel.isVisible = true;

            gameState = GameState.PLAYING;
        };
    } else {
        // Planet already exists – just resume quickly
        applyGameVisuals();
        setFirefliesVisible(false);

        // no loading overlay
        if (playerInfoText) playerInfoText.isVisible = !!player;
        if (lodInfoText) lodInfoText.isVisible = !!player;
        if (hudPanel) hudPanel.isVisible = true;

        // Re-assert camera constraints on resume
        if (mainCamera) {
            mainCamera.allowUpsideDown = false;
            mainCamera.lowerBetaLimit = 0.15;
            mainCamera.upperBetaLimit = Math.PI / 2.1;
            mainCamera.checkCollisions = false;
            mainCamera.lowerRadiusLimit = PLANET_RADIUS_UNITS * 0.001;
            mainCamera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.003;
        }

        gameState = GameState.PLAYING;
    }
}

// --------------------
// Bootstrap + loop
// --------------------
createScene();

engine.runRenderLoop(() => {
    if (!scene) return;

    const now = performance.now();
    const dtSeconds = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    // Focus position for LOD & hemisphere
    let focusPos = null;
    if (player && player.mesh) {
        focusPos = player.mesh.position;
    } else if (scene.activeCamera) {
        focusPos = scene.activeCamera.position;
    }

    if (terrain) {
        terrain.updateStreaming(focusPos);
    }


    // Update player & HUD
    if (player && gameState === GameState.PLAYING) {
        if (dtSeconds > 0) {
            player.update(dtSeconds);
        }

        if (playerInfoText && player.mesh) {
            const pos = player.mesh.position;
            const r = pos.length();
            playerInfoText.text =
                `Player  x:${pos.x.toFixed(1)}  y:${pos.y.toFixed(1)}  z:${pos.z.toFixed(1)}  r:${r.toFixed(1)}`;
            playerInfoText.isVisible = true;
        }

        if (terrain && lodInfoText && focusPos && terrain.getDebugInfo) {
            const dbg = terrain.getDebugInfo(focusPos);
            const stats = dbg.lodStats || {};
            const per = stats.perLod || [];
            const maxLod = stats.maxLodInUse ?? 0;
            
            const chunkSizeX = (dbg.chunkWorldSizeX ?? 0).toFixed(1);

            let nearStr = "";
            if (dbg.nearestChunk) {
                const n = dbg.nearestChunk;
                nearStr =
                    `  nearLOD:${n.lodLevel} res:${n.dimX} dist:${n.distance.toFixed(1)}`;
            }

            lodInfoText.text =
                `Chunks ${dbg.chunkCountX}x${dbg.chunkCountZ}  baseRes:${dbg.baseChunkResolution}  cap:${dbg.lodCap}  maxUsed:${maxLod}  chunkSizeX:${chunkSizeX}\n` +
                `[0:${per[0] || 0}  1:${per[1] || 0}  2:${per[2] || 0}  3:${per[3] || 0}  4:${per[4] || 0}  5:${per[5] || 0}]${nearStr}`;
            lodInfoText.isVisible = true;
        }

        // Sun/Moon + time-of-day HUD
        if (dayNightSystem && sunMoonInfoText && dayNightSystem.getDebugInfo) {
            const dbg = dayNightSystem.getDebugInfo();
            if (
                dbg &&
                dbg.timeOfDay != null &&
                dbg.sunDir &&
                dbg.moonDir &&
                dbg.sunPos &&
                dbg.moonPos
            ) {
                const t = dbg.timeOfDay * 24.0;
                const hour = Math.floor(t);
                const minute = Math.floor((t - hour) * 60);
                const pad = (n) => (n < 10 ? "0" + n : "" + n);

                const sDir = dbg.sunDir;
                const mDir = dbg.moonDir;
                const sPos = dbg.sunPos;
                const mPos = dbg.moonPos;

                const radToDeg = 180 / Math.PI;

                // Global altitudes (relative to world Y axis)
                const sunAltGlobal = Math.asin(sDir.y) * radToDeg;
                const moonAltGlobal = Math.asin(mDir.y) * radToDeg;

                // Local altitudes (relative to the player's "up" direction)
                let sunAltLocal = sunAltGlobal;
                let moonAltLocal = moonAltGlobal;

                if (player && player.mesh) {
                    const up = player.mesh.position.clone();
                    if (up.lengthSquared() > 0) {
                        up.normalize();
                        sunAltLocal =
                            Math.asin(BABYLON.Vector3.Dot(sDir, up)) * radToDeg;
                        moonAltLocal =
                            Math.asin(BABYLON.Vector3.Dot(mDir, up)) * radToDeg;
                    }
                }

                sunMoonInfoText.text =
                    `Time ${pad(hour)}:${pad(minute)}  ` +
                    `sunAlt(local):${sunAltLocal.toFixed(1)}°  ` +
                    `moonAlt(local):${moonAltLocal.toFixed(1)}°\n` +
                    `sunPos(${sPos.x.toFixed(0)}, ${sPos.y.toFixed(0)}, ${sPos.z.toFixed(0)})  ` +
                    `moonPos(${mPos.x.toFixed(0)}, ${mPos.y.toFixed(0)}, ${mPos.z.toFixed(0)})`;
                sunMoonInfoText.isVisible = true;
            }
        }


    } else {
        if (playerInfoText) playerInfoText.isVisible = false;
        if (lodInfoText) lodInfoText.isVisible = false;
        if (sunMoonInfoText) sunMoonInfoText.isVisible = false;
    }


    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});



























