// src/main.js
// Babylon + GUI come from global scripts in index.html
import { PlanetQuadtreeTerrain } from "./terrain/PlanetQuadtreeTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

// Planet radius in world units
export const PLANET_RADIUS_UNITS = 32400;

// Game states
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

let lastFrameTime = performance.now();

// ---------------- Scene / camera / lights -----------------

function createScene() {
    scene = new BABYLON.Scene(engine);

    applyMenuVisuals();
    scene.collisionsEnabled = true;

    mainCamera = new BABYLON.ArcRotateCamera(
        "mainCamera",
        Math.PI * 1.3,
        Math.PI / 3,
        PLANET_RADIUS_UNITS * 0.08,
        BABYLON.Vector3.Zero(),
        scene
    );
    mainCamera.attachControl(canvas, true);

    // Prevent upside down / crazy zoom
    mainCamera.allowUpsideDown = false;
    mainCamera.lowerBetaLimit = 0.15;
    mainCamera.upperBetaLimit = Math.PI / 2.1;
    mainCamera.checkCollisions = false;
    mainCamera.lowerRadiusLimit = PLANET_RADIUS_UNITS * 0.015;
    mainCamera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.08;
    mainCamera.panningSensibility = 0;

    // Lights
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0, 1, 0),
        scene
    );
    hemi.intensity = 0.8;
    hemi.groundColor = new BABYLON.Color3(0.05, 0.05, 0.1);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1, -0.3),
        scene
    );
    dir.intensity = 0.6;

    // Fireflies background
    createFireflies();

    // GUI
    ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
    createMainMenu();
    createSettingsMenu();
    createHud();
    createLoadingOverlay();

    showMainMenu();

    return scene;
}

// ---------------- Visual themes -----------------

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

// ---------------- Fireflies -----------------

