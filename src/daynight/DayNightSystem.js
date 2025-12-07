// src/DayNight/DayNightSystem.js

// Simple day/night cycle for a spherical planet.
//  - 24 real minutes = 1 in-game day (by default)
//  - Sun + moon directional lights
//  - Sun & moon billboards that always face the camera
//  - Moon stays opposite the sun

export class DayNightSystem {
    /**
     * @param {BABYLON.Scene} scene
     * @param {Object} options
     *   - planetRadius: radius of the planet in world units
     *   - dayLengthSeconds: real seconds for a full in-game day (default: 24 * 60)
     *   - startTimeOfDay: 0..1 (0 = midnight, 0.25 = 6am, 0.5 = noon, 0.75 = 6pm)
     */
    constructor(scene, options = {}) {
        this.scene = scene;
        this.engine = scene.getEngine();

        this.planetRadius = options.planetRadius ?? 50;
        this.dayLengthSeconds = options.dayLengthSeconds ?? (24 * 6);
        this.timeOfDay = options.startTimeOfDay ?? 0.5; // start around sunrise

        this.skyDistance = this.planetRadius * 10;
        this.sunSize = this.planetRadius * 0.8;
        this.moonSize = this.planetRadius * 0.6;

        // Direction that represents "noon straight up" at your reference latitude.
        // For your world we’ll pass (0, 0, 1) from main.js.
        this.orbitUpDirection = (options.orbitUpDirection
            ? options.orbitUpDirection.clone()
            : new BABYLON.Vector3(0, 1, 0)
        ).normalize();

        // Axis around which the sun/moon orbit; must be perpendicular to orbitUpDirection.
        this._orbitAxis = BABYLON.Vector3.Cross(
            this.orbitUpDirection,
            new BABYLON.Vector3(0, 1, 0)
        );
        if (this._orbitAxis.lengthSquared() === 0) {
            this._orbitAxis = BABYLON.Vector3.Cross(
                this.orbitUpDirection,
                new BABYLON.Vector3(1, 0, 0)
            );
        }
        this._orbitAxis.normalize();
        
        this._createLights();
        this._createBillboards();

        this._beforeRenderObserver = this.scene.onBeforeRenderObservable.add(
            () => this._update()
        );
    }

    _createLights() {
        // Sun light
        this.sunLight = new BABYLON.DirectionalLight(
            "dayNight_sunLight",
            new BABYLON.Vector3(0, -1, 0),
            this.scene
        );
        this.sunLight.intensity = 1.2;
        this.sunLight.diffuse = new BABYLON.Color3(1.0, 0.97, 0.9);
        this.sunLight.specular = new BABYLON.Color3(1.0, 0.97, 0.9);
        this.sunLight.groundColor = new BABYLON.Color3(0, 0, 0);

        // Moon light
        this.moonLight = new BABYLON.DirectionalLight(
            "dayNight_moonLight",
            new BABYLON.Vector3(0, -1, 0),
            this.scene
        );
        this.moonLight.intensity = 0.5;
        this.moonLight.diffuse = new BABYLON.Color3(1.0, 1.0, 0.97);
        this.moonLight.specular = new BABYLON.Color3(1.0, 1.0, 0.97);
        this.moonLight.groundColor = new BABYLON.Color3(0, 0, 0);
    }

    _createBillboards() {
        // Sun "decal"
        const sunMat = new BABYLON.StandardMaterial("dayNight_sunMat", this.scene);
        sunMat.emissiveColor = new BABYLON.Color3(1.2, 1.0, 0.6);
        sunMat.disableLighting = true;
        sunMat.backFaceCulling = false;

        this.sunBillboard = BABYLON.MeshBuilder.CreatePlane(
            "dayNight_sunBillboard",
            { size: this.sunSize },
            this.scene
        );
        this.sunBillboard.material = sunMat;
        this.sunBillboard.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        this.sunBillboard.isPickable = false;

        // Moon "decal"
        const moonMat = new BABYLON.StandardMaterial("dayNight_moonMat", this.scene);
        moonMat.emissiveColor = new BABYLON.Color3(0.8, 0.85, 1.0);
        moonMat.disableLighting = true;
        moonMat.backFaceCulling = false;

        this.moonBillboard = BABYLON.MeshBuilder.CreatePlane(
            "dayNight_moonBillboard",
            { size: this.moonSize },
            this.scene
        );
        this.moonBillboard.material = moonMat;
        this.moonBillboard.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        this.moonBillboard.isPickable = false;
    }

