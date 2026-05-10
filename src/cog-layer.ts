import { CustomLayerInterface, Map } from 'maplibre-gl';
import { fromUrl, GeoTIFF, GeoTIFFImage } from 'geotiff';

export class COGLayer implements CustomLayerInterface {
    id: string;
    type: 'custom' = 'custom';
    renderingMode: '2d' | '3d' = '2d';

    private url: string;
    private tiff: GeoTIFF | null = null;
    private images: GeoTIFFImage[] = [];
    private map: Map | null = null;
    private program: WebGLProgram | null = null;
    private vertexBuffer: WebGLBuffer | null = null;
    private textureCache: any = new (window as any).Map();
    private textureKeys: string[] = [];
    private maxCacheSize: number = 100;
    private tileCache: any = new (window as any).Map(); // Simple cache for decoded tiles

    constructor(id: string, url: string) {
        this.id = id;
        this.url = url;
    }

    async onAdd(map: Map, gl: WebGLRenderingContext) {
        this.map = map;

        // Initialize GeoTIFF
        try {
            this.tiff = await fromUrl(this.url);
            const imageCount = await this.tiff.getImageCount();
            for (let i = 0; i < imageCount; i++) {
                this.images.push(await this.tiff.getImage(i));
            }
            console.log(`Loaded COG with ${imageCount} overviews`);
            console.log("Image 0 BBox:", this.images[0].getBoundingBox());
            console.log("Image 0 Resolution:", this.images[0].getResolution());
        } catch (e) {
            console.error("Failed to load COG:", e);
        }

        // Shaders
        const vertexSource = `
            uniform mat4 u_matrix;
            attribute vec2 a_pos;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;

        const fragmentSource = `
            precision mediump float;
            uniform sampler2D u_texture;
            varying vec2 v_texCoord;
            void main() {
                gl_FragColor = texture2D(u_texture, v_texCoord);
            }
        `;

        const vertexShader = this.createShader(gl, gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        this.program = this.createProgram(gl, vertexShader, fragmentShader);

        this.vertexBuffer = gl.createBuffer();

        // Initial setup for rendering
        map.on('move', () => map.triggerRepaint());
    }

    private createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader)!);
        }
        return shader;
    }

    private createProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
        const program = gl.createProgram()!;
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program)!);
        }
        return program;
    }

    render(gl: WebGLRenderingContext, options: any) {
        if (!this.tiff || !this.program || !this.map || this.images.length === 0) {
            return;
        }

        gl.useProgram(this.program);

        const uMatrix = gl.getUniformLocation(this.program, 'u_matrix');
        const matrix = Array.isArray(options) ? options : options.modelViewProjectionMatrix;
        gl.uniformMatrix4fv(uMatrix, false, matrix);

        const aPos = gl.getAttribLocation(this.program, 'a_pos');
        const aTexCoord = gl.getAttribLocation(this.program, 'a_texCoord');

        gl.enableVertexAttribArray(aPos);
        gl.enableVertexAttribArray(aTexCoord);

        // Simple implementation: find the best image for current zoom and render visible tiles
        const zoom = this.map.getZoom();
        const image = this.getBestImage(zoom);

        const bounds = this.map.getBounds();
        const visibleTiles = this.getVisibleTiles(image, bounds);

        for (const tile of visibleTiles) {
            const texture = this.textureCache.get(`${this.images.indexOf(image)}_${tile.x}_${tile.y}`);
            if (!texture) {
                this.getTileTexture(gl, image, tile.x, tile.y);
                continue;
            }

            gl.bindTexture(gl.TEXTURE_2D, texture);

            // Texture parameters for sharpness
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            const vertices = new Float32Array([
                // pos.x, pos.y, tex.x, tex.y
                tile.bbox[0], tile.bbox[1], 0, 0,
                tile.bbox[2], tile.bbox[1], 1, 0,
                tile.bbox[0], tile.bbox[3], 0, 1,
                tile.bbox[2], tile.bbox[3], 1, 1,
            ]);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
            gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 16, 8);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    }

    private getBestImage(_zoom: number): GeoTIFFImage {
        const mapRes = this.getMapResolution();
        let bestImage = this.images[0];
        let minDiff = Math.abs(this.images[0].getResolution()[0] - mapRes);

        for (let i = 1; i < this.images.length; i++) {
            const diff = Math.abs(this.images[i].getResolution()[0] - mapRes);
            if (diff < minDiff) {
                minDiff = diff;
                bestImage = this.images[i];
            }
        }
        return bestImage;
    }

    private getMapResolution(): number {
        if (!this.map) return 0;
        const center = this.map.getCenter();
        const zoom = this.map.getZoom();
        return (Math.cos(center.lat * Math.PI / 180) * 2 * Math.PI * 6378137) / (256 * Math.pow(2, zoom));
    }

    private getVisibleTiles(image: GeoTIFFImage, bounds: any) {
        const imageBBox = image.getBoundingBox(); // [minX, minY, maxX, maxY] in EPSG:3857
        const tileWidth = image.getTileWidth();
        const tileHeight = image.getTileHeight();
        const width = image.getWidth();
        const height = image.getHeight();
        const res = image.getResolution();

        // Convert map bounds to EPSG:3857
        const mapMinX = this.lngToX(bounds.getWest());
        const mapMaxX = this.lngToX(bounds.getEast());
        const mapMinY = this.latToY(bounds.getSouth());
        const mapMaxY = this.latToY(bounds.getNorth());

        const minX = Math.max(imageBBox[0], mapMinX);
        const maxX = Math.min(imageBBox[2], mapMaxX);
        const minY = Math.max(imageBBox[1], mapMinY);
        const maxY = Math.min(imageBBox[3], mapMaxY);

        if (minX >= maxX || minY >= maxY) return [];

        const tiles = [];
        const startX = Math.floor((minX - imageBBox[0]) / (tileWidth * res[0]));
        const endX = Math.floor((maxX - imageBBox[0]) / (tileWidth * res[0]));
        const startY = Math.floor((imageBBox[3] - maxY) / (tileHeight * Math.abs(res[1])));
        const endY = Math.floor((imageBBox[3] - minY) / (tileHeight * Math.abs(res[1])));

        for (let y = Math.max(0, startY); y <= Math.min(Math.ceil(height / tileHeight) - 1, endY); y++) {
            for (let x = Math.max(0, startX); x <= Math.min(Math.ceil(width / tileWidth) - 1, endX); x++) {
                const tileBBoxMeters = [
                    imageBBox[0] + x * tileWidth * res[0],
                    imageBBox[3] - (y + 1) * tileHeight * Math.abs(res[1]),
                    imageBBox[0] + (x + 1) * tileWidth * res[0],
                    imageBBox[3] - y * tileHeight * Math.abs(res[1])
                ];

                // Convert to 0..1 range
                const tileBBox = [
                    this.mercatorX(tileBBoxMeters[0]),
                    this.mercatorY(tileBBoxMeters[3]),
                    this.mercatorX(tileBBoxMeters[2]),
                    this.mercatorY(tileBBoxMeters[1])
                ];

                tiles.push({ x, y, bbox: tileBBox });
            }
        }
        return tiles;
    }

    private async getTileTexture(gl: WebGLRenderingContext, image: GeoTIFFImage, x: number, y: number): Promise<WebGLTexture | null> {
        const imageIndex = this.images.indexOf(image);
        const cacheKey = `${imageIndex}_${x}_${y}`;

        // Prevent multiple simultaneous requests for the same tile
        if (this.tileCache.has(cacheKey)) {
            return null;
        }
        this.tileCache.set(cacheKey, true);

        // Fetch and decode tile
        try {
            const tileData = await image.readRasters({
                window: [
                    x * image.getTileWidth(),
                    y * image.getTileHeight(),
                    Math.min((x + 1) * image.getTileWidth(), image.getWidth()),
                    Math.min((y + 1) * image.getTileHeight(), image.getHeight())
                ],
                interleave: true
            });

            const texture = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, texture);

            const data = new Uint8Array(tileData as any);
            const tileW = image.getTileWidth();
            const tileH = image.getTileHeight();

            // Determine format
            const numSamples = (tileData as any).length / (tileW * tileH);
            let format: number = gl.RGB;
            if (numSamples === 4) format = gl.RGBA;
            else if (numSamples === 1) format = gl.LUMINANCE;

            gl.texImage2D(gl.TEXTURE_2D, 0, format, tileW, tileH, 0, format, gl.UNSIGNED_BYTE, data);

            this.textureCache.set(cacheKey, texture);
            this.textureKeys.push(cacheKey);

            // Evict old textures if cache is full
            if (this.textureKeys.length > this.maxCacheSize) {
                const oldestKey = this.textureKeys.shift()!;
                const oldestTexture = this.textureCache.get(oldestKey);
                if (oldestTexture) {
                    gl.deleteTexture(oldestTexture);
                }
                this.textureCache.delete(oldestKey);
            }

            this.map?.triggerRepaint();
            return texture;
        } catch (e) {
            console.error(`Failed to load tile ${x},${y}:`, e);
            return null;
        } finally {
            this.tileCache.delete(cacheKey);
        }
    }

    private lngToX(lng: number) {
        return (lng * 20037508.34) / 180;
    }

    private latToY(lat: number) {
        let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
        return (y * 20037508.34) / 180;
    }

    private mercatorX(x: number) {
        return (x + 20037508.34) / (2 * 20037508.34);
    }

    private mercatorY(y: number) {
        return (20037508.34 - y) / (2 * 20037508.34);
    }

    onRemove(_map: Map, gl: WebGLRenderingContext) {
        for (const texture of this.textureCache.values()) {
            gl.deleteTexture(texture);
        }
        this.textureCache.clear();
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.program) gl.deleteProgram(this.program);
    }
}
