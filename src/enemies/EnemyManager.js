/* global BABYLON */
import { Enemy } from "./Enemy.js";

function mulberry32(seed) {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

export class EnemyManager {
    constructor({ scene, terrain, player, planetRadius, playerStats, dayNightSystem, seed = 7 }) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.planetRadius = planetRadius;
        this.playerStats = playerStats;
        this.dayNightSystem = dayNightSystem;
        this.seed = seed;

        this.enabled = true;

        this.spawnDistance = planetRadius * 0.5;
        this.despawnDistance = planetRadius * 0.65;
        this.safePlayerRadius = planetRadius * 0.05;

        this.enemies = new Map();
        this.enemyChunk = new Map();
        this.chunkSpawned = new Set();

        window.addEventListener("keydown", (ev) => {
            if (ev.code === "F8") {
                this.enabled = !this.enabled;
                if (!this.enabled) this._clear();
                console.log(`Enemy system ${this.enabled ? "enabled" : "disabled"}`);
            }
            if (ev.code === "F9") {
                this.spawnTestEnemy();
            }
        });
    }

    setPlayer(player) {
        this.player = player;
    }

    _clear() {
        for (const enemy of this.enemies.values()) enemy.dispose();
        this.enemies.clear();
        this.enemyChunk.clear();
        this.chunkSpawned.clear();
    }

    _rngForChunk(chunkId) {
        const s = (this.seed ^ (chunkId * 7919)) >>> 0;
        return mulberry32(s);
    }

    _biomeForHeight(heightAboveSea) {
        const settings = this.terrain?.biomeSettings;
        if (!settings) return "grass";
        if (heightAboveSea < settings.seaLevelUnits + settings.beachWidthUnits) return "beach";
        if (heightAboveSea < settings.grassMaxUnits) return "grass";
        if (heightAboveSea < settings.rockFullUnits) return "rock";
        return "snow";
    }

    _timeOfDayFactor() {
        const t = this.dayNightSystem?.timeOfDay ?? 0.5;
        // 0.5 = noon, 0 or 1 = midnight
        const nightFactor = Math.abs(t - 0.5) * 2; // 0 at noon, 1 at midnight
        return nightFactor;
    }

    _projectToSurface(dir) {
        if (!this.scene || !this.terrain) return null;
        const up = dir.clone().normalize();
        const start = up.scale(this.planetRadius * 0.5);
        const ray = new BABYLON.Ray(start, up, this.planetRadius * 2.2);
        const pick = this.scene.pickWithRay(ray, (mesh) => !!(mesh?.metadata?.isTerrain));
        const distance = pick?.hit && pick.pickedPoint
            ? pick.pickedPoint.length()
            : this.planetRadius;
        const pos = up.scale(distance + this.planetRadius * 0.004);
        return { position: pos, up, heightAboveSea: distance - this.terrain.radius };
    }

    _spawnForChunk(node) {
        if (!node) return;
        const rng = this._rngForChunk(node.id);
        const plans = [];

        const baseCount = Math.floor(rng() * 2);
        const nightBonus = this._timeOfDayFactor() > 0.6 ? 1 : 0;
        const count = baseCount + nightBonus;

        for (let i = 0; i < count; i++) {
            const dir = new BABYLON.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
            if (dir.lengthSquared() < 1e-5) dir.copyFromFloats(0, 1, 0);
            dir.normalize();
            const surface = this._projectToSurface(dir);
            if (!surface) continue;

            const biome = this._biomeForHeight(surface.heightAboveSea);
            const typeBias = this._timeOfDayFactor();
            if (biome === "snow" && rng() < 0.5) continue;
            if (biome === "beach" && rng() > 0.6 + typeBias * 0.2) continue;

            plans.push(surface.position);
        }

        for (const pos of plans) {
            const enemyId = `${node.id}_${this.enemies.size}`;
            const enemy = new Enemy({ scene: this.scene, planetRadius: this.planetRadius, position: pos, id: enemyId });
            this.enemies.set(enemyId, enemy);
            this.enemyChunk.set(enemyId, node.id);
        }
    }

    spawnTestEnemy() {
        if (!this.player?.mesh) return;
        const dir = this.player.mesh.position.clone().normalize();
        const offsetDir = dir.add(new BABYLON.Vector3(0.2, 0.2, 0.2)).normalize();
        const pos = offsetDir.scale(this.planetRadius + this.planetRadius * 0.01);
        const enemyId = `manual_${Date.now()}`;
        const enemy = new Enemy({ scene: this.scene, planetRadius: this.planetRadius, position: pos, id: enemyId });
        this.enemies.set(enemyId, enemy);
        this.enemyChunk.set(enemyId, null);
    }

    _shouldDespawn(enemy) {
        if (!enemy?.mesh) return true;
        const playerPos = this.player?.mesh?.position;
        if (!playerPos) return false;
        const dist = BABYLON.Vector3.Distance(playerPos, enemy.mesh.position);
        return dist > this.despawnDistance;
    }

    update(dtSeconds) {
        if (!this.enabled) return;
        if (!this.terrain || !this.scene) return;

        const nodes = this.terrain.getVisibleNodes ? this.terrain.getVisibleNodes() : [];
        const visibleChunkIds = new Set(nodes.map((n) => n.id));
        const playerPos = this.player?.mesh?.position;

        // Despawn when far/hidden
        for (const [id, enemy] of this.enemies) {
            const chunkId = this.enemyChunk.get(id);
            const chunkInvisible = chunkId != null && !visibleChunkIds.has(chunkId);
            if (chunkInvisible || this._shouldDespawn(enemy)) {
                enemy.dispose();
                this.enemies.delete(id);
                this.enemyChunk.delete(id);
                if (chunkInvisible && chunkId != null) {
                    this.chunkSpawned.delete(chunkId);
                }
            }
        }

        // Spawn tied to visible chunks but not too close to player
        for (const node of nodes) {
            if (this.chunkSpawned.has(node.id)) continue;
            const center = node.center || BABYLON.Vector3.Zero();
            const distToPlayer = playerPos ? BABYLON.Vector3.Distance(center, playerPos) : Infinity;
            if (distToPlayer < this.safePlayerRadius || distToPlayer > this.spawnDistance) continue;
            this.chunkSpawned.add(node.id);
            this._spawnForChunk(node);
        }

        // Update existing enemies
        for (const enemy of this.enemies.values()) {
            enemy.update(dtSeconds, this.player, () => {
                if (this.playerStats?.applyDamage) {
                    this.playerStats.applyDamage(4 * dtSeconds);
                }
            });
        }
    }
}
