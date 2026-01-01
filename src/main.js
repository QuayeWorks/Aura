/* global BABYLON */
// src/main.js
// Babylon + GUI come from global scripts in index.html
// Minimap is intentionally disabled for now. Keep disabled until a new RTT-based minimap returns.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";
import { DayNightSystem } from "./daynight/DayNightSystem.js";
import {
    createMainMenu,
    createSettingsMenu,
    createHud
} from "./ui/MainMenuUI.js";
import { createUIStateHelpers } from "./ui/GameUIState.js";
import { GameRuntime } from "./gameplay/GameRuntime.js";
import { createDomHUD } from "./ui/HUD.js";
import { DevPanel } from "./ui/DevPanel.js";
import { SaveSystem } from "./save/SaveSystem.js";
import { CompassHUD } from "./ui/CompassHUD.js";
import { AudioSystem } from "./audio/AudioSystem.js";
import { createAbilityTreePanel } from "./ui/AbilityTreePanel.js";
import { createLoadingOverlay as createDomLoadingOverlay } from "./ui/LoadingOverlay.js";
import { raiseActorToSafeAltitude } from "./gameplay/GroundSpawnGate.js";
import { DebugMenu } from "./ui/DebugMenu.js";
import { DebugSettings } from "./systems/DebugSettings.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

// Planet radius in world units (meters, conceptually)
const PLANET_RADIUS_UNITS = 36000;

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
let devPanel = null;
let audioSystem = null;
const saveSystem = new SaveSystem();
let pendingLoadSnapshot = null;
let loadingGate = null;


// Camera + environment
let mainCamera = null;
let orbitCamera = null;
let cameraPivot = null;
let cameraCollider = null;
let cameraColliderDebug = null;
let cameraColliderDebugVisible = false;
let firefliesRoot = null;

// UI
let ui = null;
let mainMenuPanel = null;
let settingsPanel = null;
let hudPanel = null;
let loadingOverlay = null;
let playerInfoText = null;
let lodInfoText = null;
let sunMoonInfoText = null;
let uiState = null;
let domHud = null;
let abilityTreePanel = null;
let debugMenu = null;
let debugSubscription = null;

function applyDebugFlags(flags = DebugSettings.getAllFlags()) {
    if (domHud) {
        domHud.setGameplayVisible(!!flags.showGameplayHud);
        domHud.setDebugVisible(!!flags.showDebugHud);
    }

    if (devPanel) {
        devPanel.setVisible(!!flags.showDevPanel);
    }

    if (compassHud) {
        compassHud.setVisible(!!flags.showCompass);
    }

    if (terrain?.setBiomeDebugMode) {
        terrain.setBiomeDebugMode(flags.biomeDebug ? "biome" : "off");
    }

    cameraColliderDebugVisible = !!flags.cameraColliderDebug;
    if (cameraColliderDebugVisible) ensureCameraColliderDebugMesh();
    if (cameraColliderDebug) {
        cameraColliderDebug.isVisible = cameraColliderDebugVisible;
    }
    if (cameraCollider) {
        cameraCollider.isVisible = cameraColliderDebugVisible;
    }

    if (gameRuntime) {
        gameRuntime.setLocalSimEnabled(!!flags.localSimulation);
        gameRuntime.poiManager?.setDebugVisible?.(!!flags.showPOIDebug);
    }

    if (player?.setDebugLogRecoveries) {
        player.setDebugLogRecoveries(!!flags.logCollisionRecovery);
    }
}

function ensureDebugMenu() {
    if (debugMenu) return;

    const options = [
        { key: "showDevPanel", label: "Dev Panel" },
        { key: "showGameplayHud", label: "Gameplay HUD" },
        { key: "showDebugHud", label: "Debug HUD" },
        { key: "showCompass", label: "Compass" },
        { key: "showPOIDebug", label: "POI Debug" },
        { key: "cameraColliderDebug", label: "Camera Collider" },
        { key: "biomeDebug", label: "Biome Debug" },
        { key: "localSimulation", label: "Local Simulation" },
        { key: "logCollisionRecovery", label: "Log Collision Recovery" }
    ];

    debugMenu = new DebugMenu({
        options,
        onVisibilityChange: (isVisible) => {
            if (player?.setInputEnabled) {
                player.setInputEnabled(!isVisible);
            }
        }
    });

    debugSubscription = DebugSettings.subscribe(({ flags }) => applyDebugFlags(flags));
    applyDebugFlags(DebugSettings.getAllFlags());
}


