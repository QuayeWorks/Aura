// src/gameplay/Abilities.js
// Handles sprint + two placeholder abilities and their timers.

export class Abilities {
    constructor(playerStats, options = {}) {
        this.playerStats = playerStats;
        this.enabled = true;

        this.baseSprintNenPerSecond = options.sprintNenPerSecond ?? 8;
        this.baseSprintSpeedMultiplier = options.sprintSpeedMultiplier ?? 1.25;
        this.sprintNenPerSecond = this.baseSprintNenPerSecond;
        this.sprintSpeedMultiplier = this.baseSprintSpeedMultiplier;

        this.abilityJump = {
            key: "KeyQ",
            label: "Enhance Jump",
            baseDuration: options.jumpDuration ?? 4,
            baseCooldown: options.jumpCooldown ?? 7,
            baseNenCost: options.jumpNenCost ?? 18,
            baseJumpMultiplier: options.jumpMultiplier ?? 1.4,
            duration: options.jumpDuration ?? 4,
            cooldown: options.jumpCooldown ?? 7,
            nenCost: options.jumpNenCost ?? 18,
            jumpMultiplier: options.jumpMultiplier ?? 1.4,
            active: false,
            durationRemaining: 0,
            cooldownRemaining: 0
        };

        this.abilityCarve = {
            key: "KeyE",
            label: "Enhance Carve",
            baseDuration: options.carveDuration ?? 5,
            baseCooldown: options.carveCooldown ?? 8,
            baseNenCost: options.carveNenCost ?? 22,
            baseCarveRadiusMultiplier: options.carveRadiusMultiplier ?? 1.35,
            baseCarveCostMultiplier: options.carveCostMultiplier ?? 0.7,
            duration: options.carveDuration ?? 5,
            cooldown: options.carveCooldown ?? 8,
            nenCost: options.carveNenCost ?? 22,
            carveRadiusMultiplier: options.carveRadiusMultiplier ?? 1.35,
            carveCostMultiplier: options.carveCostMultiplier ?? 0.7,
            active: false,
            durationRemaining: 0,
            cooldownRemaining: 0
        };

        this._inputSprint = false;
        this.sprintActive = false;

        this._bindInputs();
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        if (!this.enabled) {
            this._inputSprint = false;
            this.sprintActive = false;
        }
    }

    _bindInputs() {
        window.addEventListener("keydown", (ev) => {
            if (!this.enabled) return;
            if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
                this._inputSprint = true;
            }
            if (ev.code === this.abilityJump.key) {
                this._tryActivate(this.abilityJump);
            }
            if (ev.code === this.abilityCarve.key) {
                this._tryActivate(this.abilityCarve);
            }
        });

        window.addEventListener("keyup", (ev) => {
            if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
                this._inputSprint = false;
            }
        });
    }

    _cooldownScale() {
        const derived = this.playerStats?.getDerived?.();
        return derived?.cooldownScale ?? 1;
    }

    _tryActivate(ability) {
        if (!this.enabled) return false;
        if (ability.active || ability.cooldownRemaining > 0) return false;

        const cost = ability.nenCost ?? 0;
        if (this.playerStats && !this.playerStats.spendNen(cost)) {
            return false;
        }

        ability.active = true;
        ability.durationRemaining = ability.duration;
        return true;
    }

    update(dtSeconds) {
        if (dtSeconds <= 0) return;

        // Update active timers
        for (const ability of [this.abilityJump, this.abilityCarve]) {
            if (ability.active) {
                ability.durationRemaining -= dtSeconds;
                if (ability.durationRemaining <= 0) {
                    ability.active = false;
                    ability.durationRemaining = 0;
                    ability.cooldownRemaining = ability.cooldown * this._cooldownScale();
                }
            } else if (ability.cooldownRemaining > 0) {
                ability.cooldownRemaining = Math.max(0, ability.cooldownRemaining - dtSeconds);
            }
        }

        // Sprint drains nen continuously when held
        if (this.enabled && this._inputSprint) {
            const nenCost = this.sprintNenPerSecond * dtSeconds;
            if (this.playerStats?.spendNen?.(nenCost)) {
                this.sprintActive = true;
            } else {
                this.sprintActive = false;
            }
        } else {
            this.sprintActive = false;
        }
    }

    isSprintActive() {
        return this.enabled && this.sprintActive;
    }

    getMovementModifiers() {
        return {
            sprintActive: this.isSprintActive(),
            sprintSpeedMultiplier: this.isSprintActive() ? this.sprintSpeedMultiplier : 1,
            jumpMultiplier: this.abilityJump.active ? this.abilityJump.jumpMultiplier : 1,
            carveRadiusMultiplier: this.abilityCarve.active ? this.abilityCarve.carveRadiusMultiplier : 1,
            carveCostMultiplier: this.abilityCarve.active ? this.abilityCarve.carveCostMultiplier : 1
        };
    }

    getAbilityState() {
        return {
            sprint: {
                active: this.isSprintActive(),
                requested: this._inputSprint
            },
            jump: {
                active: this.abilityJump.active,
                durationRemaining: this.abilityJump.durationRemaining,
                cooldownRemaining: this.abilityJump.cooldownRemaining,
                duration: this.abilityJump.duration,
                cooldown: this.abilityJump.cooldown
            },
            carve: {
                active: this.abilityCarve.active,
                durationRemaining: this.abilityCarve.durationRemaining,
                cooldownRemaining: this.abilityCarve.cooldownRemaining,
                duration: this.abilityCarve.duration,
                cooldown: this.abilityCarve.cooldown
            }
        };
    }

    applyExternalModifiers(mods = {}) {
        const abilityMods = mods.ability ?? {};

        this.sprintSpeedMultiplier = this.baseSprintSpeedMultiplier * (abilityMods.sprintSpeedMultiplier ?? 1);
        this.sprintNenPerSecond = this.baseSprintNenPerSecond * (abilityMods.sprintNenCostMultiplier ?? 1);

        this.abilityJump.duration = this.abilityJump.baseDuration * (abilityMods.jumpDurationMultiplier ?? 1);
        this.abilityJump.cooldown = this.abilityJump.baseCooldown * (abilityMods.jumpCooldownMultiplier ?? 1);
        this.abilityJump.nenCost = this.abilityJump.baseNenCost * (abilityMods.jumpNenCostMultiplier ?? 1);
        this.abilityJump.jumpMultiplier = this.abilityJump.baseJumpMultiplier * (abilityMods.jumpMultiplier ?? 1);

        this.abilityCarve.duration = this.abilityCarve.baseDuration * (abilityMods.carveDurationMultiplier ?? 1);
        this.abilityCarve.cooldown = this.abilityCarve.baseCooldown * (abilityMods.carveCooldownMultiplier ?? 1);
        this.abilityCarve.nenCost = this.abilityCarve.baseNenCost * (abilityMods.carveNenCostMultiplier ?? 1);
        this.abilityCarve.carveRadiusMultiplier = this.abilityCarve.baseCarveRadiusMultiplier * (abilityMods.carveRadiusMultiplier ?? 1);
        this.abilityCarve.carveCostMultiplier = this.abilityCarve.baseCarveCostMultiplier * (abilityMods.carveCostMultiplier ?? 1);
    }
}
