/* global BABYLON */
import { DebugSettings } from "../systems/DebugSettings.js";

const DEFAULT_GRACE_SECONDS = 2;
const DEFAULT_CHECK_INTERVAL = 1;
const DEFAULT_CLAMP_GRACE_SECONDS = 2;
const DEFAULT_CLAMP_MAX_STEP_SECONDS = 1 / 120;
const DEFAULT_MAX_CHECKS_PER_TICK = 3;

let lastLogMs = 0;

const logOnce = (() => {
    const seen = new Set();
    return (key, ...args) => {
        if (!DebugSettings.getFlag("verboseStreamingLogs")) return;
        if (seen.has(key)) return;
        seen.add(key);
        console.log(...args);
    };
})();

function log1Hz(...args) {
    if (!DebugSettings.getFlag("verboseStreamingLogs")) return;
    const now = performance.now();
    if (now - lastLogMs < 1000) return;
    lastLogMs = now;
    console.log(...args);
}

function getActorPosition(actor) {
    return actor?.mesh?.position || actor?.position || null;
}

function resolveUpVector(actor, fallbackUp) {
    let up = getActorPosition(actor)?.clone?.() ?? null;
    if (!up || up.lengthSquared() < 1e-6) {
        up = fallbackUp?.clone?.() ?? null;
    }
    if (!up || up.lengthSquared() < 1e-6) {
        up = new BABYLON.Vector3(0, 1, 0);
    }
    up.normalize();
    return up;
}

function applyActorPosition(actor, newPos) {
    if (!newPos || !actor) return;
    if (actor.mesh?.position) {
        actor.mesh.position.copyFrom(newPos);
    }
    if (actor.position?.copyFrom) {
        actor.position.copyFrom(newPos);
    } else if (actor.position) {
        actor.position = newPos.clone();
    }
}

function resetActorVelocity(actor) {
    if (actor?.velocity?.set) {
        actor.velocity.set(0, 0, 0);
    }
}

function getPlacementMeshes(terrain, scene) {
    let meshes = [];
    if (terrain && typeof terrain.getKnownCollisionMeshes === "function") {
        meshes = terrain.getKnownCollisionMeshes();
    } else if (terrain && typeof terrain.getCollisionMeshes === "function") {
        meshes = terrain.getCollisionMeshes();
    }

    if (!meshes || meshes.length === 0) {
        const scanScene = scene ?? terrain?.scene;
        if (scanScene?.meshes) {
            meshes = scanScene.meshes.filter((mesh) =>
                mesh
                && !mesh.isDisposed?.()
                && mesh.checkCollisions === true
            );
        }
    }

    return meshes;
}

function findTerrainHit(ray, terrain, scene) {
    const meshes = getPlacementMeshes(terrain, scene);
    const terrainId = terrain?._debugId ?? "unknown";
    const hasActiveMeshes = Array.isArray(meshes) && meshes.length > 0;
    if (Array.isArray(meshes) && meshes.length > 0) {
        logOnce(
            `ground-spawn-collision-meshes-${terrainId}`,
            "[GroundSpawnGate] Collision meshes:",
            meshes.map((mesh) => ({
                name: mesh?.name,
                checkCollisions: mesh?.checkCollisions,
                enabled: mesh?.isEnabled?.()
            }))
        );
    }
    if (!hasActiveMeshes) return null;

    let bestHit = null;
    let testedMeshes = 0;
    for (const mesh of meshes) {
        if (!mesh || !mesh.checkCollisions) continue;
        testedMeshes += 1;
        const hit = ray.intersectsMesh(mesh, true);
        if (!hit?.hit) continue;

        if (!bestHit || hit.distance < bestHit.distance) {
            bestHit = hit;
        }
    }

    logOnce(
        `ground-spawn-mesh-tests-${terrainId}-${!!bestHit}`,
        "[GroundSpawnGate] Placement terrain mesh tests:",
        testedMeshes,
        "closest hit found:",
        !!bestHit
    );
    if (!bestHit) return null;
    const pickedPoint = bestHit.pickedPoint
        ?? ray.origin.add(ray.direction.scale(bestHit.distance));
    return {
        ...bestHit,
        pickedPoint,
        hit: true
    };
}

export function repositionActorRadially(actor, targetRadius, fallbackUp) {
    if (!actor) return;
    const up = resolveUpVector(actor, fallbackUp);
    const newPos = up.scale(targetRadius);
    applyActorPosition(actor, newPos);
    resetActorVelocity(actor);
}

export function placeActorOnTerrainSurface(actor, terrain, options = {}) {
    if (!actor || !terrain) return false;

    const planetRadius = options.planetRadius ?? terrain?.radius ?? actor.planetRadius ?? 1;
    const spawnOffset = options.spawnOffset
        ?? actor.surfaceOffset
        ?? (actor.capsuleRadius ? actor.capsuleRadius * 1.5 : null)
        ?? actor.radius
        ?? 1;
    const probeStartAbove = options.probeStartAbove ?? 5;
    const maxRayDistance = options.maxRayDistance ?? Math.max(planetRadius * 3, 200000);

    const up = resolveUpVector(actor, options.fallbackUp);
    const origin = getActorPosition(actor);
    if (!origin) return false;

    const rayOrigin = origin.add(up.scale(probeStartAbove));
    const ray = new BABYLON.Ray(rayOrigin, up.scale(-1), maxRayDistance);

    const hit = findTerrainHit(ray, terrain, terrain?.scene);
    if (hit?.hit && hit.pickedPoint) {
        const target = hit.pickedPoint.add(up.scale(spawnOffset));
        applyActorPosition(actor, target);
        resetActorVelocity(actor);
        return true;
    }

    return false;
}

