import { ImageOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { tintMask } from "../../../src/livery-tint.ts"
import { assetUrl } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { LiveryOption, TeamColours } from "@/lib/types"

// Masks are fetched once and kept as pixels; every preview tints its own copy.
const masks = new Map<string, Promise<ImageData>>()
const overlays = new Map<string, Promise<HTMLImageElement>>()

function loadImage(file: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`No livery image ${file}`))
    img.src = assetUrl("liveries", file)
  })
}

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = map.get(key)
  if (!p) {
    p = load()
    map.set(key, p)
    p.catch(() => map.delete(key))
  }
  return p
}

const loadMask = (file: string) => cached(masks, file, () => loadImage(file).then((img) => {
  const c = document.createElement("canvas")
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext("2d")!
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, c.width, c.height)
}))

const loadOverlay = (model: string) => cached(overlays, model, () => loadImage(`${model}-overlay.png`))

/** True once the element has come near the viewport (and stays true). */
function useNearView<T extends Element>() {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true) }, { rootMargin: "200px" })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen] as const
}

/**
 * A livery from the side in the given colours. MM's own patterns: the pattern's side texture (the
 * car's flank). FIRE Fantasy 20: a render of its car (`livery.model`), with the shading and the
 * parts that aren't livery drawn over the tinted body.
 */
export function LiveryPreview({ livery, colours, className }: { livery: Pick<LiveryOption, "mask" | "model">; colours: TeamColours; className?: string }) {
  const [box, near] = useNearView<HTMLDivElement>()
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  const key = `${colours.primary}${colours.secondary}${colours.tertiary}${colours.trim}`
  const { mask, model } = livery

  useEffect(() => {
    if (!near) return
    let live = true
    Promise.all([loadMask(mask), model ? loadOverlay(model) : null]).then(([data, overlay]) => {
      const canvas = ref.current
      if (!live || !canvas) return
      canvas.width = data.width
      canvas.height = data.height
      const copy = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height)
      tintMask(copy.data, colours, !!model)
      const ctx = canvas.getContext("2d")!
      ctx.putImageData(copy, 0, 0)
      if (overlay) ctx.drawImage(overlay, 0, 0, data.width, data.height)
      setFailed(false)
    }, () => live && setFailed(true))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, model, key, near])

  return (
    <div ref={box} className={cn("aspect-[4/1] w-full overflow-hidden rounded-md bg-muted", className)}>
      {failed
        ? <div className="flex size-full items-center justify-center gap-1.5 text-xs text-muted-foreground"><ImageOff className="size-3.5" /> No preview</div>
        : <canvas ref={ref} className="block size-full" />}
    </div>
  )
}
