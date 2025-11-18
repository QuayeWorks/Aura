// src/main.js
// Babylon + GUI come from global scripts in index.html
// We only import our own module.
import { ChunkedPlanetTerrain } from "./terrain/ChunkedPlanetTerrain.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

let terrain = null;

const createScene = () => {
    const scene = new BABYLON.Scene(engine);

    // Blue background
    scene.clearColor = new BABYLON.Color4(0.1, 0.1, 0.9, 1.0);

    // Camera
    const camera = new BABYLON.ArcRotateCamera(
        "camera",
        Math.PI / 4,
        Math.PI / 3,
        60,
        BABYLON.Vector3.Zero(),
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
        chunkCountX: 8,
        chunkCountZ: 8,
        baseChunkResolution: 48,
        dimY: 148,
        cellSize: 1,
        isoLevel: 0,
        radius: 72
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
    if (terrain && scene.activeCamera) {
        terrain.updateStreaming(scene.activeCamera.position);
    }
    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});
