function createFireflies() {
    firefliesRoot = new BABYLON.TransformNode("firefliesRoot", scene);

    const mat = new BABYLON.StandardMaterial("fireflyMat", scene);
    mat.emissiveColor = new BABYLON.Color3(0.8, 0.9, 1.0);
    mat.disableLighting = true;
    mat.alpha = 0.9;

    const radius = PLANET_RADIUS_UNITS * 0.05;
    const count = 40;

    for (let i = 0; i < count; i++) {
        const orb = BABYLON.MeshBuilder.CreateSphere(
            "firefly_" + i,
            { diameter: PLANET_RADIUS_UNITS * 0.0015, segments: 6 },
            scene
        );
        orb.parent = firefliesRoot;
        orb.material = mat;
        orb.isPickable = false;

        const angle = Math.random() * Math.PI * 2;
        const y = (Math.random() * 2 - 1) * radius * 0.4;
        const r = radius * (0.4 + Math.random() * 0.6);

        orb.position.set(
            Math.cos(angle) * r,
            y,
            Math.sin(angle) * r
        );

        orb.metadata = {
            phase: Math.random() * Math.PI * 2,
            baseY: orb.position.y
        };
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

function setFirefliesVisible(visible) {
    if (!firefliesRoot) return;
    firefliesRoot.setEnabled(visible);
}

// ---------------- UI creation -----------------

function createMainMenu() {
    mainMenuPanel = new BABYLON.GUI.Rectangle("mainMenu");
    mainMenuPanel.width = "420px";
    mainMenuPanel.height = "380px";
    mainMenuPanel.cornerRadius = 16;
    mainMenuPanel.thickness = 0;
    mainMenuPanel.background = "rgba(10, 10, 25, 0.9)";
    mainMenuPanel.color = "white";
    mainMenuPanel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    mainMenuPanel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    mainMenuPanel.shadowBlur = 20;
    mainMenuPanel.shadowOffsetX = 0;
    mainMenuPanel.shadowOffsetY = 0;
    mainMenuPanel.shadowColor = "rgba(0,255,200,0.7)";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "90%";
    stack.isVertical = true;
    mainMenuPanel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Aura Hunter";
    title.height = "60px";
    title.color = "white";
    title.fontSize = 36;
    title.fontWeight = "bold";
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "Spherical Quadtree Planet";
    subtitle.height = "30px";
    subtitle.color = "#9eeaff";
    subtitle.fontSize = 18;
    subtitle.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(subtitle);

    const spacer1 = new BABYLON.GUI.Rectangle();
    spacer1.height = "30px";
    spacer1.thickness = 0;
    stack.addControl(spacer1);

    const playBtn = createModernButton("Play", "#00ffa9", () => startGame());
    stack.addControl(playBtn);

    const spacer2 = new BABYLON.GUI.Rectangle();
    spacer2.height = "10px";
    spacer2.thickness = 0;
    stack.addControl(spacer2);

    const settingsBtn = createModernButton("Settings", "#3f8cff", () => showSettings());
    stack.addControl(settingsBtn);

    const spacer3 = new BABYLON.GUI.Rectangle();
    spacer3.height = "30px";
    spacer3.thickness = 0;
    stack.addControl(spacer3);

    const footer = new BABYLON.GUI.TextBlock();
    footer.text = "QuayeWorks • HXH Quadtree build";
    footer.height = "30px";
    footer.color = "#666dff";
    footer.fontSize = 14;
    footer.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
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
    stack.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;

    const accent = new BABYLON.GUI.Rectangle();
    accent.width = "5px";
    accent.height = "60%";
    accent.thickness = 0;
    accent.background = accentColor;
    accent.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;

    const text = new BABYLON.GUI.TextBlock();
    text.text = label;
    text.color = "white";
    text.fontSize = 22;
    text.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;

    stack.addControl(accent);
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
    settingsPanel.background = "rgba(10,10,25,0.95)";
    settingsPanel.color = "white";
    settingsPanel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    settingsPanel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
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
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "Visual / LOD controls";
    subtitle.height = "30px";
    subtitle.color = "#a5b8ff";
    subtitle.fontSize = 16;
    subtitle.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
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
    lodHeader.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
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
        lodHeader.text = "LOD quality: " + value;
        if (terrain && terrain.setLodQuality) {
            terrain.setLodQuality(value);
        }
    });
    stack.addControl(lodSlider);

    const spacerMid = new BABYLON.GUI.Rectangle();
    spacerMid.height = "20px";
    spacerMid.thickness = 0;
    stack.addControl(spacerMid);

    const backBtn = createModernButton("Back", "#777777", () => showMainMenu());
    backBtn.height = "44px";
    stack.addControl(backBtn);

    ui.addControl(settingsPanel);
}

function createHud() {
    playerInfoText = new BABYLON.GUI.TextBlock("playerInfo");
    playerInfoText.text = "";
    playerInfoText.color = "white";
    playerInfoText.fontSize = 18;
    playerInfoText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    playerInfoText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    playerInfoText.paddingLeft = "12px";
    playerInfoText.paddingTop = "10px";
    playerInfoText.isVisible = false;
    ui.addControl(playerInfoText);

    lodInfoText = new BABYLON.GUI.TextBlock("lodInfo");
    lodInfoText.text = "";
    lodInfoText.color = "#9eeaff";
    lodInfoText.fontSize = 16;
    lodInfoText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    lodInfoText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    lodInfoText.paddingLeft = "12px";
    lodInfoText.paddingTop = "34px";
    lodInfoText.isVisible = false;
    ui.addControl(lodInfoText);

    hudPanel = new BABYLON.GUI.StackPanel();
    hudPanel.width = "260px";
    hudPanel.isVertical = true;
    hudPanel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    hudPanel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
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
    loadingOverlay.background = "rgba(10,10,25,0.9)";
    loadingOverlay.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    loadingOverlay.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_BOTTOM;
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
    loadingPercentText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(loadingPercentText);

    const barBack = new BABYLON.GUI.Rectangle();
    barBack.height = "24px";
    barBack.thickness = 0;
    barBack.cornerRadius = 12;
    barBack.background = "rgba(20,25,50,1)";
    barBack.width = "100%";
    stack.addControl(barBack);

    loadingBarFill = new BABYLON.GUI.Rectangle();
    loadingBarFill.height = "100%";
    loadingBarFill.width = "0%";
    loadingBarFill.thickness = 0;
    loadingBarFill.cornerRadius = 12;
    loadingBarFill.background = "#00ffa9";
    loadingBarFill.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    loadingBarFill.left = "0px";
    barBack.addControl(loadingBarFill);

    ui.addControl(loadingOverlay);
}

