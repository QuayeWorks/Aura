// MinimapViewport.js
// Viewport-based minimap: second camera renders into bottom-left viewport.
// Terrain colors match automatically because it renders the real meshes.

export function createMinimapViewport({
  scene,
  mainCamera,
  ui,
  options = {}
}) {
  const MAIN_LAYER = options.mainLayer ?? 0x1;
  const MINIMAP_LAYER = options.minimapLayer ?? 0x2;

  const viewX = options.viewportX ?? 0.02;
  const viewY = options.viewportY ?? 0.02;
  const viewW = options.viewportW ?? 0.25;
  const viewH = options.viewportH ?? 0.25;

  const worldRadius = options.worldRadius ?? 350; // zoom (world units around player)
  const height = options.height ?? 800;          // height above player
  const padLeft = options.uiLeft ?? "0%";
  const padTop = options.uiTop ?? "0%";
  const sizeW = options.uiWidth ?? "5%";
  const sizeH = options.uiHeight ?? "5%";

  // Ensure main camera renders normal layer
  if (mainCamera) mainCamera.layerMask = MAIN_LAYER;

  // Create minimap camera
  const minimapCamera = new BABYLON.FreeCamera(
    "minimapCamera",
    mainCamera.position.clone(),
    scene
  );

  minimapCamera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  minimapCamera.layerMask = MINIMAP_LAYER;

  minimapCamera.viewport = new BABYLON.Viewport(viewX, viewY, viewW, viewH);

  minimapCamera.orthoLeft = -worldRadius;
  minimapCamera.orthoRight = worldRadius;
  minimapCamera.orthoTop = worldRadius;
  minimapCamera.orthoBottom = -worldRadius;

  minimapCamera.minZ = 0.1;
  minimapCamera.maxZ = 50000;

  // Prevent depth buffer conflicts between minimap + main camera
  scene.autoClear = false;
  scene.autoClearDepthAndStencil = false;
  
  minimapCamera.onBeforeRenderObservable.add(() => {
      const engine = scene.getEngine();
      engine.setViewport(minimapCamera.viewport);
      engine.clear(new BABYLON.Color4(0, 0, 0, 1), true, true, true);
  });
  
  // Main camera clears full frame normally
  mainCamera.onBeforeRenderObservable.add(() => {
      const engine = scene.getEngine();
      engine.setViewport(mainCamera.viewport);
      engine.clear(scene.clearColor, true, true, true);
  });

  // UI frame overlay (optional)
  let frame = null;
  let dot = null;
  
  if (ui) {
    // --- Safety: remove any previous minimap UI controls (prevents duplicates) ---
    if (ui && ui.getControlByName) {
      const oldFrame = ui.getControlByName("minimapFrame");
      if (oldFrame) oldFrame.dispose();
    
      const oldDot = ui.getControlByName("minimapDot");
      if (oldDot) oldDot.dispose();
    }

  
    frame = new BABYLON.GUI.Rectangle("minimapFrame");
    frame.width = vpToPercent(viewW);
    frame.height = vpToPercent(viewH);
    frame.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    frame.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_BOTTOM;
    frame.left = vpToPercent(viewX);
    frame.top = "-" + vpToPercent(viewY);
  
    frame.thickness = options.thickness ?? 2;
    frame.color = options.borderColor ?? "#ffffff";
    frame.cornerRadius = options.cornerRadius ?? 12;
    frame.alpha = options.alpha ?? 0.95;
    frame.clipChildren = true;
    frame.background = options.background ?? "rgba(0,0,0,0.05)";
    frame.zIndex = 1000;
    frame.isPointerBlocker = false;
  
    ui.addControl(frame);
  
    dot = new BABYLON.GUI.Ellipse("minimapDot");
    dot.width = options.dotSize ?? "10px";
    dot.height = options.dotSize ?? "10px";
    dot.color = options.dotBorderColor ?? "white";
    dot.thickness = options.dotThickness ?? 2;
    dot.background = options.dotFillColor ?? "red";
    dot.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    dot.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    dot.zIndex = 1000;
    dot.isPointerBlocker = false;
  
    frame.addControl(dot);
  }



  let enabled = true;

  function vpToPercent(v) {
    return (v * 100).toFixed(2) + "%";
  }

  function setEnabled(v) {
    enabled = v;
  
    if (enabled) {
      // Use both cameras while playing
      scene.activeCameras = [minimapCamera, mainCamera];
      minimapCamera.viewport = new BABYLON.Viewport(viewX, viewY, viewW, viewH);
    } else {
      // IMPORTANT: go back to single-camera mode so GUI picking works in menus
      scene.activeCameras = null;
      scene.activeCamera = mainCamera;
  
      minimapCamera.viewport = new BABYLON.Viewport(0, 0, 0, 0);
    }
  
    //if (frame) frame.isVisible = enabled;
  }

  function setOverlayVisible(v) {
      if (frame) frame.isVisible = v;
      if (dot) dot.isVisible = v;
  }


  function updateFromPlayerMesh(playerMesh) {
    if (!enabled) return;
    if (!playerMesh) return;

    const pos = playerMesh.position;
    const up = pos.clone();
    if (up.lengthSquared() > 0) up.normalize();
    else up.set(0, 1, 0);

    minimapCamera.position.copyFrom(pos.add(up.scale(height)));
    minimapCamera.setTarget(pos);
  }

  function dispose() {
    try {
      if (frame) frame.dispose();
      minimapCamera.dispose();
    } catch (_) {}
  }

  // Start enabled by default
  setEnabled(true);

  return {
    minimapCamera,
    MAIN_LAYER,
    MINIMAP_LAYER,
    setEnabled,
    setOverlayVisible,
    updateFromPlayerMesh,
    dispose
  };
}



























