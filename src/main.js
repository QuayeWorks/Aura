// src/main.js
import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import "@babylonjs/loaders";
import * as BABYLON from "@babylonjs/core";

import { MarchingCubesTerrain } from "./terrain/MarchingCubesTerrain.js";

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

let terrain = null;

const createScene = () => {
    const scene = new BABYLON.Scene(engine);

    // Nice blue background so terrain silhouettes stand out
    scene.clearColor = new BABYLON.Color4(0.1, 0.1, 0.9, 1.0);

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
    camera.upperRadiusLimit = 200;

    // Lighting
    const hemi = new BABYLON.HemisphericLight(
        "hemi",
        new BABYLON.Vector3(0.3, 1, 0.2),
        scene
    );
    hemi.intensity = 0.9;
    hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.15);

    const dirLight = new BABYLON.DirectionalLight(
        "dir",
        new BABYLON.Vector3(-0.5, -1, -0.3),
        scene
    );
    dirLight.intensity = 0.6;

    // Blue "backplane" so holes / silhouettes pop
    const ground = BABYLON.MeshBuilder.CreateGround(
        "ground",
        { width: 200, height: 200 },
        scene
    );
    const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.8);
    groundMat.specularColor = BABYLON.Color3.Black();
    ground.material = groundMat;
    ground.position.y = -40;

    // Terrain (Marching Cubes)
    terrain = new MarchingCubesTerrain(scene, {
        dimX: 32,
        dimY: 32,
        dimZ: 32,
        cellSize: 1.0,
        isoLevel: 0.0,
    });

    // Simple input: LMB to carve sphere
    scene.onPointerObservable.add((pointerInfo) => {
        switch (pointerInfo.type) {
            case BABYLON.PointerEventTypes.POINTERDOWN: {
                if (pointerInfo.event.button === 0 && terrain) {
                    const pick = scene.pick(
                        pointerInfo.event.clientX,
                        pointerInfo.event.clientY
                    );
                    if (pick && pick.hit) {
                        terrain.carveSphere(pick.pickedPoint, 4.0);
                    }
                }
                break;
            }
        }
    });

    return scene;
};

const scene = createScene();

engine.runRenderLoop(() => {
    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
});
