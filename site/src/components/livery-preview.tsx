import { ImageOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { tintMask } from "../../../src/livery-tint.ts"
import { assetUrl } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { TeamColours } from "@/lib/types"

// Masks are fetched once and kept as pixels; every preview tints its own copy.
const masks = new Map<string, Promise<ImageData>>()

function loadMask(file: string): Promise<ImageData> {
  let p = masks.get(file)
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
      img.onerror = () => reject(new Error(`No livery image ${file}`))
      img.src = assetUrl("liveries", file)
    })
    masks.set(file, p)
    p.catch(() => masks.delete(file))
  }
  return p
}

/**
 * A livery pattern's side view (the car's flank, from MM's colour key) in the given colours.
 * It shows the pattern and colours, not the exact 3D car.
 */
export function LiveryPreview({ mask, colours, className }: { mask: string; colours: TeamColours; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  const key = `${colours.primary}${colours.secondary}${colours.tertiary}${colours.trim}`

  useEffect(() => {
    let live = true
    loadMask(mask).then((data) => {
      const canvas = ref.current
      if (!live || !canvas) return
      canvas.width = data.width
      canvas.height = data.height
      const copy = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height)
      tintMask(copy.data, colours)
      canvas.getContext("2d")!.putImageData(copy, 0, 0)
      setFailed(false)
    }, () => live && setFailed(true))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, key])

  if (failed) {
    return (
      <div className={cn("flex aspect-[4/1] items-center justify-center gap-1.5 rounded-md bg-muted text-xs text-muted-foreground", className)}>
        <ImageOff className="size-3.5" /> No preview
      </div>
    )
  }
  return <canvas ref={ref} className={cn("aspect-[4/1] w-full rounded-md bg-muted", className)} />
}