// Timing
let lastFrameTime = performance.now();
let autosaveTimer = 0;
const AUTOSAVE_INTERVAL = 30;
const LOADING_WAIT_SECONDS = 30;
const LOADING_RELEASE_CLAMP_SECONDS = 2;
const LOADING_RELEASE_MAX_STEP = 1 / 120;

// Third-person camera distance (scaled to planet)
const CAM_MIN_RADIUS = PLANET_RADIUS_UNITS * 0.001;
const CAM_MAX_RADIUS = PLANET_RADIUS_UNITS * 0.005;

// Physical camera collision tuning
const CAMERA_COLLIDER_RADIUS = 1;       // meters
const CAMERA_MAX_STEP_FRACTION = 0.75;    // portion of radius to move per collision step
const CAMERA_HEAD_OFFSET = 2.0;           // meters above player origin to target
const CAMERA_RECOVERY_STEPS = 4;          // attempts to push out if chunk rebuild spawns intersecting geometry
const CAMERA_RECOVERY_STEP_SIZE = CAMERA_COLLIDER_RADIUS * 0.65;

function createScene() {
    scene = new BABYLON.Scene(engine);

    // Start with a dark, night-like background for the main menu
    applyMenuVisuals();

    // Collisions stay enabled for world meshes / player, but we won't use them on the camera
    scene.collisionsEnabled = true;

    // Camera rig: orbit controller (for input), physical collider, and view camera
    orbitCamera = new BABYLON.ArcRotateCamera(
        "orbitCamera",
        Math.PI * 1.3,
        Math.PI / 3,
        PLANET_RADIUS_UNITS * 0.01,
        new BABYLON.Vector3(0, 0, 0),
        scene
    );
    orbitCamera.attachControl(canvas, true);
    orbitCamera.allowUpsideDown = true;
    orbitCamera.checkCollisions = false;
    orbitCamera.lowerRadiusLimit = CAM_MIN_RADIUS;
    orbitCamera.upperRadiusLimit = CAM_MAX_RADIUS;
    orbitCamera.panningSensibility = 0;

    mainCamera = new BABYLON.FreeCamera(
        "mainCamera",
        orbitCamera.position.clone(),
        scene
    );
    scene.activeCamera = mainCamera;
    mainCamera.minZ = 0.1;
    mainCamera.layerMask = 0x1;
    mainCamera.inputs?.clear?.();

    cameraPivot = new BABYLON.TransformNode("cameraPivot", scene);
    cameraCollider = new BABYLON.Mesh("cameraCollider", scene);
    cameraCollider.isVisible = false;
    cameraCollider.isPickable = false;
    cameraCollider.checkCollisions = true;
    cameraCollider.ellipsoid = new BABYLON.Vector3(
        CAMERA_COLLIDER_RADIUS,
        CAMERA_COLLIDER_RADIUS,
        CAMERA_COLLIDER_RADIUS
    );
    cameraCollider.ellipsoidOffset = BABYLON.Vector3.Zero();
    cameraCollider.collisionRetryCount = 1;
    cameraCollider.position.copyFrom(orbitCamera.position);
    cameraPivot.position.copyFrom(orbitCamera.target || BABYLON.Vector3.Zero());
    syncViewCamera(BABYLON.Axis.Y);

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
        loadingOverlay: null,
        playerInfoText,
        lodInfoText,
        setFirefliesVisible
    });

    // DOM HUD overlay (not Babylon GUI)
    if (!domHud) {
        domHud = createDomHUD();
    }
    if (!devPanel) {
        devPanel = new DevPanel();
        devPanel.setToggleGuard(() => gameState === GameState.PLAYING);
    }
    if (!abilityTreePanel) {
        abilityTreePanel = createAbilityTreePanel({ abilityTree: null });
        abilityTreePanel.setVisible(false);
    }
    if (!compassHud) {
        compassHud = new CompassHUD();
    }

    if (!loadingOverlay) {
        loadingOverlay = createDomLoadingOverlay();
    }

    ensureDebugMenu();

    // Start in menu
    showMainMenu();

    // (Optional) keyboard shortcuts for quick testing
    window.addEventListener("keydown", (e) => {
        if (e.repeat) return;
        if (e.code === "Enter" && gameState === GameState.MENU) startNewGame();
        if (e.code === "Escape" && gameState === GameState.PLAYING) showMainMenu();
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

function beginLoadingGate() {
    loadingGate = {
        elapsed: 0,
        released: false
    };

    if (loadingOverlay?.show) {
        loadingOverlay.show();
        loadingOverlay.setProgress(0);
        loadingOverlay.setMessage("Loading world… 0%");
        loadingOverlay.setStreamingMessage("");
    }
}

function freezePlayerForLoading() {
    if (!player) return;
    if (player.setInputEnabled) player.setInputEnabled(false);
    if (player.velocity?.set) {
        player.velocity.set(0, 0, 0);
    }
}

function moveActorToSafeAltitude(actor, fallbackUp) {
    if (!actor) return;
    const unitsPerMeter = terrain?.biomeSettings?.unitsPerMeter ?? 1;
    const planetRadius = terrain?.radius ?? PLANET_RADIUS_UNITS;
    const up = fallbackUp
        || actor.spawnDirection?.clone?.()
        || actor?.mesh?.position?.clone?.();
    raiseActorToSafeAltitude(actor, { planetRadius, unitsPerMeter, fallbackUp: up });
    if (actor.velocity?.set) {
        actor.velocity.set(0, 0, 0);
    }
}

function releaseLoadingGate() {
    if (!player) return;
    if (loadingGate?.released) return;
    loadingGate.released = true;

    if (loadingOverlay) {
        loadingOverlay.setProgress(1);
        loadingOverlay.setMessage("Loading world… 100%");
        loadingOverlay.setStreamingMessage("");
        loadingOverlay.fadeOut();
    }

    if (player?.applyGroundGateClamp) {
        player.applyGroundGateClamp(LOADING_RELEASE_CLAMP_SECONDS, LOADING_RELEASE_MAX_STEP);
    }
    if (player?.velocity?.set) {
        player.velocity.set(0, 0, 0);
    }

    enterGameplayFromLoading();
    loadingGate = null;
}

function updateLoadingGate(dtSeconds) {
    if (!loadingGate) return;

    loadingGate.elapsed += dtSeconds;
    const progress = Math.min(loadingGate.elapsed / LOADING_WAIT_SECONDS, 1);

    if (loadingOverlay) {
        loadingOverlay.setProgress(progress);
        const pct = Math.round(progress * 100);
        loadingOverlay.setMessage(`Loading world… ${pct}%`);
    }

    if (loadingGate.elapsed >= LOADING_WAIT_SECONDS) {
        releaseLoadingGate();
    }
}

function getCameraOrbitBasis(up) {
    let forwardRef = BABYLON.Vector3.Cross(up, BABYLON.Axis.X);
    if (forwardRef.lengthSquared() < 1e-3) {
        forwardRef = BABYLON.Vector3.Cross(up, BABYLON.Axis.Z);
    }
    forwardRef.normalize();

    const right = BABYLON.Vector3.Cross(up, forwardRef).normalize();
    const forward = BABYLON.Vector3.Cross(right, up).normalize();
    return { right, up, forward };
}

function computeDesiredCameraPosition(pivotPos, up) {
    if (!orbitCamera) return pivotPos.clone();

    const { right, up: basisUp, forward } = getCameraOrbitBasis(up);
    const radius = orbitCamera.radius;
    const alpha = orbitCamera.alpha;
    const beta = orbitCamera.beta;

    const sinBeta = Math.sin(beta);
    const cosBeta = Math.cos(beta);

    const offset = right
        .scale(radius * sinBeta * Math.cos(alpha))
        .add(basisUp.scale(radius * cosBeta))
        .add(forward.scale(radius * sinBeta * Math.sin(alpha)));

    return pivotPos.add(offset);
}

function moveCameraColliderToward(desiredPos) {
    if (!cameraCollider) return;

    const delta = desiredPos.subtract(cameraCollider.position);
    const distance = delta.length();
    if (distance < 1e-4) return;

    const maxStep = CAMERA_COLLIDER_RADIUS * CAMERA_MAX_STEP_FRACTION;
    const steps = Math.max(1, Math.ceil(distance / maxStep));
    const step = delta.scale(1 / steps);

    for (let i = 0; i < steps; i++) {
        cameraCollider.moveWithCollisions(step);
    }
}

function syncViewCamera(camUp) {
    if (!mainCamera || !cameraPivot || !cameraCollider) return;

    mainCamera.position.copyFrom(cameraCollider.position);
    mainCamera.upVector = camUp;
    mainCamera.setTarget(cameraPivot.position);

    if (cameraColliderDebug) {
        cameraColliderDebug.position.copyFrom(cameraCollider.position);
        cameraColliderDebug.isVisible = cameraColliderDebugVisible;
    }
    cameraCollider.isVisible = cameraColliderDebugVisible;
}

function resolveCameraGroundClip() {
    if (!scene || !cameraPivot || !cameraCollider) return;

    const toCam = cameraCollider.position.subtract(cameraPivot.position);
    const dist = toCam.length();
    if (dist < 1e-3) return;

    const dir = toCam.scale(1 / dist);
    const ray = new BABYLON.Ray(cameraPivot.position, dir, dist + CAMERA_COLLIDER_RADIUS);
    const pick = scene.pickWithRay(
        ray,
        (mesh) => mesh?.metadata?.isTerrainCollider || mesh?.metadata?.isTerrain
    );

    if (pick?.hit && pick.distance < dist) {
        const safeDist = Math.max(0, pick.distance - CAMERA_COLLIDER_RADIUS * 0.5);
        cameraCollider.position.copyFrom(ray.origin.add(dir.scale(Math.min(safeDist, dist))));
    }
}

function ensureCameraColliderDebugMesh() {
    if (cameraColliderDebug || !scene) return;
    cameraColliderDebug = BABYLON.MeshBuilder.CreateSphere(
        "cameraColliderDebug",
        { diameter: CAMERA_COLLIDER_RADIUS * 2, segments: 12 },
        scene
    );
    const mat = new BABYLON.StandardMaterial("cameraColliderDebugMat", scene);
    mat.wireframe = true;
    mat.emissiveColor = new BABYLON.Color3(0.1, 0.8, 1.0);
    mat.disableLighting = true;
    cameraColliderDebug.material = mat;
    cameraColliderDebug.isPickable = false;
    cameraColliderDebug.layerMask = 0x1;
    cameraColliderDebug.isVisible = false;
}

function updateCameraRig() {
    if (!player || !player.mesh || !mainCamera || !orbitCamera || !cameraPivot || !cameraCollider) {
        return;
    }

    // Process orbit input even though orbitCamera is not the active renderer
    orbitCamera._checkInputs();

    const camUp = player.mesh.position.clone();
    if (camUp.lengthSquared() > 0) camUp.normalize();

    const headPos = player.mesh.position.add(camUp.scale(CAMERA_HEAD_OFFSET));
    cameraPivot.position.copyFrom(headPos);

    orbitCamera.upVector = camUp;
    orbitCamera.target = cameraPivot.position;

    const desiredPos = computeDesiredCameraPosition(cameraPivot.position, camUp);
    moveCameraColliderToward(desiredPos);

    // Simple recovery if a streamed chunk appears intersecting the camera
    const toCam = cameraCollider.position.subtract(cameraPivot.position);
    if (toCam.lengthSquared() < 1e-3) {
        const recoverDir = camUp.lengthSquared() > 0 ? camUp : BABYLON.Axis.Y;
        cameraCollider.moveWithCollisions(recoverDir.scale(CAMERA_COLLIDER_RADIUS));
    }

    resolveCameraGroundClip();

    syncViewCamera(camUp);
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
        camera: orbitCamera
            ? {
                  alpha: orbitCamera.alpha,
                  beta: orbitCamera.beta,
                  radius: orbitCamera.radius
              }
            : null,
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
    }
    if (orbitCamera && snap.camera) {
        if (snap.camera.alpha != null) orbitCamera.alpha = snap.camera.alpha;
        if (snap.camera.beta != null) orbitCamera.beta = snap.camera.beta;
        if (snap.camera.radius != null) orbitCamera.radius = snap.camera.radius;
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
    const previousState = gameState;
    if (previousState === GameState.PLAYING) {
        performSave();
    }
    gameState = GameState.MENU;
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
    if (devPanel) devPanel.setVisible(false);
    if (abilityTreePanel) abilityTreePanel.setVisible(false);
    if (compassHud) compassHud.setVisible(false);
    if (loadingOverlay?.hide) loadingOverlay.hide();

    // Keep the menu camera stable even if a player exists.
    if (mainCamera) {
        mainCamera.setTarget(new BABYLON.Vector3(0, 0, 0));
    }
}


function showSettings() {
    gameState = GameState.SETTINGS;
    if (minimap) minimap.setEnabled(false);
    if (uiState && uiState.showSettings) {
        uiState.showSettings();
    }
    if (loadingOverlay?.hide) loadingOverlay.hide();

    // Settings still counts as menu: no gameplay input/simulation
    if (player && player.setInputEnabled) player.setInputEnabled(false);
    if (dayNightSystem && dayNightSystem.setEnabled) dayNightSystem.setEnabled(false);
    if (gameRuntime) gameRuntime.setEnabled(false);
    if (domHud) {
        domHud.setGameplayVisible(false);
        domHud.setDebugVisible(false);
    }
    if (devPanel) devPanel.setVisible(false);
    if (abilityTreePanel) abilityTreePanel.setVisible(false);
    if (compassHud) compassHud.setVisible(false);

    if (mainCamera) {
        mainCamera.setTarget(new BABYLON.Vector3(0, 0, 0));
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
    if (playerInfoText) playerInfoText.isVisible = false;
    if (lodInfoText) lodInfoText.isVisible = false;

    beginLoadingGate();
    setFirefliesVisible(true);
    applyMenuVisuals();

    if (gameRuntime) gameRuntime.setEnabled(false);
    if (domHud) {
        domHud.setGameplayVisible(false);
        domHud.setDebugVisible(false);
    }
    if (compassHud) compassHud.setVisible(false);
    freezePlayerForLoading();

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
            setupPlayerAndSystems();
        });
    } else {
        setupPlayerAndSystems();
    }
}

