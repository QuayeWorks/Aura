// src/main.js
// Babylon + GUI come from global scripts in index.html
// We only import our own module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";

const EARTH_RADIUS_KM = 6371;
const HALF_EARTH_RADIUS_KM = EARTH_RADIUS_KM * 0.5;

// How many kilometers correspond to 1 game unit
const KM_PER_GAME_UNIT = 100; // tweak this if you want "bigger" or "smaller" feel

// Convert half-Earth radius into game units
const HALF_EARTH_RADIUS_UNITS = HALF_EARTH_RADIUS_KM / KM_PER_GAME_UNIT;

const moveState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false
};

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

let terrain = null;

const createScene = () => {
    const scene = new BABYLON.Scene(engine);

    // Blue background
    scene.clearColor = new BABYLON.Color4(0.1, 0.1, 0.9, 1.0);

    // Camera - spawn outside the planet based on half-Earth radius
    const planetRadius = HALF_EARTH_RADIUS_UNITS;          // from the constants at top
    const cameraDistance = planetRadius * 1.2;             // 20% above surface
    const cameraHeight   = planetRadius * 0.2;             // some height above equator

    const cameraStartPos = new BABYLON.Vector3(
        0,
        cameraHeight,
        cameraDistance
    );

    const camera = new BABYLON.UniversalCamera(
        "camera",
        cameraStartPos,
        scene
    );
    camera.setTarget(BABYLON.Vector3.Zero());

    // Disable built-in WASD so we use our custom movement
    camera.keysUp = [];
    camera.keysDown = [];
    camera.keysLeft = [];
    camera.keysRight = [];

    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    // Lights
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.3, 1, 0.2),
        scene
    );
    hemi.intensity = 0.9;
    hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.15);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1, -0.3),
        scene
    );
    dir.intensity = 0.6;

    // Blue ground plane for contrast
    const ground = BABYLON.MeshBuilder.CreateGround(
        "g",
        { width: 200, height: 200, subdivisions: 16 },
        scene
    );
    const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.8);
    groundMat.specularColor = BABYLON.Color3.Black();
    ground.material = groundMat;
    ground.position.y = -40;

    // Chunked marching-cubes planet terrain
    terrain = new ChunkedPlanetTerrain(scene, {
        chunkCountX: 3,
        chunkCountZ: 3,
        baseChunkResolution: 24,
        dimY: 48,
        cellSize: 1,
        isoLevel: 0,
        radius: HALF_EARTH_RADIUS_UNITS
    });

    // -----------------------
    // UI: lighting/material controls
    // -----------------------

    const ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

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

    let sceneBrightness = 1.0;
    let ambientIntensity = 1.0;
    let terrainBrightness = 1.0;
    let isWireframe = false;
    let globalLod = 2;

    addSlider("Scene Brightness", 0.1, 2.0, 1.0, (v) => {
        sceneBrightness = v;
        hemi.intensity = baseHemiIntensity * sceneBrightness * ambientIntensity;
        dir.intensity = baseDirIntensity * sceneBrightness;
    });

    addSlider("Ambient Light", 0.1, 2.0, 1.0, (v) => {
        ambientIntensity = v;
        hemi.intensity = baseHemiIntensity * sceneBrightness * ambientIntensity;
    });

    addSlider("Terrain Brightness", 0.1, 3.0, 1.0, (v) => {
        terrainBrightness = v;
        terrainMat.diffuseColor = baseDiffuse.scale(terrainBrightness);
        // Optionally, make emissive also track brightness
        terrainMat.emissiveColor = baseEmissive.scale(terrainBrightness * 0.3);
    });

    // Wireframe toggle
    const wireHeader = new BABYLON.GUI.TextBlock();
    wireHeader.text = "Wireframe: OFF";
    wireHeader.height = "26px";
    wireHeader.marginTop = "12px";
    wireHeader.color = "white";
    wireHeader.fontSize = 16;
    wireHeader.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    panel.addControl(wireHeader);

    const wireButton = BABYLON.GUI.Button.CreateSimpleButton(
        "wireBtn",
        "Toggle Wireframe"
    );
    wireButton.height = "30px";
    wireButton.color = "white";
    wireButton.background = "#444444";
    wireButton.cornerRadius = 6;
    wireButton.thickness = 1;
    wireButton.onPointerClickObservable.add(() => {
        isWireframe = !isWireframe;
        terrainMat.wireframe = isWireframe;
        wireHeader.text = `Wireframe: ${isWireframe ? "ON" : "OFF"}`;
    });
    panel.addControl(wireButton);

    // LOD slider (0 = low, 1 = medium, 2 = high)
    addSlider("Global LOD", 0, 2, 2, (v) => {
        const level = Math.round(v);
        globalLod = level;
        if (terrain) {
            // v is a float; ChunkedPlanetTerrain expects integer levels 0–2
            terrain.setLodLevel(level);
        }
    });

    // -----------------------
    // Input handling for free-fly movement
    // -----------------------
    window.addEventListener("keydown", (ev) => {
        switch (ev.key) {
            case "w":
            case "W":
                moveState.forward = true;
                break;
            case "s":
            case "S":
                moveState.back = true;
                break;
            case "a":
            case "A":
                moveState.left = true;
                break;
            case "d":
            case "D":
                moveState.right = true;
                break;
            case " ":
                moveState.up = true;
                break;
            case "Shift":
            case "ShiftLeft":
            case "ShiftRight":
                moveState.down = true;
                break;
        }
    });

    window.addEventListener("keyup", (ev) => {
        switch (ev.key) {
            case "w":
            case "W":
                moveState.forward = false;
                break;
            case "s":
            case "S":
                moveState.back = false;
                break;
            case "a":
            case "A":
                moveState.left = false;
                break;
            case "d":
            case "D":
                moveState.right = false;
                break;
            case " ":
                moveState.up = false;
                break;
            case "Shift":
            case "ShiftLeft":
            case "ShiftRight":
                moveState.down = false;
                break;
        }
    });

    return scene;
};

const scene = createScene();

// Main render loop
engine.runRenderLoop(() => {
    const camera = scene.activeCamera;
    if (camera && camera instanceof BABYLON.UniversalCamera) {
        const dt = engine.getDeltaTime() / 1000.0;
        const moveSpeed = 40;

        let move = BABYLON.Vector3.Zero();

        if (moveState.forward) {
            move = move.add(
                camera.getDirection(new BABYLON.Vector3(0, 0, 1))
            );
        }
        if (moveState.back) {
            move = move.add(
                camera.getDirection(new BABYLON.Vector3(0, 0, -1))
            );
        }
        if (moveState.right) {
            move = move.add(
                camera.getDirection(new BABYLON.Vector3(1, 0, 0))
            );
        }
        if (moveState.left) {
            move = move.add(
                camera.getDirection(new BABYLON.Vector3(-1, 0, 0))
            );
        }
        if (moveState.up) {
            move = move.add(new BABYLON.Vector3(0, 1, 0));
        }
        if (moveState.down) {
            move = move.add(new BABYLON.Vector3(0, -1, 0));
        }

        if (!move.equals(BABYLON.Vector3.Zero())) {
            move = move.normalize().scale(moveSpeed * dt);
            camera.position.addInPlace(move);
        }

        if (terrain) {
            terrain.updateStreaming(camera.position);
        }
    } else if (terrain) {
        terrain.updateStreaming(null);
    }

    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});
