/* global BABYLON */

const EnemyState = {
    IDLE: "idle",
    PATROL: "patrol",
    CHASE: "chase",
    ATTACK: "attack",
    FLEE: "flee"
};

const enemyModelCache = new Map();

function assetUrl(relPath) {
    return new URL(relPath, document.baseURI).toString();
}

async function getEnemyModelContainer(scene, modelFile) {
    if (enemyModelCache.has(modelFile)) return enemyModelCache.get(modelFile);

    const basePath = assetUrl("assets/characters/");
    const loadPromise = BABYLON.SceneLoader.LoadAssetContainerAsync(basePath, modelFile, scene)
        .then((container) => {
            for (const mesh of container.meshes) {
                mesh.isPickable = false;
                if (mesh.name === "__root__") {
                    mesh.setEnabled(false);
                }
            }
            return container;
        });

    enemyModelCache.set(modelFile, loadPromise);
    return loadPromise;
}

export class Enemy {
    constructor({ scene, planetRadius, position, id, modelFile } = {}) {
        this.scene = scene;
        this.planetRadius = planetRadius ?? 1;
        this.id = id;

        this.mesh = new BABYLON.TransformNode(`enemy_${id}`, this.scene);
        this.mesh.isPickable = false;

        this.placeholder = BABYLON.MeshBuilder.CreateSphere(`enemy_placeholder_${id}`, {
            diameter: 1.2
        }, this.scene);
        this.placeholder.material = new BABYLON.StandardMaterial(`enemy_placeholder_mat_${id}`, this.scene);
        this.placeholder.material.diffuseColor = new BABYLON.Color3(0.8, 0.2, 0.2);
        this.placeholder.material.emissiveColor = new BABYLON.Color3(0.5, 0.1, 0.1);
        this.placeholder.isPickable = false;
        this.placeholder.parent = this.mesh;

        this.state = EnemyState.IDLE;
        this.stateTimer = 0;
        this.attackCooldown = 0;

        this.speed = 6;
        this.surfaceOffset = 2.0;
        this.detectionRange = 20;
        this.attackRange = 2.5;

        this.mesh.position.copyFrom(position || new BABYLON.Vector3(this.planetRadius, 0, 0));
        this._stickToSurface();
        this._pickNewPatrol();

        this.isFrozen = false;
        this.isActive = true;
        this._postReleaseClampRemaining = 0;
        this._postReleaseMaxDt = 1 / 120;

        if (modelFile) {
            this._loadModel(modelFile);
        }
    }

    async _loadModel(modelFile) {
        const resolvedUrl = assetUrl(`assets/characters/${modelFile}`);
        try {
            const container = await getEnemyModelContainer(this.scene, modelFile);
            const { rootNodes } = container.instantiateModelsToScene(
                (name) => `${name}_${this.id}`,
                false
            );

            for (const node of rootNodes) {
                node.parent = this.mesh;
                if (node.name === "__root__") {
                    node.setEnabled(false);
                }
            }

            if (this.placeholder) {
                this.placeholder.dispose();
                this.placeholder = null;
            }
        } catch (err) {
            console.error(`Failed to load enemy model ${modelFile}:`, err);
            try {
                const res = await fetch(resolvedUrl);
                const contentType = res.headers.get("content-type");
                console.error(`[EnemyModelDebug] fetch ${resolvedUrl} ->`, res.status, contentType);
            } catch (diagErr) {
                console.error(`[EnemyModelDebug] Failed to diagnostic-fetch ${resolvedUrl}`, diagErr);
            }
        }
    }

    dispose() {
        this.placeholder?.dispose();
        this.mesh?.dispose();
    }

    setFrozen(isFrozen) {
        this.isFrozen = !!isFrozen;
    }

    setActive(isActive) {
        this.isActive = !!isActive;
    }

    applyGroundGateClamp(durationSeconds = 2, maxStepSeconds = 1 / 120) {
        this._postReleaseClampRemaining = Math.max(this._postReleaseClampRemaining, durationSeconds);
        this._postReleaseMaxDt = maxStepSeconds ?? this._postReleaseMaxDt;
    }

