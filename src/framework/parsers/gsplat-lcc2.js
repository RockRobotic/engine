import { Debug } from '../../core/debug.js';
import { http, Http } from '../../platform/net/http.js';
import { buildLcc2Tree } from '../../scene/gsplat-unified/gsplat-lod-tree.js';
import { GSplatOctreeResource } from '../../scene/gsplat-unified/gsplat-octree.resource.js';
import { GSplatAssetLoader } from '../components/gsplat/gsplat-asset-loader.js';

/**
 * @import { AppBase } from '../app-base.js'
 * @import { ResourceHandlerCallback } from '../handlers/handler.js'
 */

// Reads one LCC2 node without converting or retaining its descendants.
const readLcc2Node = (node) => {
    const splats = node.data?.['3dgs'];
    return {
        bound: node.boundingBox,
        lod: splats ? { file: splats.name, offset: splats.start ?? 0, count: splats.count ?? 0 } : null,
        children: Object.values(node.child ?? {})
    };
};

const readManifest = (lcc) => {
    if (parseInt(String(lcc.version ?? '0'), 10) !== 0) {
        throw new Error(`unsupported LCC2 version: ${lcc.version} (expected 0.x.x)`);
    }
    const root = lcc.root;
    if (!root) throw new Error('LCC2: missing root node');

    const filenames = root.splatFiles ?? [];
    const envIndex = root.data?.env?.name;
    if (lcc.virtualLoD?.method && lcc.virtualLoD.method !== 'simple') {
        Debug.warn(`LCC2: virtualLoD.method "${lcc.virtualLoD.method}" is not implemented`);
    }

    return {
        hierarchyMode: 'tree',
        version: lcc.version,
        totalLevels: lcc.totalLevels ?? lcc.lodSplats?.length,
        lodLevels: 1,
        filenames,
        environment: typeof envIndex === 'number' ? filenames[envIndex] : undefined,
        metadata: {
            lodSplats: lcc.lodSplats ?? null,
            virtualLoD: lcc.virtualLoD ?? null,
            totalSplats: lcc.totalSplats ?? null,
            env: lcc.env ?? null
        },
        tree: root
    };
};

/**
 * Translates an LCC2 manifest into the single-range-per-node format returned by earlier ROCK
 * versions. These manifests can still be passed to GSplatOctreeResource.
 *
 * @param {object} lcc - Parsed LCC2 manifest.
 * @returns {object} The legacy octree manifest.
 * @ignore
 */
const translateLcc2ToOctreeData = (lcc) => {
    const data = readManifest(lcc);
    const translate = (node, depth) => {
        const { bound, lod, children } = readLcc2Node(node);
        return { bound, lod, depth, children: children.map(child => translate(child, depth + 1)) };
    };
    data.tree = translate(data.tree, 0);
    data.totalLevels ??= 1;
    return data;
};

// whether a vector is absent or has every component equal to value
const isUniform = (v, value) => !v || (v[0] === value && v[1] === value && v[2] === value);

/**
 * Parser for LCC2 scenes, the XGRIDS level of detail tree of Gaussian splat files. Data
 * Organization Format originated from XGRIDS.
 *
 * The `.lcc2` file describes the tree, and every node below its root references a range of splats
 * in one of the scene's splat files, which are streamed on demand. Each node holds one LOD level of
 * its region and is replaced by its children for more detail, so the tree loads directly as a
 * hierarchical {@link GSplatOctree}. Only the splats are loaded: the scene's meshes and collision
 * data are not.
 *
 * @ignore
 */
class GSplatLcc2Parser {
    /** @type {AppBase} */
    app;

    /**
     * @param {AppBase} app - The app instance.
     */
    constructor(app) {
        this.app = app;
    }

    canParse(context) {
        return context.ext === 'lcc2';
    }

    /**
     * Converts parsed LCC2 data to the data a hierarchical {@link GSplatOctree} is created from.
     *
     * @param {object} lcc - The parsed `.lcc2` JSON.
     * @returns {object} The octree data.
     */
    static convert(lcc) {
        Debug.call(() => {
            if (!String(lcc.version).startsWith('0.0.')) {
                Debug.warnOnce(`GSplatLcc2Parser: LCC2 version ${lcc.version} is untested.`);
            }
            if (!isUniform(lcc.offset, 0) || !isUniform(lcc.shift, 0) || !isUniform(lcc.scale, 1)) {
                Debug.warnOnce('GSplatLcc2Parser: the offset, shift and scale of the LCC2 scene are not applied.');
            }
        });

        return buildLcc2Tree(readManifest(lcc), readLcc2Node);
    }

    /**
     * @param {object} url - The URL of the resource to load.
     * @param {string} url.load - The URL to use for loading the resource.
     * @param {string} url.original - The original URL useful for identifying the resource type.
     * @param {ResourceHandlerCallback} callback - The callback used when
     * the resource is loaded or an error occurs.
     * @param {object} asset - Container asset.
     */
    load(url, callback, asset) {
        if (typeof url === 'string') {
            url = {
                load: url,
                original: url
            };
        }

        // the http layer does not recognize .lcc2 as JSON
        const options = {
            retry: this.handler.maxRetries > 0,
            maxRetries: this.handler.maxRetries,
            responseType: Http.ResponseType.JSON,
            withCredentials: true
        };

        http.get(url.load, options, (err, data) => {
            if (err) {
                callback(`Error loading LCC2 gsplat scene: ${url.original} [${err}]`);
                return;
            }

            let resource;
            try {
                const manifest = GSplatLcc2Parser.convert(data);
                resource = new GSplatOctreeResource(asset.file.url, manifest, new GSplatAssetLoader(this.app.assets));
            } catch (error) {
                callback(`Error parsing LCC2: ${url.original} [${error.message}]`);
                return;
            }
            callback(null, resource);
        });
    }
}

export { GSplatLcc2Parser, translateLcc2ToOctreeData };
