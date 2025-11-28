// src/main.js
// Babylon + GUI come from global scripts in index.html
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";

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

// Timing
let lastFrameTime = performance.now();

function createScene() {
    scene = new BABYLON.Scene(engine);

    // Start with a dark, night-like background for the main menu
    applyMenuVisuals();

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

    // Prevent camera from clipping through terrain
    mainCamera.checkCollisions = true;
    mainCamera.collisionRadius = new BABYLON.Vector3(50, 50, 50);
    mainCamera.lowerRadiusLimit = PLANET_RADIUS_UNITS * 0.01;
    mainCamera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.2;

    // Lights for menu + in-game
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.0, 1.0, 0.0),
        scene
    );
    hemi.intensity = 0.8;
    hemi.groundColor = new BABYLON.Color3(0.05, 0.05, 0.1);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1.0, -0.3),
        scene
    );
    dir.intensity = 0.6;

    // --- Fireflies / menu ambiance ---
    createFireflies();

    // --- UI ---
    ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
    createMainMenu();
    createSettingsMenu();
    createHud();
    createLoadingOverlay();

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
                    terrain.carveSphere(pick.pickedPoint, 4.0);
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
    const count = 40;

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
// UI creation
// --------------------
function createMainMenu() {
    mainMenuPanel = new BABYLON.GUI.Rectangle("mainMenu");
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

    // subtle glow border
    mainMenuPanel.shadowBlur = 20;
    mainMenuPanel.shadowOffsetX = 0;
    mainMenuPanel.shadowOffsetY = 0;
    mainMenuPanel.shadowColor = "rgba(0, 255, 200, 0.7)";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "90%";
    stack.isVertical = true;
    stack.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    mainMenuPanel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Aura Hunter";
    title.height = "60px";
    title.color = "white";
    title.fontSize = 36;
    title.fontWeight = "bold";
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
    spacer1.height = "30px";
    spacer1.thickness = 0;
    spacer1.background = "transparent";
    stack.addControl(spacer1);

    const playBtn = createModernButton("Play", "#00ffa9", () => {
        startGame();
    });
    stack.addControl(playBtn);

    const spacer2 = new BABYLON.GUI.Rectangle();
    spacer2.height = "10px";
    spacer2.thickness = 0;
    spacer2.background = "transparent";
    stack.addControl(spacer2);

    const settingsBtn = createModernButton("Settings", "#3f8cff", () => {
        showSettings();
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
}

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
    leftAccent.width = "5px";
    leftAccent.height = "60%";
    leftAccent.background = accentColor;
    leftAccent.thickness = 0;
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
    btn.onPointerUpObservable.add(onClick);

    return btn;
}

function createSettingsMenu() {
    settingsPanel = new BABYLON.GUI.Rectangle("settingsMenu");
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
    title.fontSize = 30;
    title.fontWeight = "bold";
    title.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "Visual / debug controls";
    subtitle.height = "30px";
    subtitle.color = "#a5b8ff";
    subtitle.fontSize = 16;
    subtitle.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(subtitle);

    const spacerTop = new BABYLON.GUI.Rectangle();
    spacerTop.height = "20px";
    spacerTop.thickness = 0;
    stack.addControl(spacerTop);

    // LOD quality slider (global cap)
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
        if (terrain && terrain.setLodLevel) {
            terrain.setLodLevel(value);
        }
    });
    stack.addControl(lodSlider);

    const spacerMid1 = new BABYLON.GUI.Rectangle();
    spacerMid1.height = "16px";
    spacerMid1.thickness = 0;
    stack.addControl(spacerMid1);

    // Wireframe toggle
    const wireBtn = createModernButton("Toggle Wireframe", "#ff9f43", () => {
        if (terrain && terrain.material) {
            terrain.material.wireframe = !terrain.material.wireframe;
        }
    });
    wireBtn.height = "40px";
    stack.addControl(wireBtn);

    const spacerMid2 = new BABYLON.GUI.Rectangle();
    spacerMid2.height = "20px";
    spacerMid2.thickness = 0;
    stack.addControl(spacerMid2);

    const backBtn = createModernButton("Back", "#777777", () => {
        showMainMenu();
    });
    backBtn.height = "44px";
    stack.addControl(backBtn);

    ui.addControl(settingsPanel);
}

function createHud() {
    // Simple text HUD in top-left
    playerInfoText = new BABYLON.GUI.TextBlock("playerInfo");
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
    ui.addControl(playerInfoText);

    lodInfoText = new BABYLON.GUI.TextBlock("lodInfo");
    lodInfoText.text = "";
    lodInfoText.color = "#9eeaff";
    lodInfoText.fontSize = 16;
    lodInfoText.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    lodInfoText.textVerticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    lodInfoText.paddingLeft = "12px";
    lodInfoText.paddingTop = "34px";
    lodInfoText.isVisible = false;
    ui.addControl(lodInfoText);

    // Right-side HUD container (if you want to add more later)
    hudPanel = new BABYLON.GUI.StackPanel();
    hudPanel.width = "260px";
    hudPanel.isVertical = true;
    hudPanel.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    hudPanel.verticalAlignment =
        BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    hudPanel.paddingRight = "20px";
    hudPanel.paddingTop = "20px";
    hudPanel.background = "rgba(0,0,0,0.25)";
    hudPanel.isVisible = false;
    ui.addControl(hudPanel);
}

