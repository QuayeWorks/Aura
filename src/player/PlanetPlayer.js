// PlanetPlayer.js
// Simple gravity-based capsule controller for a spherical planet,
// with safety against falling through LOD gaps.

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
        this.accel = options.accel ?? 20;             // how fast we reach target speed
        this.gravity = options.gravity ?? 10;         // "m/s^2" toward planet center
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

        // Remember last valid ground contact so LOD cracks / rebuilds
        // don’t instantly drop the player through the planet.
        this.lastGroundHit = null;
        this.lastGroundNormal = null;
        this._groundMissFrames = 0;   // how many frames in a row we saw no ground

        // Last safe position on solid ground (used as a respawn if we fall through)
        this.lastSafePosition = this.mesh.position.clone();
        // Radius below which we assume we fell into the world and must reset
        this.fallResetRadius = this.planetRadius * 0.9;
        // Radius above which we assume we fell out / away due to a gap
        this.fallOutRadius = this.planetRadius * 1.2;

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

        // First, ensure we're snapped to whatever ground exists below us
        // based on last frame's position (this sets isGrounded).
        this._groundCheckAndSnap();

        const pos = this.mesh.position.clone();
        const r = pos.length();
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
        let vTangent = this.velocity.subtract(vVertical);

        // Desired movement direction along surface from camera
        if (hasMoveInput) {
            let camForward;
            if (this.camera) {
                // From camera position to its target, projected onto tangent plane
                camForward = this.camera.target
                    .subtract(this.camera.position)
                    .normalize();
            } else {
                // Fallback: look "forward" along -Z
                camForward = new BABYLON.Vector3(0, 0, -1);
            }

            camForward = this._projectOntoPlane(camForward, up);
            if (camForward.lengthSquared() > 0.0001) {
                camForward.normalize();
            } else {
                camForward = new BABYLON.Vector3(0, 0, -1);
            }

            const camRight = BABYLON.Vector3.Cross(camForward, up).normalize();

            let desiredMoveDir = new BABYLON.Vector3(0, 0, 0);
            desiredMoveDir.addInPlace(camForward.scale(moveInput.z));
            desiredMoveDir.addInPlace(camRight.scale(moveInput.x));

            if (desiredMoveDir.lengthSquared() > 0.0001) {
                desiredMoveDir.normalize();

                const targetSpeed = this.inputRun ? this.runSpeed : this.walkSpeed;
                const targetVelTangent = desiredMoveDir.scale(targetSpeed);

                const tangentDelta = targetVelTangent.subtract(vTangent);
                const maxChange = this.accel * dtSeconds;
                const deltaLen = tangentDelta.length();

                if (deltaLen > maxChange) {
                    tangentDelta.scaleInPlace(maxChange / deltaLen);
                }

                vTangent.addInPlace(tangentDelta);
            }
        } else {
            // No input: apply friction to horizontal velocity
            const friction = this.isGrounded ? this.groundFriction : this.airFriction;
            const mag = vTangent.length();
            const drop = friction * dtSeconds;

            if (mag <= drop) {
                vTangent.set(0, 0, 0);
            } else {
                const newMag = mag - drop;
                vTangent.scaleInPlace(newMag / mag);
            }
        }

        // Recombine velocity
        this.velocity = vVertical.add(vTangent);

        // ---------------------------
        // 3) Jump
        // ---------------------------
        if (this.inputJumpRequested && this.isGrounded) {
            this.velocity.addInPlace(up.scale(this.jumpSpeed));
            this.isGrounded = false;
        }
        this.inputJumpRequested = false;

        // ---------------------------
        // 4) Integrate position
        // ---------------------------
        const deltaPos = this.velocity.scale(dtSeconds);
        this.mesh.position.addInPlace(deltaPos);

        // ---------------------------
        // 5) Emergency fall safety (inward & outward)
        // ---------------------------
        this._applyFallSafety();

        // ---------------------------
        // 6) Ground snap & orientation using new position
        // ---------------------------
        this._groundCheckAndSnap();
        this._orientToSurface();
    }

    // --------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------

    _spawnOnSurface() {
        // Spawn on +Z just above the surface using planet radius
        const startDir = new BABYLON.Vector3(0, 0, 1).normalize();
        const spawnRadius =
            this.planetRadius + this.height * 0.5 + this.capsuleRadius * 1.5;

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
     * Emergency safety:
     * - If radius < fallResetRadius: we fell into the world -> teleport to last safe spot.
     * - If radius > fallOutRadius: we fell away from the planet (LOD gap) -> teleport back.
     */
    _applyFallSafety() {
        const pos = this.mesh.position;
        const r = pos.length();

        if (!this.lastSafePosition || !isFinite(r)) return;

        const fellInward = r < this.fallResetRadius;
        const fellOutward = r > this.fallOutRadius;

        if (fellInward || fellOutward) {
            this.mesh.position.copyFrom(this.lastSafePosition);
            this.velocity.set(0, 0, 0);
            this.isGrounded = true;
            this._groundMissFrames = 0;
        }
    }

    /**
     * Raycast from slightly above the player towards planet center to find terrain
     * and snap the capsule gently to the surface.
     *
     * Also:
     * - Uses a short grace period with the last valid hit.
     * - Updates lastSafePosition whenever we have a solid ground contact.
     * - If we have no ground for a while but there *is* terrain above us,
     *   we snap back up to it (helps with falling through thin cracks).
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

        let hit = null;

        if (pick.hit && pick.pickedPoint) {
            hit = pick;
            this.lastGroundHit = pick;
            this.lastGroundNormal =
                pick.getNormal(true, false) || up.clone();
            this._groundMissFrames = 0;
        } else if (this.lastGroundHit && this._groundMissFrames < 3) {
            // Short grace period: reuse last hit while terrain LOD/mesh updates
            hit = this.lastGroundHit;
            this._groundMissFrames++;
        } else {
            this._groundMissFrames++;
        }

        if (hit && hit.pickedPoint) {
            const groundNormal = this.lastGroundNormal || up;
            const targetPos = hit.pickedPoint.add(
                groundNormal.scale(this.capsuleRadius * 0.9)
            );
            this.mesh.position.copyFrom(targetPos);

            // Kill downward velocity into the surface
            const velDown = BABYLON.Vector3.Dot(this.velocity, groundNormal.scale(-1));
            if (velDown > 0) {
                this.velocity = this.velocity.subtract(
                    groundNormal.scale(-velDown)
                );
            }

            this.isGrounded = true;

            // Update last safe position a bit above the surface
            this.lastSafePosition = hit.pickedPoint
                .add(groundNormal.scale(this.capsuleRadius * 1.2));
        } else {
            this.isGrounded = false;

            // If we've missed ground for a little while, check terrain *above* us.
            // This catches the case where we slipped slightly below the surface
            // through a crack / LOD seam.
            if (this._groundMissFrames > 10 && this.lastSafePosition) {
                const upRay = new BABYLON.Ray(
                    this.mesh.position,
                    up,
                    this.height * 4
                );
                const upPick = this.scene.pickWithRay(
                    upRay,
                    (mesh) => mesh && mesh.metadata && mesh.metadata.isTerrain
                );

                if (upPick.hit && upPick.pickedPoint) {
                    const snapPos = upPick.pickedPoint.add(
                        up.scale(this.capsuleRadius * 1.2)
                    );
                    this.mesh.position.copyFrom(snapPos);
                    this.velocity.set(0, 0, 0);
                    this.isGrounded = true;
                    this._groundMissFrames = 0;
                    this.lastSafePosition = snapPos.clone();
                }
            }
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
