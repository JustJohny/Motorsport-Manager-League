import { ImageOff, Loader2, Rotate3d } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { tintMask } from "../../../src/livery-tint.ts"
import { assetUrl } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { TeamColours } from "@/lib/types"

// FIRE Fantasy 20's car (tools/ff20-car-renders.py) with a livery's UV colour key, tinted like
// FF20's LiveryShader, and the team's stickers on the decal meshes. Models, keys and stickers are
// fetched once per page.
const models = new Map<string, Promise<GLTF>>()
const keys = new Map<string, Promise<ImageData>>()
const stickerImages = new Map<string, Promise<HTMLImageElement>>()
// Decal meshes are "SponsorNN": sticker slot NN - 1, as the league game patch maps them in game.
const SPONSOR = /^Sponsor0([1-6])$/
// MM's decals are 2:1; stickers are drawn at their size onto one this big.
const DECAL_W = 1024, DECAL_H = 512

function loadSticker(url: string): Promise<HTMLImageElement> {
  let p = stickerImages.get(url)
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`No sticker ${url}`))
      img.src = url
    })
    stickerImages.set(url, p)
    p.catch(() => stickerImages.delete(url))
  }
  return p
}

/** A car sticker: its image and its size as a share of the spot (1 = fitted to it). */
export interface CarSticker { url: string; scale: number }

function loadModel(model: string): Promise<GLTF> {
  let p = models.get(model)
  if (!p) {
    p = new GLTFLoader().loadAsync(assetUrl("liveries", `${model}-car.glb`))
    models.set(model, p)
    p.catch(() => models.delete(model))
  }
  return p
}

function loadKey(file: string): Promise<ImageData> {
  let p = keys.get(file)
  if (!p) {
    p = new Promise<ImageData>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => {
        const c = document.createElement("canvas")
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext("2d")!
        ctx.drawImage(img, 0, 0)
        resolve(ctx.getImageData(0, 0, c.width, c.height))
      }
      img.onerror = () => reject(new Error(`No livery texture ${file}`))
      img.src = assetUrl("liveries", file)
    })
    keys.set(file, p)
    p.catch(() => keys.delete(file))
  }
  return p
}

/**
 * The car in 3D, in the given colours; drag to turn it, scroll or pinch to zoom. `stickers` are by
 * decal slot (stickerSpots order); a slot without one is blank, as in game.
 */
