export type MapPoint = [number, number]
export type MapBounds = [MapPoint, MapPoint]

// A useful Moscow and surrounding region overview, including the outer delivery belt.
// This minimum extent deliberately prevents one address from zooming down to a street.
export const moscowOverviewBounds: MapBounds = [[54.85, 36.35], [56.5, 39.0]]

export function requestOverviewBounds(points: readonly MapPoint[]): MapBounds {
  const [[south, west], [north, east]] = moscowOverviewBounds
  const bounds: MapBounds = [[south, west], [north, east]]
  for (const [latitude, longitude] of points) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue
    bounds[0][0] = Math.min(bounds[0][0], latitude)
    bounds[0][1] = Math.min(bounds[0][1], longitude)
    bounds[1][0] = Math.max(bounds[1][0], latitude)
    bounds[1][1] = Math.max(bounds[1][1], longitude)
  }
  return bounds
}

export type RequestFitView =
  | { center: MapPoint; zoom: number }
  | { bounds: MapBounds; maxZoom: number }

/** Explicit Show all frames the actual points; the initial regional overview is separate. */
export function requestFitView(points: readonly MapPoint[]): RequestFitView | null {
  let bounds: MapBounds | null = null
  for (const [latitude, longitude] of points) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue
    if (!bounds) bounds = [[latitude, longitude], [latitude, longitude]]
    else {
      bounds[0][0] = Math.min(bounds[0][0], latitude)
      bounds[0][1] = Math.min(bounds[0][1], longitude)
      bounds[1][0] = Math.max(bounds[1][0], latitude)
      bounds[1][1] = Math.max(bounds[1][1], longitude)
    }
  }
  if (!bounds) return null
  // Colocated requests are one geographical point, so avoid fitting zero-area bounds.
  if (bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1]) return { center: bounds[0], zoom: 12 }
  return { bounds, maxZoom: 12 }
}

/** Clamp a fixed-width hover card inside the map without panning its geographical view. */
export function mapCardPosition(anchor: { x: number; y: number }, card: { width: number; height: number }, surface: { width: number; height: number }) {
  const inset = 12, gap = 24
  const left = Math.max(inset, Math.min(anchor.x - card.width / 2, surface.width - card.width - inset))
  const above = anchor.y - card.height - gap
  const top = above >= inset ? above : Math.max(inset, Math.min(anchor.y + gap, surface.height - card.height - inset))
  return { left, top }
}
