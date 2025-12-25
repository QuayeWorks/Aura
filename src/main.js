/* global BABYLON */
// src/main.js
// Babylon + GUI come from global scripts in index.html
// Minimap is intentionally disabled for now.
// (Keep the import commented to avoid bundling/confusion until RTT-based minimap returns.)
// import { createMinimapViewport } from "./ui/MinimapViewport.js";
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
import { GameRuntime } from "./gameplay/GameRuntime.js";
import { createDomHUD } from "./ui_dom/HUD.js";
import { SaveSystem } from "./save/SaveSystem.js";
import { CompassHUD } from "./ui_dom/CompassHUD.js";
import { AudioSystem } from "./audio/AudioSystem.js";
import { createAbilityTreePanel } from "./ui_dom/AbilityTreePanel.js";

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
let minimap = null;
let gameRuntime = null;
let compassHud = null;
let audioSystem = null;
const saveSystem = new SaveSystem();
let pendingLoadSnapshot = null;


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
let domHud = null;
let abilityTreePanel = null;


// Timing
let lastFrameTime = performance.now();
let autosaveTimer = 0;
const AUTOSAVE_INTERVAL = 30;

// --- Camera anti-clipping (ArcRotate spring arm) ---
const CAM_PAD = 0.8;      // stay this far away from terrain
const CAM_SMOOTH = 0.25;  // 0..1 (higher = snappier)

// Third-person camera distance (scaled to planet)
const CAM_MIN_RADIUS = PLANET_RADIUS_UNITS * 0.001;
const CAM_MAX_RADIUS = PLANET_RADIUS_UNITS * 0.005;

function clampArcRotateRadiusAgainstTerrain(scene, camera, targetPos) {
    if (!scene || !camera || !targetPos) return;

    // Desired camera position given current alpha/beta/radius
    const desiredPos = camera.position.clone();
    const origin = targetPos.clone();

    const toCam = desiredPos.subtract(origin);
    const desiredDist = toCam.length();
    if (desiredDist < 1e-3) return;

    const dir = toCam.scale(1 / desiredDist);

    // Raycast from target -> camera
    const ray = new BABYLON.Ray(origin, dir, desiredDist + 2.0);

    // Only collide with terrain meshes (your terrain sets metadata.isTerrain = true)
    const hit = scene.pickWithRay(ray, (m) => !!(m && m.isPickable && m.metadata && m.metadata.isTerrain));

    let targetRadius = desiredDist;
    if (hit && hit.hit) {
        targetRadius = Math.max(camera.lowerRadiusLimit ?? 1.0, hit.distance - CAM_PAD);
    }

    // Smooth radius changes to avoid jitter
    camera.radius = BABYLON.Scalar.Lerp(camera.radius, targetRadius, CAM_SMOOTH);
}

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
        PLANET_RADIUS_UNITS * 0.01,
        new BABYLON.Vector3(0, 0, 0),
        scene
    );
    mainCamera.attachControl(canvas, true);

    // Camera constraints to avoid flipping / clipping
    mainCamera.allowUpsideDown = false;
    mainCamera.lowerBetaLimit = 0.15;
    mainCamera.upperBetaLimit = Math.PI / 2.1;
    mainCamera.checkCollisions = false;      // IMPORTANT: let limits, not collisions, control it
    mainCamera.lowerRadiusLimit = CAM_MIN_RADIUS;
    mainCamera.upperRadiusLimit = CAM_MAX_RADIUS;
    mainCamera.panningSensibility = 0;       // avoid accidental panning weirdness

    // Lights for menu + in-game
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.0, 1.0, 0.0),
        scene
    );
    // We want illumination only from the sun + moon system,
    // so keep these "legacy" lights effectively disabled.
    hemi.intensity = 0.2;
    hemi.groundColor = new BABYLON.Color3(0.05, 0.05, 0.1);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1.0, -0.3),
        scene
    );
    dir.intensity = 0.2;

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
    // You *do* still want the main menu / HUD, just not the minimap.
    // So we create a single main ADT and skip any minimap UI/camera wiring.
    ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
    ui.layer.layerMask = 0x1;

    // Main menu
    mainMenuPanel = createMainMenu(ui, {
        onPlay: () => startNewGame(),
        onSettings: () => showSettings(),
        onContinue: () => continueFromSave()
    });
    refreshContinueButton();

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

    // DOM HUD overlay (not Babylon GUI)
    if (!domHud) {
        domHud = createDomHUD();
        domHud.setGameplayVisible(false);
        domHud.setDebugVisible(false);
    }
    if (!abilityTreePanel) {
        abilityTreePanel = createAbilityTreePanel({ abilityTree: null });
        abilityTreePanel.setVisible(false);
    }
    if (!compassHud) {
        compassHud = new CompassHUD();
        compassHud.setVisible(false);
    }

    // Start in menu
    showMainMenu();

    // (Optional) keyboard shortcuts for quick testing
    window.addEventListener("keydown", (e) => {
        if (e.repeat) return;
        if (e.code === "Enter" && gameState === GameState.MENU) startNewGame();
        if (e.code === "Escape" && gameState === GameState.PLAYING) showMainMenu();
        if (e.code === "KeyB" && terrain && terrain.cycleBiomeDebugMode) {
            const mode = terrain.cycleBiomeDebugMode();
            console.log("Biome debug mode:", mode);
        }
    });
    




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
                    if (gameRuntime) {
                        gameRuntime.handleCarve(pick.pickedPoint);
                    } else {
                        terrain.carveSphere(pick.pickedPoint, 70.0);
                    }
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
        orb.layerMask = 0x1;
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

