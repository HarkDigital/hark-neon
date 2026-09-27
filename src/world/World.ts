import * as THREE from 'three'
import type { Frame } from '../core/types'

/*
 * The shared world: THE SHOP AT NIGHT, whatever every chapter has behind it.
 *
 *   dome      near-black backdrop, a faint tinted haze glow low in the frame
 *             (the light of signs out of shot bouncing around the room)
 *   haze      FogExp2 — depth falls off into dark violet
 *   motes     dust drifting in the air, catching the tubes' colour; world-
 *             anchored, wrapped around the camera (no scroll accumulation)
 *   env       a PMREM "neon room" (colour strips on black), so glossy glass,
 *             acrylic, chrome and sealed concrete reflect tubes
 *   fill      a dim hemisphere so unlit props aren't pure black holes
 *
 * Keep what the engine calls: `object`, `params`, `resetParams()`,
 * `update(frame, camera)`, `warmEnv()` (prewarm: lit programs key on the env).
 * Chapters set world.params each frame they care; the engine resets them to
 * defaults first; values are damped so cuts never pop.
 */

export interface WorldParams {
  /** backdrop gradient (above the horizon / below) */
  top: THREE.ColorRepresentation
  bottom: THREE.ColorRepresentation
  /** haze glow band low in the frame: strength 0..1 and colour */
  glow: number
  glowColor: THREE.ColorRepresentation
  /** FogExp2 density (0 = none) and colour */
  fog: number
  fogColor: THREE.ColorRepresentation
  /** dust motes 0..1 and their tint */
  motes: number
  moteColor: THREE.ColorRepresentation
  /** scene.environmentIntensity (the neon-room reflections) */
  env: number
  /** hemisphere fill strength */
  fill: number
}

export const WORLD_DEFAULTS = {
  top: '#050408',
  bottom: '#0a0710',
  glow: 0.35,
  glowColor: '#ff2e97',
  fog: 0.028,
  fogColor: '#08060d',
  motes: 0.5,
  moteColor: '#ffd6ec',
  env: 0.55,
  fill: 0.18,
}

const MOTE_BOX = 12

