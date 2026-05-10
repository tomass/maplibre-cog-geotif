import { Map } from 'maplibre-gl';
import { fromUrl } from 'geotiff';

const map = new Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json', // Simple base style
    center: [0, 0],
    zoom: 2
});

map.on('load', async () => {
    // Test if your Docker server is serving the COG correctly
    try {
        const tiff = await fromUrl('http://localhost:8080/your-file.tif');
        const image = await tiff.getImage();
        console.log("COG Header Loaded:", image.getWidth(), "x", image.getHeight());

        // This is where your custom WebGL Layer logic will eventually go
    } catch (e) {
        console.error("Check Docker or CORS:", e);
    }
});