function refreshContinueButton() {
    if (mainMenuPanel && mainMenuPanel.setContinueVisible) {
        mainMenuPanel.setContinueVisible(saveSystem.hasSave());
    }
}

function buildSaveSnapshot() {
    if (!player || !player.mesh || !terrain || !gameRuntime) return null;
    const pos = player.mesh.position;
    const forward = player.mesh.getDirection ? player.mesh.getDirection(BABYLON.Axis.Z) : null;
    const regionSize = terrain.chunkWorldSizeX || (terrain.radius ? terrain.radius * 0.1 : 5000);
    const carves = saveSystem.filterCarves(terrain.getCarveHistory?.() || [], { regionSize });
    const runtimeSnapshot = gameRuntime.getSnapshot?.();

    return {
        player: {
            position: { x: pos.x, y: pos.y, z: pos.z },
            forward: forward ? { x: forward.x, y: forward.y, z: forward.z } : null
        },
        camera: mainCamera ? { alpha: mainCamera.alpha, beta: mainCamera.beta, radius: mainCamera.radius } : null,
        stats: runtimeSnapshot?.stats,
        abilityTree: runtimeSnapshot?.abilityTree,
        carves
    };
}

function performSave() {
    const snapshot = buildSaveSnapshot();
    if (snapshot) {
        saveSystem.save(snapshot);
        refreshContinueButton();
    }
}

function applyPendingSnapshot() {
    if (!pendingLoadSnapshot) return;
    const snap = pendingLoadSnapshot;
    if (snap.carves && terrain?.setCarveHistory) {
        terrain.setCarveHistory(snap.carves);
    }
    if (gameRuntime && snap.stats) {
        gameRuntime.applySnapshot(snap);
    }
    if (player?.mesh && snap.player?.position) {
        player.mesh.position.x = snap.player.position.x;
        player.mesh.position.y = snap.player.position.y;
        player.mesh.position.z = snap.player.position.z;
        if (player.velocity?.set) {
            player.velocity.set(0, 0, 0);
        } else if (BABYLON?.Vector3) {
            player.velocity = new BABYLON.Vector3(0, 0, 0);
        }
        if (player.reprojectToSurface) player.reprojectToSurface();
    }
    if (mainCamera && snap.camera) {
        if (snap.camera.alpha != null) mainCamera.alpha = snap.camera.alpha;
        if (snap.camera.beta != null) mainCamera.beta = snap.camera.beta;
        if (snap.camera.radius != null) mainCamera.radius = snap.camera.radius;
    }
    pendingLoadSnapshot = null;
}

function startNewGame() {
    pendingLoadSnapshot = null;
    saveSystem.clear();
    refreshContinueButton();
    startGame();
}

function continueFromSave() {
    const loaded = saveSystem.load();
    if (loaded) {
        pendingLoadSnapshot = loaded;
        startGame();
    } else {
        startGame();
    }
}

