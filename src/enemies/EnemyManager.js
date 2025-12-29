/* global BABYLON */
import { Enemy } from "./Enemy.js";

export class EnemyManager {
    constructor({ scene, terrain, player, planetRadius, playerStats, dayNightSystem, spawnRadius = 10, maxEnemies = 2 }) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.planetRadius = planetRadius ?? 1;
        this.playerStats = playerStats;
        this.dayNightSystem = dayNightSystem;

        this.enabled = true;

        this.spawnRadius = spawnRadius;
        this.maxEnemies = maxEnemies;
        this.enemyConfigs = [
            { type: "male", model: "Male_doll.glb" },
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

        const up = playerPos.clone().normalize();
        const { tangent, bitangent } = this._tangentBasis(up);
        const angle = Math.random() * Math.PI * 2;
        const offsetDir = tangent.scale(Math.cos(angle)).add(bitangent.scale(Math.sin(angle))).normalize();
        const baseRadius = Math.max(playerPos.length(), this.planetRadius);
        const rawPos = playerPos.add(offsetDir.scale(this.spawnRadius));
        const projected = rawPos.normalize().scale(baseRadius + 2);
        return projected;
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
            enemy.update(dtSeconds, this.player, () => {
                if (this.playerStats?.applyDamage) {
                    this.playerStats.applyDamage(6 * dtSeconds);
                }
            });
        }
    }
}
