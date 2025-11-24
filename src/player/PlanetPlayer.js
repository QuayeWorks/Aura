// src/player/PlanetPlayer.js

export class PlanetPlayer {
    constructor(scene, terrain, options = {}) {
        this.scene = scene;
        this.terrain = terrain;

        // Config
        // Prefer terrain radius so we always match the actual SDF planet.
        this.planetRadius =  10800;

        this.moveSpeed = options.moveSpeed ?? 20;       // target horizontal speed
        this.moveAccel = options.moveAccel ?? 60;       // accel toward target speed

        this.height = options.height ?? 2.0;            // eye-to-ground distance
        this.capsuleRadius = options.capsuleRadius ?? 0.6;

        this.groundCheckExtra = options.groundCheckExtra ?? 0.6;
        // Physics
        this.velocity = new BABYLON.Vector3(0, 0, 0);
        this.isGrounded = false;

        this.gravityStrength = options.gravityStrength ?? 60.0;     // m/s^2 toward planet center
        this.maxFallSpeed   = options.maxFallSpeed ?? 250.0;       // clamp downward velocity
        this.jumpSpeed      = options.jumpSpeed ?? 120.0;          // initial jump impulse

        // Ground probing / snap
        this.groundProbeLength  = options.groundProbeLength ?? (this.height + 10);
        this.groundSnapDistance = options.groundSnapDistance ?? 8;
        this.groundOffset       = options.groundOffset ?? 1.0;     // small gap above surface

        // Movement state
        this.input = {
            forward: false,
            back: false,
            left: false,
            right: false
        };

        this.velocity = BABYLON.Vector3.Zero(); // world-space velocity
        this.isGrounded = false;
        // Input
        this.jumpRequested = false;

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

        // Start just above the planet surface (on +Z)
        const startDir = new BABYLON.Vector3(0, 0, 1).normalize();

        const spawnRadius =
            this.planetRadius +
            this.height +
            this.capsuleRadius * 0.5;

        this.mesh.position = startDir.scale(spawnRadius);

        // Debug in console so we KNOW what was used:
        console.log(
            "[PlanetPlayer] spawn:",
            "planetRadius =", this.planetRadius,
            "spawnRadius =", spawnRadius,
            "position =", this.mesh.position.toString()
        );


        // Do an initial ground snap so we start exactly on the surface
        // once terrain meshes exist.
        //this._orientToSurface();


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
            switch (ev.code) {
                case "w":
                    this.inputForward = true;
                    break;
                case "s":
                    this.inputBackward = true;
                    break;
                case "a":
                    this.inputLeft = true;
                    break;
                case "d":
                    this.inputRight = true;
                    break;
                case "Space":
                    this.jumpRequested = true; // one-shot, consumed in update()
                    break;
            }
        });

        window.addEventListener("keyup", (ev) => {
            switch (ev.code) {
                case "w":
                    this.inputForward = false;
                    break;
                case "s":
                    this.inputBackward = false;
                    break;
                case "a":
                    this.inputLeft = false;
                    break;
                case "d":
                    this.inputRight = false;
                    break;
            }
        });
    }

    // Helper: project v onto plane with normal n
    _projectOntoPlane(v, n) {
        const dot = BABYLON.Vector3.Dot(v, n);
        return v.subtract(n.scale(dot));
    }

    _groundCheck(upDir) {
        const scene = this.scene;
        const down = upDir.scale(-1);

        // Start ray slightly above the capsule center
        const rayOrigin = this.mesh.position.add(upDir.scale(this.groundProbeLength * 0.25));
        const ray = new BABYLON.Ray(rayOrigin, down, this.groundProbeLength);

        const pick = scene.pickWithRay(ray, (mesh) => {
            return !!(mesh.metadata && mesh.metadata.isTerrain);
        });

        if (pick.hit) {
            // Position where the feet should be (just above the hit point)
            const targetPos = pick.pickedPoint.add(
                upDir.scale(this.groundOffset)
            );

            const dist = BABYLON.Vector3.Distance(this.mesh.position, targetPos);
            if (dist < this.groundSnapDistance) {
                // Snap onto ground
                this.mesh.position.copyFrom(targetPos);
                this.isGrounded = true;

                // Kill any velocity into the ground
                const vDot = BABYLON.Vector3.Dot(this.velocity, down);
                if (vDot > 0) {
                    this.velocity = this.velocity.subtract(down.scale(vDot));
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

    //update(dtSeconds)
        update(deltaTime) {
        if (!this.mesh) return;

        const dt = deltaTime;
        if (dt <= 0) return;

        // Current position & radial up vector
        const pos = this.mesh.position;
        const dist = pos.length();
        if (dist < 1e-6) return;

        const up = pos.scale(1.0 / dist);      // outward from planet center
        const down = up.scale(-1);

        // ---------- GRAVITY ----------
        this.velocity.addInPlace(down.scale(this.gravityStrength * dt));

        // Clamp fall speed along-down direction
        const vDown = BABYLON.Vector3.Dot(this.velocity, down);
        if (vDown > this.maxFallSpeed) {
            const vUp = BABYLON.Vector3.Dot(this.velocity, up);
            const tangent = this.velocity.subtract(up.scale(vUp)).subtract(down.scale(vDown));
            this.velocity = tangent.add(down.scale(this.maxFallSpeed)).add(up.scale(vUp));
        }

        // ---------- MOVEMENT INPUT ON TANGENT PLANE ----------
        let input = new BABYLON.Vector3(0, 0, 0);
        if (this.inputForward)  input.z += 1;
        if (this.inputBackward) input.z -= 1;
        if (this.inputRight)    input.x += 1;
        if (this.inputLeft)     input.x -= 1;

        if (input.lengthSquared() > 0.0001) {
            input.normalize();

            // Get camera basis
            let forward = this.camera.getDirection(BABYLON.Axis.Z);
            let right   = this.camera.getDirection(BABYLON.Axis.X);

            // Project onto tangent plane (perpendicular to up)
            forward = forward.subtract(up.scale(BABYLON.Vector3.Dot(forward, up)));
            right   = right.subtract(up.scale(BABYLON.Vector3.Dot(right,   up)));

            if (forward.lengthSquared() > 0.0001) forward.normalize();
            if (right.lengthSquared()   > 0.0001) right.normalize();

            const moveDir = right.scale(input.x).add(forward.scale(input.z));
            if (moveDir.lengthSquared() > 0.0001) {
                moveDir.normalize();
                const moveVel = moveDir.scale(this.moveSpeed); // use your existing moveSpeed

                // Keep existing vertical component, override tangent
                const vUp = BABYLON.Vector3.Dot(this.velocity, up);
                const vD  = BABYLON.Vector3.Dot(this.velocity, down);
                const vertical = up.scale(vUp).add(down.scale(vD));

                this.velocity = moveVel.add(vertical);
            }
        }

        // ---------- JUMP ----------
        if (this.jumpRequested && this.isGrounded) {
            this.velocity.addInPlace(up.scale(this.jumpSpeed));
            this.isGrounded = false;
        }
        this.jumpRequested = false;

        // ---------- INTEGRATE POSITION ----------
        this.mesh.position.addInPlace(this.velocity.scale(dt));

        // ---------- GROUND SNAP ----------
        this._groundCheck(up);

        // ---------- ORIENT CAPSULE / CAMERA TO SURFACE ----------
        // Keep your existing orientation function if you have one:
        if (this._orientToSurface) {
            this._orientToSurface(up);
        }
    }



    getPosition() {
        return this.mesh ? this.mesh.position : null;
    }
}










