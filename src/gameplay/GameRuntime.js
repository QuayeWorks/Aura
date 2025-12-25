// src/gameplay/GameRuntime.js
// Wires player stats, abilities, HUD, and terrain interactions together.

import { PlayerStats } from "./PlayerStats.js";
import { Abilities } from "./Abilities.js";

export class GameRuntime {
    constructor({ player, terrain, hud, baseMovement, baseCarve } = {}) {
        this.player = player;
        this.terrain = terrain;
        this.hud = hud;

        this.playerStats = new PlayerStats({
            baseMovement: {
                walkSpeed: baseMovement?.walkSpeed ?? player?.walkSpeed ?? 2,
                runSpeed: baseMovement?.runSpeed ?? player?.runSpeed ?? 6,
                jumpImpulse: baseMovement?.jumpImpulse ?? player?.jumpSpeed ?? 10,
                gravity: baseMovement?.gravity ?? player?.gravity ?? 10,
                accel: baseMovement?.accel ?? player?.accel ?? 20,
                groundFriction: baseMovement?.groundFriction ?? player?.groundFriction ?? 8,
                airFriction: baseMovement?.airFriction ?? player?.airFriction ?? 1
            },
            baseCarve: {
                radius: baseCarve?.radius ?? 70,
                nenCost: baseCarve?.nenCost ?? 12
            }
        });

        this.abilities = new Abilities(this.playerStats, {
            sprintNenPerSecond: 10,
            sprintSpeedMultiplier: 1.25,
            jumpDuration: 4,
            jumpCooldown: 7,
            jumpNenCost: 18,
            jumpMultiplier: 1.5,
            carveDuration: 5,
            carveCooldown: 8,
            carveNenCost: 22,
            carveRadiusMultiplier: 1.4,
            carveCostMultiplier: 0.65
        });

        this.enabled = true;
        this.timeSinceHudUpdate = 0;
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        this.abilities?.setEnabled(this.enabled);
        if (!this.enabled && this.hud) {
            this.hud.setGameplayVisible(false);
        }
    }

    update(dtSeconds) {
        if (!this.enabled) return;
        if (!this.player) return;

        this.playerStats.update(dtSeconds);
        this.abilities.update(dtSeconds);

        this._applyStatsToPlayer();
        this.timeSinceHudUpdate += dtSeconds;
        if (this.timeSinceHudUpdate > 0.08 && this.hud) {
            this._updateHud();
            this.timeSinceHudUpdate = 0;
        }
    }

    _applyStatsToPlayer() {
        if (!this.player) return;
        const derived = this.playerStats.getDerived();
        const mods = this.abilities.getMovementModifiers();

        this.player.walkSpeed = derived.walkSpeed;
        this.player.runSpeed = derived.runSpeed * mods.sprintSpeedMultiplier;
        this.player.accel = derived.accel;
        this.player.jumpSpeed = derived.jumpImpulse * mods.jumpMultiplier;
        this.player.gravity = derived.gravity;
        this.player.airFriction = derived.airFriction;
        this.player.groundFriction = derived.groundFriction;

        // Force sprint flag to follow resource/activation state
        this.player.inputRun = mods.sprintActive;
    }

    _updateHud() {
        const abilityState = this.abilities.getAbilityState();
        const derived = this.playerStats.getDerived();
        this.hud.update({
            health: derived.health,
            maxHealth: derived.maxHealth,
            nen: derived.nen,
            maxNen: derived.maxNen,
            level: derived.level,
            currentXP: derived.currentXP,
            xpToNext: derived.xpToNext,
            abilityState,
            nenRegen: derived.nenRegenPerSec,
            stats: derived.stats
        });
    }

    handleCarve(worldPoint) {
        if (!this.enabled) return false;
        if (!this.terrain || !worldPoint) return false;

        const derived = this.playerStats.getDerived();
        const mods = this.abilities.getMovementModifiers();

        const radius = (this.playerStats.baseCarve?.radius ?? 70)
            * derived.carveRadiusMultiplier
            * mods.carveRadiusMultiplier;

        const baseCost = (this.playerStats.baseCarve?.nenCost ?? 12);
        const radiusFactor = radius * 0.05;
        const cost = (baseCost + radiusFactor)
            * derived.carveCostMultiplier
            * mods.carveCostMultiplier;

        if (!this.playerStats.spendNen(cost)) {
            this.hud?.flashNenBar();
            return false;
        }

        this.terrain.carveSphere(worldPoint, radius);
        return true;
    }
}