    _stickToSurface() {
        const dir = this.mesh.position.clone();
        const len = dir.length();
        if (len < 1e-5) return;
        dir.scaleInPlace(1 / len);
        const targetRadius = Math.max(len, this.planetRadius + this.surfaceOffset);
        this.mesh.position.copyFrom(dir.scale(targetRadius));

        const up = dir;
        const forward = BABYLON.Vector3.Cross(up, new BABYLON.Vector3(0, 1, 0));
        if (forward.lengthSquared() < 1e-4) forward.copyFromFloats(1, 0, 0);
        forward.normalize();
        const right = BABYLON.Vector3.Cross(forward, up).normalize();
        const rotationMatrix = BABYLON.Matrix.Identity();
        BABYLON.Matrix.FromXYZAxesToRef(right, up, forward, rotationMatrix);
        this.mesh.rotationQuaternion = BABYLON.Quaternion.FromRotationMatrix(rotationMatrix);
    }

    _pickNewPatrol() {
        this.state = EnemyState.PATROL;
        this.stateTimer = 2 + Math.random() * 3;

        const randomDir = new BABYLON.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
        if (randomDir.lengthSquared() < 1e-5) randomDir.copyFromFloats(1, 0, 0);
        randomDir.normalize();
        this.patrolDir = randomDir;
    }

    _moveAlongSurface(desiredDir, dtSeconds) {
        const up = this.mesh.position.clone().normalize();
        let dir = desiredDir.subtract(up.scale(BABYLON.Vector3.Dot(desiredDir, up)));
        if (dir.lengthSquared() < 1e-6) return;
        dir.normalize();
        const step = dir.scale(this.speed * dtSeconds);
        this.mesh.position.addInPlace(step);
        this._stickToSurface();
    }

    update(dtSeconds, player, onAttack) {
        if (dtSeconds <= 0 || !this.mesh) return;

        if (!this.isActive) {
            return;
        }

        if (this.isFrozen) {
            return;
        }

        if (this._postReleaseClampRemaining > 0) {
            this._postReleaseClampRemaining = Math.max(0, this._postReleaseClampRemaining - dtSeconds);
            dtSeconds = Math.min(dtSeconds, this._postReleaseMaxDt);
        }

        const playerPos = player?.mesh?.position;
        const toPlayer = playerPos ? playerPos.subtract(this.mesh.position) : null;
        const distanceToPlayer = toPlayer ? toPlayer.length() : Infinity;

        // State transitions
        if (playerPos && distanceToPlayer < this.attackRange) {
            this.state = EnemyState.ATTACK;
        } else if (playerPos && distanceToPlayer < this.detectionRange) {
            this.state = EnemyState.CHASE;
        } else if (this.state !== EnemyState.PATROL) {
            this._pickNewPatrol();
        }

        // Update state timers
        this.stateTimer = Math.max(0, this.stateTimer - dtSeconds);
        this.attackCooldown = Math.max(0, this.attackCooldown - dtSeconds);

        switch (this.state) {
            case EnemyState.CHASE:
                if (toPlayer) {
                    this._moveAlongSurface(toPlayer.normalize(), dtSeconds);
                }
                break;
            case EnemyState.ATTACK:
                if (toPlayer && distanceToPlayer < this.attackRange * 1.2) {
                    if (this.attackCooldown <= 0) {
                        onAttack?.();
                        this.attackCooldown = 1.2;
                    }
                } else if (toPlayer) {
                    this._moveAlongSurface(toPlayer.normalize(), dtSeconds);
                }
                break;
            case EnemyState.PATROL:
                if (this.stateTimer <= 0) this._pickNewPatrol();
                this._moveAlongSurface(this.patrolDir, dtSeconds);
                break;
            case EnemyState.IDLE:
            default:
                this.state = EnemyState.PATROL;
                break;
        }

        // Keep aligned to surface
        this._stickToSurface();
    }
}
