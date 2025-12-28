/* global BABYLON */
// AnimationController.js
// Drives Babylon.js AnimationGroups for the player. Handles locomotion loops
// plus one-shot attacks / jumps that layer on top of movement.

const LOCOMOTION_NAMES = ["Idle", "Walk", "Jog", "RunSlow", "RunMedium", "RunFast"];
const ATTACK_NAMES = [
    "Attack_Punch",
    "Attack_PunchCombo",
    "Attack_Elbow",
    "Attack_KickA",
    "Attack_KickB",
    "Attack_KickC",
    "Attack_KickD",
    "Attack_KickE",
];
const JUMP_NAMES = ["JumpA", "JumpB", "JumpC"];
const LAND_NAMES = ["LandA", "LandB"];

const DEFAULT_ATTACK_LOCOMOTION_WEIGHT = 0.85;

export class AnimationController {
    constructor(scene, animationGroups = [], options = {}) {
        this.scene = scene;
        this.animationGroups = new Map();
        this.currentLocomotion = null;
        this.targetLocomotionWeight = 1;
        this.activeOneShots = new Set();
        this.fadingOutGroups = new Set();
        this.comboWindowMs = options.comboWindowMs ?? 350;
        this.lastAttackEndTime = -Infinity;
        this.lastAttackStartTime = -Infinity;
        this.warnedMissingPunchCombo = false;
        this.upperBodyMask = options.upperBodyMask ?? null; // Hook for future upper-body-only attacks

        this._autoUpdateObserver = null;
        if (this.scene) {
            this._autoUpdateObserver = this.scene.onBeforeRenderObservable.add(() => {
                const engine = this.scene.getEngine?.();
                const dt = engine?.getDeltaTime ? engine.getDeltaTime() / 1000 : 0;
                this.update(dt);
            });
        }

        this.setAnimationGroups(animationGroups);
    }

    dispose() {
        if (this._autoUpdateObserver && this.scene) {
            this.scene.onBeforeRenderObservable.remove(this._autoUpdateObserver);
            this._autoUpdateObserver = null;
        }
        this.animationGroups.clear();
        this.activeOneShots.clear();
        this.fadingOutGroups.clear();
    }

    setAnimationGroups(groups = []) {
        this.animationGroups.clear();

        groups.forEach((group) => {
            if (!group || !group.name) return;
            this.animationGroups.set(group.name, group);

            if (LOCOMOTION_NAMES.includes(group.name)) {
                group.loopAnimation = true;
            } else {
                group.loopAnimation = false;
            }
        });
    }

    getGroup(name) {
        return this.animationGroups.get(name);
    }

    playLocomotion(name, weight = 1) {
        const group = this.getGroup(name);
        if (!group) return;

        if (this.currentLocomotion && this.currentLocomotion !== group) {
            this._setWeight(this.currentLocomotion, 0);
            this.currentLocomotion.stop();
        }

        this.currentLocomotion = group;
        this.targetLocomotionWeight = weight;
        group.loopAnimation = true;
        group.reset();
        this._setWeight(group, weight);
        group.play(true);
    }

    triggerAttack(type) {
        let chosenName = null;
        const now = this._now();
        const comboGroup = this.getGroup("Attack_PunchCombo");

        const preferCombo =
            this.activeOneShots.has("Attack_Punch") ||
            this.activeOneShots.has("Attack_PunchCombo") ||
            now - this.lastAttackEndTime < this.comboWindowMs;

        if (type === "Punch") {
            if (!comboGroup && !this.warnedMissingPunchCombo) {
                console.warn("AnimationController: Attack_PunchCombo missing; falling back to Attack_Punch.");
                this.warnedMissingPunchCombo = true;
            }

            const punchGroup = this.getGroup("Attack_Punch");
            if (preferCombo && comboGroup) {
                chosenName = "Attack_PunchCombo";
            } else {
                const roll = Math.random();
                if (roll < 0.3 && comboGroup) {
                    chosenName = "Attack_PunchCombo";
                } else if (punchGroup) {
                    chosenName = "Attack_Punch";
                } else if (comboGroup) {
                    chosenName = "Attack_PunchCombo";
                }
            }
        } else if (type === "Elbow") {
            chosenName = this.getGroup("Attack_Elbow") ? "Attack_Elbow" : null;
        } else if (type === "Kick") {
            const kicks = [
                "Attack_KickA",
                "Attack_KickB",
                "Attack_KickC",
                "Attack_KickD",
                "Attack_KickE",
            ].filter((name) => this.getGroup(name));
            if (kicks.length > 0) {
                chosenName = kicks[Math.floor(Math.random() * kicks.length)];
            }
        }

        if (!chosenName) return false;
        return this._playOneShot(chosenName, ATTACK_NAMES.includes(chosenName));
    }

    triggerJump(name) {
        if (!JUMP_NAMES.includes(name)) return false;
        return this._playOneShot(name, false);
    }

    triggerLand(name) {
        if (!LAND_NAMES.includes(name)) return false;
        return this._playOneShot(name, false);
    }

    setUpperBodyMask(mask) {
        // Hook for future upper-body-only attack blending. No-op for now.
        this.upperBodyMask = mask;
    }

    update(dtSeconds) {
        this._updateFades(dtSeconds);
        this._updateLocomotionWeight();
    }

    _playOneShot(name, isAttack = false) {
        const group = this.getGroup(name);
        if (!group) return false;

        this.activeOneShots.add(name);
        group.loopAnimation = false;
        group.reset();
        this._setWeight(group, 1);
        group.play(false);

        if (isAttack) {
            this.targetLocomotionWeight = DEFAULT_ATTACK_LOCOMOTION_WEIGHT;
            this.lastAttackStartTime = this._now();
        }

        const onEnd = group.onAnimationGroupEndObservable.add(() => {
            group.onAnimationGroupEndObservable.remove(onEnd);
            this._fadeOutGroup(group, isAttack);
        });

        return true;
    }

    _fadeOutGroup(group, isAttack) {
        this.fadingOutGroups.add({ group, remaining: 0.2, isAttack });
        this.activeOneShots.delete(group.name);

        if (isAttack) {
            this.lastAttackEndTime = this._now();
        }
    }

    _updateFades(dtSeconds) {
        if (this.fadingOutGroups.size === 0) return;
        for (const fade of Array.from(this.fadingOutGroups)) {
            fade.remaining = Math.max(0, fade.remaining - dtSeconds);
            const weight = fade.remaining > 0 ? fade.remaining / 0.2 : 0;
            this._setWeight(fade.group, weight);

            if (fade.remaining <= 0) {
                fade.group.stop();
                this._setWeight(fade.group, 0);
                this.fadingOutGroups.delete(fade);
            }
        }
    }

    _updateLocomotionWeight() {
        if (!this.currentLocomotion) return;

        const target = this.activeOneShots.size > 0 ? this.targetLocomotionWeight : 1;
        this._setWeight(this.currentLocomotion, target);
    }

    _setWeight(group, weight) {
        if (!group || typeof group.setWeightForAllAnimatables !== "function") return;
        group.setWeightForAllAnimatables(weight);
    }

    _now() {
        if (typeof performance !== "undefined" && performance.now) return performance.now();
        return Date.now();
    }
}
