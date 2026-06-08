// Leaflet map — CartoDB Positron tiles (clean, minimal, no API key needed)

let map, markersLayer, markerMap = {}, userMarker = null, _lastBounds = []

export function initMap(containerId) {
  map = L.map(containerId, {
    zoomControl: false,
    center: [34.02, -118.35],
    zoom: 10,
    doubleClickZoom: false,
  })

  // CartoDB Voyager — warm streets, green parks, clean labels. Closest free look to Google Maps.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map)

  L.control.zoom({ position: 'bottomright' }).addTo(map)

  // Near Me — uses L.DomEvent to avoid Leaflet swallowing the click
  const NearMe = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'near-me-btn')
      btn.textContent = '📍 Near me'
      L.DomEvent.disableClickPropagation(btn)
      L.DomEvent.on(btn, 'click', () => {
        if (!navigator.geolocation) { alert('Geolocation is not supported by your browser.'); return }
        navigator.geolocation.getCurrentPosition(
          p => {
            window._userLat = p.coords.latitude
            window._userLng = p.coords.longitude
            showUserLocation(p.coords.latitude, p.coords.longitude)
            map.setView([p.coords.latitude, p.coords.longitude], 13)
          },
          err => {
            if (err.code === err.PERMISSION_DENIED)
              alert('Location access was denied. Please allow it in your browser settings and try again.')
            else
              alert('Could not get your location. Try again.')
          }
        )
      })
      return btn
    },
  })
  new NearMe().addTo(map)

  // Reset/fit-all button
  const ResetView = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'reset-view-btn')
      btn.textContent = '⤢'
      btn.title = 'Fit all markers'
      L.DomEvent.disableClickPropagation(btn)
      L.DomEvent.on(btn, 'click', () => {
        if (_lastBounds.length) map.fitBounds(_lastBounds, { padding: [56, 56], maxZoom: 12 })
      })
      return btn
    },
  })
  new ResetView().addTo(map)

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
    const fontSize = String(num).length >= 3 ? 9 : 11
    const size = 26

    const icon = L.divIcon({
      className: '',
      html: `<div class="num-pin${isClosed ? ' closed' : ''}" data-id="${biz.id}" style="width:${size}px;height:${size}px;font-size:${fontSize}px">${num}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    })

    const cat = biz.categories?.[0]?.title || ''
    const popup = L.popup({ maxWidth: 200, autoPan: false, closeButton: false })
      .setContent(`<b style="font-family:Inter,sans-serif;font-size:.82rem">${biz.name}</b><br><span style="font-size:.75rem;color:#666">${biz.rating}★${cat ? ' · ' + cat : ''}</span>`)

    const marker = L.marker([lat, lng], { icon })
      .bindPopup(popup)
      .on('click', () => onMarkerClick(biz.id))
    markersLayer.addLayer(marker)
    markerMap[biz.id] = { marker, num }
    bounds.push([lat, lng])
  }

  _lastBounds = bounds
  if (bounds.length) map.fitBounds(bounds, { padding: [56, 56], maxZoom: 12 })
}

export function highlightMarker(id) {
  for (const [mid, { marker }] of Object.entries(markerMap)) {
    const el = marker.getElement()
    if (!el) continue
    el.querySelector('.num-pin')?.classList.toggle('highlighted', mid === id)
  }
}

export function panToMarker(id) {
  const entry = markerMap[id]
  if (!entry) return
  map.panTo(entry.marker.getLatLng(), { animate: true })
}

export function showUserLocation(lat, lng) {
  userMarker?.remove()
  const icon = L.divIcon({
    className: '',
    html: '<div class="user-dot"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
  userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map)
}

export function centerOnUser(lat, lng) {
  map.setView([lat, lng], 13)
}
