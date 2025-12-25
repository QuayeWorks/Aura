// src/multiplayer/NetModel.js
// Lightweight networking scaffold and local simulation.

/* global BABYLON */

class NetEventBus {
    constructor() {
        this.listeners = new Map();
    }

    on(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
        return () => this.listeners.get(type)?.delete(handler);
    }

    emit(type, payload) {
        const set = this.listeners.get(type);
        if (!set) return;
        for (const cb of set) cb(payload);
    }
}

class CarveLog {
    constructor() {
        this.seen = new Set();
    }

    has(playerId, seq) {
        return this.seen.has(`${playerId}|${seq}`);
    }

    add(playerId, seq) {
        this.seen.add(`${playerId}|${seq}`);
    }
}

export class NetSyncController {
    constructor({ terrain, saveSystem, localPlayerId = null }) {
        this.terrain = terrain;
        this.saveSystem = saveSystem;
        this.bus = new NetEventBus();
        this.carveLog = new CarveLog();
        this.pendingCarves = [];
        this.lastApply = 0;
        this.remotePlayers = new Map();
        this.localPlayerId = localPlayerId;
    }

    attachTo(bus) {
        if (!bus) return;
        bus.on("carve", (evt) => this._onRemoteCarve(evt));
        bus.on("playerState", (evt) => this._onPlayerState(evt));
        bus.on("ability", (evt) => this._onAbility(evt));
    }

    _onAbility(evt) {
        // Scaffold: abilities replicate but are not authoritative yet.
        this.remotePlayers.set(evt.playerId, {
            ...(this.remotePlayers.get(evt.playerId) || {}),
            lastAbility: evt
        });
    }

    _onPlayerState(evt) {
        const existing = this.remotePlayers.get(evt.playerId) || {};
        this.remotePlayers.set(evt.playerId, {
            ...existing,
            state: evt
        });
    }

    _onRemoteCarve(evt) {
        if (evt?.playerId && this.localPlayerId && evt.playerId === this.localPlayerId) return;
        if (!evt || this.carveLog.has(evt.playerId, evt.seq)) return;
        this.carveLog.add(evt.playerId, evt.seq);
        this.pendingCarves.push(evt);
    }

    update(dtSeconds) {
        if (!this.terrain) return;
        this.lastApply += dtSeconds;
        if (this.lastApply < 0.5) return;
        this.lastApply = 0;

        if (this.pendingCarves.length === 0) return;
        const batch = this.pendingCarves.splice(0, 4);
        const merged = [...(this.terrain.getCarveHistory?.() || []), ...batch.map((c) => ({
            position: c.position,
            radius: c.radius,
        }))];
        const filtered = this.saveSystem?.filterCarves?.(merged, {}) || merged;
        this.terrain.setCarveHistory(filtered);
    }

    getRemotePlayerCount() {
        return this.remotePlayers.size;
    }
}

export class LocalMultiplayerSim {
    constructor({ scene, terrain, player, planetRadius, eventBus }) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.planetRadius = planetRadius;
        this.eventBus = eventBus;
        this.enabled = false;
        this.ghosts = [];
        this.seq = 0;
    }

    setEnabled(isEnabled) {
        if (this.enabled === isEnabled) return;
        this.enabled = !!isEnabled;
        if (this.enabled) {
            this._spawnGhosts();
        } else {
            this._disposeGhosts();
        }
    }

    _spawnGhosts() {
        this._disposeGhosts();
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
            const dir = new BABYLON.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
            dir.normalize();
            const pos = dir.scale(this.planetRadius * 1.02);
            const mesh = BABYLON.MeshBuilder.CreateSphere(`ghost_${i}`, { diameter: 8 }, this.scene);
            mesh.position.copyFrom(pos);
            mesh.material = new BABYLON.StandardMaterial(`ghostMat_${i}`, this.scene);
            mesh.material.emissiveColor = new BABYLON.Color3(0.9, 0.4, 1.0);
            mesh.isPickable = false;
            this.ghosts.push({ mesh, dir, playerId: `ghost-${i}` });
        }
    }

    _disposeGhosts() {
        this.ghosts.forEach((g) => g.mesh?.dispose());
        this.ghosts = [];
    }

    update(dtSeconds) {
        if (!this.enabled) return;
        for (const ghost of this.ghosts) {
            const jitter = new BABYLON.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
            ghost.dir = ghost.dir.add(jitter).normalize();
            const pos = ghost.dir.scale(this.planetRadius * 1.02);
            ghost.mesh.position.copyFrom(pos);

            const velocity = ghost.dir.scale(2);
            this.eventBus?.emit("playerState", {
                playerId: ghost.playerId,
                position: pos,
                velocity,
                timestamp: performance.now(),
            });

            if (Math.random() < 0.02) {
                const carveRadius = 40 + Math.random() * 20;
                this.eventBus?.emit("carve", {
                    playerId: ghost.playerId,
                    seq: this.seq++,
                    position: { x: pos.x, y: pos.y, z: pos.z },
                    radius: carveRadius,
                    timestamp: performance.now(),
                });
            }
        }
    }
}

export { NetEventBus };
