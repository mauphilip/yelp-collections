// Leaflet map — CartoDB Positron tiles, numbered rounded-square pins

let map, markersLayer, markerMap = {}

export function initMap(containerId) {
  map = L.map(containerId, {
    zoomControl: false,
    // Default view: LA area, zoomed out enough to see the full basin
    center: [34.05, -118.25],
    zoom: 10,
  })

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
    // Wider for 3-digit numbers
    const w = num >= 100 ? 30 : 26
    const h = 26

    const icon = L.divIcon({
      className: '',
      html: `<div class="num-pin${isClosed ? ' closed' : ''}" data-id="${biz.id}" style="width:${w}px;height:${h}px">${num}</div>`,
      iconSize: [w, h],
      iconAnchor: [w / 2, h / 2],
    })

    const marker = L.marker([lat, lng], { icon })
      .on('click', () => onMarkerClick(biz.id))
    markersLayer.addLayer(marker)
    markerMap[biz.id] = { marker, num }
    bounds.push([lat, lng])
  }

  // Fit to markers but don't zoom in too far — keep LA-area context
  if (bounds.length) map.fitBounds(bounds, { padding: [56, 56], maxZoom: 12 })
}

export function highlightMarker(id) {
  for (const [mid, { marker }] of Object.entries(markerMap)) {
    const el = marker.getElement()
    if (!el) continue
    el.querySelector('.num-pin')?.classList.toggle('highlighted', mid === id)
  }
}

export function centerOnUser(lat, lng) {
  map.setView([lat, lng], 13)
}