// ---------------- State transitions -----------------

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
        terrain = new PlanetQuadtreeTerrain(scene, {
            radius: PLANET_RADIUS_UNITS,
            patchResolution: 33,
            maxLevel: 6
        });
    }

    // Create / reset player
    if (!player) {
        player = new PlanetPlayer(scene, terrain, {
            planetRadius: PLANET_RADIUS_UNITS + 1,
            walkSpeed: 4,
            runSpeed: 22,
            height: 10,
            radius: 2
        });
    }

    if (mainCamera && player && player.mesh) {
        player.attachCamera(mainCamera);
        mainCamera.radius = PLANET_RADIUS_UNITS * 0.02;
    }

    applyGameVisuals();
    setFirefliesVisible(false);

    if (loadingOverlay) {
        loadingOverlay.isVisible = false;
        loadingBarFill.width = "100%";
        loadingPercentText.text = "Generating planet: 100%";
    }

    if (playerInfoText) playerInfoText.isVisible = true;
    if (lodInfoText) lodInfoText.isVisible = true;
    if (hudPanel) hudPanel.isVisible = true;

    gameState = GameState.PLAYING;
}

// ---------------- Boot + loop -----------------

createScene();

engine.runRenderLoop(() => {
    if (!scene) return;

    const now = performance.now();
    const dtSeconds = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    let focusPos = null;
    if (player && player.mesh) {
        focusPos = player.mesh.position;
    } else if (scene.activeCamera) {
        focusPos = scene.activeCamera.position;
    }

    if (terrain && focusPos) {
        terrain.updateStreaming(focusPos);
    }

    // Loading overlay is trivial for quadtree – planet builds instantly.
    if (loadingOverlay && loadingOverlay.isVisible && terrain) {
        const prog = terrain.getInitialBuildProgress
            ? terrain.getInitialBuildProgress()
            : 1;
        const pct = Math.max(0, Math.min(1, prog));
        loadingBarFill.width = (pct * 100).toFixed(1) + "%";
        loadingPercentText.text = `Generating planet: ${(pct * 100).toFixed(1)}%`;

        if (prog >= 1 && gameState === GameState.LOADING) {
            // Just in case; startGame already hides the overlay.
            loadingOverlay.isVisible = false;
        }
    }

    // Player update
    if (player && gameState === GameState.PLAYING && dtSeconds > 0) {
        player.update(dtSeconds);
    }

    // HUD
    if (playerInfoText && player && player.mesh && gameState === GameState.PLAYING) {
        const pos = player.mesh.position;
        const r = pos.length();
        playerInfoText.text =
            `Player  x:${pos.x.toFixed(1)}  y:${pos.y.toFixed(1)}  z:${pos.z.toFixed(1)}  r:${r.toFixed(1)}`;
        playerInfoText.isVisible = true;
    }

    if (lodInfoText && terrain && focusPos && gameState === GameState.PLAYING && terrain.getDebugInfo) {
        const dbg = terrain.getDebugInfo(focusPos);
        const stats = dbg.lodStats || {};
        const per = stats.perLod || [];
        const maxLod = stats.maxLodInUse ?? 0;

        let nearStr = "";
        if (dbg.nearestChunk) {
            const n = dbg.nearestChunk;
            nearStr =
                `  nearLOD:${n.lodLevel} res:${n.dimX} dist:${n.distance.toFixed(1)}`;
        }

        lodInfoText.text =
            `Patches active:${stats.totalVisible ?? 0}  baseRes:${dbg.baseChunkResolution}  cap:${dbg.lodCap}  maxUsed:${maxLod}\n` +
            `[0:${per[0] || 0}  1:${per[1] || 0}  2:${per[2] || 0}  3:${per[3] || 0}  4:${per[4] || 0}  5:${per[5] || 0}]${nearStr}`;
        lodInfoText.isVisible = true;
    }

    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});
