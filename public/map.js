// Leaflet map — CartoDB Positron tiles (clean, modern, no API key needed)

let map, markersLayer, markerMap = {}

export function initMap(containerId) {
  map = L.map(containerId, {
    zoomControl: false,  // we'll reposition it
  })

  // CartoDB Positron — clean white map, no visual clutter
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map)

  // Zoom control bottom-right
  L.control.zoom({ position: 'bottomright' }).addTo(map)

  return map
}

export function renderMarkers(businesses, onMarkerClick) {
  markersLayer?.remove()
  markersLayer = L.layerGroup().addTo(map)
  markerMap = {}

  const bounds = []

  for (const biz of businesses) {
    const { latitude: lat, longitude: lng } = biz.coordinates || {}
    if (!lat || !lng) continue

    const isClosed = biz.closed_status === 'closed'

    const icon = L.divIcon({
      className: '',
      html: `<div class="map-pin-wrap">
               <div class="map-pin${isClosed ? ' map-pin-closed' : ''}" data-id="${biz.id}"></div>
               <div class="map-pin-label">${biz.name.length > 22 ? biz.name.slice(0, 22) + '…' : biz.name}</div>
             </div>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    })

    const marker = L.marker([lat, lng], { icon })
      .on('click', () => onMarkerClick(biz.id))
    markersLayer.addLayer(marker)
    markerMap[biz.id] = marker
    bounds.push([lat, lng])
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 })
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
