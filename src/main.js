// src/main.js
// Babylon + GUI come from global scripts in index.html
// We only import our own module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);
const PLANET_RADIUS_UNITS = 10800;
let terrain = null;
let player = null;
let playerInfoText = null;   // <-- optional HUD text (currently unused)

const createScene = () => {
    const scene = new BABYLON.Scene(engine);
    scene.collisionsEnabled = true;

    // Blue background
    scene.clearColor = new BABYLON.Color4(0.51, 0.89, 1.0, 1.0);

    // Camera
    const camera = new BABYLON.ArcRotateCamera(
        "camera",
        Math.PI / 4,
        Math.PI / 3,
        60,
        new BABYLON.Vector3.Zero(),
        scene
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 10;
    camera.upperRadiusLimit = 400;

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


    // Chunked marching-cubes planet terrain
    // IMPORTANT: assign to the outer 'terrain' (no 'const' here)
    terrain = new ChunkedPlanetTerrain(scene, {
        chunkCountX: 16,
        chunkCountZ: 16,
        baseChunkResolution: 32,
        dimY: 22200,
        cellSize: 1,
        isoLevel: 0,
        radius: PLANET_RADIUS_UNITS
        // You can optionally override LOD ring distances here:
        // lodNear: 15.0,
        // lodMid: 30.0
    });

        // --- Water sphere (oceans) ---
    const waterLevelOffset = 300; // sea level above base radius, in meters

    const water = BABYLON.MeshBuilder.CreateSphere(
        "waterSphere",
        {
            planetRadius: PLANET_RADIUS_UNITS,
            diameter: 2 * (planetRadius + waterLevelOffset),
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


    // --- Player capsule that can traverse the planet -------------------------
    player = new PlanetPlayer(scene, terrain, {
        planetRadius: PLANET_RADIUS_UNITS + 1,
        moveSpeed: 175,
        height: 2.0,
        capsuleRadius: 0.6
    });

    // Let the player use the active camera for movement direction
    if (scene.activeCamera) {
        player.attachCamera(scene.activeCamera);
        // Make the orbit camera follow the capsule instead of the world origin
        camera.lockedTarget = player.mesh;
        // Optional: tweak distance so you see more of the planet
        camera.radius = camera.radius || 80;
    }

    // -----------------------
    // UI: lighting/material controls
    // -----------------------

    const ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    // --- Player debug info text (top-left) (currently disabled) ---
    
    playerInfoText = new BABYLON.GUI.TextBlock("playerInfo");
    playerInfoText.text = "Player: (0, 0, 0) r=0";
    playerInfoText.color = "white";
    playerInfoText.fontSize = 18;
    playerInfoText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    playerInfoText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    playerInfoText.paddingLeft = "10px";
    playerInfoText.paddingTop = "10px";
    ui.addControl(playerInfoText);
    

    const panel = new BABYLON.GUI.StackPanel();
    panel.width = "260px";
    panel.isVertical = true;
    panel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    panel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    panel.paddingRight = "20px";
    panel.paddingTop = "20px";
    panel.background = "rgba(0,0,0,0.4)";
    ui.addControl(panel);

    function addSlider(label, min, max, startValue, onChange) {
        const header = new BABYLON.GUI.TextBlock();
        header.text = `${label}: ${startValue.toFixed(2)}`;
        header.height = "26px";
        header.marginTop = "6px";
        header.color = "white";
        header.fontSize = 16;
        header.textHorizontalAlignment =
            BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        panel.addControl(header);

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
        panel.addControl(slider);
    }

    // Cache base values so sliders act as multipliers
    const baseHemiIntensity = hemi.intensity;
    const baseDirIntensity = dir.intensity;

    const terrainMat = terrain.material;
    const baseDiffuse = terrainMat.diffuseColor.clone();
    const baseEmissive = terrainMat.emissiveColor
        ? terrainMat.emissiveColor.clone()
        : new BABYLON.Color3(0, 0, 0);

    // LOD Quality: 0 = Low, 1 = Medium, 2 = High
    addSlider("LOD quality", 0, 2, 2, (v) => {
        // v is a float; ChunkedPlanetTerrain expects integer levels 0–2
        terrain.setLodLevel(v);
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
        terrainMat.wireframe = !terrainMat.wireframe;
    });
    panel.addControl(wireframeButton);

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

const scene = createScene();

engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    // Use the player capsule as the focus position for LOD + hemisphere decisions.
    let focusPos = null;
    if (player && player.mesh) {
        focusPos = player.mesh.position;
    } else if (scene.activeCamera) {
        // Fallback: use camera position before player is ready
        focusPos = scene.activeCamera.position;
    }

    if (terrain) {
        terrain.updateStreaming(focusPos);
    }

    if (player) {
        player.update(dt);
    }

    
    // Update player debug HUD
    if (player && player.mesh && playerInfoText) {
        const p = player.mesh.position;
        const r = p.length();
        playerInfoText.text =
            `Player: x=${p.x.toFixed(1)}  y=${p.y.toFixed(1)}  ` +
            `z=${p.z.toFixed(1)}  r=${r.toFixed(1)}`;
    }
    

    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});





