/* global BABYLON */
// Chunk-aware point-of-interest manager. Spawns lightweight placeholder meshes
// near visible chunks without blocking terrain streaming.

function mulberry32(seed) {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function pickRandom(arr, rng) {
    if (!arr || arr.length === 0) return null;
    const idx = Math.floor(rng() * arr.length);
    return arr[idx];
}

export class POIManager {
    constructor({ scene, terrain, player, seed = 1, planetRadius = 1, onSpawn = null, onDespawn = null }) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.seed = seed;
        this.planetRadius = planetRadius;

        this.enabled = true;
        this.showDebug = true;

        this.spawnDistance = this.planetRadius * 0.55;
        this.despawnDistance = this.spawnDistance * 1.25;
        this.maxPerChunk = 2;

        this.plannedByChunk = new Map();
        this.spawnedPOIs = new Map();

        this.onSpawn = onSpawn;
        this.onDespawn = onDespawn;

        window.addEventListener("keydown", (ev) => {
            if (ev.code === "F7") {
                this.showDebug = !this.showDebug;
                this._applyVisibility();
                console.log(`POIs ${this.showDebug ? "shown" : "hidden"} (count ${this.spawnedPOIs.size})`);
            }
        });
    }

    setPlayer(player) {
        this.player = player;
    }

    _rngForChunk(chunkId) {
        const seed = (this.seed ^ (chunkId * 9973)) >>> 0;
        return mulberry32(seed);
    }

    _ensurePlansForChunk(node) {
        if (!node || this.plannedByChunk.has(node.id)) return;
        const rng = this._rngForChunk(node.id);
        const plan = [];

        const count = Math.floor(rng() * (this.maxPerChunk + 1));
        for (let i = 0; i < count; i++) {
            const dir = new BABYLON.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
            if (dir.lengthSquared() < 1e-5) {
                dir.copyFromFloats(0, 1, 0);
            }
            dir.normalize();

            const surface = this._projectToSurface(dir);
            if (!surface) continue;

            const biome = this._biomeForHeight(surface.heightAboveSea);
            const type = this._pickTypeForBiome(biome, rng);
            if (!type) continue;

            const poiId = `${node.id}_${i}`;
            plan.push({ id: poiId, type, position: surface.position, up: surface.up });
        }

        this.plannedByChunk.set(node.id, plan);
    }

    _projectToSurface(dir) {
        if (!this.scene || !this.terrain) return null;
        const up = dir.clone().normalize();
        const start = up.scale(this.planetRadius * 0.5);
        const rayLen = this.planetRadius * 2.2;

        const ray = new BABYLON.Ray(start, up, rayLen);
        const pick = this.scene.pickWithRay(ray, (mesh) => !!(mesh?.metadata?.isTerrain));

        const distance = pick?.hit && pick.pickedPoint
            ? pick.pickedPoint.length()
            : this.planetRadius;

        const offset = 12;
        const targetPos = up.scale(distance + offset);
        return { position: targetPos, up, heightAboveSea: distance - this.terrain.radius };
    }

    _biomeForHeight(heightAboveSea) {
        const settings = this.terrain?.biomeSettings;
        if (!settings) return "grass";

        if (heightAboveSea < settings.seaLevelUnits + settings.beachWidthUnits) return "beach";
        if (heightAboveSea < settings.grassMaxUnits) return "grass";
        if (heightAboveSea < settings.rockFullUnits) return "rock";
        return "snow";
    }

    _pickTypeForBiome(biome, rng) {
        const table = {
            beach: ["wreck", "camp"],
            grass: ["shrine", "ruins", "settlement"],
            rock: ["cave", "stone-ring"],
            snow: ["altar", "monolith"],
        };

        // Bias settlements to be rare and only in grass bands.
        const candidates = table[biome] || [];
        if (biome === "grass" && rng() > 0.55) {
            return "settlement";
        }
        return pickRandom(candidates, rng);
    }

    _buildMesh(desc) {
        const material = new BABYLON.StandardMaterial(`poiMat_${desc.id}`, this.scene);
        material.diffuseColor = new BABYLON.Color3(0.2, 0.5, 0.9);
        material.emissiveColor = new BABYLON.Color3(0.1, 0.3, 0.8);

        let mesh;
        if (desc.type === "stone-ring" || desc.type === "cave") {
            mesh = BABYLON.MeshBuilder.CreateTorus(desc.id, {
                diameter: this.planetRadius * 0.02,
                thickness: this.planetRadius * 0.003
            }, this.scene);
        } else if (desc.type === "altar" || desc.type === "monolith") {
            mesh = BABYLON.MeshBuilder.CreateBox(desc.id, {
                width: this.planetRadius * 0.01,
                height: this.planetRadius * 0.02,
                depth: this.planetRadius * 0.01
            }, this.scene);
        } else {
            mesh = BABYLON.MeshBuilder.CreateCylinder(desc.id, {
                height: this.planetRadius * 0.02,
                diameter: this.planetRadius * 0.01
            }, this.scene);
        }

        mesh.material = material;
        mesh.isPickable = false;

        const up = desc.up.clone().normalize();
        const forward = BABYLON.Vector3.Cross(up, new BABYLON.Vector3(0, 1, 0));
        if (forward.lengthSquared() < 1e-4) {
            forward.copyFromFloats(1, 0, 0);
        }
        forward.normalize();
        const right = BABYLON.Vector3.Cross(forward, up).normalize();

        mesh.position.copyFrom(desc.position);

        const rotationMatrix = BABYLON.Matrix.Identity();
        BABYLON.Matrix.FromXYZAxesToRef(right, up, forward, rotationMatrix);
        mesh.rotationQuaternion = BABYLON.Quaternion.FromRotationMatrix(rotationMatrix);
        return mesh;
    }

    _applyVisibility() {
        for (const [, entry] of this.spawnedPOIs) {
            if (entry.mesh) {
                entry.mesh.setEnabled(this.showDebug);
            }
        }
    }

    _spawnIfNeeded(node) {
        this._ensurePlansForChunk(node);
        const plans = this.plannedByChunk.get(node.id) || [];
        for (const plan of plans) {
            if (this.spawnedPOIs.has(plan.id)) continue;
            const mesh = this._buildMesh(plan);
            this.spawnedPOIs.set(plan.id, { mesh, chunkId: node.id, plan });
            if (!this.showDebug) mesh.setEnabled(false);
            if (typeof this.onSpawn === "function") {
                this.onSpawn(plan, mesh);
            }
        }
    }

    update() {
        if (!this.enabled || !this.terrain || !this.scene) return;

        const nodes = this.terrain.getVisibleNodes ? this.terrain.getVisibleNodes() : [];
        const visibleChunkIds = new Set(nodes.map((n) => n.id));

        const playerPos = this.player?.mesh?.position;

        // Despawn first to keep counts small
        for (const [id, entry] of this.spawnedPOIs) {
            const chunkVisible = visibleChunkIds.has(entry.chunkId);
            const distOk = playerPos
                ? BABYLON.Vector3.Distance(entry.mesh.position, playerPos) <= this.despawnDistance
                : true;
            if (!chunkVisible || !distOk) {
                if (typeof this.onDespawn === "function") {
                    this.onDespawn(id, entry.plan);
                }
                entry.mesh?.dispose();
                this.spawnedPOIs.delete(id);
            }
        }

        // Spawn new POIs for visible chunks within range
        for (const node of nodes) {
            const center = node.center || new BABYLON.Vector3(0, 0, 0);
            const distToPlayer = playerPos ? BABYLON.Vector3.Distance(center, playerPos) : 0;
            if (playerPos && distToPlayer > this.spawnDistance) continue;
            this._spawnIfNeeded(node);
        }
    }
}
