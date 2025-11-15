// src/main.js
import { SmoothTerrain } from "./terrain/SmoothTerrain.js";

window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("renderCanvas");
    const engine = new BABYLON.Engine(canvas, true);

    const createScene = () => {
        const scene = new BABYLON.Scene(engine);
        scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

        // CAMERA: free-fly WASD
        const camera = new BABYLON.UniversalCamera(
            "camera",
            new BABYLON.Vector3(0, 12, -30),
            scene
        );
        camera.setTarget(new BABYLON.Vector3(0, 5, 0));
        camera.attachControl(canvas, true);

        camera.speed = 0.6;
        camera.inertia = 0.5;
        camera.angularSensibility = 2500;

        scene.collisionsEnabled = false;
        camera.checkCollisions = false;
        camera.applyGravity = false;

        camera.keysUp.push(87);    // W
        camera.keysDown.push(83);  // S
        camera.keysLeft.push(65);  // A
        camera.keysRight.push(68); // D

        // LIGHTING
        const hemi = new BABYLON.HemisphericLight(
            "hemi",
            new BABYLON.Vector3(0, 1, 0),
            scene
        );
        hemi.intensity = 1.1; // stronger ambient

        const dirLight = new BABYLON.DirectionalLight(
            "dirLight",
            new BABYLON.Vector3(-0.4, -1, 0.4),
            scene
        );
        dirLight.position = new BABYLON.Vector3(40, 60, -40);
        dirLight.intensity = 0.5;

        // SKYBOX
        const skybox = BABYLON.MeshBuilder.CreateBox("skyBox", { size: 1000 }, scene);
        const skyMat = new BABYLON.StandardMaterial("skyMat", scene);
        skyMat.backFaceCulling = false;
        skyMat.emissiveColor = new BABYLON.Color3(0.02, 0.02, 0.06);
        skyMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
        skyMat.specularColor = new BABYLON.Color3(0, 0, 0);
        skybox.material = skyMat;

        // UI
        const ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

        const title = new BABYLON.GUI.TextBlock();
        title.text = "Aura – Smooth Terrain Prototype";
        title.color = "white";
        title.fontSize = 40;
        title.top = "-150px";
        ui.addControl(title);

        const subtitle = new BABYLON.GUI.TextBlock();
        subtitle.text = "WASD to move, mouse to look, left-click to destroy terrain";
        subtitle.color = "#ccccff";
        subtitle.fontSize = 20;
        subtitle.top = "-100px";
        ui.addControl(subtitle);

        const playButton = BABYLON.GUI.Button.CreateSimpleButton("playButton", "PLAY");
        playButton.width = "200px";
        playButton.height = "60px";
        playButton.cornerRadius = 12;
        playButton.color = "white";
        playButton.thickness = 2;
        playButton.background = "#4444aa";
        playButton.top = "20px";
        ui.addControl(playButton);

        let gameStarted = false;
        let terrain = null;

        const lockPointer = () => {
            if (document.pointerLockElement !== canvas) {
                const req =
                    canvas.requestPointerLock ||
                    canvas.msRequestPointerLock ||
                    canvas.mozRequestPointerLock ||
                    canvas.webkitRequestPointerLock;
                if (req) req.call(canvas);
            }
        };

        playButton.onPointerUpObservable.add(() => {
            if (gameStarted) return;
            gameStarted = true;

            ui.rootContainer.isVisible = false;

            camera.position = new BABYLON.Vector3(0, 14, -35);
            camera.setTarget(new BABYLON.Vector3(0, 5, 0));

            terrain = new SmoothTerrain(scene);
            terrain.buildInitialTerrain();

            canvas.addEventListener("click", () => lockPointer());

            scene.onPointerDown = (evt, pickInfo) => {
                if (!gameStarted || !terrain) return;
                if (evt.button !== 0) return;

                const pick = scene.pick(
                    scene.pointerX,
                    scene.pointerY,
                    (mesh) => mesh === terrain.mesh
                );

                if (pick.hit) {
                    terrain.carveSphere(pick.pickedPoint, 2.8);
                }
            };
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
});
