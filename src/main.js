// src/main.js
// Babylon.js + Babylon.GUI are loaded globally via index.html.
// We only import our own terrain module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";

// Simple gameplay-scale radius.
// With dimY = 32 and cellSize = 0.5, this radius fits fully
// inside the sampled volume so you see a full globe, not a slice.
const PLANET_RADIUS_UNITS = 7.0;

// Movement state for free-fly camera controls
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

    // Background color
    scene.clearColor = new BABYLON.Color4(0.1, 0.1, 0.9, 1.0);

    // ---------------------------------------------------------------------
    // Camera: free-fly UniversalCamera
    // ---------------------------------------------------------------------
    const camera = new BABYLON.UniversalCamera(
        "camera",
        new BABYLON.Vector3(0, 20, -60),
        scene
    );
    camera.setTarget(BABYLON.Vector3.Zero());

    // Disable built-in WASD so we handle movement manually
    camera.keysUp = [];
    camera.keysDown = [];
    camera.keysLeft = [];
    camera.keysRight = [];

    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    // ---------------------------------------------------------------------
    // Lighting
    // ---------------------------------------------------------------------
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.3, 1.0, 0.2),
        scene
    );
    hemi.intensity = 0.9;
    hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.15);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1.0, -0.3),
        scene
    );
    dir.intensity = 0.6;

    // Simple ground plane for visual reference
    const ground = BABYLON.MeshBuilder.CreateGround(
        "ground",
        { width: 200, height: 200, subdivisions: 16 },
        scene
    );
    const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.8);
    groundMat.specularColor = BABYLON.Color3.Black();
    ground.material = groundMat;
    ground.position.y = -40;

    // ---------------------------------------------------------------------
    // Chunked marching-cubes planet terrain (static grid)
    // ---------------------------------------------------------------------
    terrain = new ChunkedPlanetTerrain(scene, {
        chunkCountX: 4,
        chunkCountZ: 4,
        baseChunkResolution: 48,
        dimY: 32,
        cellSize: 0.5,
        radius: PLANET_RADIUS_UNITS,
        enableNoise: true
    });

    // ---------------------------------------------------------------------
    // UI: LOD slider (integer 0–2)
    // ---------------------------------------------------------------------
    const ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const panel = new BABYLON.GUI.StackPanel();
    panel.width = "260px";
    panel.isVertical = true;
    panel.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    panel.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    panel.paddingRight = "20px";
    panel.paddingTop = "20px";
    panel.background = "rgba(0, 0, 0, 0.4)";
    ui.addControl(panel);

    const lodLabel = new BABYLON.GUI.TextBlock();
    lodLabel.text = "LOD: 2";
    lodLabel.height = "26px";
    lodLabel.marginTop = "6px";
    lodLabel.color = "white";
    lodLabel.fontSize = 16;
    lodLabel.textHorizontalAlignment =
        BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    panel.addControl(lodLabel);

    const lodSlider = new BABYLON.GUI.Slider();
    lodSlider.minimum = 0;
    lodSlider.maximum = 2;
    lodSlider.value = 2;
    lodSlider.step = 1;
    lodSlider.height = "20px";
    lodSlider.color = "#88ff88";
    lodSlider.background = "#333333";
    lodSlider.borderColor = "#aaaaaa";
    lodSlider.onValueChangedObservable.add((v) => {
        const rounded = Math.round(v);
        if (lodSlider.value !== rounded) {
            lodSlider.value = rounded;
        }
        lodLabel.text = `LOD: ${rounded}`;
        if (terrain) {
            terrain.setLodLevel(rounded);
        }
    });
    panel.addControl(lodSlider);

    // ---------------------------------------------------------------------
    // Input handling for free-fly movement (WASD + Space/Shift)
    // ---------------------------------------------------------------------
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

// -------------------------------------------------------------------------
// Main render loop
// -------------------------------------------------------------------------
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
            terrain.updateStreaming(camera.position); // static grid hook
        }
    } else if (terrain) {
        terrain.updateStreaming(null);
    }

    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});
