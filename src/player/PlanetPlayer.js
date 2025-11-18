// src/player/PlanetPlayer.js

export class PlanetPlayer {
    constructor(scene, terrain, options = {}) {
        this.scene = scene;
        this.terrain = terrain;

        // Config
        this.planetRadius = options.planetRadius ?? 40; // world units
        this.moveSpeed = options.moveSpeed ?? 20;       // units / second
        this.height = options.height ?? 2.0;            // distance from ground to "eyes"
        this.capsuleRadius = options.capsuleRadius ?? 0.6;

        // Input state
        this.input = {
            forward: false,
            back: false,
            left: false,
            right: false
        };

        // Create capsule mesh
        this.mesh = BABYLON.MeshBuilder.CreateCapsule(
            "playerCapsule",
            {
                height: this.height * 2.0,
                radius: this.capsuleRadius,
                tessellation: 8,
                subdivisions: 2
            },
            scene
        );

        this.mesh.checkCollisions = false; // we manage movement manually

        // Start somewhere above the planet near +Z
        const startDir = new BABYLON.Vector3(0, 0, 1).normalize();
        this.mesh.position = startDir.scale(this.planetRadius + this.height);

        // Optional: a simple material so we can see the player
        const mat = new BABYLON.StandardMaterial("playerMat", scene);
        mat.diffuseColor = new BABYLON.Color3(1, 0.8, 0.2);
        mat.specularColor = BABYLON.Color3.Black();
        this.mesh.material = mat;

        this.camera = null;

        this._registerInput();
    }

    attachCamera(camera) {
        this.camera = camera;
    }

    _registerInput() {
        window.addEventListener("keydown", (ev) => {
            switch (ev.key) {
                case "w":
                case "W":
                    this.input.forward = true;
                    break;
                case "s":
                case "S":
                    this.input.back = true;
                    break;
                case "a":
                case "A":
                    this.input.left = true;
                    break;
                case "d":
                case "D":
                    this.input.right = true;
                    break;
                default:
                    break;
            }
        });

        window.addEventListener("keyup", (ev) => {
            switch (ev.key) {
                case "w":
                case "W":
                    this.input.forward = false;
                    break;
                case "s":
                case "S":
                    this.input.back = false;
                    break;
                case "a":
                case "A":
                    this.input.left = false;
                    break;
                case "d":
                case "D":
                    this.input.right = false;
                    break;
                default:
                    break;
            }
        });
    }

    // Helper: project v onto plane with normal n
    _projectOntoPlane(v, n) {
        const dot = BABYLON.Vector3.Dot(v, n);
        return v.subtract(n.scale(dot));
    }

    // Snap player to terrain using a ray toward planet center
    _stickToGround() {
        const pos = this.mesh.position;
        if (pos.lengthSquared() === 0) return;

        const up = pos.normalize();
        const rayOrigin = pos.add(up.scale(5));          // a bit above
        const rayDir = up.scale(-1);                     // toward planet
        const rayLength = 30;

        const ray = new BABYLON.Ray(rayOrigin, rayDir, rayLength);

        const pick = this.scene.pickWithRay(
            ray,
            (mesh) =>
                mesh &&
                mesh.name &&
                mesh.name.startsWith("marchingCubesTerrain")
        );

        if (pick.hit && pick.pickedPoint) {
            // Stand a bit above the hit point
            const targetPos = pick.pickedPoint.add(up.scale(this.height));
            this.mesh.position.copyFrom(targetPos);
        } else {
            // Fallback to perfect sphere surface if no mesh was hit
            const fallbackPos = up.scale(this.planetRadius + this.height);
            this.mesh.position.copyFrom(fallbackPos);
        }
    }

    // Optional: orient capsule so "up" aligns with planet normal
    _orientToSurface() {
        const pos = this.mesh.position;
        if (pos.lengthSquared() === 0) return;

        const up = pos.normalize();

        let forwardWorld = new BABYLON.Vector3(0, 0, 1);
        if (this.camera && this.camera.getDirection) {
            forwardWorld = this.camera.getDirection(
                new BABYLON.Vector3(0, 0, 1)
            );
        }

        // Make forward tangent to surface
        let forward = this._projectOntoPlane(forwardWorld, up);
        if (forward.lengthSquared() < 1e-4) {
            forward = BABYLON.Vector3.Cross(up, BABYLON.Axis.X);
        }
        forward.normalize();

        const right = BABYLON.Vector3.Cross(forward, up).normalize();

        // Construct a rotation matrix manually from Right / Up / Forward
        const m = BABYLON.Matrix.FromValues(
            right.x,   right.y,   right.z,   0,
            up.x,      up.y,      up.z,      0,
            forward.x, forward.y, forward.z, 0,
            0,         0,         0,         1
        );
        
        if (!this.mesh.rotationQuaternion) {
            this.mesh.rotationQuaternion = new BABYLON.Quaternion();
        }
        BABYLON.Quaternion.FromRotationMatrixToRef(m, this.mesh.rotationQuaternion);
    }

    update(dtSeconds) {
        if (!this.mesh) return;

        const pos = this.mesh.position;
        if (pos.lengthSquared() === 0) return;

        const up = pos.normalize();

        // Determine movement basis (camera-relative if possible)
        let forwardWorld = new BABYLON.Vector3(0, 0, 1);
        let rightWorld = new BABYLON.Vector3(1, 0, 0);

        if (this.camera && this.camera.getDirection) {
            forwardWorld = this.camera.getDirection(
                new BABYLON.Vector3(0, 0, 1)
            );
            rightWorld = this.camera.getDirection(
                new BABYLON.Vector3(1, 0, 0)
            );
        }

        // Project onto the tangent plane so movement hugs the sphere
        let forward = this._projectOntoPlane(forwardWorld, up);
        let right = this._projectOntoPlane(rightWorld, up);

        if (forward.lengthSquared() > 1e-4) forward.normalize();
        if (right.lengthSquared() > 1e-4) right.normalize();

        // Build movement vector from input
        let move = BABYLON.Vector3.Zero();
        if (this.input.forward) move = move.add(forward);
        if (this.input.back) move = move.subtract(forward);
        if (this.input.right) move = move.add(right);
        if (this.input.left) move = move.subtract(right);

        if (move.lengthSquared() > 0) {
            move.normalize();
            const displacement = move.scale(this.moveSpeed * dtSeconds);
            this.mesh.position.addInPlace(displacement);
        }

        // Keep the player stuck to the terrain
        this._stickToGround();

        // Align capsule orientation with surface normal
        this._orientToSurface();
    }

    getPosition() {
        return this.mesh ? this.mesh.position : null;
    }
}

