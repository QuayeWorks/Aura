/* global BABYLON */
// Gameplay-aware carving controller that factors stats, abilities, nen costs,
// and overuse penalties. Exposes a simple API for the main loop and input layer.

export class CarveController {
    constructor({ terrain, playerStats, abilities, hud, baseRadius = 70, baseNenCost = 12 } = {}) {
        this.terrain = terrain;
        this.playerStats = playerStats;
        this.abilities = abilities;
        this.hud = hud;

        this.enabled = true;

        this.baseRadius = baseRadius;
        this.baseNenCost = baseNenCost;
        this.costPerRadius = 0.08;

        this.heat = 0;
        this.heatThreshold = 100;
        this.heatLockoutThreshold = 150;
        this.heatPerCarve = 35;
        this.heatDecayPerSecond = 28;
        this.lockoutDuration = 3.2;
        this.lockoutRemaining = 0;

        this.pendingPulses = [];
        this.pulseCooldown = 0;
        this.pulseInterval = 0.25;
    }

    _computeRadius(requestedRadius) {
        const derived = this.playerStats?.getDerived?.() || {};
        const mods = this.abilities?.getMovementModifiers?.() || {};

        const base = requestedRadius && requestedRadius > 0
            ? requestedRadius
            : this.baseRadius;

        return base * (derived.carveRadiusMultiplier || 1) * (mods.carveRadiusMultiplier || 1);
    }

    _computeCost(radius) {
        const derived = this.playerStats?.getDerived?.() || {};
        const mods = this.abilities?.getMovementModifiers?.() || {};

        const baseCost = this.baseNenCost;
        const scaledCost = baseCost + this.costPerRadius * radius;

        // Heat increases cost slightly before a full lockout kicks in
        const heatOver = Math.max(0, this.heat - this.heatThreshold);
        const heatMultiplier = 1 + (heatOver / this.heatThreshold) * 0.5;

        return scaledCost
            * (derived.carveCostMultiplier || 1)
            * (mods.carveCostMultiplier || 1)
            * heatMultiplier;
    }

    _queuePulse(position, radius) {
        this.pendingPulses.push({ position, radius, delay: this.pulseInterval });
    }

    canCarve(requestedRadius) {
        if (!this.enabled) return { can: false, reason: "disabled" };
        if (this.lockoutRemaining > 0) {
            return { can: false, reason: "lockout" };
        }

        const radius = this._computeRadius(requestedRadius);
        const cost = this._computeCost(radius);

        if (this.playerStats?.nen != null && this.playerStats.nen < cost) {
            return { can: false, reason: "nen" };
        }

        return { can: true, reason: "ok", radius, cost };
    }

    tryCarve(worldPos, requestedRadius) {
        if (!worldPos || !this.terrain) {
            return { success: false, reason: "no-terrain" };
        }

        const check = this.canCarve(requestedRadius);
        if (!check.can) {
            if (check.reason === "nen") {
                this.hud?.flashNenBar?.();
            }
            return { success: false, reason: check.reason };
        }

        const radius = check.radius;
        const cost = check.cost;

        if (this.playerStats && !this.playerStats.spendNen(cost)) {
            this.hud?.flashNenBar?.();
            return { success: false, reason: "nen" };
        }

        // Execute the primary carve immediately.
        this.terrain.carveSphere(worldPos, radius);

        // Pulse carve when the carve ability is active.
        const carveAbilityActive = !!this.abilities?.abilityCarve?.active;
        const extraPulses = carveAbilityActive ? 2 : 0;
        for (let i = 0; i < extraPulses; i++) {
            this._queuePulse(worldPos.clone(), radius * 0.9);
        }

        this._applyHeat(radius);

        return { success: true, reason: "ok", radius, cost };
    }

    _applyHeat(radius) {
        this.heat += this.heatPerCarve + radius * 0.15;
        if (this.heat >= this.heatLockoutThreshold) {
            this.lockoutRemaining = this.lockoutDuration;
        }
    }

    getHeat() {
        return { value: this.heat, threshold: this.heatThreshold, lockoutRemaining: this.lockoutRemaining };
    }

    update(dtSeconds) {
        if (dtSeconds <= 0) return;

        if (this.lockoutRemaining > 0) {
            this.lockoutRemaining = Math.max(0, this.lockoutRemaining - dtSeconds);
        }

        // Heat naturally decays over time.
        if (this.heat > 0) {
            this.heat = Math.max(0, this.heat - this.heatDecayPerSecond * dtSeconds);
        }

        if (!this.enabled) {
            this.pendingPulses.length = 0;
            return;
        }

        // Process any queued pulses, spreading them out to avoid spikes.
        if (this.pendingPulses.length > 0) {
            this.pulseCooldown -= dtSeconds;
            if (this.pulseCooldown <= 0) {
                const pulse = this.pendingPulses.shift();
                if (pulse) {
                    this.terrain.carveSphere(pulse.position, pulse.radius);
                }
                this.pulseCooldown = this.pulseInterval;
            }
        } else {
            this.pulseCooldown = Math.max(0, this.pulseCooldown - dtSeconds);
        }
    }
}
