/* global BABYLON */
// src/audio/AudioSystem.js
// Minimal synthesized audio for footsteps, wind, and ability activations.

export class AudioSystem {
    constructor({ player, terrain, gameRuntime } = {}) {
        this.player = player;
        this.terrain = terrain;
        this.gameRuntime = gameRuntime;

        this.context = null;
        this.masterGain = null;
        this.footstepGain = null;
        this.windGain = null;
        this.windSource = null;

        this.lastStepTime = 0;
        this.stepCooldown = 0.5;
        this.muted = false;
        this.muteStorageKey = "auraion_audio_muted";

        this.lastAbilityState = { jump: false, carve: false, sprint: false };
        this.lastWindUpdate = 0;

        this._loadMutePreference();
    }

    _ensureContext() {
        if (this.context) return;
        this.context = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.context.createGain();
        this.masterGain.gain.value = this.muted ? 0 : 0.8;
        this.masterGain.connect(this.context.destination);

        this.footstepGain = this.context.createGain();
        this.footstepGain.gain.value = 0.8;
        this.footstepGain.connect(this.masterGain);

        this.windGain = this.context.createGain();
        this.windGain.gain.value = 0;
        this.windGain.connect(this.masterGain);

        this._createWind();
    }

    _createWind() {
        if (!this.context || this.windSource) return;
        const bufferSize = 2 * this.context.sampleRate;
        const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.5;
        }
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(this.windGain);
        source.start();
        this.windSource = source;
    }

    setMuted(isMuted) {
        this.muted = !!isMuted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.muted ? 0 : 0.8;
        }
        try {
            localStorage.setItem(this.muteStorageKey, JSON.stringify(this.muted));
        } catch (e) {
            console.warn("Audio mute preference save failed", e);
        }
    }

    toggleMute() {
        this.setMuted(!this.muted);
    }

    _loadMutePreference() {
        try {
            const raw = localStorage.getItem(this.muteStorageKey);
            if (raw != null) {
                this.muted = JSON.parse(raw);
            }
        } catch (e) {
            console.warn("Audio mute preference load failed", e);
        }
    }

    _playNoiseBurst({ duration = 0.12, frequency = 400, type = "square", gain = 0.6 } = {}, targetGainNode) {
        if (!this.context || this.muted) return;
        const osc = this.context.createOscillator();
        const envelope = this.context.createGain();
        osc.type = type;
        osc.frequency.value = frequency;
        osc.connect(envelope);
        envelope.connect(targetGainNode || this.masterGain);
        const now = this.context.currentTime;
        envelope.gain.setValueAtTime(gain, now);
        envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);
        osc.start(now);
        osc.stop(now + duration + 0.02);
    }

    _playFootstep(kind = "grass") {
        const freq = kind === "sand" ? 220 : kind === "rock" ? 380 : 300;
        this._playNoiseBurst({ duration: 0.08, frequency: freq, type: "triangle", gain: 0.45 }, this.footstepGain);
    }

    _playAbility(type) {
        const freq = type === "jump" ? 520 : 420;
        this._playNoiseBurst({ duration: 0.16, frequency: freq, type: "sawtooth", gain: 0.55 }, this.masterGain);
    }

    _classifyBiome() {
        if (!this.player || !this.terrain) return "rock";
        const pos = this.player.mesh?.position;
        if (!pos) return "rock";
        const biome = this.terrain.biomeSettings || {};
        const radius = this.terrain.radius || 1;
        const dist = pos.length ? pos.length() : Math.hypot(pos.x, pos.y, pos.z);
        const heightAboveSea = (dist - radius) - (biome.seaLevelUnits || 0);
        const slopeNormal = this.player.lastGroundNormal;
        const up = pos.clone ? pos.clone() : { ...pos };
        const len = dist || Math.hypot(up.x, up.y, up.z) || 1;
        up.x /= len; up.y /= len; up.z /= len;
        let slope = 0;
        if (slopeNormal) {
            const dot = BABYLON.Vector3.Dot ? BABYLON.Vector3.Dot(slopeNormal, up) : (slopeNormal.x * up.x + slopeNormal.y * up.y + slopeNormal.z * up.z);
            slope = Math.max(0, 1 - dot);
        }

        if (heightAboveSea < -(biome.shallowWaterDepthUnits || 20)) return "sand";
        if (heightAboveSea < (biome.beachWidthUnits || 80)) return "sand";
        if (heightAboveSea > (biome.rockStartUnits || 200) || slope > (biome.slopeRockStart || 0.35)) return "rock";
        return "grass";
    }

    _shouldStep(now) {
        if (!this.player || !this.player.isGrounded) return false;
        const vel = this.player.velocity;
        if (!vel) return false;
        const speed = vel.length ? vel.length() : Math.hypot(vel.x, vel.y, vel.z);
        if (speed < 0.5) return false;
        const cadence = speed > 8 ? 0.26 : speed > 3 ? 0.38 : 0.5;
        this.stepCooldown = cadence;
        return now - this.lastStepTime >= this.stepCooldown;
    }

    _updateWind(now) {
        if (!this.context) return;
        if (now - this.lastWindUpdate < 0.08) return;
        this.lastWindUpdate = now;
        const pos = this.player?.mesh?.position;
        if (!pos || !this.terrain) return;
        const dist = pos.length ? pos.length() : Math.hypot(pos.x, pos.y, pos.z);
        const biome = this.terrain.biomeSettings || {};
        const altitude = (dist - (this.terrain.radius || 0)) - (biome.seaLevelUnits || 0);
        const altFactor = Math.max(0, Math.min(1, altitude / ((this.terrain.radius || 1) * 0.05)));
        if (this.windGain) {
            this.windGain.gain.linearRampToValueAtTime(0.05 + altFactor * 0.35, this.context.currentTime + 0.1);
        }
    }

    update(dtSeconds) {
        if (!this.context || this.muted) return;
        const now = this.context.currentTime;
        this._updateWind(now);
        if (this._shouldStep(now)) {
            this.lastStepTime = now;
            const biome = this._classifyBiome();
            this._playFootstep(biome);
        }

        const abilityState = this.gameRuntime?.getAbilityState?.();
        if (abilityState) {
            if (abilityState.jump?.active && !this.lastAbilityState.jump) {
                this._playAbility("jump");
            }
            if (abilityState.carve?.active && !this.lastAbilityState.carve) {
                this._playAbility("carve");
            }
            if (abilityState.sprint?.active && !this.lastAbilityState.sprint) {
                this._playAbility("sprint");
            }
            this.lastAbilityState = {
                jump: !!abilityState.jump?.active,
                carve: !!abilityState.carve?.active,
                sprint: !!abilityState.sprint?.active
            };
        }
    }

    ensureStarted() {
        this._ensureContext();
        if (this.context?.state === "suspended") {
            this.context.resume();
        }
    }
}
