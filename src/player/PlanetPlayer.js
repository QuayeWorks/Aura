/* global BABYLON */
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
        
        // Jump grace: prevents fall-safeguard/ground-snap from cancelling an intentional jump
        this.jumpGraceSeconds = options.jumpGraceSeconds ?? 3;
        this._jumpGraceRemaining = 0;
        this._minUpwardVelForGrace = options.minUpwardVelForGrace ?? 1;
this.groundFriction = options.groundFriction ?? 8;
        this.airFriction = options.airFriction ?? 1;

        this.groundSnapDistance =
            options.groundSnapDistance ??
            Math.max(6, this.planetRadius * 0.003); // scale with planet size

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

        // Input can be disabled while in menus so gameplay controls don't bleed through.
        this.inputEnabled = options.inputEnabled ?? true;

        // Deterministic spawn direction (defaults to +Z). We then raycast to the real surface.
        this.spawnDirection = (options.spawnDirection
            ? options.spawnDirection.clone()
            : new BABYLON.Vector3(0, 0, 1)
        ).normalize();

        // Start just above the actual terrain surface along spawnDirection.
        this._spawnOnSurface(this.spawnDirection);

        this.velocity = new BABYLON.Vector3(0, 0, 0);
        this.isGrounded = false;

        // Camera we attach to (ArcRotate in your scene)
        this.camera = null;

        // Remember last valid ground contact so LOD cracks / rebuilds
        // don’t instantly drop the player through the planet.
        this.lastGroundHit = null;
        this.lastGroundNormal = null;
        this._groundMissFrames = 0;   // how many frames in a row we saw no ground

        // Last safe position on solid ground (used as a respawn if we fall through)
        this.lastSafePosition = this.mesh.position.clone();

        // Collision miss detection helpers
        this._previousPosition = this.mesh.position.clone();
        this._wasGroundedLastFrame = false;
        this._collisionRecoveryCooldown = 0;
        this._debugLogRecoveries = false;

        // Physics sub-stepping to avoid tunneling on large dt spikes or sprint speed
        this.maxPhysicsStepSeconds = options.maxPhysicsStepSeconds ?? 1 / 60;
        this.maxPhysicsSubsteps = options.maxPhysicsSubsteps ?? 5;
        this.maxMoveFractionPerSubstep = options.maxMoveFractionPerSubstep ?? 0.75; // portion of capsule radius per micro-step

        this.isFrozen = false;

        // Input flags
        this.inputForward = false;
        this.inputBack = false;
        this.inputLeft = false;
        this.inputRight = false;
        this.inputRun = false;
        this.inputJumpRequested = false;

        this._registerInput();
    }

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

    setFrozen(isFrozen) {
        this.isFrozen = !!isFrozen;
        if (this.isFrozen) {
            this.velocity.set(0, 0, 0);
            this.inputJumpRequested = false;
        }
    }

    /**
     * Enable/disable gameplay input without destroying the player.
     * When disabling, we clear current movement flags.
     */
    setInputEnabled(isEnabled) {
        this.inputEnabled = !!isEnabled;

        if (!this.inputEnabled) {
            this.inputForward = false;
            this.inputBack = false;
            this.inputLeft = false;
            this.inputRight = false;
            this.inputRun = false;
            this.inputJumpRequested = false;
        }
    }

    /**
     * Snap the player back onto the terrain surface along their current radial direction.
     * Useful after loading, teleporting, or returning from menus.
     */
    reprojectToSurface() {
        const dir = this.mesh.position.clone();
        if (dir.lengthSquared() < 1e-6) dir.copyFromFloats(0, 0, 1);
        dir.normalize();
        this._spawnOnSurface(dir);
    }

    /**
     * Per-frame update. Call from your render loop with delta in SECONDS.
     */

    update(dtSeconds) {
        if (dtSeconds <= 0) return;

        if (this.isFrozen) {
            this.velocity.set(0, 0, 0);
            return;
        }

        // Remember starting point for tunnel detection
        this._previousPosition.copyFrom(this.mesh.position);

        // Clamp dt to avoid giant steps when the tab was unfocused, and sub-step
        // to reduce tunneling when sprinting fast.
        const clampedDt = Math.min(
            dtSeconds,
            this.maxPhysicsStepSeconds * this.maxPhysicsSubsteps
        );
        const steps = Math.max(1, Math.ceil(clampedDt / this.maxPhysicsStepSeconds));
        const stepDt = clampedDt / steps;

        this._collisionRecoveryCooldown = Math.max(
            0,
            this._collisionRecoveryCooldown - dtSeconds
        );

        for (let i = 0; i < steps; i++) {
            this._integrateStep(stepDt);
        }

        this._wasGroundedLastFrame = this.isGrounded;
    }

    _integrateStep(dtSeconds) {
        const pos = this.mesh.position.clone();
        const r = pos.length();

        if (r < 1e-3) {
            // Avoid NaNs if somehow at the exact center
            return;
        }

        const up = pos.scale(1 / r);   // radial up
        const down = up.scale(-1);

        // Jump grace countdown + radial velocity gating
        if (this._jumpGraceRemaining > 0) {
            this._jumpGraceRemaining = Math.max(0, this._jumpGraceRemaining - dtSeconds);
        }
        const radialVel = BABYLON.Vector3.Dot(this.velocity, up); // + = moving away from center
        const isMovingUp = radialVel > this._minUpwardVelForGrace;
        const inJumpGrace = (this._jumpGraceRemaining > 0) && isMovingUp;

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
            // Grace window so ground snap / fail-safe won't cancel the jump
            this._jumpGraceRemaining = this.jumpGraceSeconds;
        }

        // consume jump for this frame
        this.inputJumpRequested = false;

        // ---------------------------
        // 4) Integrate motion with micro-steps to avoid tunneling
        // ---------------------------
        const desiredDelta = this.velocity.scale(dtSeconds);
        const maxMove = Math.max(
            this.capsuleRadius * this.maxMoveFractionPerSubstep,
            0.01
        );
        const microSteps = Math.max(
            1,
            Math.ceil(desiredDelta.length() / maxMove)
        );
        const microDt = dtSeconds / microSteps;
        const microDelta = desiredDelta.scale(1 / microSteps);

        for (let i = 0; i < microSteps; i++) {
            const segmentStart = this.mesh.position.clone();
            this.mesh.position.addInPlace(microDelta);
            const recovered = this._detectCollisionMiss(segmentStart, this.mesh.position, up, microDt);
            if (recovered) break;
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
    }

    _detectCollisionMiss(startPos, endPos, up, dtSeconds) {
        if (this._collisionRecoveryCooldown > 0) return false;

        const movement = endPos.subtract(startPos);
        const moveLen = movement.length();
        if (moveLen < 1e-4) return false;

        const speed = moveLen / Math.max(dtSeconds, 1e-4);
        const checkBecauseSpeed =
            speed > this.runSpeed * 1.25 ||
            dtSeconds > this.maxPhysicsStepSeconds * 0.75 ||
            moveLen > this.capsuleRadius * 0.9;
        const lostGround = this._wasGroundedLastFrame && !this.isGrounded;
        if (!(checkBecauseSpeed || lostGround)) return false;

        const ray = new BABYLON.Ray(
            startPos,
            movement.normalize(),
            moveLen + this.capsuleRadius * 0.5
        );
        const pick = this._terrainRaycast(ray);

        const insideSolid = this._isInsideTerrainApprox(endPos, up);
        let shouldRecover = false;
        let recoveryHint = null;

        if (pick?.hit && pick.distance <= ray.length) {
            const hitPoint = pick.pickedPoint;
            const endedInside =
                endPos.length() + this.capsuleRadius * 0.25 < hitPoint.length() ||
                insideSolid;
            if (endedInside) {
                shouldRecover = true;
                recoveryHint = hitPoint;
            }
        } else if (insideSolid && this._previousPosition.length() > endPos.length()) {
            shouldRecover = true;
        }

        if (shouldRecover) {
            this._recoverToSafePosition(recoveryHint, up, {
                speed,
                dt: dtSeconds,
                rayHit: !!pick?.hit,
                insideSolid,
            });
            return true;
        }

        return false;
    }

    _terrainRaycast(ray) {
        return this.scene.pickWithRay(
            ray,
            (mesh) =>
                mesh &&
                mesh.metadata &&
                (
                    mesh.metadata.isTerrainCollider === true ||
                    mesh.metadata.isTerrain === true
                )
        );
    }

    _isInsideTerrainApprox(pos, up) {
        const outward = new BABYLON.Ray(pos, up, this.capsuleRadius * 1.5);
        const outwardHit = this._terrainRaycast(outward);
        if (outwardHit?.hit && outwardHit.distance < this.capsuleRadius * 0.5) return true;

        const inward = new BABYLON.Ray(
            pos.add(up.scale(this.capsuleRadius * 0.5)),
            up.scale(-1),
            this.capsuleRadius * 2
        );
        const inwardHit = this._terrainRaycast(inward);
        return !!(inwardHit?.hit && inwardHit.distance < this.capsuleRadius * 0.5);
    }

    _recoverToSafePosition(hitPoint, up, debugInfo = {}) {
        let target = null;
        if (this.lastSafePosition) {
            target = this.lastSafePosition.clone();
        } else if (hitPoint) {
            target = hitPoint.add(up.scale(this.height * 0.5 + this.capsuleRadius));
        } else if (this._previousPosition) {
            target = this._previousPosition.clone();
        }

        if (target) {
            this.mesh.position.copyFrom(target);
            this.lastSafePosition = target.clone();
        }

        this.velocity.set(0, 0, 0);
        this.isGrounded = false;
        this._collisionRecoveryCooldown = 0.25;
        this._groundMissFrames = 0;

        if (this._debugLogRecoveries) {
            // eslint-disable-next-line no-console
            console.log('[Player] Collision miss recovery', {
                ...debugInfo,
                target,
            });
        }
    }

    _spawnOnSurface(startDir) {
        const dir = (startDir ? startDir.clone() : new BABYLON.Vector3(0, 0, 1));
        if (dir.lengthSquared() < 1e-6) dir.copyFromFloats(0, 0, 1);
        dir.normalize();

        // Clearance above the surface.
        const surfaceClearance = this.capsuleRadius * 1.5 + this.height * 0.25;

        // Start from well above the expected surface and raycast inward.
        const startRadius = this.planetRadius + (this.planetRadius * 0.08);
        const rayOrigin = dir.scale(startRadius);
        const ray = new BABYLON.Ray(rayOrigin, dir.scale(-1), this.planetRadius * 0.2);

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

        if (pick && pick.hit && pick.pickedPoint) {
            // Place player just above the surface hit.
            const bottomToCenter = this.height * 0.5;
            const up = pick.pickedPoint.clone().normalize();
            this.mesh.position.copyFrom(
                pick.pickedPoint.add(up.scale(bottomToCenter + surfaceClearance))
            );
        } else {
            // Fallback: sphere radius spawn (still deterministic)
            const spawnRadius = this.planetRadius + surfaceClearance;
            this.mesh.position = dir.scale(spawnRadius);
        }

        // Reset motion so we don't inherit junk velocity on respawn.
        this.velocity?.set?.(0, 0, 0);
        this.isGrounded = false;
        this._groundMissFrames = 0;
    }

    _registerInput() {
        window.addEventListener("keydown", (ev) => {
            if (!this.inputEnabled) return;
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
                case "F6":
                    this._debugLogRecoveries = !this._debugLogRecoveries;
                    // eslint-disable-next-line no-console
                    console.log(
                        `Collision miss recovery logging: ${this._debugLogRecoveries ? "ON" : "OFF"}`
                    );
                    break;
            }
        });

        window.addEventListener("keyup", (ev) => {
            if (!this.inputEnabled) return;
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

        

        // If we're in jump grace and moving upward, don't snap to ground this frame
        if (this._jumpGraceRemaining > 0) {
            const radialVelNow = BABYLON.Vector3.Dot(this.velocity, up);
            if (radialVelNow > this._minUpwardVelForGrace) {
                this.isGrounded = false;
                return;
            }
        }
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
            if (this._jumpGraceRemaining <= 0) {
                this.lastSafePosition = this.mesh.position.clone();
            }

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
                    if (this._jumpGraceRemaining <= 0) {
                        this.lastSafePosition = this.mesh.position.clone();
                    }
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