export class World {
  object = new THREE.Group()
  hemi: THREE.HemisphereLight
  params: WorldParams = { ...WORLD_DEFAULTS }
  private cur = {
    top: new THREE.Color(),
    bottom: new THREE.Color(),
    glowColor: new THREE.Color(),
    fogColor: new THREE.Color(),
    moteColor: new THREE.Color(),
    glow: WORLD_DEFAULTS.glow,
    fog: WORLD_DEFAULTS.fog,
    motes: WORLD_DEFAULTS.motes,
    env: WORLD_DEFAULTS.env,
    fill: WORLD_DEFAULTS.fill,
  }
  private first = true
  private domeU = {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uGlowAmt: { value: 0 },
  }
  private moteU = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uColor: { value: new THREE.Color() },
    uAmount: { value: 0 },
    uPx: { value: 1 },
  }
  private motes: THREE.Points
  private fog: THREE.FogExp2
  private envTex: THREE.Texture | null = null
  private tmp = new THREE.Color()

  constructor(
    private scene: THREE.Scene,
    mobile: boolean,
    private renderer: THREE.WebGLRenderer,
  ) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: this.domeU,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uBottom, uGlow;
          uniform float uGlowAmt;
          varying vec3 vDir;
          float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y * 0.5 + 0.5;
            vec3 c = mix(uBottom, uTop, smoothstep(0.3, 0.8, h));
            // a low band of bounced sign light, strongest just under the horizon
            float band = exp(-abs(d.y + 0.06) * 7.0);
            c += uGlow * band * uGlowAmt * 0.16;
            c += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // dither: no banding in the blacks
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      }),
    )
    dome.frustumCulled = false
    dome.renderOrder = -10
    this.object.add(dome)

    this.fog = new THREE.FogExp2(WORLD_DEFAULTS.fogColor, WORLD_DEFAULTS.fog)
    scene.fog = this.fog

    // dust motes: a box of points around the camera, world-anchored by wrapping
    const n = mobile ? 420 : 1100
    const pos = new Float32Array(n * 3)
    const seed = new Float32Array(n)
    let s = 3
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < n; i++) {
      pos[i * 3] = r() * MOTE_BOX
      pos[i * 3 + 1] = r() * MOTE_BOX
      pos[i * 3 + 2] = r() * MOTE_BOX
      seed[i] = r()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    this.motes = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.moteU,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          uniform float uTime, uPx;
          uniform vec3 uCam;
          attribute float aSeed;
          varying float vA;
          const float B = ${MOTE_BOX.toFixed(1)};
          void main() {
            vec3 drift = vec3(sin(uTime * 0.11 + aSeed * 40.0) * 0.25, uTime * (0.015 + aSeed * 0.03), cos(uTime * 0.09 + aSeed * 17.0) * 0.25);
            vec3 p = mod(position + drift - uCam + B * 0.5, B) - B * 0.5 + uCam;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float d = -mv.z;
            // fade at the box edge and right at the lens
            float edge = 1.0 - smoothstep(B * 0.32, B * 0.5, length(p - uCam));
            vA = edge * smoothstep(0.4, 1.4, d) * (0.35 + 0.65 * fract(aSeed * 7.13));
            gl_PointSize = clamp(uPx * (1.2 + aSeed * 1.6) * (4.0 / max(d, 0.5)), 1.0, 6.0 * uPx);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uAmount;
          varying float vA;
          void main() {
            vec2 q = gl_PointCoord - 0.5;
            float a = 1.0 - smoothstep(0.1, 0.5, length(q));
            gl_FragColor = vec4(uColor * a * vA * uAmount * 0.55, 1.0);
          }
        `,
      }),
    )
    this.motes.frustumCulled = false
    this.motes.renderOrder = 5
    // motes live in world space (not in the camera-following object)
    scene.add(this.motes)

    this.hemi = new THREE.HemisphereLight(0xb9a6d6, 0x1a1016, WORLD_DEFAULTS.fill)
    scene.add(this.hemi)
  }

  /**
   * The "neon room" env map: colour strips on black, prefiltered with PMREM
   * on the GPU. Built once, before prewarm, so lit programs compile with it.
   */
  warmEnv() {
    if (this.envTex) return
    const room = new THREE.Scene()
    room.background = new THREE.Color(0x020203)
    const strip = (color: string, hdr: number, w: number, h: number, x: number, y: number, z: number, ry = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(hdr), side: THREE.DoubleSide }))
      m.position.set(x, y, z)
      m.rotation.y = ry
      room.add(m)
    }
    // ceiling fluorescents
    strip('#eef3ff', 2.2, 4, 0.18, 0, 3.2, -2)
    strip('#eef3ff', 2.2, 4, 0.18, 0, 3.2, 2)
    // signs around the room
    strip('#ff2e97', 3.0, 2.4, 0.12, -3.4, 1.6, 0, Math.PI / 2)
    strip('#ff2e97', 2.4, 1.2, 0.1, -3.4, 1.1, 1.2, Math.PI / 2)
    strip('#2cb4ff', 3.0, 2.0, 0.12, 3.4, 1.8, -0.6, -Math.PI / 2)
    strip('#9b5cff', 2.2, 1.6, 0.1, 0.4, 1.4, -3.4)
    strip('#ffa126', 2.0, 1.4, 0.1, -1.2, 0.9, 3.4)
    strip('#ff4220', 1.8, 0.8, 0.1, 1.8, 2.2, 3.4)
    const pm = new THREE.PMREMGenerator(this.renderer)
    this.envTex = pm.fromScene(room, 0.03).texture
    pm.dispose()
    room.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    })
    this.scene.environment = this.envTex
  }

  resetParams() {
    Object.assign(this.params, WORLD_DEFAULTS)
  }

  update(frame: Frame, camera: THREE.Camera) {
    if (!this.envTex) this.warmEnv()
    const p = this.params
    const c = this.cur
    if (this.first) {
      c.top.set(p.top)
      c.bottom.set(p.bottom)
      c.glowColor.set(p.glowColor)
      c.fogColor.set(p.fogColor)
      c.moteColor.set(p.moteColor)
      c.glow = p.glow
      c.fog = p.fog
      c.motes = p.motes
      c.env = p.env
      c.fill = p.fill
      this.first = false
    }
    const k = 1 - Math.exp(-5 * frame.dt)
    c.top.lerp(this.tmp.set(p.top), k)
    c.bottom.lerp(this.tmp.set(p.bottom), k)
    c.glowColor.lerp(this.tmp.set(p.glowColor), k)
    c.fogColor.lerp(this.tmp.set(p.fogColor), k)
    c.moteColor.lerp(this.tmp.set(p.moteColor), k)
    c.glow += (p.glow - c.glow) * k
    c.fog += (p.fog - c.fog) * k
    c.motes += (p.motes - c.motes) * k
    c.env += (p.env - c.env) * k
    c.fill += (p.fill - c.fill) * k

    this.domeU.uTop.value.copy(c.top)
    this.domeU.uBottom.value.copy(c.bottom)
    this.domeU.uGlow.value.copy(c.glowColor)
    this.domeU.uGlowAmt.value = c.glow
    this.fog.color.copy(c.fogColor)
    this.fog.density = c.fog
    this.scene.environmentIntensity = c.env
    this.hemi.intensity = c.fill

    this.moteU.uTime.value = frame.time
    this.moteU.uCam.value.copy(camera.position)
    this.moteU.uColor.value.copy(c.moteColor)
    this.moteU.uAmount.value = frame.reducedMotion ? c.motes * 0.6 : c.motes
    this.moteU.uPx.value = this.renderer.getPixelRatio()
    this.motes.visible = c.motes > 0.01

    this.object.position.copy(camera.position)
  }
}