function setupPlayerAndSystems() {
    if (!terrain) return;

    if (!player) {
        // Create player on planet surface
        player = new PlanetPlayer(scene, terrain, {
            planetRadius: PLANET_RADIUS_UNITS + 500,
            walkSpeed: 2.2,
            runSpeed: 11,
            height: 1.8,
            radius: 0.35,
            jumpGraceSeconds: 40,
            inputEnabled: false
        });
    }

    freezePlayerForLoading();

    moveActorToSafeAltitude(player, player.spawnDirection);

    if (mainCamera && player?.mesh) {
        player.attachCamera(mainCamera);
        mainCamera.maxZ = 1_000_000;
        mainCamera.setTarget(player.mesh.position);
    }

    if (orbitCamera && player?.mesh) {
        const up = player.mesh.position.clone();
        if (up.lengthSquared() > 0) up.normalize();
        cameraPivot.position.copyFrom(
            player.mesh.position.add(up.scale(CAMERA_HEAD_OFFSET))
        );
        orbitCamera.target = cameraPivot.position;
        orbitCamera.upVector = up;
        cameraCollider.position.copyFrom(
            computeDesiredCameraPosition(cameraPivot.position, up)
        );
        syncViewCamera(up);
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

    if (!gameRuntime) {
        gameRuntime = new GameRuntime({
            player,
            terrain,
            hud: domHud,
            baseMovement,
            baseCarve: { radius: 70, nenCost: 14 },
            scene,
            dayNightSystem,
            saveSystem
        });
    }

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

    applyDebugFlags(DebugSettings.getAllFlags());

    applyPendingSnapshot();

    moveActorToSafeAltitude(player, player.spawnDirection);

    if (gameRuntime) gameRuntime.setEnabled(false);
}

function enterGameplayFromLoading() {
    applyGameVisuals();
    setFirefliesVisible(false);

    applyDebugFlags(DebugSettings.getAllFlags());
    if (gameRuntime) gameRuntime.setEnabled(true);

    if (player && player.setFrozen) player.setFrozen(false);
    if (player && player.setInputEnabled) player.setInputEnabled(true);

    if (orbitCamera && player?.mesh) {
        const up = player.mesh.position.clone();
        if (up.lengthSquared() > 0) up.normalize();
        cameraPivot.position.copyFrom(
            player.mesh.position.add(up.scale(CAMERA_HEAD_OFFSET))
        );
        orbitCamera.target = cameraPivot.position;
        orbitCamera.upVector = up;
        cameraCollider.position.copyFrom(
            computeDesiredCameraPosition(cameraPivot.position, up)
        );
        syncViewCamera(up);
    }

    if (dayNightSystem && dayNightSystem.setEnabled) dayNightSystem.setEnabled(true);
    if (mainCamera && player && player.mesh) mainCamera.setTarget(player.mesh.position);
    gameState = GameState.PLAYING;
    autosaveTimer = 0;
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

    // Clamp simulation delta to avoid massive physics jumps when tab focus is lost
    const simDtSeconds = Math.min(dtSeconds, 1 / 30);

    // Focus position for LOD & hemisphere
    let focusPos = null;
    if (cameraCollider) {
        focusPos = cameraCollider.position;
    } else if (player && player.mesh) {
        focusPos = player.mesh.position;
    } else if (scene.activeCamera) {
        focusPos = scene.activeCamera.position;
    }

    if (terrain && (gameState === GameState.LOADING || gameState === GameState.PLAYING)) {
        terrain.updateStreaming(focusPos);
    }

    if (gameState === GameState.LOADING) {
        updateLoadingGate(simDtSeconds);
    }


    // Update player & HUD
    if (player && gameState === GameState.PLAYING) {
        autosaveTimer += simDtSeconds;
        if (autosaveTimer >= AUTOSAVE_INTERVAL) {
            performSave();
            autosaveTimer = 0;
        }
        if (simDtSeconds > 0) {
            if (gameRuntime) gameRuntime.update(simDtSeconds);
            player.update(simDtSeconds);
            updateCameraRig();

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
                audioSystem.update(simDtSeconds);
            }

            // === END CAMERA FIX ===
        }

        const devData = devPanel ? {} : null;

        if (player.mesh && devData) {
            const pos = player.mesh.position;
            devData.player = { x: pos.x, y: pos.y, z: pos.z, r: pos.length() };
        }

        if (terrain && focusPos && terrain.getDebugInfo) {
            const dbg = terrain.getDebugInfo(focusPos);
            const stats = dbg.lodStats || {};
            const per = stats.perLod || [];
            const maxLod = stats.maxLodInUse ?? 0;

            const chunkSizeX = (dbg.chunkWorldSizeX ?? 0).toFixed(1);

            let nearStr = "";
            if (dbg.nearestChunk) {
                const n = dbg.nearestChunk;
                nearStr =
                    `nearLOD:${n.lodLevel} res:${n.dimX} dist:${n.distance.toFixed(1)}`;
            }

            if (devData) {
                devData.chunk = {
                    count: `${dbg.chunkCountX}x${dbg.chunkCountZ}`,
                    baseRes: dbg.baseChunkResolution,
                    sizeX: chunkSizeX,
                    perLod: per.map((v, idx) => `${idx}:${v || 0}`),
                    nearStr
                };
            }
        }

        // Sun/Moon + time-of-day HUD
        if (dayNightSystem && dayNightSystem.getDebugInfo) {
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

                const timeStr = `${pad(hour)}:${pad(minute)}`;
                if (devData) {
                    devData.time = timeStr;
                    devData.sun = {
                        alt: `${sunAltLocal.toFixed(1)}°`,
                        pos: `${sPos.x.toFixed(0)}, ${sPos.y.toFixed(0)}, ${sPos.z.toFixed(0)}`
                    };
                    devData.moon = {
                        alt: `${moonAltLocal.toFixed(1)}°`,
                        pos: `${mPos.x.toFixed(0)}, ${mPos.y.toFixed(0)}, ${mPos.z.toFixed(0)}`
                    };
                }
            }
        }

        if (devPanel && devData) devPanel.update(devData);


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