export default function LiveryCar3D({ model, texture, colours, stickers = [], className }: {
  model: string; texture: string; colours: TeamColours; stickers?: (CarSticker | null | undefined)[]; className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const body = useRef<THREE.MeshStandardMaterial | null>(null)
  const decals = useRef<THREE.MeshStandardMaterial[]>([])
  const canvas = useRef<HTMLCanvasElement>(document.createElement("canvas"))
  const map = useRef<THREE.CanvasTexture | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading")
  const colourKey = `${colours.primary}${colours.secondary}${colours.tertiary}${colours.trim}`
  const stickerKey = Array.from({ length: 6 }, (_, i) => (stickers[i] ? `${stickers[i]!.url}@${stickers[i]!.scale}` : "")).join("|")

  // Scene, camera and the model: once per model.
  useEffect(() => {
    const el = host.current
    if (!el) return
    let live = true
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    el.appendChild(renderer.domElement)
    renderer.domElement.className = "block size-full touch-none"

    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(4, 6, 3)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0xffffff, 0.8)
    fill.position.set(-5, 2, -4)
    scene.add(fill)

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.enablePan = false
    controls.maxPolarAngle = Math.PI * 0.49
    controls.autoRotate = true
    controls.autoRotateSpeed = 1.2
    controls.addEventListener("start", () => { controls.autoRotate = false })

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }

    loadModel(model).then((gltf) => {
      if (!live) return
      const car = gltf.scene.clone(true)
      // One material per decal slot, hidden until it has a sticker; drawn over the body it sits on.
      decals.current = Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial({
        transparent: true, alphaTest: 0.02, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        roughness: 0.5, metalness: 0.1, visible: false,
      }))
      car.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mat = mesh.material as THREE.MeshStandardMaterial
        const slot = SPONSOR.exec(mat.name)
        if (mat.name === "Livery") {
          const own = mat.clone()
          body.current = own
          mesh.material = own
        } else if (slot) {
          mesh.material = decals.current[Number(slot[1]) - 1]
          mesh.renderOrder = 1
        }
      })
      // Stand the car on the ground at the origin.
      const box = new THREE.Box3().setFromObject(car)
      const centre = box.getCenter(new THREE.Vector3())
      car.position.set(-centre.x, -box.min.y, -centre.z)
      scene.add(car)
      const size = box.getSize(new THREE.Vector3())
      const length = Math.max(size.x, size.z)
      const ground = new THREE.Mesh(new THREE.CircleGeometry(length * 0.55, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1 }))
      ground.rotation.x = -Math.PI / 2
      ground.scale.set(0.55, 1, 1)
      ground.position.y = 0.001
      scene.add(ground)
      // Three-quarter view from the front, the car filling the frame.
      controls.target.set(0, size.y * 0.35, 0)
      camera.position.copy(new THREE.Vector3(0.8, 0.32, 0.62).normalize().multiplyScalar(length * 1.15)).add(controls.target)
      controls.minDistance = length * 0.55
      controls.maxDistance = length * 2.2
      setState("ready")
      tick()
    }, () => live && setState("failed"))

    return () => {
      live = false
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      body.current?.dispose()
      body.current = null
      for (const d of decals.current) { d.map?.dispose(); d.dispose() }
      decals.current = []
      map.current?.dispose()
      map.current = null
      renderer.domElement.remove()
    }
  }, [model])

  // The livery in the colours: tint the key and put it on the body.
  useEffect(() => {
    let live = true
    loadKey(texture).then((data) => {
      const mat = body.current
      if (!live) return
      const copy = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height)
      tintMask(copy.data, colours, true)
      const c = canvas.current
      c.width = data.width
      c.height = data.height
      c.getContext("2d")!.putImageData(copy, 0, 0)
      if (!map.current) {
        map.current = new THREE.CanvasTexture(c)
        map.current.flipY = false
        map.current.colorSpace = THREE.SRGBColorSpace
        map.current.anisotropy = 4
      }
      map.current.needsUpdate = true
      if (mat && mat.map !== map.current) {
        mat.map = map.current
        mat.needsUpdate = true
      }
    }, () => live && setState("failed"))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texture, colourKey, state])

  // Stickers on their decal slots, shrunk around the centre like the league game patch does.
  useEffect(() => {
    let live = true
    decals.current.forEach((mat, slot) => {
      const sticker = stickers[slot]
      if (!sticker) {
        mat.visible = false
        return
      }
      loadSticker(sticker.url).then((img) => {
        if (!live) return
        let tex = mat.map as THREE.CanvasTexture | null
        if (!tex) {
          const c = document.createElement("canvas")
          c.width = DECAL_W
          c.height = DECAL_H
          tex = new THREE.CanvasTexture(c)
          tex.flipY = false
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 4
          mat.map = tex
        }
        const c = tex.image as HTMLCanvasElement
        const ctx = c.getContext("2d")!
        const w = DECAL_W * sticker.scale, h = DECAL_H * sticker.scale
        ctx.clearRect(0, 0, DECAL_W, DECAL_H)
        ctx.drawImage(img, (DECAL_W - w) / 2, (DECAL_H - h) / 2, w, h)
        tex.needsUpdate = true
        mat.visible = true
        mat.needsUpdate = true
      }, () => {})
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickerKey, state])

  return (
    <div className={cn("relative aspect-[16/7] w-full overflow-hidden rounded-lg bg-gradient-to-b from-muted to-muted/40", className)}>
      <div ref={host} className="absolute inset-0" />
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading the car</div>
      )}
      {state === "failed" && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"><ImageOff className="size-3.5" /> No 3D car yet</div>
      )}
      {state === "ready" && (
        <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <Rotate3d className="size-3.5" /> Drag to turn
        </span>
      )}
    </div>
  )
}
