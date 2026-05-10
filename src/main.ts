import { Map } from 'maplibre-gl';
import { COGLayer } from './cog-layer';

const map = new Map({
    container: 'map',
    style: {
        version: 8,
        sources: {},
        layers: [
            {
                id: 'background',
                type: 'background',
                paint: {
                    'background-color': '#f0f0f0'
                }
            }
        ]
    },
    center: [25.2797, 54.6872], // Approximate center of the example.tif (Lithuania area based on bbox)
    zoom: 12,
    hash: true
});

map.on('load', () => {
    const cogLayer = new COGLayer('cog-layer', 'http://localhost:8080/example.tif');
    map.addLayer(cogLayer);
});