    _update() {
        const dt = this.engine.getDeltaTime() / 1000; // seconds
        if (dt <= 0) return;

        // Advance time of day, keeping it in [0, 1)
        this.timeOfDay = (this.timeOfDay + dt / this.dayLengthSeconds) % 1.0;

        // Map timeOfDay to an orbit angle:
        // 0.0 = midnight (sun on opposite side of orbitUpDirection)
        // 0.25 = sunrise
        // 0.5 = noon (sun aligned with orbitUpDirection)
        // 0.75 = sunset
        const angle = (this.timeOfDay - 0.5) * 2 * Math.PI;

        const up = this.orbitUpDirection;
        const axis = this._orbitAxis;

        // Sun direction is a rotation around 'axis' in the plane spanned by up & axis.
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        const sunDir = up.scale(cosA).add(axis.scale(sinA)).normalize();

        // Moon is always exactly opposite the sun (180° apart).
        const moonDir = sunDir.scale(-1);

        // Store directions for HUD/debug
        this.sunDir = sunDir.clone();
        this.moonDir = moonDir.clone();

        const orbitRadius = this.planetRadius * 10;
        const sunPos = sunDir.scale(orbitRadius);
        const moonPos = moonDir.scale(orbitRadius);

        // Store world positions for HUD/debug
        this.sunPos = sunPos.clone();
        this.moonPos = moonPos.clone();


        // Lights point toward planet center (assumed origin)
        this.sunLight.position.copyFrom(sunPos);
        this.sunLight.direction.copyFrom(sunDir.scale(-1));

        this.moonLight.position.copyFrom(moonPos);
        this.moonLight.direction.copyFrom(moonDir.scale(-1));

        const camera = this.scene.activeCamera;
        if (camera) {
            // Place billboards at a fixed distance from camera in the
            // same directions as the lights.
            const sunOffset = sunDir.scale(this.skyDistance);
            this.sunBillboard.position
                .copyFrom(camera.position)
                .addInPlace(sunOffset);

            const moonOffset = moonDir.scale(this.skyDistance);
            this.moonBillboard.position
                .copyFrom(camera.position)
                .addInPlace(moonOffset);
        }

        // Light intensity based on sun height above horizon
        const sunHeight = sunDir.y; // >0 day, <0 night

        const sunFactor = BABYLON.Scalar.Clamp((sunHeight + 0.1) / 1.1, 0, 1);
        const maxSun = 1.2;
        const maxMoon = 0.4;

        this.sunLight.intensity = maxSun * sunFactor;

        const moonFactor = 1.0 - sunFactor;
        this.moonLight.intensity = maxMoon * moonFactor;

        // Optional: adjust exposure if using environmentTexture
        if (this.scene.environmentTexture) {
            const baseExposure = 1.0;
            const nightDarkening = 0.4;
            this.scene.imageProcessingConfiguration.exposure =
                baseExposure - (nightDarkening * moonFactor);
        }
    }

    getDebugInfo() {
        return {
            timeOfDay: this.timeOfDay,
            sunDir: this.sunDir ? this.sunDir.clone() : null,
            moonDir: this.moonDir ? this.moonDir.clone() : null,
            sunPos: this.sunPos ? this.sunPos.clone() : null,
            moonPos: this.moonPos ? this.moonPos.clone() : null,
            planetRadius: this.planetRadius
        };
    }


    dispose() {
        if (this._beforeRenderObserver) {
            this.scene.onBeforeRenderObservable.remove(this._beforeRenderObserver);
            this._beforeRenderObserver = null;
        }

        if (this.sunLight) {
            this.sunLight.dispose();
            this.sunLight = null;
        }
        if (this.moonLight) {
            this.moonLight.dispose();
            this.moonLight = null;
        }
        if (this.sunBillboard) {
            this.sunBillboard.dispose();
            this.sunBillboard = null;
        }
        if (this.moonBillboard) {
            this.moonBillboard.dispose();
            this.moonBillboard = null;
        }
    }
}






