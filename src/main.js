// Babylon + GUI come from global scripts in index.html
// We only import our own module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

// Planet radius in world units (meters in your mental model)
const PLANET_RADIUS_UNITS = 32400;

// --- Simple game state machine ---
const GameState = {
    MENU: "MENU",
    SETTINGS: "SETTINGS",
    LOADING: "LOADING",
    PLAYING: "PLAYING"
};

let gameState = GameState.MENU;

// World objects
let terrain = null;
let player = null;

// UI references
let ui = null;
let mainMenuPanel = null;
let settingsPanel = null;
let hudPanel = null;
let debugPanel = null;
let loadingText = null;
let playerInfoText = null;

// Simple per-frame delta time (seconds)
let lastFrameTime = performance.now();

const createScene = () => {
    const scene = new BABYLON.Scene(engine);

    // --- Atmosphere / fog ---
    scene.clearColor = new BABYLON.Color4(0.55, 0.8, 1.0, 1.0); // blue sky

    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogColor = new BABYLON.Color3(0.55, 0.8, 1.0);
    // With a 32.4 km radius world, we need tiny fog density
    scene.fogDensity = 3e-5;  // tweak between 1e-5 and 1e-4 to taste

    // So terrain meshes actually receive fog:
    scene.fogEnabled = true;
    scene.collisionsEnabled = true;

    // Camera
    const camera = new BABYLON.ArcRotateCamera(
        "camera",
        Math.PI,            // alpha: behind the +Z facing player
        Math.PI / 2.2,      // beta: slightly above horizon
        PLANET_RADIUS_UNITS * 0.08,
        new BABYLON.Vector3(0, 0, 0),
        scene
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = PLANET_RADIUS_UNITS * 0.003; // close-ish
    camera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.007; // can zoom way out

    // Lights
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.3, 1, 0.2),
        scene
    );
    hemi.intensity = 0.7;
    hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.15);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1, -0.3),
        scene
    );
    dir.intensity = 0.6;

    // --- Water sphere (oceans) ---
    const waterLevelOffset = 0; // sea level above base radius, in meters

    const water = BABYLON.MeshBuilder.CreateSphere(
        "waterSphere",
        {
            diameter: 1.5 * (PLANET_RADIUS_UNITS + waterLevelOffset),
            segments: 64
        },
        scene
    );

    const waterMat = new BABYLON.StandardMaterial("waterMat", scene);
    waterMat.diffuseColor = new BABYLON.Color3(0.1, 0.4, 0.8);
    waterMat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.3);
    waterMat.alpha = 0.55;
    waterMat.backFaceCulling = false;

    water.material = waterMat;
    water.isPickable = false;
    water.checkCollisions = false;

    // -----------------------
    // UI setup
    // -----------------------
    ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    createMenus(scene);
    createHud(scene);

    // Initial state: main menu
    showMainMenu();

    // -----------------------
    // Carving input (LMB)
    // -----------------------
    scene.onPointerObservable.add((pointerInfo) => {
        if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
            if (pointerInfo.event.button === 0 && terrain) {
                const pick = scene.pick(
                    pointerInfo.event.clientX,
                    pointerInfo.event.clientY
                );
                if (pick && pick.hit) {
                    terrain.carveSphere(pick.pickedPoint, 4.0);
                }
            }
        }
    });

    return scene;
};

// --------------------------
// UI helpers
// --------------------------

