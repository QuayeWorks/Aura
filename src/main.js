// src/main.js
// Babylon + GUI come from global scripts in index.html
// We only import our own module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";
import { PlanetPlayer } from "./player/PlanetPlayer.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);
const PLANET_RADIUS_UNITS = 32400;
let terrain = null;
let player = null;
let loadingText = null;
let playerInfoText = null;   // <-- optional HUD text (currently unused)

const createScene = () => {
    const scene = new BABYLON.Scene(engine);
    // --- Simple atmospheric look ---
    scene.clearColor = new BABYLON.Color4(0.55, 0.8, 1.0, 1.0); // blue sky
    
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogColor = new BABYLON.Color3(0.55, 0.8, 1.0);
    // With a 32.4 km radius world, we need tiny fog density
    scene.fogDensity = 3e-5;  // tweak between 1e-5 and 1e-4 to taste
    
    // So terrain meshes actually receive fog:
    scene.fogEnabled = true;

    scene.collisionsEnabled = true;

    // Blue background
    scene.clearColor = new BABYLON.Color4(0.51, 0.89, 1.0, 1.0);

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
    camera.upperRadiusLimit = PLANET_RADIUS_UNITS * 0.007;  // can zoom way out

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
        baseChunkResolution: 48,
        dimY: 66600,
        cellSize: 1,
        isoLevel: 0,
        radius: PLANET_RADIUS_UNITS
        // You can optionally override LOD ring distances here:
    });
    
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




    // When the terrain reports it's done, spawn the player
    terrain.onInitialBuildDone = () => {
        console.log("Planet finished generating, spawning player.");
        // --- Player capsule that can traverse the planet -------------------------
        player = new PlanetPlayer(scene, terrain, {
            planetRadius: PLANET_RADIUS_UNITS + 1,
            walkSpeed: 4,  // ~8 mph
            runSpeed: 22,  // ~47 mph
            height: 10.0,
            capsuleRadius: 1
        });
    
        // Let the player use the active camera for movement direction
        if (scene.activeCamera) {
            player.attachCamera(scene.activeCamera);
            // Make the orbit camera follow the capsule instead of the world origin
            camera.lockedTarget = player.mesh;
            // Optional: tweak distance so you see more of the planet
            camera.radius = camera.radius || 80;
        }
    };

    // -----------------------
    // UI: lighting/material controls
    // -----------------------

    const ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    // After AdvancedDynamicTexture.CreateFullscreenUI("UI")
    loadingText = new BABYLON.GUI.TextBlock();
    loadingText.text = "Generating planet...";
    loadingText.color = "white";
    loadingText.fontSize = 24;
    loadingText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    loadingText.textVerticalAlignment   = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    loadingText.paddingLeft = "10px";
    loadingText.paddingTop  = "10px";
    ui.addControl(loadingText);


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

    // LOD Quality: 0 = Low, 5 = High
    addSlider("LOD quality", 0, 5, 5, (v) => {
        // v is a float; ChunkedPlanetTerrain expects integer levels 0–5
         terrain.setLodLevel(Math.round(v));
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
    if (!scene) return;

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
    }

    // --- LOADING TEXT / PROGRESS -----------------------------------
    if (terrain && loadingText) {
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
    if (player) {
        player.update();
    }

    scene.render();
});


window.addEventListener("resize", () => {
    engine.resize();
});








































