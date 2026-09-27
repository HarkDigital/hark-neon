import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/*
 * Post-processing: Scene (+ Sanitize NaN guard) → Bloom → Output → FINAL.
 * Only the scene render is multisampled (its own target, the only one with a
 * depth buffer); the composer's ping-pong targets are single-sampled.
 *
 * THEME: the FINAL pass is where a concept gets its signature look and its
 * chapter-cut transition. Previous concepts replaced it with:
 *   Orbit      glitch tear + zoom blur + white-green flash
 *   Resonance  pressure-wave ripple + paper wash
 *   Press      ink densities → rotated halftone screens (riso)
 *   Town       tilt-shift blur + miniature saturation + cloud wipe
 *   Arcade     pixelate + palette snap + Bayer dither + CRT + iris wipe
 *   Noir       silver-gelatin B&W, one hue survives, venetian-blind cut
 *
 * NEON: a night photograph of a sign shop. The bloom pass IS the glow (tuned
 * for thin HDR tubes), then the final pass adds a touch of vibrance, a crushed
 * black floor, faint lens fringing, grain and a vignette — and two neon-only
 * effects:
 *   LONG EXPOSURE   at scroll speed, the brightest tubes smear into light
 *                   trails along the scroll (a camera dragged on a slow
 *                   shutter). Only what glows streaks; darks never do.
 *   LIGHTS-OUT CUT  the chapter cut: the frame goes dark in order of
 *                   brightness (walls, then props, then the tubes last), the
 *                   hottest tubes smear into trails, black at the boundary,
 *                   then the next scene STRIKES on brightest-first and fills in.
 * Calm (reduced motion / Motion off): no trails, a fade through black.
 *
 * The pass runs AFTER the sRGB output pass: it sees display values. Keep the
 * Post API (params / resetParams / setSize / render / compileAsync /
 * setFadeTone) and the uTransition / uFade / uFlash / uGlitch uniforms — the
 * engine drives them.
 */

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    /** 0..1, peaks exactly at a chapter boundary (engine-driven) */
    uTransition: { value: 0 },
    /** 0..1 electrical interference: torn horizontal bands (the short circuit) */
    uGlitch: { value: 0 },
    uAberration: { value: 0.0012 },
    uGrain: { value: 0.024 },
    uVignette: { value: 0.42 },
    /** 0..1 wash to white */
    uFlash: { value: 0 },
    /** 0..1 fade to uFadeColor (calm cuts) */
    uFade: { value: 0 },
    uCutColor: { value: new THREE.Color('#050408') },
    uFadeColor: { value: new THREE.Color('#050408') },
    /** light-trail length (uv) from scroll speed, and its direction (+1 / -1) */
    uTrail: { value: 0 },
    uTrailDir: { value: 1 },
    /** the colour trails cool toward (display value) */
    uTrailTint: { value: new THREE.Color('#ff2e97').convertLinearToSRGB() },
    /** 0..1 how far trails pull toward uTrailTint (0 = each tube's own colour) */
    uTrailMix: { value: 0 },
    /** 0..1 speed dim: the whole frame dims while the page moves fast (flash safety net) */
    uSpeedDim: { value: 0 },
    /** vibrance (1 = none) and black-point lift */
    uSat: { value: 1.08 },
    uLift: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uDpr, uTransition, uGlitch, uAberration, uGrain, uVignette, uFlash, uFade, uTrail, uTrailDir, uTrailMix, uSat, uLift, uSpeedDim;
    uniform vec2 uResolution;
    uniform vec3 uCutColor, uFadeColor, uTrailTint;
    varying vec2 vUv;

    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float peak(vec3 c) { return max(c.r, max(c.g, c.b)); }
    // only what glows: a soft bright-pass on display values
    vec3 hot(vec2 uv, float thr) {
      vec3 c = texture2D(tDiffuse, uv).rgb;
      return c * smoothstep(thr, thr + 0.2, peak(c));
    }

    void main() {
      vec2 uv = vUv;
      // electrical interference: a few torn bands that jump sideways, 20 fps
      float g = clamp(uGlitch, 0.0, 1.0);
      if (g > 0.001) {
        float fr = floor(uTime * 20.0);
        float band = floor(uv.y * 34.0);
        float on = step(1.0 - 0.3 * g, hash(vec2(band, fr)));
        uv.x += on * (hash(vec2(band * 3.1, fr + 7.0)) - 0.5) * 0.045 * g;
      }
      vec2 c = uv - 0.5;
      float ab = uAberration * (1.0 + 2.5 * g);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      // LIGHTS-OUT / STRIKE: a rising cut-off in brightness; the tubes go last
      float t = clamp(uTransition, 0.0, 1.0);
      if (t > 0.001) {
        float thr = t * 1.2 - 0.14;
        float keep = smoothstep(thr - 0.05, thr + 0.22, peak(col));
        col *= mix(1.0, keep, smoothstep(0.0, 0.12, t));
      }

      // LONG EXPOSURE: bright tubes smear along the scroll (and through the cut)
      float L = uTrail + t * (1.0 - t) * 0.5;
      if (L > 0.0025) {
        float tthr = mix(0.6, 0.42, t);
        // half smear (the integral a slow shutter records), half comet (the
        // brightest sample, fading with distance): streaks keep a crisp edge
        vec3 acc = vec3(0.0);
        vec3 comet = vec3(0.0);
        float ws = 0.0;
        // per-pixel jitter on the taps: noise instead of stepped ghost copies
        float jit = hash(gl_FragCoord.xy + fract(uTime) * 13.0);
        for (int i = 1; i <= 10; i++) {
          float k = (float(i) - jit) / 10.0;
          float w = (1.0 - k) * (1.0 - k);
          vec3 h = hot(uv + vec2(0.0, -k * L * uTrailDir), tthr);
          acc += h * w;
          comet = max(comet, h * (1.0 - k));
          ws += w;
        }
        vec3 trail = mix(acc / ws, comet, 0.55);
        // each tube keeps its own colour (uTrailTint can pull them together: 0 by default)
        float tl = dot(trail, vec3(0.2126, 0.7152, 0.0722));
        trail = mix(trail, uTrailTint * tl * 1.5, uTrailMix);
        // the cut's trails fade as the frame reaches black
        trail *= 1.0 - smoothstep(0.7, 1.0, t);
        col = max(col, trail * 1.15);
      }
      col = mix(col, uCutColor, smoothstep(0.86, 1.0, t));

      // grade: a little vibrance, a clean black floor, optional lift
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(l), col, uSat), 0.0);
      col = uLift + col * (1.0 - uLift);

      // flash safety net: bright things sweeping past at speed swing each
      // screen block's luminance; dimming the frame at speed shrinks every swing
      col *= 1.0 - clamp(uSpeedDim, 0.0, 0.8);
      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      float v = 1.0 - smoothstep(0.35, 1.05, length(c * vec2(1.0, 0.9)) * 1.4);
      col *= mix(1.0, 0.5 + 0.5 * v, uVignette);
      // grain: coarser on dense screens so it reads the same size, 24 fps
      vec2 gp = floor(vUv * uResolution / max(1.0, uDpr));
      col += (hash(gp + fract(floor(uTime * 24.0) * 0.1317) * 97.0) - 0.5) * uGrain;
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

