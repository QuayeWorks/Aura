/* global BABYLON */

export class PlanetWorld {
    constructor({ radius = 1, gravityStrength = 1, defaultUp = null } = {}) {
        this.radius = radius;
        this.gravityStrength = gravityStrength;
        this.defaultUp = defaultUp ?? new BABYLON.Vector3(0, 0, 1);
    }

    setRadius(radius) {
        if (Number.isFinite(radius)) this.radius = radius;
    }

    getUpVector(pos) {
        if (!pos) return this.defaultUp.clone();
        const v = pos.clone ? pos.clone() : new BABYLON.Vector3(pos.x, pos.y, pos.z);
        if (v.lengthSquared() < 1e-6) return this.defaultUp.clone();
        return v.normalize();
    }

    getGravityVector(pos) {
        const up = this.getUpVector(pos);
        return up.scale(-1 * (this.gravityStrength ?? 1));
    }

    getSurfaceRadiusAtDirection() {
        return this.radius;
    }

    getSurfacePoint(posOrDir) {
        const up = this.getUpVector(posOrDir);
        return up.scale(this.radius);
    }
}