function createMenus(scene) {
    // --- Main menu ---
    mainMenuPanel = new BABYLON.GUI.StackPanel();
    mainMenuPanel.width = "300px";
    mainMenuPanel.isVertical = true;
    mainMenuPanel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    mainMenuPanel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    mainMenuPanel.background = "rgba(0,0,0,0.5)";
    mainMenuPanel.paddingLeft = "20px";
    mainMenuPanel.paddingRight = "20px";
    mainMenuPanel.paddingTop = "20px";
    mainMenuPanel.paddingBottom = "20px";

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Aura – Planet Prototype";
    title.height = "40px";
    title.color = "white";
    title.fontSize = 28;
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    mainMenuPanel.addControl(title);

    const spacer1 = new BABYLON.GUI.TextBlock();
    spacer1.height = "10px";
    spacer1.text = "";
    mainMenuPanel.addControl(spacer1);

    const playButton = BABYLON.GUI.Button.CreateSimpleButton("playBtn", "Play");
    playButton.height = "40px";
    playButton.color = "white";
    playButton.background = "#4CAF50";
    playButton.cornerRadius = 8;
    playButton.thickness = 0;
    playButton.fontSize = 20;
    playButton.onPointerUpObservable.add(() => {
        startGame(scene);
    });
    mainMenuPanel.addControl(playButton);

    const spacer2 = new BABYLON.GUI.TextBlock();
    spacer2.height = "10px";
    spacer2.text = "";
    mainMenuPanel.addControl(spacer2);

    const settingsButton = BABYLON.GUI.Button.CreateSimpleButton("settingsBtn", "Settings");
    settingsButton.height = "36px";
    settingsButton.color = "white";
    settingsButton.background = "#5555aa";
    settingsButton.cornerRadius = 8;
    settingsButton.thickness = 0;
    settingsButton.fontSize = 18;
    settingsButton.onPointerUpObservable.add(() => {
        showSettings();
    });
    mainMenuPanel.addControl(settingsButton);

    ui.addControl(mainMenuPanel);

    // --- Settings screen (empty for now, just back button) ---
    settingsPanel = new BABYLON.GUI.StackPanel();
    settingsPanel.width = "300px";
    settingsPanel.isVertical = true;
    settingsPanel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    settingsPanel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    settingsPanel.background = "rgba(0,0,0,0.5)";
    settingsPanel.paddingLeft = "20px";
    settingsPanel.paddingRight = "20px";
    settingsPanel.paddingTop = "20px";
    settingsPanel.paddingBottom = "20px";
    settingsPanel.isVisible = false;

    const settingsTitle = new BABYLON.GUI.TextBlock();
    settingsTitle.text = "Settings (WIP)";
    settingsTitle.height = "40px";
    settingsTitle.color = "white";
    settingsTitle.fontSize = 24;
    settingsTitle.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    settingsPanel.addControl(settingsTitle);

    const settingsSpacer = new BABYLON.GUI.TextBlock();
    settingsSpacer.height = "20px";
    settingsSpacer.text = "";
    settingsPanel.addControl(settingsSpacer);

    const backButton = BABYLON.GUI.Button.CreateSimpleButton("backBtn", "Back");
    backButton.height = "36px";
    backButton.color = "white";
    backButton.background = "#444444";
    backButton.cornerRadius = 8;
    backButton.thickness = 0;
    backButton.fontSize = 18;
    backButton.onPointerUpObservable.add(() => {
        showMainMenu();
    });
    settingsPanel.addControl(backButton);

    ui.addControl(settingsPanel);
}

function createHud(scene) {
    // --- Loading text (top-left) ---
    loadingText = new BABYLON.GUI.TextBlock();
    loadingText.text = "";
    loadingText.color = "white";
    loadingText.fontSize = 24;
    loadingText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    loadingText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    loadingText.paddingLeft = "10px";
    loadingText.paddingTop = "10px";
    loadingText.isVisible = false;
    ui.addControl(loadingText);

    // --- Player debug info text (top-left, below loading) ---
    playerInfoText = new BABYLON.GUI.TextBlock("playerInfo");
    playerInfoText.text = "Player: (0, 0, 0) r=0";
    playerInfoText.color = "white";
    playerInfoText.fontSize = 18;
    playerInfoText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    playerInfoText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    playerInfoText.paddingLeft = "10px";
    playerInfoText.paddingTop = "40px";
    playerInfoText.isVisible = false;
    ui.addControl(playerInfoText);

    // --- Right-side debug panel (LOD slider, wireframe) ---
    hudPanel = new BABYLON.GUI.StackPanel();
    hudPanel.width = "260px";
    hudPanel.isVertical = true;
    hudPanel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    hudPanel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    hudPanel.paddingRight = "20px";
    hudPanel.paddingTop = "20px";
    hudPanel.background = "rgba(0,0,0,0.4)";
    hudPanel.isVisible = false;
    ui.addControl(hudPanel);

    debugPanel = hudPanel;

    function addSlider(label, min, max, startValue, onChange) {
        const header = new BABYLON.GUI.TextBlock();
        header.text = `${label}: ${startValue.toFixed(2)}`;
        header.height = "26px";
        header.marginTop = "6px";
        header.color = "white";
        header.fontSize = 16;
        header.textHorizontalAlignment =
            BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        debugPanel.addControl(header);

        const slider = new BABYLON.GUI.Slider();
        slider.minimum = min;
        slider.maximum = max;
        slider.value = startValue;
        slider.height = "20px";
        slider.color = "#88ff88";
        slider.background = "#333333";
        slider.borderColor = "#aaaaaa";
        slider.onValueChangedObservable.add((v) => {
            header.text = `${label}: ${v.toFixed(2)}`;
            onChange(v);
        });
        debugPanel.addControl(slider);
    }

    // LOD Quality: 0 = Low, 5 = High (caps max LOD level)
    addSlider("LOD quality", 0, 5, 5, (v) => {
        if (terrain && terrain.setLodLevel) {
            terrain.setLodLevel(Math.round(v));
        }
    });

    // Wireframe toggle
    const wireframeButton = BABYLON.GUI.Button.CreateSimpleButton(
        "wireBtn",
        "Toggle Wireframe"
    );
    wireframeButton.height = "32px";
    wireframeButton.color = "white";
    wireframeButton.background = "#5555aa";
    wireframeButton.cornerRadius = 6;
    wireframeButton.thickness = 1;
    wireframeButton.marginTop = "10px";
    wireframeButton.onPointerUpObservable.add(() => {
        if (terrain && terrain.material) {
            terrain.material.wireframe = !terrain.material.wireframe;
        }
    });
    debugPanel.addControl(wireframeButton);
}

