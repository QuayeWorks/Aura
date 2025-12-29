/* global BABYLON */
import { Enemy } from "./Enemy.js";

export class EnemyManager {
    constructor({ scene, terrain, player, planetRadius, playerStats, dayNightSystem, groundGate, spawnRadius = 10, maxEnemies = 2 }) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.planetRadius = planetRadius ?? 1;
        this.playerStats = playerStats;
        this.dayNightSystem = dayNightSystem;
        this.groundGate = groundGate;

        this.enabled = true;

        this.spawnRadius = spawnRadius;
        this.maxEnemies = maxEnemies;
        this.enemyConfigs = [
            { type: "male", model: "male_doll.glb" },
            { type: "female", model: "female_doll.glb" }
        ];

        this.enemies = new Map();
    }

    setPlayer(player) {
        this.player = player;
    }

    _clear() {
        for (const enemy of this.enemies.values()) enemy.dispose();
        this.enemies.clear();
    }

    _tangentBasis(up) {
        let tangent = BABYLON.Vector3.Cross(up, new BABYLON.Vector3(0, 1, 0));
        if (tangent.lengthSquared() < 1e-4) {
            tangent = BABYLON.Vector3.Cross(up, new BABYLON.Vector3(1, 0, 0));
        }
        tangent.normalize();
        const bitangent = BABYLON.Vector3.Cross(tangent, up).normalize();
        return { tangent, bitangent };
    }

    _spawnPositionAroundPlayer() {
        const playerPos = this.player?.mesh?.position;
        if (!playerPos) return null;

        const playerRadius = playerPos.length();
        if (playerRadius < 1e-4) return null;

        const up = playerPos.clone().normalize();
        const { tangent, bitangent } = this._tangentBasis(up);
        const angle = Math.random() * Math.PI * 2;
        const offsetDir = tangent.scale(Math.cos(angle)).add(bitangent.scale(Math.sin(angle))).normalize();

        const angularOffset = Math.min(1, this.spawnRadius / playerRadius);
        const spawnDir = up.scale(Math.cos(angularOffset)).add(offsetDir.scale(Math.sin(angularOffset))).normalize();
        return spawnDir.scale(playerRadius);
    }

    _spawnEnemy(config) {
        const position = this._spawnPositionAroundPlayer();
        if (!position) return null;
        const enemyId = `${config.type}_${Date.now()}`;
        const enemy = new Enemy({
            scene: this.scene,
            terrain: this.terrain,
            planetRadius: this.planetRadius,
            position,
            id: enemyId,
            modelFile: config.model
        });
        if (this.groundGate) {
            this.groundGate.registerActor(enemy, { planetRadius: this.planetRadius });
        }
        this.enemies.set(config.type, enemy);
        return enemy;
    }

    _cleanupDisposed() {
        for (const [type, enemy] of this.enemies) {
            if (!enemy?.mesh || enemy.mesh.isDisposed()) {
                this.enemies.delete(type);
            }
        }
    }

    update(dtSeconds) {
        if (!this.enabled) return;
        if (!this.scene || !this.player?.mesh) return;

        this._cleanupDisposed();

        for (const config of this.enemyConfigs) {
            if (this.enemies.size >= this.maxEnemies) break;
            if (!this.enemies.has(config.type)) {
                this._spawnEnemy(config);
            }
        }

        for (const enemy of this.enemies.values()) {
            const safeDt = this.groundGate
                ? this.groundGate.consumeClampedDt(enemy, dtSeconds)
                : dtSeconds;
            enemy.update(safeDt, this.player, () => {
                if (this.playerStats?.applyDamage) {
                    this.playerStats.applyDamage(6 * dtSeconds);
                }
            });
        }
    }
}
