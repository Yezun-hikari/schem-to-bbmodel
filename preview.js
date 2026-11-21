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

export function showPreview(canvas, bbmodel) {
  if (!renderer) init(canvas);
  if (model) {
    scene.remove(model);
    model.traverse((o) => o.geometry?.dispose());
    model.userData.materials.forEach((m) => { m.map?.dispose(); m.dispose(); });
  }
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const materials = bbmodel.textures.map((t) => {
    const map = new THREE.TextureLoader().load(t.source ?? '');
    map.magFilter = THREE.NearestFilter;
    map.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshLambertMaterial({ map, transparent: true, alphaTest: 0.05 });
  });
  model = new THREE.Group();
  model.userData.materials = [...materials, hidden];

  for (const el of bbmodel.elements) {
    const size = [0, 1, 2].map((i) => el.to[i] - el.from[i]);
    const geo = new THREE.BoxGeometry(...size);
    const uv = geo.attributes.uv;
    BOX_FACES.forEach((name, fi) => {
      const f = el.faces[name];
      if (f?.texture == null) return;
      const [u1, v1, u2, v2] = f.uv;
      // Corners clockwise from top-left; a face rotation shifts which texture corner lands where
      const tex = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
      const steps = ((f.rotation ?? 0) / 90) | 0;
      // BoxGeometry vertex order per face: top-left, top-right, bottom-left, bottom-right
      [0, 1, 3, 2].forEach((corner, vi) => {
        const [u, v] = tex[(corner - steps + 4) % 4];
        uv.setXY(fi * 4 + vi, u / 16, 1 - v / 16);
      });
    });
    const mats = BOX_FACES.map((n) => materials[el.faces[n]?.texture] ?? hidden);
    const mesh = new THREE.Mesh(geo, mats);
    const pivot = new THREE.Group();
    pivot.position.set(...el.origin);
    pivot.rotation.set(...el.rotation.map(THREE.MathUtils.degToRad), 'ZYX');
    mesh.position.set(...[0, 1, 2].map((i) => (el.from[i] + el.to[i]) / 2 - el.origin[i]));
    pivot.add(mesh);
    model.add(pivot);
  }
  scene.add(model);

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 8;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(radius * 2.6));
  camera.near = radius / 100; camera.far = radius * 20;
  camera.updateProjectionMatrix();
}