function showMainMenu() {
    gameState = GameState.MENU;

    if (mainMenuPanel) mainMenuPanel.isVisible = true;
    if (settingsPanel) settingsPanel.isVisible = false;
    if (hudPanel) hudPanel.isVisible = false;
    if (loadingText) loadingText.isVisible = false;
    if (playerInfoText) playerInfoText.isVisible = false;
}

function showSettings() {
    gameState = GameState.SETTINGS;

    if (mainMenuPanel) mainMenuPanel.isVisible = false;
    if (settingsPanel) settingsPanel.isVisible = true;
    if (hudPanel) hudPanel.isVisible = false;
    if (loadingText) loadingText.isVisible = false;
    if (playerInfoText) playerInfoText.isVisible = false;
}

// Start the game: kick off planet generation + loading screen
function startGame(scene) {
    if (gameState === GameState.LOADING || gameState === GameState.PLAYING) {
        return;
    }

    gameState = GameState.LOADING;

    if (mainMenuPanel) mainMenuPanel.isVisible = false;
    if (settingsPanel) settingsPanel.isVisible = false;
    if (hudPanel) hudPanel.isVisible = true;

    if (loadingText) {
        loadingText.text = "Generating planet: 0.0%";
        loadingText.isVisible = true;
    }

    // Create terrain only once; subsequent "Play" will just resume
    if (!terrain) {
        terrain = new ChunkedPlanetTerrain(scene, {
            chunkCountX: 16,
            chunkCountZ: 16,
            baseChunkResolution: 128,      // highest LOD chunk resolution
            isoLevel: 0,
            radius: PLANET_RADIUS_UNITS
        });

        // When the terrain reports it's done, spawn the player
        terrain.onInitialBuildDone = () => {
            console.log("Planet finished generating, spawning player.");

            player = new PlanetPlayer(scene, terrain, {
                planetRadius: PLANET_RADIUS_UNITS + 1,
                walkSpeed: 4,   // ~8 mph
                runSpeed: 22,   // ~47 mph
                height: 10.0,
                capsuleRadius: 1
            });

            // Let the player use the active camera for movement direction
            if (scene.activeCamera && player) {
                const cam = scene.activeCamera;
                player.attachCamera(cam);
                cam.lockedTarget = player.mesh;
                if (!cam.radius) {
                    cam.radius = PLANET_RADIUS_UNITS * 0.08;
                }
            }

            if (loadingText) loadingText.isVisible = false;
            if (playerInfoText) playerInfoText.isVisible = true;
            if (hudPanel) hudPanel.isVisible = true;

            gameState = GameState.PLAYING;
        };
    } else {
        // Terrain already exists; treat as instantly loaded
        if (loadingText) loadingText.isVisible = false;
        if (hudPanel) hudPanel.isVisible = true;
        if (playerInfoText && player) playerInfoText.isVisible = true;
        gameState = GameState.PLAYING;
    }
}

// --------------------------
// Scene / loop bootstrap
// --------------------------

const scene = createScene();

engine.runRenderLoop(() => {
    if (!scene) return;

    const now = performance.now();
    const dtSeconds = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    // Focus position for streaming / LOD
    let focusPos = null;
    if (player && player.mesh) {
        focusPos = player.mesh.position;
    } else if (scene.activeCamera) {
        // Fallback while planet is loading
        focusPos = scene.activeCamera.position;
    }

    if (terrain && focusPos) {
        terrain.updateStreaming(focusPos);
    } else if (terrain) {
        // Even without focus, process initial build queue
        terrain.updateStreaming(null);
    }

    // --- LOADING TEXT / PROGRESS -----------------------------------
    if (terrain && loadingText && gameState === GameState.LOADING) {
        if (!terrain.initialBuildDone) {
            const prog = terrain.getInitialBuildProgress
                ? terrain.getInitialBuildProgress()
                : 0;
            loadingText.text = `Generating planet: ${(prog * 100).toFixed(1)}%`;
            loadingText.isVisible = true;
        } else {
            loadingText.isVisible = false;
        }
    }

    // --- PLAYER UPDATE (only after spawned) -------------------------
    if (player && dtSeconds > 0) {
        player.update(dtSeconds);

        if (playerInfoText && player.mesh) {
            const pos = player.mesh.position;
            const r = pos.length();
            playerInfoText.text = `Player: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})  r=${r.toFixed(1)}`;
            playerInfoText.isVisible = (gameState === GameState.PLAYING);
        }
    } else if (playerInfoText && gameState !== GameState.PLAYING) {
        playerInfoText.isVisible = false;
    }

    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});
