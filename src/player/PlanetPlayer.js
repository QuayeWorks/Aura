// PlanetPlayer.js
// Simple gravity-based capsule controller for a spherical planet.

export class PlanetPlayer {
    /**
     * @param {BABYLON.Scene} scene
     * @param {ChunkedPlanetTerrain} terrain
     * @param {object} options
     *   - planetRadius: radius of the planet in world units (REQUIRED for correct spawn)
     *   - height: capsule height (default 10)
     *   - radius: capsule radius (default 2)
     */
    constructor(scene, terrain, options = {}) {
        this.scene = scene;
        this.terrain = terrain;

        // --- Shape / planet parameters ---
        const defaultHeight = options.height ?? 20;
        const defaultRadius = options.radius ?? 2;

        this.height = defaultHeight;
        this.capsuleRadius = defaultRadius;

        // Use planetRadius from options/terrain, never hard-code
        this.planetRadius =
            options.planetRadius ??
            (terrain && terrain.radius ? terrain.radius : 72);

        // --- Movement / physics tuning ---
        // Movement tuning (speeds in m/s)
        // 4 mph  ≈ 1.788 m/s
        // 25 mph ≈ 11.176 m/s
        this.walkSpeed = options.walkSpeed ?? 1.788;  // normal walk
        this.runSpeed  = options.runSpeed  ?? 11.176; // sprint
        this.accel = options.accel ?? 20;           // how fast we reach target speed
        this.gravity = options.gravity ?? 10;       // "m/s^2" toward planet center
        this.jumpSpeed = options.jumpSpeed ?? 10;
        this.groundFriction = options.groundFriction ?? 8;
        this.airFriction = options.airFriction ?? 1;

        this.groundSnapDistance = options.groundSnapDistance ?? 6;

        // --- Runtime state ---
        this.mesh = BABYLON.MeshBuilder.CreateCapsule(
            "playerCapsule",
            {
                height: this.height,
                radius: this.capsuleRadius,
            },
            this.scene
        );
        this.mesh.checkCollisions = false;
        this.mesh.isPickable = false;

        // Start just above surface on +Z
        this._spawnOnSurface();

        this.velocity = new BABYLON.Vector3(0, 0, 0);
        this.isGrounded = false;

        // Camera we attach to (ArcRotate in your scene)
        this.camera = null;

        // Input flags
        this.inputForward = false;
        this.inputBack = false;
        this.inputLeft = false;
        this.inputRight = false;
        this.inputRun = false;
        this.inputJumpRequested = false;

        this._registerInput();
    }

    // --------------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------------

    /**
     * Attach a camera so we can move relative to its orientation.
     * main.js: player.attachCamera(camera);
     */
    attachCamera(camera) {
        this.camera = camera;

        if (!this.camera) return;

        // For ArcRotateCamera this is enough for following.
        this.camera.lockedTarget = this.mesh;

        // Make sure camera radius is reasonable for your planet size.
        const minRadius = this.planetRadius * 0.02;
        if (this.camera.radius < minRadius) {
            this.camera.radius = minRadius;
        }
    }

