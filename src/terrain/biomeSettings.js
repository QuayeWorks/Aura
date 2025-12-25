export const DEFAULT_BIOME_SETTINGS = {
    unitsPerMeter: 1,
    seaLevelMeters: 220,
    shallowWaterDepthMeters: 80,
    beachWidthMeters: 220,
    grassMaxMeters: 250,
    rockStartMeters: 250,
    rockFullMeters: 700,
    snowStartMeters: 700,
    snowFullMeters: 1600,
    slopeRockStart: 0.35,
    slopeRockFull: 0.75,
    slopeEpsMeters: 6,
    debugMode: "off"
};

export function resolveBiomeSettings(settings = {}) {
    const merged = { ...DEFAULT_BIOME_SETTINGS, ...(settings || {}) };
    const unitsPerMeter = Math.max(0.0001, merged.unitsPerMeter || 1);

    return {
        ...merged,
        unitsPerMeter,
        seaLevelUnits: merged.seaLevelMeters * unitsPerMeter,
        shallowWaterDepthUnits: merged.shallowWaterDepthMeters * unitsPerMeter,
        beachWidthUnits: merged.beachWidthMeters * unitsPerMeter,
        grassMaxUnits: merged.grassMaxMeters * unitsPerMeter,
        rockStartUnits: merged.rockStartMeters * unitsPerMeter,
        rockFullUnits: merged.rockFullMeters * unitsPerMeter,
        snowStartUnits: merged.snowStartMeters * unitsPerMeter,
        snowFullUnits: merged.snowFullMeters * unitsPerMeter,
        slopeEpsUnits: Math.max(0.001, merged.slopeEpsMeters * unitsPerMeter),
    };
}
