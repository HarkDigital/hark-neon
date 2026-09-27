# Hark Neon — concept site

A Hark Digital concept direction: **a neon sign shop after hours**. Glass
tubes bent along the Hark mark, words bent from single-stroke script, frames
and icons in eleven colours of gas, striking on as the camera arrives; bare
fluorescents, black-plum brick, sealed concrete streaked with reflections. At
scroll speed the brightest tubes smear into long-exposure light trails, and
chapters cut "lights-out / strike": the frame goes dark in order of
brightness, then the next scene strikes on brightest-first.

Built from `Hark Concept Starter` (see `../HARK-CONCEPT-PLAYBOOK.md`).

**Live:** https://harkdigital.github.io/hark-neon/

| Chapter | Label | Scene |
|---|---|---|
| hero | Lights On | the front room: fluorescents strike, the mark ignites, lights out, neon only |
| work | The Sign Wall | six lightbox signs (the featured projects), names bent in neon, a pickup board |
| services | Tube Chart | eleven tube colours, eleven service icons bent in glass |
| voices | Word of Mouth | neon speech bubbles in the shop window, a bokeh street beyond |
| shield | Short Circuit | "HACKED?" shorts out, the breaker resets, "breathe." in argon blue, 24/7 |
| process | The Bench | pattern, ribbon burner, a tube bent to "hello", the stats in neon |
| contact | Open Late | a real OPEN sign, "Say hello." writes itself, the shop goes dark |

Kit: `src/kit/neon.ts` (tubes, blockout jumpers, electrodes, `Striker` with a
site-wide flash budget, wall spill), `src/kit/type.ts` (EMS single-line fonts,
SIL OFL, via hersheytext — `scripts/build-neon-fonts.mjs`), `src/kit/shop.ts`
(brick, concrete, acrylic, fluorescent fixtures, RectAreaLights).

```bash
npm install
npm run dev
npm run build
```
