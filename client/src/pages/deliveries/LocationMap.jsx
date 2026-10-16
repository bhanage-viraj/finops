import { useEffect, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Fix default marker paths under Vite.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const BALI = { lat: -8.65, lng: 115.2 };

function ClickPicker({ onPick }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

export default function LocationMap({ initial, onPick }) {
  const [pos, setPos] = useState(initial || BALI);

  useEffect(() => {
    if (initial?.lat != null) setPos(initial);
  }, [initial?.lat, initial?.lng]);

  return (
    <div style={{ height: 240, marginTop: 8, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
      <MapContainer center={[pos.lat, pos.lng]} zoom={15} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[pos.lat, pos.lng]} />
        <ClickPicker onPick={(coords) => {
          setPos(coords);
          onPick(coords);
        }}
        />
      </MapContainer>
      <p className="hint" style={{ padding: '4px 8px' }}>Tap the map to drop a pin.</p>
    </div>
  );
}