    /**
     * Per-frame update. Call from your render loop with delta in SECONDS.
     */
    update(dtSeconds) {
        if (dtSeconds <= 0) return;

        const pos = this.mesh.position.clone();
        const r = pos.length() + 5;

        if (r < 1e-3) {
            // Avoid NaNs if somehow at the exact center
            return;
        }

        const up = pos.scale(1 / r);   // radial up
        const down = up.scale(-1);

        // ---------------------------
        // 1) Gravity
        // ---------------------------
        this.velocity.addInPlace(down.scale(this.gravity * dtSeconds));

        // ---------------------------
        // 2) Movement input
        // ---------------------------
        let moveInput = new BABYLON.Vector3(0, 0, 0);
        if (this.inputForward) moveInput.z += 1;
        if (this.inputBack) moveInput.z -= 1;
        if (this.inputRight) moveInput.x += 1;
        if (this.inputLeft) moveInput.x -= 1;

        const hasMoveInput = moveInput.lengthSquared() > 0.0001;

        // Decompose velocity into vertical vs tangential
        const vVertical = up.scale(BABYLON.Vector3.Dot(this.velocity, up));
        let vTangential = this.velocity.subtract(vVertical);

        if (hasMoveInput) {
            moveInput.normalize();

            let forwardTangent;
            let rightTangent;

            if (this.camera && this.camera.getDirection) {
                const camForward = this.camera.getDirection(
                    new BABYLON.Vector3(0, 0, 1)
                );
                const camRight = this.camera.getDirection(
                    new BABYLON.Vector3(1, 0, 0)
                );

                forwardTangent = this._projectOntoPlane(camForward, up);
                rightTangent = this._projectOntoPlane(camRight, up);
            } else {
                // Fallback basis
                forwardTangent = this._projectOntoPlane(
                    BABYLON.Axis.Z,
                    up
                );
                rightTangent = BABYLON.Vector3.Cross(
                    forwardTangent,
                    up
                );
            }

            forwardTangent.normalize();
            rightTangent.normalize();

            const desiredDir = forwardTangent
                .scale(moveInput.z)
                .add(rightTangent.scale(moveInput.x))
                .normalize();

            const targetSpeed = this.inputRun
                ? this.runSpeed
                : this.walkSpeed;
            const targetTangential = desiredDir.scale(targetSpeed);

            // Accelerate toward target tangential velocity
            const lerpFactor = 1 - Math.exp(-this.accel * dtSeconds);
            vTangential = BABYLON.Vector3.Lerp(
                vTangential,
                targetTangential,
                lerpFactor
            );
        } else {
            // Friction when no input
            const friction =
                this.isGrounded ? this.groundFriction : this.airFriction;
            const damp = Math.exp(-friction * dtSeconds);
            vTangential.scaleInPlace(damp);
        }

        // Recombine with vertical component
        this.velocity = vTangential.add(vVertical);

        // ---------------------------
        // 3) Jump
        // ---------------------------
        if (this.inputJumpRequested && this.isGrounded) {
            this.velocity.addInPlace(up.scale(this.jumpSpeed));
            this.isGrounded = false;
        }
        // consume jump for this frame
        this.inputJumpRequested = false;

        // ---------------------------
        // 4) Integrate motion
        // ---------------------------
        this.mesh.position.addInPlace(this.velocity.scale(dtSeconds));

        // Prevent falling through the entire planet core if something goes wrong
        const newR = this.mesh.position.length();
        const minR = this.planetRadius * 0.3;
        if (newR < minR) {
            this.mesh.position = this.mesh.position
                .normalize()
                .scale(minR);
        }

        // ---------------------------
        // 5) Ground snap vs terrain mesh
        // ---------------------------
        this._groundCheckAndSnap();

        // ---------------------------
        // 6) Orient capsule to follow surface normal
        // ---------------------------
        this._orientToSurface();

        // ---------- CAMERA UP LOCK ----------
        if (this.camera) {
            // Planet-normal up at player position
            const camUp = this.mesh.position.clone().normalize();
        
            // Keep arc-rotate camera's up aligned with the planet
            this.camera.upVector = camUp;
        
            // Always look at the player
            this.camera.setTarget(this.mesh.position);
        }



        // Camera follow: ArcRotate already locked to mesh
        // (nothing else required here for now)
    }

    // --------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------

    _spawnOnSurface() {
        // Start over +Z
        const startDir = new BABYLON.Vector3(0, 0, 1).normalize();
        // A bit above the nominal radius so we are not intersecting terrain
        const spawnRadius =
            this.planetRadius * 1.01 +
            this.height +
            this.capsuleRadius * 1.5;

        this.mesh.position = startDir.scale(spawnRadius);
    }

