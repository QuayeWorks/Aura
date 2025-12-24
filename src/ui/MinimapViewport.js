// MinimapViewport.js
// Viewport-based minimap: second camera renders into bottom-left viewport.
// Terrain colors match automatically because it renders the real meshes.

export function createMinimapViewport({
  scene,
  mainCamera,
  uiMinimap,
  options = {}
}) {
  const MAIN_LAYER = options.mainLayer ?? 0x1;
  const MINIMAP_LAYER = options.minimapLayer ?? 0x2;

  const viewX = options.viewportX ?? 0.02;
  const viewY = options.viewportY ?? 0.02;
  const viewW = options.viewportW ?? 0.1;
  const viewH = options.viewportH ?? 0.1;

  const worldRadius = options.worldRadius ?? 350; // zoom (world units around player)
  const height = options.height ?? 800;          // height above player
  const padLeft = options.uiLeft ?? "0%";
  const padTop = options.uiTop ?? "0%";
  const sizeW = options.uiWidth ?? "1%";
  const sizeH = options.uiHeight ?? "1%";

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
  minimapCamera.maxZ = Math.max(50000, (options.maxZ ?? 200000));

  // UI frame overlay (optional)
  let frame = null;
  let dot = null;
  
  if (uiMinimap) {
    // --- Safety: remove any previous minimap UI controls (prevents duplicates) ---
    if (uiMinimap.getControlByName) {
      const oldFrame = uiMinimap.getControlByName("minimapFrame");
      if (oldFrame) oldFrame.dispose();
  
      const oldDot = uiMinimap.getControlByName("minimapDot");
      if (oldDot) oldDot.dispose();
    }
  
    const engine = scene.getEngine();
  
    const computeFramePixels = () => {
      const w = engine.getRenderWidth(true);
      const h = engine.getRenderHeight(true);
  
      // Viewport coords: bottom-left origin
      const pxLeft = Math.round(viewX * w);
      const pxTop  = Math.round((1.0 - (viewY + viewH)) * h); // GUI top-left origin
      const pxW    = Math.round(viewW * w);
      const pxH    = Math.round(viewH * h);
  
      return { pxLeft, pxTop, pxW, pxH };
    };
  
    frame = new BABYLON.GUI.Rectangle("minimapFrame");
  
    // Pixel-perfect sizing/positioning to match the viewport exactly
    const { pxLeft, pxTop, pxW, pxH } = computeFramePixels();
    frame.width  = pxW + "px";
    frame.height = pxH + "px";
  
    frame.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    frame.verticalAlignment   = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    frame.left = pxLeft + "px";
    frame.top  = pxTop + "px";
  
    frame.thickness = options.thickness ?? 2;
    frame.color = options.borderColor ?? "#ffffff";
    frame.cornerRadius = options.cornerRadius ?? 12;
    frame.alpha = options.alpha ?? 0.95;
    frame.clipChildren = true;
  
    // Give it enough backing so the world behind doesn't look like minimap bleed
    frame.background = options.background ?? "rgba(0,0,0,0.55)";
  
    frame.zIndex = 1000;
    frame.isPointerBlocker = false;
  
    uiMinimap.addControl(frame);
  
    dot = new BABYLON.GUI.Ellipse("minimapDot");
    dot.width = options.dotSize ?? "10px";
    dot.height = options.dotSize ?? "10px";
    dot.color = options.dotBorderColor ?? "white";
    dot.thickness = options.dotThickness ?? 2;
    dot.background = options.dotFillColor ?? "red";
    dot.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    dot.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    dot.zIndex = 1001;
    dot.isPointerBlocker = false;
  
    frame.addControl(dot);
  
    // Keep it pixel-perfect when the canvas resizes (window resize / DPR changes)
    engine.onResizeObservable.add(() => {
      if (!frame) return;
      const r = computeFramePixels();
      frame.width  = r.pxW + "px";
      frame.height = r.pxH + "px";
      frame.left   = r.pxLeft + "px";
      frame.top    = r.pxTop + "px";
    });
  }



  let enabled = true;

  function vpToPercent(v) {
    return (v * 100).toFixed(2) + "%";
  }

  function setEnabled(v) {
    enabled = !!v;
  
    if (enabled) {
      scene.activeCameras = [mainCamera, minimapCamera];
      minimapCamera.viewport = new BABYLON.Viewport(viewX, viewY, viewW, viewH);
    } else {
      scene.activeCameras = null;
      scene.activeCamera = mainCamera;
      minimapCamera.viewport = new BABYLON.Viewport(0, 0, 0, 0);
    }
  
    if (frame) frame.isVisible = enabled;
    if (dot) dot.isVisible = enabled;
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









