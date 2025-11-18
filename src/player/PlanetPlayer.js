// src/player/PlanetPlayer.js

export class PlanetPlayer {
    constructor(scene, terrain, options = {}) {
        this.scene = scene;
        this.terrain = terrain;

        // Config
        // Prefer terrain radius so we always match the actual SDF planet.
        this.planetRadius = options.planetRadius ?? (terrain && terrain.radius ? terrain.radius : 72);

        this.moveSpeed = options.moveSpeed ?? 20;       // target horizontal speed
        this.moveAccel = options.moveAccel ?? 60;       // accel toward target speed
        this.groundFriction = options.groundFriction ?? 12;
        this.airFriction = options.airFriction ?? 1;
        this.gravity = options.gravity ?? 10;           // units/s^2 toward center
        this.jumpSpeed = options.jumpSpeed ?? 15;       // initial jump speed

        this.height = options.height ?? 2.0;            // eye-to-ground distance
        this.capsuleRadius = options.capsuleRadius ?? 0.6;

        this.groundCheckExtra = options.groundCheckExtra ?? 0.6;
        this.groundSnapDistance = options.groundSnapDistance ?? 0.5;

        // Movement state
        this.input = {
            forward: false,
            back: false,
            left: false,
            right: false
        };

        this.velocity = BABYLON.Vector3.Zero(); // world-space velocity
        this.isGrounded = false;
        this.jumpQueued = false;

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
        this.mesh.checkCollisions = false; // we handle our own

        // Start somewhere above the planet near +Z
        const startDir = new BABYLON.Vector3(0, 0, 1).normalize();
        this.mesh.position = startDir.scale(this.planetRadius + this.height);
        // Do an initial ground snap so we start exactly on the surface
        // once terrain meshes exist.
        this._checkGroundAndSnap();
        this._orientToSurface();


        // Simple debug material
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
                case " ":
                    // queue jump (handled once in update)
                    this.jumpQueued = true;
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
                case " ":
                    // don't keep jump held forever
                    this.jumpQueued = false;
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

    // Ground ray + snapping
    _checkGroundAndSnap() {
        const pos = this.mesh.position;
        if (pos.lengthSquared() === 0) return;

        const up = pos.normalize();

        const rayOrigin = pos.add(up.scale(this.capsuleRadius + 0.5));
        const rayDir = up.scale(-1);
        const rayLen = this.height + this.capsuleRadius + this.groundCheckExtra;

        const ray = new BABYLON.Ray(rayOrigin, rayDir, rayLen);

        const pick = this.scene.pickWithRay(
            ray,
            (mesh) =>
                mesh &&
                mesh.name &&
                mesh.name.startsWith("marchingCubesTerrain")
        );

        if (pick.hit && pick.pickedPoint) {
            const targetPos = pick.pickedPoint.add(up.scale(this.height));
            const distToGround = BABYLON.Vector3.Distance(targetPos, pos);

            if (distToGround <= this.groundSnapDistance) {
                this.isGrounded = true;
                this.mesh.position.copyFrom(targetPos);

                // Remove downward component of velocity
                const vDotUp = BABYLON.Vector3.Dot(this.velocity, up);
                if (vDotUp < 0) {
                    this.velocity = this.velocity.subtract(up.scale(vDotUp));
                }
                return;
            }
        }

        this.isGrounded = false;
    }

    // Simple wall collision: cast ray along movement, stop/slide on hit
    _resolveHorizontalCollisions(pos, displacement) {
        const dispLenSq = displacement.lengthSquared();
        if (dispLenSq < 1e-6) {
            return pos;
        }

        const dispLen = Math.sqrt(dispLenSq);
        const dir = displacement.scale(1 / dispLen);

        const ray = new BABYLON.Ray(
            pos,
            dir,
            dispLen + this.capsuleRadius * 1.1
        );

        const pick = this.scene.pickWithRay(
            ray,
            (mesh) =>
                mesh &&
                mesh.name &&
                mesh.name.startsWith("marchingCubesTerrain")
        );

        if (!pick.hit || !pick.pickedPoint) {
            return pos.add(displacement);
        }

        // Move to just outside the wall
        const hitPoint = pick.pickedPoint;
        const hitNormal =
            pick.getNormal && pick.getNormal(true)
                ? pick.getNormal(true)
                : dir.scale(-1);

        const newPos = hitPoint.add(
            hitNormal.scale(this.capsuleRadius * 1.01)
        );

        // Remove velocity component into the wall to "slide" along it
        const vDotN = BABYLON.Vector3.Dot(this.velocity, hitNormal);
        if (vDotN < 0) {
            this.velocity = this.velocity.subtract(hitNormal.scale(vDotN));
        }

        return newPos;
    }

    // Orient capsule so "up" aligns with planet normal and forward follows camera
    _orientToSurface() {
        const pos = this.mesh.position;
        if (pos.lengthSquared() === 0) return;

        const up = pos.normalize();

        // Determine forward direction (camera-relative if possible)
        let forwardWorld = new BABYLON.Vector3(0, 0, 1);
        if (this.camera && this.camera.getDirection) {
            forwardWorld = this.camera.getDirection(
                new BABYLON.Vector3(0, 0, 1)
            );
        }

        // Project forward onto tangent plane
        let forward = this._projectOntoPlane(forwardWorld, up);
        if (forward.lengthSquared() < 1e-4) {
            forward = BABYLON.Vector3.Cross(up, BABYLON.Axis.X);
        }
        forward.normalize();

        const right = BABYLON.Vector3.Cross(forward, up).normalize();

        // Construct rotation matrix from Right / Up / Forward
        const m = BABYLON.Matrix.FromValues(
            right.x,   right.y,   right.z,   0,
            up.x,      up.y,      up.z,      0,
            forward.x, forward.y, forward.z, 0,
            0,         0,         0,         1
        );

        if (!this.mesh.rotationQuaternion) {
            this.mesh.rotationQuaternion = new BABYLON.Quaternion();
        }
        BABYLON.Quaternion.FromRotationMatrixToRef(
            m,
            this.mesh.rotationQuaternion
        );
    }

    update(dtSeconds) {
        if (!this.mesh) return;

        // Movement basis from camera if available
        let forwardWorld = new BABYLON.Vector3(0, 0, 1);
        let rightWorld   = new BABYLON.Vector3(1, 0, 0);
        let upWorld      = new BABYLON.Vector3(0, 1, 0);

        if (this.camera && this.camera.getDirection) {
            forwardWorld = this.camera.getDirection(new BABYLON.Vector3(0, 0, 1));
            rightWorld   = this.camera.getDirection(new BABYLON.Vector3(1, 0, 0));
            upWorld      = this.camera.getDirection(new BABYLON.Vector3(0, 1, 0));
        }

        // Build movement vector from input (WASD)
        let move = BABYLON.Vector3.Zero();
        if (this.input.forward) move = move.add(forwardWorld);
        if (this.input.back)    move = move.subtract(forwardWorld);
        if (this.input.right)   move = move.add(rightWorld);
        if (this.input.left)    move = move.subtract(rightWorld);
        // (Space / jump is ignored for now)

        if (move.lengthSquared() > 0) {
            move.normalize();
            const displacement = move.scale(this.moveSpeed * dtSeconds);
            this.mesh.position.addInPlace(displacement);

            // Orient capsule to face movement direction, keep a consistent "up"
            const forward = move.clone().normalize();
            const up = upWorld.normalize();
            const right = BABYLON.Vector3.Cross(forward, up).normalize();

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

    }


    getPosition() {
        return this.mesh ? this.mesh.position : null;
    }
}