export function raiseActorToSafeAltitude(actor, {
    planetRadius,
    unitsPerMeter = 1,
    fallbackUp,
    safeAltitudeMeters = 4000
} = {}) {
    const safeUnits = safeAltitudeMeters * unitsPerMeter;
    const targetRadius = (planetRadius ?? actor?.planetRadius ?? 1) + safeUnits;
    repositionActorRadially(actor, targetRadius, fallbackUp);
}

export class GroundSpawnGate {
    constructor({ scene, terrain, player, planetRadius, unitsPerMeter = 1 } = {}) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.defaultPlanetRadius = planetRadius ?? terrain?.radius ?? 1;
        this.unitsPerMeter = unitsPerMeter;

        this.entries = new Map();
        logOnce(
            `ground-spawn-terrain-ref-${terrain?._debugId ?? "unknown"}`,
            "[GroundSpawnGate] terrain ref",
            terrain,
            "id",
            terrain?._debugId
        );
    }

    getCollisionMeshCount() {
        if (!this.terrain) return 0;
        if (this.terrain.getKnownCollisionMeshes) {
            return this.terrain.getKnownCollisionMeshes().length;
        }
        if (this.terrain.getCollisionMeshes) {
            return this.terrain.getCollisionMeshes().length;
        }
        return 0;
    }

    registerActor(actor, { planetRadius, fallbackUp, safeAltitudeMeters } = {}) {
        if (!actor?.mesh) return;

        const entry = {
            actor,
            planetRadius: planetRadius ?? actor.planetRadius ?? this.defaultPlanetRadius,
            elapsed: 0,
            graceRemaining: DEFAULT_GRACE_SECONDS,
            timeSinceCheck: 0,
            released: false,
            clampRemaining: 0,
            maxClampDt: DEFAULT_CLAMP_MAX_STEP_SECONDS,
            fallbackUp
        };

        this.entries.set(actor, entry);
        raiseActorToSafeAltitude(actor, {
            planetRadius: entry.planetRadius,
            unitsPerMeter: this.unitsPerMeter,
            fallbackUp,
            safeAltitudeMeters
        });
        this._freezeActor(actor);
    }

    update(dtSeconds) {
        if (dtSeconds <= 0 || this.entries.size === 0) return;

        let checksRemaining = DEFAULT_MAX_CHECKS_PER_TICK;
        for (const [actor, entry] of this.entries) {
            if (!entry?.actor?.mesh || entry.actor.mesh.isDisposed()) {
                this.entries.delete(actor);
                continue;
            }

            if (entry.released) {
                entry.clampRemaining = Math.max(0, entry.clampRemaining - dtSeconds);
                if (entry.clampRemaining <= 0) {
                    this.entries.delete(actor);
                }
                continue;
            }

            entry.elapsed += dtSeconds;
            entry.timeSinceCheck += dtSeconds;

            // Keep actor frozen while waiting for ground
            this._freezeActor(entry.actor);

            if (entry.graceRemaining > 0) {
                entry.graceRemaining = Math.max(0, entry.graceRemaining - dtSeconds);
                continue;
            }

            if (entry.timeSinceCheck < DEFAULT_CHECK_INTERVAL) continue;
            entry.timeSinceCheck = 0;

            if (checksRemaining <= 0) continue;
            checksRemaining -= 1;

            if (this._tryPlace(entry)) {
                this._release(entry);
            }
        }
    }

    consumeClampedDt(actor, dtSeconds) {
        if (dtSeconds <= 0) return dtSeconds;
        const entry = this.entries.get(actor);
        if (!entry || entry.clampRemaining <= 0) return dtSeconds;
        return Math.min(dtSeconds, entry.maxClampDt ?? dtSeconds);
    }

    _freezeActor(actor) {
        if (actor.setFrozen) actor.setFrozen(true);
        if (actor.velocity?.set) actor.velocity.set(0, 0, 0);
    }

    _unfreezeActor(actor) {
        if (actor.setFrozen) actor.setFrozen(false);
    }

    _applyClamp(entry, clampDuration = DEFAULT_CLAMP_GRACE_SECONDS) {
        entry.clampRemaining = clampDuration;
        entry.maxClampDt = DEFAULT_CLAMP_MAX_STEP_SECONDS;
        if (entry.actor?.applyGroundGateClamp) {
            entry.actor.applyGroundGateClamp(clampDuration, entry.maxClampDt);
        }
        if (entry.actor?.velocity?.set) {
            entry.actor.velocity.set(0, 0, 0);
        }
    }

    _release(entry) {
        this._unfreezeActor(entry.actor);
        this.entries.delete(entry.actor);
    }

    _tryPlace(entry) {
        const pos = entry.actor?.mesh?.position;
        if (!pos || !this.terrain) return false;

        const meshes = this._getPlacementMeshes();
        const active = meshes.length > 0;
        log1Hz(
            "[GroundSpawnGate] Placement terrain meshes active:",
            active,
            "count:",
            meshes.length
        );

        const fallbackUp = this.player?.mesh?.position?.clone?.() ?? entry.fallbackUp;
        const placed = placeActorOnTerrainSurface(entry.actor, this.terrain, {
            planetRadius: entry.planetRadius ?? this.defaultPlanetRadius,
            spawnOffset: entry.actor?.surfaceOffset ?? 2,
            probeStartAbove: 5 * this.unitsPerMeter,
            maxRayDistance: Math.max((entry.planetRadius ?? this.defaultPlanetRadius) * 3, 200000),
            fallbackUp
        });
        if (placed) {
            this._applyClamp(entry);
        }
        return placed;
    }

    _getPlacementMeshes() {
        return getPlacementMeshes(this.terrain, this.scene);
    }
}