/** minimum seconds between two white-flash onsets (WCAG 2.3.1) */
const FLASH_GAP = 0.4

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  aberration: number
  grain: number
  vignette: number
  /** electrical interference 0..1 */
  glitch: number
  /** white wash 0..1 */
  flash: number
  exposure: number
  /** scale on the scroll-speed light trails (0 = none) */
  trails: number
  /** vibrance (1 = none) */
  saturation: number
  /** black-point lift 0..0.15 */
  lift: number
}

/**
 * Bloom is the neon glow: only HDR (> ~0.9) catches it — the tubes, the
 * fluorescent strips. Screenshots and DOM-like surfaces must stay below it.
 */
export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0.8,
  bloomRadius: 0.28,
  bloomThreshold: 0.9,
  aberration: 0.0012,
  grain: 0.024,
  vignette: 0.42,
  glitch: 0,
  flash: 0,
  exposure: 1,
  trails: 1,
  saturation: 1.08,
  lift: 0,
}

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through bloom.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
}

/**
 * Renders the scene into its OWN target — the only multisampled one and the
 * only one with depth — then sanitizes (NaN guard) into the composer's
 * single-sampled read buffer. Multisampled ping-pong targets cost 2–3x per
 * post pass (Frost's lesson), so MSAA lives here only.
 */
class ScenePass extends Pass {
  target: THREE.WebGLRenderTarget
  material: THREE.ShaderMaterial
  private quad: FullScreenQuad
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    samples: number,
  ) {
    super()
    this.needsSwap = false
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples })
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SanitizeShader.uniforms),
      vertexShader: SanitizeShader.vertexShader,
      fragmentShader: SanitizeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.material)
  }
  setSize(w: number, h: number) {
    this.target.setSize(w, h)
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    this.material.uniforms.tDiffuse.value = this.target.texture
    renderer.setRenderTarget(this.renderToScreen ? null : read)
    this.quad.render(renderer)
  }
}

