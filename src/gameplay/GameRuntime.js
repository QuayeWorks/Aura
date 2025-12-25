// src/gameplay/GameRuntime.js
// Wires player stats, abilities, HUD, and terrain interactions together.

import { PlayerStats } from "./PlayerStats.js";
import { Abilities } from "./Abilities.js";
import { CarveController } from "./CarveController.js";
import { POIManager } from "../world/POIManager.js";
import { EnemyManager } from "../enemies/EnemyManager.js";

export class GameRuntime {
    constructor({ player, terrain, hud, baseMovement, baseCarve, scene, dayNightSystem } = {}) {
        this.player = player;
        this.terrain = terrain;
        this.hud = hud;
        this.scene = scene;
        this.dayNightSystem = dayNightSystem;

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

        this.carveController = new CarveController({
            terrain: this.terrain,
            playerStats: this.playerStats,
            abilities: this.abilities,
            hud: this.hud,
            baseRadius: baseCarve?.radius ?? 70,
            baseNenCost: baseCarve?.nenCost ?? 12
        });

        this.poiManager = new POIManager({
            scene,
            terrain,
            player,
            seed: terrain?.seed ?? 1,
            planetRadius: terrain?.radius ?? 1
        });

        this.enemyManager = new EnemyManager({
            scene,
            terrain,
            player,
            planetRadius: terrain?.radius ?? 1,
            playerStats: this.playerStats,
            dayNightSystem,
            seed: terrain?.seed ?? 7
        });
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        this.abilities?.setEnabled(this.enabled);
        if (this.carveController) this.carveController.enabled = this.enabled;
        if (this.poiManager) this.poiManager.enabled = this.enabled;
        if (this.enemyManager) this.enemyManager.enabled = this.enabled;
        if (!this.enabled && this.hud) {
            this.hud.setGameplayVisible(false);
        }
    }

    update(dtSeconds) {
        if (!this.enabled) return;
        if (!this.player) return;

        this.playerStats.update(dtSeconds);
        this.abilities.update(dtSeconds);
        this.carveController?.update(dtSeconds);
        this.poiManager?.update(dtSeconds);
        this.enemyManager?.update(dtSeconds);

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
            stats: derived.stats,
            carveHeat: this.carveController?.getHeat?.()
        });
    }

    handleCarve(worldPoint) {
        if (!this.enabled) return false;
        if (!this.terrain || !worldPoint) return false;
        const result = this.carveController?.tryCarve(worldPoint);
        if (!result?.success && result?.reason === "lockout") {
            this.hud?.flashNenBar?.();
        }
        return !!result?.success;
    }
}
