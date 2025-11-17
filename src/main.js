// src/main.js
// Babylon + GUI come from global scripts in index.html
// We only import our own module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";

const EARTH_RADIUS_KM = 6371;
const HALF_EARTH_RADIUS_KM = EARTH_RADIUS_KM * 0.5;

// How many kilometers correspond to 1 game unit
const KM_PER_GAME_UNIT = 1; // tweak this if you want "bigger" or "smaller" feel

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

    // === Camera Spawn Based on Planet Radius ===
    const planetRadius = terrain.radius; // from ChunkedPlanetTerrain options

    // Spawn 10% above the planet surface
    const cameraDistance = planetRadius * 1.1;

    // Position camera on +Z axis looking inward
    const cameraStartPos = new BABYLON.Vector3(0, 0, cameraDistance);

    const camera = new BABYLON.UniversalCamera("camera", cameraStartPos, scene);

    // Look directly toward planet center
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
        { width: 200, height: 200 },
        scene
    );
    const groundMat = new BABYLON.StandardMaterial("gm", scene);
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

    // Scene brightness
    addSlider("Scene brightness", 0.0, 2.0, 1.0, (v) => {
        hemi.intensity = baseHemiIntensity * v;
        dir.intensity = baseDirIntensity * v;
    });

    // Ambient / hemi only
    addSlider("Ambient light", 0.0, 2.0, 1.0, (v) => {
        hemi.intensity = baseHemiIntensity * v;
    });

    // Terrain material brightness
    addSlider("Terrain brightness", 0.0, 3.0, 1.0, (v) => {
        terrainMat.diffuseColor = new BABYLON.Color3(
            baseDiffuse.r * v,
            baseDiffuse.g * v,
            baseDiffuse.b * v
        );
        terrainMat.emissiveColor = new BABYLON.Color3(
            baseEmissive.r * v,
            baseEmissive.g * v,
            baseEmissive.b * v
        );
    });
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
    const camera = scene.activeCamera;

    if (camera) {
        const dt = engine.getDeltaTime() / 1000;
        const moveSpeed = 40;

        let move = BABYLON.Vector3.Zero();

        if (moveState.forward) {
            move = move.add(camera.getDirection(new BABYLON.Vector3(0, 0, 1)));
        }
        if (moveState.back) {
            move = move.add(
                camera.getDirection(new BABYLON.Vector3(0, 0, -1))
            );
        }
        if (moveState.right) {
            move = move.add(camera.getDirection(new BABYLON.Vector3(1, 0, 0)));
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
            moveState.down = false;
            break;
    }
});

window.addEventListener("resize", () => {
    engine.resize();
});










