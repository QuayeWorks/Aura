// src/main.js
import * as BABYLON from "https://cdn.babylonjs.com/babylon.esm.js";
import { MarchingCubesTerrain } from "./terrain/MarchingCubesTerrain.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

let terrain = null;

const createScene = () => {
    const scene = new BABYLON.Scene(engine);

    // blue background
    scene.clearColor = new BABYLON.Color4(0.1, 0.1, 0.9, 1.0);

    // simple ArcRotate camera
    const camera = new BABYLON.ArcRotateCamera(
        "camera",
        Math.PI / 4,
        Math.PI / 3,
        60,
        BABYLON.Vector3.Zero(),
        scene
    );
    camera.attachControl(canvas, true);

    // lighting
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.3, 1, 0.2), scene);
    hemi.intensity = 0.9;
    hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.15);

    const dir = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1, -0.3),
        scene
    );
    dir.intensity = 0.6;

    // blue floor plane
    const ground = BABYLON.MeshBuilder.CreateGround("g", { width: 200, height: 200 }, scene);
    const mat = new BABYLON.StandardMaterial("gm", scene);
    mat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.8);
    ground.material = mat;
    ground.position.y = -40;

    // MARCHING CUBES TERRAIN
    terrain = new MarchingCubesTerrain(scene, {
        dimX: 32,
        dimY: 32,
        dimZ: 32,
        cellSize: 1,
        isoLevel: 0,
    });

    // carve with left mouse
    scene.onPointerObservable.add((pointerInfo) => {
        if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
            if (pointerInfo.event.button === 0) {
                const pick = scene.pick(pointerInfo.event.clientX, pointerInfo.event.clientY);
                if (pick.hit) {
                    terrain.carveSphere(pick.pickedPoint, 4.0);
                }
            }
        }
    });

    return scene;
};

const scene = createScene();
engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