function createLoadingOverlay() {
    loadingOverlay = new BABYLON.GUI.Rectangle("loadingOverlay");
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

    loadingPercentText = new BABYLON.GUI.TextBlock("loadingPercent");
    loadingPercentText.text = "Generating planet: 0%";
    loadingPercentText.height = "30px";
    loadingPercentText.color = "white";
    loadingPercentText.fontSize = 20;
    loadingPercentText.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(loadingPercentText);

    const barBack = new BABYLON.GUI.Rectangle();
    barBack.height = "24px";
    barBack.thickness = 0;
    barBack.cornerRadius = 12;
    barBack.background = "rgba(20, 25, 50, 1)";
    barBack.width = "100%";
    stack.addControl(barBack);

    loadingBarFill = new BABYLON.GUI.Rectangle();
    loadingBarFill.height = "100%";
    loadingBarFill.width = "0%";
    loadingBarFill.thickness = 0;
    loadingBarFill.cornerRadius = 12;
    loadingBarFill.background = "#00ffa9";
    loadingBarFill.horizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    loadingBarFill.left = "0px";
    barBack.addControl(loadingBarFill);

    ui.addControl(loadingOverlay);
}

// --------------------
// State transitions
// --------------------
function showMainMenu() {
    gameState = GameState.MENU;

    if (mainMenuPanel) mainMenuPanel.isVisible = true;
    if (settingsPanel) settingsPanel.isVisible = false;
    if (hudPanel) hudPanel.isVisible = false;
    if (playerInfoText) playerInfoText.isVisible = false;
    if (lodInfoText) lodInfoText.isVisible = false;
    if (loadingOverlay) loadingOverlay.isVisible = false;

    setFirefliesVisible(true);
    applyMenuVisuals();
}

function showSettings() {
    gameState = GameState.SETTINGS;

    if (mainMenuPanel) mainMenuPanel.isVisible = false;
    if (settingsPanel) settingsPanel.isVisible = true;
    if (hudPanel) hudPanel.isVisible = false;
    if (playerInfoText) playerInfoText.isVisible = false;
    if (lodInfoText) lodInfoText.isVisible = false;
    if (loadingOverlay) loadingOverlay.isVisible = false;

    setFirefliesVisible(true);
    applyMenuVisuals();
}

function startGame() {
    if (gameState === GameState.LOADING || gameState === GameState.PLAYING) {
        return;
    }

    gameState = GameState.LOADING;

    if (mainMenuPanel) mainMenuPanel.isVisible = false;
    if (settingsPanel) settingsPanel.isVisible = false;
    if (hudPanel) hudPanel.isVisible = true;
    if (loadingOverlay) loadingOverlay.isVisible = true;
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
                planetRadius: PLANET_RADIUS_UNITS * 1.05,
                walkSpeed: 4,
                runSpeed: 22,
                height: 10,
                radius: 2
            });

            if (mainCamera && player && player.mesh) {
                player.attachCamera(mainCamera);
            }

            // Switch to playing visuals
            applyGameVisuals();
            setFirefliesVisible(false);

            if (loadingOverlay) loadingOverlay.isVisible = false;
            if (playerInfoText) playerInfoText.isVisible = true;
            if (lodInfoText) lodInfoText.isVisible = true;
            if (hudPanel) hudPanel.isVisible = true;

            gameState = GameState.PLAYING;
        };
    } else {
        // Planet already exists – just resume quickly
        applyGameVisuals();
        setFirefliesVisible(false);

        if (loadingOverlay) loadingOverlay.isVisible = false;
        if (playerInfoText) playerInfoText.isVisible = !!player;
        if (lodInfoText) lodInfoText.isVisible = !!player;
        if (hudPanel) hudPanel.isVisible = true;

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

    // Loading bar update
    if (terrain && loadingOverlay && loadingOverlay.isVisible) {
        if (!terrain.initialBuildDone && terrain.getInitialBuildProgress) {
            const p = terrain.getInitialBuildProgress();
            const pct = Math.max(0, Math.min(1, p));
            loadingPercentText.text = `Generating planet: ${(pct * 100).toFixed(1)}%`;
            loadingBarFill.width = (pct * 100).toFixed(1) + "%";
        } else {
            loadingBarFill.width = "100%";
            loadingPercentText.text = "Generating planet: 100%";
        }
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

        if (terrain && lodInfoText && focusPos && terrain.getLodStats) {
            const stats = terrain.getLodStats();
            const maxLod = stats.maxLodInUse ?? 0;
            const per = stats.perLod || [];
            lodInfoText.text =
                `LOD max: ${maxLod}   [0:${per[0] || 0}  1:${per[1] || 0}  2:${per[2] || 0}  3:${per[3] || 0}  4:${per[4] || 0}  5:${per[5] || 0}]`;
            lodInfoText.isVisible = true;
        }
    } else {
        if (playerInfoText) playerInfoText.isVisible = false;
        if (lodInfoText) lodInfoText.isVisible = false;
    }

    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});


