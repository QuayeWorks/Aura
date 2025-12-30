/* global BABYLON */

const DEFAULT_GRACE_SECONDS = 2;
const DEFAULT_CHECK_INTERVAL = 1;
const DEFAULT_MIN_RAY_LENGTH_METERS = 8000;
const DEFAULT_MAX_RAY_LENGTH_METERS = 20000;
const DEFAULT_RAY_OFFSET_METERS = 1;
const DEFAULT_CLAMP_GRACE_SECONDS = 2;
const DEFAULT_CLAMP_MAX_STEP_SECONDS = 1 / 120;
const DEFAULT_SURFACE_OFFSET_METERS = 2;
const MAX_CHECKS_PER_UPDATE = 6;

function terrainPredicate(mesh) {
    if (!mesh?.checkCollisions) return false;
    const meta = mesh.metadata || {};
    if (meta.isTerrainCollider || meta.isTerrain) return true;
    return mesh.name ? mesh.name.toLowerCase().startsWith("terrain") : false;
}

export function repositionActorRadially(actor, targetRadius, fallbackUp) {
    if (!actor) return;
    const pos = actor?.mesh?.position || actor.position;
    let up = pos ? pos.clone() : null;

    if (!up || up.lengthSquared() < 1e-6) {
        up = fallbackUp ? fallbackUp.clone() : null;
    }

    if (!up || up.lengthSquared() < 1e-6) {
        up = new BABYLON.Vector3(0, 1, 0);
    }

    up.normalize();
    const newPos = up.scale(targetRadius);

    if (actor.mesh?.position) {
        actor.mesh.position.copyFrom(newPos);
    }
    if (actor.position?.copyFrom) {
        actor.position.copyFrom(newPos);
    } else if (actor.position) {
        actor.position = newPos.clone();
    }

    if (actor.velocity?.set) {
        actor.velocity.set(0, 0, 0);
    }
}

export class GroundSpawnGate {
    constructor({ scene, terrain, player, planetRadius, unitsPerMeter = 1 } = {}) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.defaultPlanetRadius = planetRadius ?? terrain?.radius ?? 1;
        this.unitsPerMeter = unitsPerMeter;

        this.entries = new Map();
        this._checkCursor = 0;
    }

    registerActor(actor, { planetRadius } = {}) {
        if (!actor?.mesh) return;

        const entry = {
            actor,
            planetRadius: planetRadius ?? actor.planetRadius ?? this.defaultPlanetRadius,
            graceRemaining: DEFAULT_GRACE_SECONDS,
            timeSinceCheck: 0,
            clampRemaining: 0,
            maxClampDt: DEFAULT_CLAMP_MAX_STEP_SECONDS,
            released: false,
            surfaceOffset: this._computeSurfaceOffset(actor, planetRadius),
        };

        this.entries.set(actor, entry);
        this._freezeActor(actor);
    }

    update(dtSeconds) {
        if (dtSeconds <= 0 || this.entries.size === 0) return;

        const entriesArray = Array.from(this.entries.values());
        let checksRemaining = MAX_CHECKS_PER_UPDATE;
        let checksUsed = 0;
        const startIndex = entriesArray.length > 0
            ? this._checkCursor % entriesArray.length
            : 0;

        for (let i = 0; i < entriesArray.length; i++) {
            const entry = entriesArray[(startIndex + i) % entriesArray.length];
            const actor = entry?.actor;
            if (!actor?.mesh || actor.mesh.isDisposed()) {
                if (actor) this.entries.delete(actor);
                continue;
            }

            if (entry.released) {
                entry.clampRemaining = Math.max(0, entry.clampRemaining - dtSeconds);
                if (entry.clampRemaining <= 0) {
                    this.entries.delete(actor);
                }
                continue;
            }

            entry.timeSinceCheck += dtSeconds;

            // Keep actor frozen while waiting for ground
            this._freezeActor(entry.actor);

            if (entry.graceRemaining > 0) {
                entry.graceRemaining = Math.max(0, entry.graceRemaining - dtSeconds);
                continue;
            }

            if (entry.timeSinceCheck < DEFAULT_CHECK_INTERVAL) continue;
            if (checksRemaining <= 0) continue;

            entry.timeSinceCheck = 0;
            const groundHit = this._getGroundHit(entry);
            checksRemaining--;
            checksUsed++;
            if (groundHit) {
                this._placeOnGround(entry, groundHit);
                this._release(entry);
            }
        }

        if (this.entries.size > 0) {
            this._checkCursor = (startIndex + checksUsed) % this.entries.size;
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
        this._applyClamp(entry);
        this._unfreezeActor(entry.actor);
        entry.released = true;
    }

    _getRayLength(entry) {
        const planetRadius = entry.planetRadius ?? this.defaultPlanetRadius;
        const minLength = DEFAULT_MIN_RAY_LENGTH_METERS * this.unitsPerMeter;
        const maxLength = DEFAULT_MAX_RAY_LENGTH_METERS * this.unitsPerMeter;
        const quarterRadius = planetRadius * 0.25;
        return Math.min(maxLength, Math.max(minLength, quarterRadius));
    }

    _computeSurfaceOffset(actor, planetRadius) {
        const pos = actor?.mesh?.position;
        const currentRadius = pos?.length ? pos.length() : 0;
        const baseOffset = Math.max(0, currentRadius - (planetRadius ?? this.defaultPlanetRadius));
        return Math.max(DEFAULT_SURFACE_OFFSET_METERS * this.unitsPerMeter, baseOffset);
    }

    _getGroundHit(entry) {
        const pos = entry.actor?.mesh?.position;
        if (!pos || !this.scene) return null;

        let up = pos.clone();
        if (up.lengthSquared() < 1e-6) {
            up = this.player?.mesh?.position?.clone();
        }
        if (!up || up.lengthSquared() < 1e-6) return null;
        up.normalize();

        const offset = up.scale(DEFAULT_RAY_OFFSET_METERS * this.unitsPerMeter);
        const origin = pos.add(offset);
        const rayLength = this._getRayLength(entry);
        const ray = new BABYLON.Ray(origin, up.scale(-1), rayLength);

        const pick = this.scene.pickWithRay(ray, terrainPredicate);
        if (pick?.hit && pick.distance <= rayLength + 1e-3) {
            return { hitPoint: pick.pickedPoint ?? pick.hitPoint, distance: pick.distance, up };
        }
        return null;
    }

    _placeOnGround(entry, groundHit) {
        const actor = entry.actor;
        if (!actor?.mesh || !groundHit?.hitPoint) return;

        let up = groundHit.up?.clone?.() ?? actor.mesh.position?.clone?.();
        if (up && up.lengthSquared() > 0) {
            up.normalize();
        } else {
            const fallbackUp = this.player?.mesh?.position?.clone?.();
            if (fallbackUp && fallbackUp.lengthSquared() > 0) {
                up = fallbackUp.normalize();
            } else {
                up = new BABYLON.Vector3(0, 1, 0);
            }
        }

        const surfaceOffset = entry.surfaceOffset ?? DEFAULT_SURFACE_OFFSET_METERS * this.unitsPerMeter;
        const target = groundHit.hitPoint.add(up.scale(surfaceOffset));
        actor.mesh.position.copyFrom(target);
        if (actor.position?.copyFrom) {
            actor.position.copyFrom(target);
        }
        if (actor.velocity?.set) {
            actor.velocity.set(0, 0, 0);
        }
    }
}
