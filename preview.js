// 3D preview of a generated .bbmodel with three.js (orbit with mouse/touch).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// BoxGeometry face groups in order +x, -x, +y, -y, +z, -z; their default UVs match Minecraft's face orientation
const BOX_FACES = ['east', 'west', 'up', 'down', 'south', 'north'];

let renderer, scene, camera, controls, model;

function init(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.6, 1, 0.4);
  scene.add(sun);
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = canvas;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe(canvas);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}

export function showPreview(canvas, bbmodel, keepView = false) {
  if (!renderer) init(canvas);
  if (model) {
    scene.remove(model);
    model.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
  }
  // All faces sharing a texture go into one merged mesh: one draw call per texture instead of per cube
  const batches = bbmodel.textures.map(() => ({ pos: [], nor: [], uv: [], idx: [] }));
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const uPos = unit.attributes.position.array, uNor = unit.attributes.normal.array, uIdx = unit.index.array;
  const m = new THREE.Matrix4(), rot = new THREE.Matrix4(), e = new THREE.Euler(), v = new THREE.Vector3();
  const pivot = new THREE.Matrix4(), offset = new THREE.Matrix4(), scale = new THREE.Matrix4();

  for (const el of bbmodel.elements) {
    e.set(...el.rotation.map(THREE.MathUtils.degToRad), 'ZYX');
    rot.makeRotationFromEuler(e);
    pivot.makeTranslation(...el.origin);
    offset.makeTranslation(...[0, 1, 2].map((i) => (el.from[i] + el.to[i]) / 2 - el.origin[i]));
    scale.makeScale(...[0, 1, 2].map((i) => el.to[i] - el.from[i]));
    m.copy(pivot).multiply(rot).multiply(offset).multiply(scale);
    BOX_FACES.forEach((name, fi) => {
      const f = el.faces[name];
      const b = batches[f?.texture];
      if (!b) return;
      const [u1, v1, u2, v2] = f.uv;
      // Corners clockwise from top-left; a face rotation shifts which texture corner lands where
      const tex = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
      const steps = ((f.rotation ?? 0) / 90) | 0;
      const base = b.pos.length / 3;
      // BoxGeometry vertex order per face: top-left, top-right, bottom-left, bottom-right
      [0, 1, 3, 2].forEach((corner, vi) => {
        const k = (fi * 4 + vi) * 3;
        v.fromArray(uPos, k).applyMatrix4(m);
        b.pos.push(v.x, v.y, v.z);
        v.fromArray(uNor, k).transformDirection(rot);
        b.nor.push(v.x, v.y, v.z);
        const [u, w] = tex[(corner - steps + 4) % 4];
        b.uv.push(u / 16, 1 - w / 16);
      });
      for (let i = fi * 6; i < fi * 6 + 6; i++) b.idx.push(base + uIdx[i] - fi * 4);
    });
  }
  unit.dispose();

  model = new THREE.Group();
  bbmodel.textures.forEach((t, ti) => {
    const b = batches[ti];
    if (!b.idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setIndex(b.idx);
    const map = new THREE.TextureLoader().load(t.source ?? '');
    map.magFilter = THREE.NearestFilter;
    map.colorSpace = THREE.SRGBColorSpace;
    model.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map, transparent: true, alphaTest: 0.05 })));
  });
  scene.add(model);
  if (keepView) return; // live update after an option change: leave the camera where the user put it

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 8;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(radius * 2.6));
  camera.near = radius / 100; camera.far = radius * 20;
  camera.updateProjectionMatrix();
}