export class Post {
  composer: EffectComposer
  bloom: UnrealBloomPass
  final: ShaderPass
  private scenePass: ScenePass
  /**
   * Chapters write targets here every frame (the engine resets them to
   * defaults first); values are damped so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  fade = 0
  /** engine: reduced motion or the visitor's Motion switch is off (no trails, no interference) */
  calm = false
  /** engine: smoothed scroll velocity in viewport heights per second (signed) */
  velocity = 0
  /** engine: +1 when the nearest boundary is ahead (leaving a chapter), -1 when behind (entering) */
  cutSide = 1
  private trail = 0
  private speedDim = 0
  /**
   * Run right before the scene renders each frame, at the TOP level (camera
   * already placed, its matrixWorld updated). Mirrors/reflectors render here
   * instead of from Mesh.onBeforeRender: a nested render makes every lit
   * material re-resolve its program twice a frame. Check your own group's
   * visibility inside the hook (it runs whichever chapter is active).
   */
  preRender: ((renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void)[] = []
  private lastFlashAt = -1e9
  private flashLive = false
  private flashOk = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    /** skip MSAA (retina / mobile: already supersampled; MSAA half-float targets are huge) */
    noMsaa: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
      depthBuffer: false,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.scenePass = new ScenePass(scene, camera, noMsaa ? 0 : 4)
    this.composer.addPass(this.scenePass)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), POST_DEFAULTS.bloomStrength, POST_DEFAULTS.bloomRadius, POST_DEFAULTS.bloomThreshold)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.final = new ShaderPass(FinalShader)
    this.composer.addPass(this.final)
  }

  /** The scene's render target (HDR, linear; multisampled on 1x desktops) — prewarm compiles against it. */
  get sceneTarget() {
    return this.scenePass.target
  }

  /** true when `rt` is the frame's own scene target (not a mirror / transmission pass) */
  isFrameTarget(rt: THREE.WebGLRenderTarget | null) {
    return rt === this.scenePass.target
  }

  /** THEME: colour the cut and calm fade pass through. */
  setCutColor(color: THREE.ColorRepresentation) {
    ;(this.final.uniforms.uCutColor.value as THREE.Color).set(color)
    ;(this.final.uniforms.uFadeColor.value as THREE.Color).set(color)
  }

  /** the colour light trails cool toward (a TUBE hex) */
  setTrailTint(color: THREE.ColorRepresentation) {
    ;(this.final.uniforms.uTrailTint.value as THREE.Color).set(color).convertLinearToSRGB()
  }

  /** Engine hook (kept for compatibility; themes may tint the fade by scene tone). */
  setFadeTone(_tone: number) {}

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  /**
   * Compile every post-processing shader in parallel so the first composer
   * render doesn't block on synchronous links.
   */
  compileAsync(): Promise<unknown> {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const b = this.bloom as unknown as Record<string, unknown>
    const mats: THREE.Material[] = []
    const add = (m: unknown) => {
      if (m && (m as THREE.Material).isMaterial) mats.push(m as THREE.Material)
    }
    for (const pass of this.composer.passes) add((pass as unknown as { material?: unknown }).material)
    for (const m of (b.separableBlurMaterials as unknown[]) ?? []) add(m)
    add(b.compositeMaterial)
    add(b.blendMaterial)
    add(b.materialHighPassFilter)
    add(b.copyMaterial)
    return Promise.all(mats.map(m => this.renderer.compileAsync(new THREE.Mesh(quad.geometry, m), cam).catch(() => {})))
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.final.uniforms.uDpr.value = dpr
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    // flash budget (WCAG 2.3.1): a flash starting within FLASH_GAP of the last is dropped
    if (c.flash > 0.02) {
      if (!this.flashLive) {
        this.flashLive = true
        this.flashOk = time - this.lastFlashAt >= FLASH_GAP
        if (this.flashOk) this.lastFlashAt = time
      }
      if (!this.flashOk) c.flash = 0
    } else this.flashLive = false
    // long exposure: trails only past a brisk scroll, capped, damped (never a pop)
    const speed = Math.abs(this.velocity)
    const want = this.calm ? 0 : Math.min(0.055, Math.max(0, speed - 1.2) * 0.012) * c.trails
    this.trail += (want - this.trail) * (1 - Math.exp(-8 * dt))
    // speed dim (WCAG 2.3.1 safety net): the frame dims as the page moves fast,
    // attack ~0.2 s, release ~0.6 s — slow enough that wheel notches under
    // reduced motion (instant scroll, spiky velocity) read as one steady dim
    {
      const v = Math.abs(this.velocity)
      const x = Math.max(0, Math.min(1, (v - 1.1) / 2.4))
      const target = x * x * (3 - 2 * x) * 0.5
      const tau = target > this.speedDim ? 0.2 : 0.6
      this.speedDim += (target - this.speedDim) * (1 - Math.exp(-dt / tau))
    }
    // chapters zero bloom where nothing crosses the threshold: skip the pass entirely
    this.bloom.enabled = c.bloomStrength > 0.01
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uGlitch.value = this.calm ? 0 : c.glitch
    u.uAberration.value = c.aberration
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uFade.value = this.fade
    u.uTrail.value = this.trail
    u.uTrailDir.value = this.velocity < 0 ? -1 : 1
    u.uSpeedDim.value = this.speedDim
    u.uSat.value = c.saturation
    u.uLift.value = c.lift
    if (this.preRender.length) {
      this.camera.updateMatrixWorld()
      for (const fn of this.preRender) fn(this.renderer, this.scene, this.camera)
    }
    this.composer.render(dt)
  }
}
