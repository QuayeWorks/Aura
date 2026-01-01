/* global BABYLON */

const DEFAULT_GRACE_SECONDS = 2;
const DEFAULT_REPOSITION_SECONDS = 40;
const DEFAULT_FORCE_RELEASE_SECONDS = 45;
const DEFAULT_CHECK_INTERVAL = 1;
const DEFAULT_RAY_LENGTH_METERS = 10;
const DEFAULT_RAY_OFFSET_METERS = 1;
const DEFAULT_FALLBACK_ALTITUDE_METERS = 100;
const DEFAULT_CLAMP_GRACE_SECONDS = 2;
const DEFAULT_CLAMP_MAX_STEP_SECONDS = 1 / 120;
const DEFAULT_SAFE_ALTITUDE_METERS = 3240;

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

export function raiseActorToSafeAltitude(actor, {
    planetRadius,
    unitsPerMeter = 1,
    fallbackUp
} = {}) {
    const targetRadius = (planetRadius ?? actor?.planetRadius ?? 1)
        + DEFAULT_SAFE_ALTITUDE_METERS * unitsPerMeter;
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
    }

    registerActor(actor, { planetRadius } = {}) {
        if (!actor?.mesh) return;

        const entry = {
            actor,
            planetRadius: planetRadius ?? actor.planetRadius ?? this.defaultPlanetRadius,
            elapsed: 0,
            graceRemaining: DEFAULT_GRACE_SECONDS,
            timeSinceCheck: 0,
            repositioned: false,
            released: false,
            clampRemaining: 0,
            maxClampDt: DEFAULT_CLAMP_MAX_STEP_SECONDS,
        };

        this.entries.set(actor, entry);
        this._freezeActor(actor);
    }

    update(dtSeconds) {
        if (dtSeconds <= 0 || this.entries.size === 0) return;

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

            if (!entry.repositioned && entry.elapsed >= DEFAULT_REPOSITION_SECONDS) {
                this._repositionHigh(entry);
                entry.repositioned = true;
            }

            if (entry.elapsed >= DEFAULT_FORCE_RELEASE_SECONDS) {
                this._forceRelease(entry);
                continue;
            }

            if (entry.graceRemaining > 0) {
                entry.graceRemaining = Math.max(0, entry.graceRemaining - dtSeconds);
                continue;
            }

            if (entry.timeSinceCheck < DEFAULT_CHECK_INTERVAL) continue;
            entry.timeSinceCheck = 0;

            if (this._hasGround(entry)) {
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

    _repositionHigh(entry) {
        const planetRadius = entry.planetRadius ?? this.defaultPlanetRadius;
        const targetRadius = planetRadius + DEFAULT_FALLBACK_ALTITUDE_METERS * this.unitsPerMeter;
        const fallbackUp = this.player?.mesh?.position;
        repositionActorRadially(entry.actor, targetRadius, fallbackUp);
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

    _forceRelease(entry) {
        entry.released = true;
        this._applyClamp(entry);
        this._unfreezeActor(entry.actor);
    }

    _hasGround(entry) {
        const pos = entry.actor?.mesh?.position;
        if (!pos || !this.scene) return false;

        let up = pos.clone();
        if (up.lengthSquared() < 1e-6) {
            up = this.player?.mesh?.position?.clone();
        }
        if (!up || up.lengthSquared() < 1e-6) return false;
        up.normalize();

        const offset = up.scale(DEFAULT_RAY_OFFSET_METERS * this.unitsPerMeter);
        const origin = pos.add(offset);
        const ray = new BABYLON.Ray(
            origin,
            up.scale(-1),
            DEFAULT_RAY_LENGTH_METERS * this.unitsPerMeter
        );

        const pick = this.scene.pickWithRay(ray, terrainPredicate);
        return !!(pick?.hit && pick.distance <= DEFAULT_RAY_LENGTH_METERS * this.unitsPerMeter + 1e-3);
    }
}
