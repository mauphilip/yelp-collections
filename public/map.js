// Leaflet map — Infatuation-style blue markers, synced with card list

let map, markersLayer, markerMap = {}

export function initMap(containerId) {
  map = L.map(containerId, { zoomControl: true })
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)
  markersLayer = L.layerGroup().addTo(map)
  return map
}

export function renderMarkers(businesses, onMarkerClick) {
  markersLayer.clearLayers()
  markerMap = {}

  const bounds = []

  for (const biz of businesses) {
    const { latitude: lat, longitude: lng } = biz.coordinates || {}
    if (!lat || !lng) continue

    const icon = L.divIcon({
      className: '',
      html: `<div class="map-pin${biz.closed_status === 'closed' ? ' map-pin-closed' : ''}" data-id="${biz.id}">
               <span>${biz.name.slice(0, 20)}</span>
             </div>`,
      iconAnchor: [12, 12],
    })

    const marker = L.marker([lat, lng], { icon })
      .on('click', () => onMarkerClick(biz.id))
    markersLayer.addLayer(marker)
    markerMap[biz.id] = marker
    bounds.push([lat, lng])
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 })
}

export function highlightMarker(id) {
  for (const [mid, m] of Object.entries(markerMap)) {
    const el = m.getElement()
    if (!el) continue
    el.querySelector('.map-pin')?.classList.toggle('map-pin-highlight', mid === id)
  }
}

export function centerOnUser(lat, lng) {
  map.setView([lat, lng], 14)
}
