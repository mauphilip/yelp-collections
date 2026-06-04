// Leaflet map — CartoDB Positron tiles, numbered circle pins

let map, markersLayer, markerMap = {}

export function initMap(containerId) {
  map = L.map(containerId, { zoomControl: false })

  // CartoDB Positron — clean white, modern, no API key
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map)

  L.control.zoom({ position: 'bottomright' }).addTo(map)
  return map
}

// businesses should have _num set (1-based index in current filtered list)
export function renderMarkers(businesses, onMarkerClick) {
  markersLayer?.remove()
  markersLayer = L.layerGroup().addTo(map)
  markerMap = {}
  const bounds = []

  for (const biz of businesses) {
    const { latitude: lat, longitude: lng } = biz.coordinates || {}
    if (!lat || !lng) continue

    const num = biz._num ?? ''
    const isClosed = biz.closed_status === 'closed'
    const size = num >= 100 ? 28 : 24

    const icon = L.divIcon({
      className: '',
      html: `<div class="num-pin${isClosed ? ' closed' : ''}" data-id="${biz.id}" style="width:${size}px;height:${size}px;font-size:${num >= 100 ? '9' : '10'}px">${num}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    })

    const marker = L.marker([lat, lng], { icon })
      .on('click', () => onMarkerClick(biz.id))
    markersLayer.addLayer(marker)
    markerMap[biz.id] = { marker, num }
    bounds.push([lat, lng])
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 })
}

export function highlightMarker(id) {
  for (const [mid, { marker }] of Object.entries(markerMap)) {
    const el = marker.getElement()
    if (!el) continue
    el.querySelector('.num-pin')?.classList.toggle('highlighted', mid === id)
  }
}

export function centerOnUser(lat, lng) {
  map.setView([lat, lng], 14)
}
