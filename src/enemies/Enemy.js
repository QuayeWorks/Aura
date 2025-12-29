/* global BABYLON */

const EnemyState = {
    IDLE: "idle",
    PATROL: "patrol",
    CHASE: "chase",
    ATTACK: "attack",
    FLEE: "flee"
};

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

        if (modelFile) {
            this._loadModel(modelFile);
        }
    }

    async _loadModel(modelFile) {
        try {
            const result = await BABYLON.SceneLoader.ImportMeshAsync(
                "",
                "assets/characters/",
                modelFile,
                this.scene
            );

            for (const mesh of result.meshes) {
                if (mesh === result.meshes[0] && mesh.name === "__root__") {
                    mesh.setEnabled(false);
                    mesh.parent = this.mesh;
                    continue;
                }
                mesh.parent = this.mesh;
                mesh.isPickable = false;
            }

            if (this.placeholder) {
                this.placeholder.dispose();
                this.placeholder = null;
            }
        } catch (err) {
            console.error(`Failed to load enemy model ${modelFile}:`, err);
        }
    }

    dispose() {
        this.placeholder?.dispose();
        this.mesh?.dispose();
    }

    _stickToSurface() {
        const dir = this.mesh.position.clone();
        const len = dir.length();
        if (len < 1e-5) return;
        dir.scaleInPlace(1 / len);
        this.mesh.position.copyFrom(dir.scale(this.planetRadius + this.surfaceOffset));

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
