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

        // Track last known good ground position for emergency recovery
        this.lastGroundPosition = this.mesh.position.clone();
        this.framesSinceGrounded = 0;
        this.maxUngroundedFramesBeforeRecover =
            options.maxUngroundedFramesBeforeRecover ?? 180; // ~3s at 60fps
        this.emergencySurfaceRayLength =
            options.emergencySurfaceRayLength ?? this.planetRadius * 0.1;

        // Camera we attach to (ArcRotate in your scene)
        this.camera = null;

        // Remember last valid ground contact so LOD cracks / rebuilds
        // don’t instantly drop the player through the planet.
        this.lastGroundHit = null;
        this.lastGroundNormal = null;
        this._groundMissFrames = 0;   // how many frames in a row we saw no ground

        // Last safe position on solid ground (used as a respawn if we fall through)
        this.lastSafePosition = null;
        // Radius below which we assume we fell out of the world and must reset
        this.fallResetRadius = this.planetRadius * 0.9;
        
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

        /**
     * If we've been ungrounded for a long time (likely due to a missing
     * collider / LOD seam), try to get back to a safe surface spot.
     */
    _emergencySurfaceRecovery() {
        const pos = this.mesh.position.clone();
        const r = pos.length();
        if (r < 1e-3) return;

        const up = pos.scale(1 / r);
        const rayLen = this.planetRadius * 0.1;

        // First try: ray outward from current position to find terrain above
        const rayOut = new BABYLON.Ray(
            this.mesh.position.clone(),
            up,
            rayLen
        );

        const pick = this.scene.pickWithRay(
            ray,
            (mesh) =>
                mesh &&
                mesh.metadata &&
                mesh.metadata.isTerrainCollider === true
        );


        if (pick.hit && pick.pickedPoint) {
            const bottomToCenter = this.height * 0.5;
            const surfaceClearance = this.capsuleRadius * 0.1;

            const targetPos = pick.pickedPoint.add(
                up.scale(bottomToCenter + surfaceClearance)
            );
            this.mesh.position.copyFrom(targetPos);
        } else if (this.lastSafePosition) {
            // Fallback: teleport back to last known safe grounded position
            this.mesh.position.copyFrom(this.lastSafePosition);
        } else {
            // Final fallback: snap to planet radius slightly above surface
            this.mesh.position = up.scale(
                this.planetRadius + this.height + this.capsuleRadius
            );
        }

        // Reset velocity and counters so we don't immediately yeet again
        this.velocity.set(0, 0, 0);
        this.isGrounded = true;
        this._framesSinceGrounded = 0;
        this._groundMissFrames = 0;
    }

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

        // Prevent falling through the entire planet if something goes wrong.
        // If we drop far below the expected surface shell, snap back to the
        // last known safe grounded position.
        const newR = this.mesh.position.length();
        if (newR < this.fallResetRadius) {
            if (this.lastSafePosition) {
                this.mesh.position.copyFrom(this.lastSafePosition);
            } else {
                // Fallback: put the player back on +Z at a safe radius
                const fallbackDir = new BABYLON.Vector3(0, 0, 1);
                this.mesh.position = fallbackDir
                    .normalize()
                    .scale(this.planetRadius * 1.02);
            }

            // Stop any crazy velocity and let ground snap re-acquire
            this.velocity.set(0, 0, 0);
            this.isGrounded = false;
            this._groundMissFrames = 0;
        }


        // ---------------------------
        // 5) Ground snap vs terrain mesh
        // ---------------------------
        this._groundCheckAndSnap();

        
        // 5b) Emergency surface recovery if we've been ungrounded too long
        if (!this.isGrounded) {
            this.framesSinceGrounded++;
            if (this.framesSinceGrounded > this.maxUngroundedFramesBeforeRecover) {
                this._emergencySurfaceRecovery();
            }
        } else {
            this.framesSinceGrounded = 0;
        }

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

        // Capsule geometry
        const bottomToCenter = this.height * 0.5;
        const surfaceClearance = this.capsuleRadius * 0.1; // small gap above surface

        // Ray starts slightly above the head and goes inward toward the planet
        const rayOrigin = pos.add(
            up.scale(bottomToCenter + this.capsuleRadius)
        );
        const rayLen =
            bottomToCenter + this.capsuleRadius + this.groundSnapDistance;

        const ray = new BABYLON.Ray(rayOrigin, down, rayLen);

        // Only hit terrain chunks (metadata.isTerrain set on them)
        const pick = this.scene.pickWithRay(
            ray,
            (mesh) =>
                mesh &&
                mesh.metadata &&
                (
                    mesh.metadata.isTerrainCollider === true ||
                    mesh.metadata.isTerrain === true
                )
        );


        let groundedThisFrame = false;

        if (pick.hit && pick.pickedPoint) {
            // --- Normal path: we see ground under us ---
            this._groundMissFrames = 0;

            const targetPos = pick.pickedPoint.add(
                up.scale(bottomToCenter + surfaceClearance)
            );
            this.mesh.position.copyFrom(targetPos);

            const velDown = BABYLON.Vector3.Dot(this.velocity, down);
            if (velDown > 0) {
                this.velocity = this.velocity.subtract(
                    down.scale(velDown)
                );
            }

            groundedThisFrame = true;

            // Remember this contact for brief LOD gaps
            this.lastGroundHit = pick.pickedPoint.clone
                ? pick.pickedPoint.clone()
                : pick.pickedPoint;

            if (pick.getNormal) {
                const n = pick.getNormal(true);
                this.lastGroundNormal = n
                    ? (n.clone ? n.clone() : n)
                    : up;
            } else {
                this.lastGroundNormal = up;
            }

            // Update last safe grounded position
            this.lastSafePosition = this.mesh.position.clone();

        } else {
            // --- No ground hit this frame ---
            this._groundMissFrames++;

            // For just a few frames, we may be crossing an LOD seam where
            // the mesh is temporarily gone. In that case, keep using the
            // last stable ground contact as a "virtual" surface.
            if (this.lastGroundHit && this._groundMissFrames <= 3) {
                const distToLast = BABYLON.Vector3.Distance(
                    pos,
                    this.lastGroundHit
                );

                if (distToLast <= this.groundSnapDistance * 1.5) {
                    const targetPos = this.lastGroundHit.add(
                        up.scale(bottomToCenter + surfaceClearance)
                    );
                    this.mesh.position.copyFrom(targetPos);

                    const velDown = BABYLON.Vector3.Dot(this.velocity, down);
                    if (velDown > 0) {
                        this.velocity = this.velocity.subtract(
                            down.scale(velDown)
                        );
                    }

                    groundedThisFrame = true;
                    // This still counts as standing on solid ground for safety
                    this.lastSafePosition = this.mesh.position.clone();
                }
            }

            // If we've gone several frames with no ground, we assume the
            // geometry is really gone (e.g. we carved a hole) and let the
            // player fall instead of standing on an invisible platform.
            if (!groundedThisFrame && this._groundMissFrames > 3) {
                this.lastGroundHit = null;
                this.lastGroundNormal = null;
            }
        }

        this.isGrounded = groundedThisFrame;
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






