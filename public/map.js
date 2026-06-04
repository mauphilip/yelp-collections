// Leaflet map — Esri World Topo tiles (terrain, free, no API key), white numbered pins

let map, markersLayer, markerMap = {}

export function initMap(containerId) {
  map = L.map(containerId, {
    zoomControl: false,
    center: [34.02, -118.35],
    zoom: 10,
  })

  // Esri World Topo — terrain, green hills, highway shields, clean labels
  // Free, no API key required
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a>',
    maxZoom: 19,
  }).addTo(map)

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

    const num = biz._num ?? ''
    const isClosed = biz.closed_status === 'closed'
    const w = num >= 100 ? 32 : 28
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