// --------------------
// State transitions
// --------------------
function showMainMenu() {
    if (gameState === GameState.PLAYING) {
        performSave();
    }
    refreshContinueButton();
    if (minimap) {
        minimap.setEnabled(false);
        minimap.setOverlayVisible(false);
    }
    if (uiState && uiState.showMainMenu) {
        uiState.showMainMenu();
    }

    // Menu owns input: freeze gameplay systems cleanly
    if (player && player.setInputEnabled) player.setInputEnabled(false);
    if (dayNightSystem && dayNightSystem.setEnabled) dayNightSystem.setEnabled(false);
    if (gameRuntime) gameRuntime.setEnabled(false);
    if (domHud) {
        domHud.setGameplayVisible(false);
        domHud.setDebugVisible(false);
    }
    if (abilityTreePanel) abilityTreePanel.setVisible(false);
    if (compassHud) compassHud.setVisible(false);

    // Keep the menu camera stable even if a player exists.
    if (mainCamera) {
        mainCamera.lockedTarget = new BABYLON.Vector3(0, 0, 0);
    }
}


function showSettings() {
    if (minimap) minimap.setEnabled(false);
    if (uiState && uiState.showSettings) {
        uiState.showSettings();
    }

    // Settings still counts as menu: no gameplay input/simulation
    if (player && player.setInputEnabled) player.setInputEnabled(false);
    if (dayNightSystem && dayNightSystem.setEnabled) dayNightSystem.setEnabled(false);
    if (gameRuntime) gameRuntime.setEnabled(false);
    if (domHud) {
        domHud.setGameplayVisible(false);
        domHud.setDebugVisible(false);
    }
    if (abilityTreePanel) abilityTreePanel.setVisible(false);
    if (compassHud) compassHud.setVisible(false);

    if (mainCamera) {
        mainCamera.lockedTarget = new BABYLON.Vector3(0, 0, 0);
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

        terrain.setOnInitialBuildDone(() => {
            console.log("Initial planet build complete.");

            // Create player on planet surface
            player = new PlanetPlayer(scene, terrain, {
                planetRadius: PLANET_RADIUS_UNITS + 500,
                walkSpeed: 2,
                runSpeed: 205,
                height: 2,
                radius: 0.35,
                jumpGraceSeconds: 15,
                inputEnabled: true
            });

            if (mainCamera && player && player.mesh) {
                // Let the player use this camera for movement direction
                player.attachCamera(mainCamera);

                // Reset camera constraints & orientation after attach
                mainCamera.allowUpsideDown = false;
                mainCamera.lowerBetaLimit = 0.15;
                mainCamera.upperBetaLimit = Math.PI / 2.1;
                mainCamera.checkCollisions = false;
                mainCamera.lowerRadiusLimit = CAM_MIN_RADIUS;
                mainCamera.upperRadiusLimit = CAM_MAX_RADIUS;

                mainCamera.radius = Math.min(Math.max(mainCamera.radius, CAM_MIN_RADIUS), CAM_MAX_RADIUS);
            }

            const baseMovement = {
                walkSpeed: player.walkSpeed,
                runSpeed: player.runSpeed,
                jumpImpulse: player.jumpSpeed,
                gravity: player.gravity,
                accel: player.accel,
                groundFriction: player.groundFriction,
                airFriction: player.airFriction
            };

            gameRuntime = new GameRuntime({
                player,
                terrain,
                hud: domHud,
                baseMovement,
                baseCarve: { radius: 70, nenCost: 14 },
                scene,
                dayNightSystem
            });

            if (abilityTreePanel && gameRuntime?.abilityTree) {
                abilityTreePanel.setAbilityTree(gameRuntime.abilityTree);
            }

            if (!audioSystem) {
                audioSystem = new AudioSystem({ player, terrain, gameRuntime });
            } else {
                audioSystem.player = player;
                audioSystem.terrain = terrain;
                audioSystem.gameRuntime = gameRuntime;
            }
            if (audioSystem) {
                audioSystem.ensureStarted();
            }
            if (domHud) {
                domHud.setAudioToggleHandler(() => {
                    if (audioSystem) audioSystem.toggleMute();
                    domHud.setAudioMuted(audioSystem?.muted);
                });
                domHud.setAudioMuted(audioSystem?.muted);
            }

            applyPendingSnapshot();

            // Switch to playing visuals
            applyGameVisuals();
            setFirefliesVisible(false);

            if (domHud) domHud.setGameplayVisible(true);
            if (gameRuntime) gameRuntime.setEnabled(true);
            if (compassHud) compassHud.setVisible(true);

            // loading overlay is no longer used
            if (playerInfoText) playerInfoText.isVisible = true;
            if (lodInfoText) lodInfoText.isVisible = true;
            if (hudPanel) hudPanel.isVisible = true;

            gameState = GameState.PLAYING;
            if (player && player.setInputEnabled) player.setInputEnabled(true);
            if (player && player.reprojectToSurface) player.reprojectToSurface();
            if (dayNightSystem && dayNightSystem.setEnabled) dayNightSystem.setEnabled(true);
            if (mainCamera && player && player.mesh) mainCamera.lockedTarget = player.mesh;
            autosaveTimer = 0;
            //minimap.setEnabled(true);
            //minimap.setOverlayVisible(true);


        });
    } else {
        // Planet already exists – just resume quickly
        applyGameVisuals();
        setFirefliesVisible(false);

        if (!gameRuntime && player) {
            const baseMovement = {
                walkSpeed: player.walkSpeed,
                runSpeed: player.runSpeed,
                jumpImpulse: player.jumpSpeed,
                gravity: player.gravity,
                accel: player.accel,
                groundFriction: player.groundFriction,
                airFriction: player.airFriction
            };

            gameRuntime = new GameRuntime({
                player,
                terrain,
                hud: domHud,
                baseMovement,
                baseCarve: { radius: 70, nenCost: 14 },
                scene,
                dayNightSystem
            });

            if (abilityTreePanel && gameRuntime?.abilityTree) {
                abilityTreePanel.setAbilityTree(gameRuntime.abilityTree);
            }
        }

        if (!audioSystem) {
            audioSystem = new AudioSystem({ player, terrain, gameRuntime });
        } else {
            audioSystem.player = player;
            audioSystem.terrain = terrain;
            audioSystem.gameRuntime = gameRuntime;
        }
        if (audioSystem) {
            audioSystem.ensureStarted();
        }
        if (domHud) {
            domHud.setAudioToggleHandler(() => {
                if (audioSystem) audioSystem.toggleMute();
                domHud.setAudioMuted(audioSystem?.muted);
            });
            domHud.setAudioMuted(audioSystem?.muted);
        }

        applyPendingSnapshot();

        if (domHud) domHud.setGameplayVisible(true);
        if (gameRuntime) gameRuntime.setEnabled(true);
        if (compassHud) compassHud.setVisible(true);

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
            mainCamera.lowerRadiusLimit = CAM_MIN_RADIUS;
            mainCamera.upperRadiusLimit = CAM_MAX_RADIUS;
        }

        gameState = GameState.PLAYING;
        if (player && player.setInputEnabled) player.setInputEnabled(true);
        if (player && player.reprojectToSurface) player.reprojectToSurface();
        if (dayNightSystem && dayNightSystem.setEnabled) dayNightSystem.setEnabled(true);
        // Minimap is intentionally disabled. Keep these guarded for future RTT minimap return.
        if (minimap) {
            minimap.setEnabled(true);
            minimap.setOverlayVisible(true);
        }
        autosaveTimer = 0;

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

    if (terrain && (gameState === GameState.LOADING || gameState === GameState.PLAYING)) {
        terrain.updateStreaming(focusPos);
    }


    // Update player & HUD
    if (player && gameState === GameState.PLAYING) {
        autosaveTimer += dtSeconds;
        if (autosaveTimer >= AUTOSAVE_INTERVAL) {
            performSave();
            autosaveTimer = 0;
        }
        if (dtSeconds > 0) {
            if (gameRuntime) gameRuntime.update(dtSeconds);
            player.update(dtSeconds);
            // === CAMERA TERRAIN CLIP PREVENTION (ADD THIS BLOCK) ===
            if (mainCamera && player.mesh) {
                // Player "head" position (planet-aware up)
                const up = player.mesh.position.clone();
                if (up.lengthSquared() > 0) up.normalize();
    
                const headPos = player.mesh.position.add(up.scale(2.0)); // tweak height if needed
    
                clampArcRotateRadiusAgainstTerrain(
                    scene,
                    mainCamera,
                    headPos
                );
            }

            if (minimap) {
                minimap.updateFromPlayerMesh(player.mesh);
            }

            if (compassHud && player.mesh) {
                const playerForward = player.mesh.getDirection
                    ? player.mesh.getDirection(BABYLON.Axis.Z)
                    : null;
                const cameraForward = mainCamera && mainCamera.getDirection
                    ? mainCamera.getDirection(BABYLON.Axis.Z)
                    : null;

                const compassData = compassHud.update({
                    playerPosition: player.mesh.position,
                    playerForward: cameraForward || playerForward
                });
                if (terrain && compassData) {
                    terrain.latitudeSnowBias = compassData.snowBias;
                }
            }

            if (audioSystem) {
                audioSystem.update(dtSeconds);
            }

            // === END CAMERA FIX ===
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







