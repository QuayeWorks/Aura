// src/ui/CompassHUD.js
// DOM-based compass + latitude overlay for orientation awareness.

export class CompassHUD {
    constructor() {
        this.visible = true;
        this.root = document.getElementById("hud-root") || this._ensureRoot();
        this.container = document.createElement("div");
        this.container.className = "compass-container";

        this.dial = document.createElement("div");
        this.dial.className = "compass-dial";

        this.headingNeedle = document.createElement("div");
        this.headingNeedle.className = "compass-needle";

        const ring = document.createElement("div");
        ring.className = "compass-ring";
        const cardinals = ["N", "E", "S", "W"];
        cardinals.forEach((c) => {
            const label = document.createElement("div");
            label.className = `compass-label compass-${c}`;
            label.textContent = c;
            ring.appendChild(label);
        });

        this.latText = document.createElement("div");
        this.latText.className = "compass-lat";
        this.latText.textContent = "Lat 0°";

        this.dial.appendChild(ring);
        this.dial.appendChild(this.headingNeedle);
        this.container.appendChild(this.dial);
        this.container.appendChild(this.latText);
        this.root.appendChild(this.container);

    }

    _ensureRoot() {
        const root = document.createElement("div");
        root.id = "hud-root";
        document.body.appendChild(root);
        return root;
    }

    setVisible(isVisible) {
        this.visible = !!isVisible;
        this.container.classList.toggle("hud-hidden", !this.visible);
    }

    update({ playerPosition, playerForward }) {
        if (!this.visible) return { snowBias: 0 };
        if (!playerPosition) return { snowBias: 0 };

        const up = playerPosition.clone ? playerPosition.clone() : { ...playerPosition };
        const upLen = Math.hypot(up.x, up.y, up.z);
        if (upLen < 1e-5) return { snowBias: 0 };
        up.x /= upLen; up.y /= upLen; up.z /= upLen;

        const worldNorth = { x: 0, y: 1, z: 0 };
        const dotNorthUp = up.x * worldNorth.x + up.y * worldNorth.y + up.z * worldNorth.z;
        let northTangent = {
            x: worldNorth.x - up.x * dotNorthUp,
            y: worldNorth.y - up.y * dotNorthUp,
            z: worldNorth.z - up.z * dotNorthUp
        };
        let northLen = Math.hypot(northTangent.x, northTangent.y, northTangent.z);
        if (northLen < 1e-5) {
            const fallback = { x: 0, y: 0, z: 1 };
            const dotFallback = up.x * fallback.x + up.y * fallback.y + up.z * fallback.z;
            northTangent = {
                x: fallback.x - up.x * dotFallback,
                y: fallback.y - up.y * dotFallback,
                z: fallback.z - up.z * dotFallback
            };
            northLen = Math.hypot(northTangent.x, northTangent.y, northTangent.z);
        }
        northTangent.x /= northLen; northTangent.y /= northLen; northTangent.z /= northLen;

        const eastTangent = {
            x: up.y * northTangent.z - up.z * northTangent.y,
            y: up.z * northTangent.x - up.x * northTangent.z,
            z: up.x * northTangent.y - up.y * northTangent.x
        };
        const eastLen = Math.hypot(eastTangent.x, eastTangent.y, eastTangent.z) || 1;
        eastTangent.x /= eastLen; eastTangent.y /= eastLen; eastTangent.z /= eastLen;

        let forward = playerForward;
        if (!forward) {
            forward = northTangent;
        }
        if (forward.clone) forward = forward.clone();
        const fLen = Math.hypot(forward.x, forward.y, forward.z) || 1;
        forward.x /= fLen; forward.y /= fLen; forward.z /= fLen;

        const dotForwardUp = forward.x * up.x + forward.y * up.y + forward.z * up.z;
        const projForward = {
            x: forward.x - up.x * dotForwardUp,
            y: forward.y - up.y * dotForwardUp,
            z: forward.z - up.z * dotForwardUp
        };
        const projLen = Math.hypot(projForward.x, projForward.y, projForward.z) || 1;
        projForward.x /= projLen; projForward.y /= projLen; projForward.z /= projLen;

        const heading = Math.atan2(
            projForward.x * eastTangent.x + projForward.y * eastTangent.y + projForward.z * eastTangent.z,
            projForward.x * northTangent.x + projForward.y * northTangent.y + projForward.z * northTangent.z
        );

        const headingDeg = heading * (180 / Math.PI);
        this.headingNeedle.style.transform = `translate(-50%, -100%) rotate(${headingDeg}deg)`;

        const latRad = Math.asin(dotNorthUp);
        const latDeg = latRad * (180 / Math.PI);
        this.latText.textContent = `Lat ${latDeg.toFixed(1)}°`;

        const snowBias = Math.abs(Math.sin(latRad));
        return { snowBias };
    }
}