    _registerInput() {
        window.addEventListener("keydown", (ev) => {
            switch (ev.code) {
                case "KeyW":
                case "ArrowUp":
                    this.inputForward = true;
                    break;
                case "KeyS":
                case "ArrowDown":
                    this.inputBack = true;
                    break;
                case "KeyA":
                case "ArrowLeft":
                    this.inputLeft = true;
                    break;
                case "KeyD":
                case "ArrowRight":
                    this.inputRight = true;
                    break;
                case "ShiftLeft":
                case "ShiftRight":
                    this.inputRun = true;
                    break;
                case "Space":
                    this.inputJumpRequested = true;
                    break;
            }
        });

        window.addEventListener("keyup", (ev) => {
            switch (ev.code) {
                case "KeyW":
                case "ArrowUp":
                    this.inputForward = false;
                    break;
                case "KeyS":
                case "ArrowDown":
                    this.inputBack = false;
                    break;
                case "KeyA":
                case "ArrowLeft":
                    this.inputLeft = false;
                    break;
                case "KeyD":
                case "ArrowRight":
                    this.inputRight = false;
                    break;
                case "ShiftLeft":
                case "ShiftRight":
                    this.inputRun = false;
                    break;
            }
        });
    }

    _projectOntoPlane(vec, planeNormal) {
        const n = planeNormal.normalize();
        const d = BABYLON.Vector3.Dot(vec, n);
        return vec.subtract(n.scale(d));
    }

    /**
     * Raycast from slightly above the player towards planet center to find terrain
     * and snap the capsule gently to the surface.
     */
    _groundCheckAndSnap() {
        const pos = this.mesh.position.clone();
        const r = pos.length();
        if (r < 1e-3) return;

        const up = pos.scale(1 / r);
        const down = up.scale(-1);

        const rayOrigin = pos.add(up.scale(this.capsuleRadius));
        const rayLen =
            this.capsuleRadius + this.height + this.groundSnapDistance;

        const ray = new BABYLON.Ray(rayOrigin, down, rayLen);

        // Only hit terrain chunks (you set metadata.isTerrain = true on them)
        const pick = this.scene.pickWithRay(
            ray,
            (mesh) => mesh && mesh.metadata && mesh.metadata.isTerrain
        );

        if (pick.hit && pick.pickedPoint) {
            // Move the capsule so **its bottom half is above the surface**.
            // Babylon's capsule is height tall, with extents ±height/2 from center.
            const bottomToCenter = this.height * 0.5;
            const surfaceClearance = this.capsuleRadius * 0.1; // small gap so it doesn't clip

            const targetPos = pick.pickedPoint.add(
                up.scale(bottomToCenter + surfaceClearance)
            );
            this.mesh.position.copyFrom(targetPos);

            // Kill downward velocity into the surface
            const velDown = BABYLON.Vector3.Dot(this.velocity, down);
            if (velDown > 0) {
                this.velocity = this.velocity.subtract(
                    down.scale(velDown)
                );
            }
            this.isGrounded = true;
        } else {
            this.isGrounded = false;
        }
    }

    /**
     * Smoothly align the capsule "up" with the planet radial up.
     */
    _orientToSurface() {
        const pos = this.mesh.position.clone();
        const r = pos.length();
        if (r < 1e-3) return;

        const up = pos.scale(1 / r);

        if (!this.mesh.rotationQuaternion) {
            this.mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
        }

        // Current up in world space
        const currentUp = this.mesh
            .getDirection(BABYLON.Axis.Y)
            .normalize();

        const dot = BABYLON.Vector3.Dot(currentUp, up);
        const clampedDot = Math.min(1, Math.max(-1, dot));
        const angle = Math.acos(clampedDot);

        if (angle < 1e-3) return;

        const axis = BABYLON.Vector3.Cross(currentUp, up);
        if (axis.lengthSquared() < 1e-6) return;
        axis.normalize();

        const q = BABYLON.Quaternion.RotationAxis(axis, angle);

        // Apply rotation in world space
        this.mesh.rotationQuaternion = q.multiply(
            this.mesh.rotationQuaternion
        );
    }
}















