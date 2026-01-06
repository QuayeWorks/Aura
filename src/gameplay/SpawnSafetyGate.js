/* global BABYLON */

const SAFE_ALTITUDE_METERS = 4000;
const RELEASE_DELAY_SECONDS = 60;

function resolvePosition(actor) {
    return actor?.mesh?.position || actor?.position || null;
}

function resolveUpVector(actor, fallbackUp) {
    let up = resolvePosition(actor)?.clone?.() ?? null;
    if (!up || up.lengthSquared() < 1e-6) {
        up = fallbackUp?.clone?.() ?? null;
    }
    if (!up || up.lengthSquared() < 1e-6) {
        up = new BABYLON.Vector3(0, 1, 0);
    }
    up.normalize();
    return up;
}

function applyPosition(actor, newPos) {
    if (!newPos) return;
    if (actor?.mesh?.position) {
        actor.mesh.position.copyFrom(newPos);
    }
    if (actor?.position?.copyFrom) {
        actor.position.copyFrom(newPos);
    } else if (actor && actor.position) {
        actor.position = newPos.clone();
    }
}

function resetVelocity(actor) {
    if (actor?.velocity?.set) {
        actor.velocity.set(0, 0, 0);
    }
}

function setActorActive(actor, isActive) {
    if (!actor) return;
    if (actor.hasOwnProperty("isActive")) {
        actor.isActive = !!isActive;
    }
    if (actor.setInputEnabled) {
        actor.setInputEnabled(!!isActive);
    }
}

export class SpawnSafetyGate {
    constructor({ planetRadius = 1, unitsPerMeter = 1, getGameState, onPlayerReady } = {}) {
        this.defaultPlanetRadius = planetRadius;
        this.unitsPerMeter = unitsPerMeter;
        this.entries = new Map();
        this.getGameState = getGameState;
        this.onPlayerReady = onPlayerReady;
    }

    registerActor(actor, { type = "npc", planetRadius, fallbackUp } = {}) {
        if (!actor) return;
        const entry = {
            actor,
            type,
            planetRadius: planetRadius ?? actor.planetRadius ?? this.defaultPlanetRadius,
            elapsed: 0,
            released: false,
            fallbackUp,
        };
        this.entries.set(actor, entry);
        this._liftToSafeAltitude(entry);
        setActorActive(actor, false);
        resetVelocity(actor);
    }

    update(dtSeconds) {
        if (dtSeconds <= 0 || this.entries.size === 0) return;
        const gameState = this.getGameState ? this.getGameState() : null;
        for (const entry of this.entries.values()) {
            if (entry.released) continue;
            entry.elapsed += dtSeconds;

            if (entry.elapsed >= RELEASE_DELAY_SECONDS) {
                if (entry.type === "player" && this.onPlayerReady) {
                    this.onPlayerReady();
                }
                if (!gameState || gameState === "PLAYING" || entry.type === "player") {
                    this._release(entry);
                }
            }
        }
    }

    forceRelease(actor) {
        const entry = this.entries.get(actor);
        if (!entry) return;
        this._release(entry);
    }

    _liftToSafeAltitude(entry) {
        const actor = entry.actor;
        const up = resolveUpVector(actor, entry.fallbackUp);
        const safeUnits = SAFE_ALTITUDE_METERS * this.unitsPerMeter;
        const targetRadius = (entry.planetRadius ?? this.defaultPlanetRadius) + safeUnits;
        const newPos = up.scale(targetRadius);
        applyPosition(actor, newPos);
        resetVelocity(actor);
    }

    _release(entry) {
        setActorActive(entry.actor, true);
        resetVelocity(entry.actor);
        entry.released = true;
        this.entries.delete(entry.actor);
    }
}

export function repositionActorRadially(actor, targetRadius, fallbackUp) {
    if (!actor) return;
    const up = resolveUpVector(actor, fallbackUp);
    const newPos = up.scale(targetRadius);
    applyPosition(actor, newPos);
    resetVelocity(actor);
}
