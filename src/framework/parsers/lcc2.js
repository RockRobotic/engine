import { http, Http } from '../../platform/net/http.js';
import { GSplatOctreeResource } from '../../scene/gsplat-unified/gsplat-octree.resource.js';
import { GSplatAssetLoader } from '../components/gsplat/gsplat-asset-loader.js';
import { Debug } from '../../core/debug.js';

/**
 * @import { AppBase } from '../app-base.js'
 * @import { ResourceHandlerCallback } from '../handlers/handler.js'
 */

const SUPPORTED_MAJOR = 0;

/**
 * Translates a parsed LCC2 JSON object into the hierarchical data shape
 * consumed by `GSplatOctree` when `hierarchyMode === "tree"`.
 *
 * Pure function — no I/O, no engine state. Exported for unit testing.
 *
 * @param {Object} lcc2 - Parsed LCC2 JSON (top-level object from the `.lcc2` file).
 * @returns {Object} Translated data for `GSplatOctreeResource`.
 */
export function translateLcc2ToOctreeData(lcc2) {
    const versionParts = String(lcc2.version ?? '0.0.0').split('.');
    const major = parseInt(versionParts[0], 10);
    if (major !== SUPPORTED_MAJOR) {
        throw new Error(`unsupported LCC2 version: ${lcc2.version} (expected 0.x.x)`);
    }

    const root = lcc2.root;
    if (!root) {
        throw new Error('LCC2: missing root node');
    }

    const splatFiles = root.splatFiles ?? [];

    // env.name is an index into splatFiles. When present, resolve to the filename.
    const envIndex = root.data?.env?.name;
    const environment = (typeof envIndex === 'number' && splatFiles[envIndex]) ?
        splatFiles[envIndex] :
        undefined;

    const tree = translateNode(root, 0);

    if (lcc2.virtualLoD && lcc2.virtualLoD.method && lcc2.virtualLoD.method !== 'simple') {
        Debug.warn(`LCC2: virtualLoD.method "${lcc2.virtualLoD.method}" not implemented; pass-through only`);
    }

    return {
        hierarchyMode: 'tree',
        version: lcc2.version,
        totalLevels: lcc2.totalLevels ?? 1,
        lodLevels: 1,
        filenames: splatFiles,
        environment,
        metadata: {
            lodSplats: lcc2.lodSplats ?? null,
            virtualLoD: lcc2.virtualLoD ?? null,
            totalSplats: lcc2.totalSplats ?? null,
            env: lcc2.env ?? null
        },
        tree
    };
}

/**
 * Recursively translates one LCC2 node into the engine's hierarchical node shape.
 *
 * @param {Object} node - LCC2 node.
 * @param {number} depth - Depth assigned to this node (root = 0).
 * @returns {Object} Translated node.
 */
function translateNode(node, depth) {
    const threeDgs = node.data && node.data['3dgs'];
    const lod = threeDgs ?
        { file: threeDgs.name, offset: threeDgs.start ?? 0, count: threeDgs.count ?? 0 } :
        null;

    const children = [];
    const childObj = node.child;
    if (childObj) {
        const keys = Object.keys(childObj)
        .map(k => [parseInt(k, 10), k])
        .sort((a, b) => a[0] - b[0]);
        for (const [, key] of keys) {
            children.push(translateNode(childObj[key], depth + 1));
        }
    }

    return {
        bound: {
            min: node.boundingBox.min,
            max: node.boundingBox.max
        },
        lod,
        depth,
        children
    };
}

/**
 * Asset-system parser. Fetches the `.lcc2` JSON, translates, and constructs a
 * hierarchical `GSplatOctreeResource`.
 */
class Lcc2Parser {
    /** @type {AppBase} */
    app;

    /** @type {number} */
    maxRetries;

    /**
     * @param {AppBase} app - The app instance.
     * @param {number} maxRetries - Maximum amount of retries.
     */
    constructor(app, maxRetries) {
        this.app = app;
        this.maxRetries = maxRetries;
    }

    /**
     * @param {object|string} url - The URL of the resource to load.
     * @param {ResourceHandlerCallback} callback - Completion callback.
     * @param {object} asset - Container asset.
     */
    load(url, callback, asset) {
        if (typeof url === 'string') {
            url = { load: url, original: url };
        }

        const options = {
            retry: this.maxRetries > 0,
            maxRetries: this.maxRetries,
            responseType: Http.ResponseType.JSON,
            // Send cookies so CloudFront signed-cookie-protected URLs work.
            // Safe for non-credentialed origins: browser only attaches cookies
            // the origin actually has.
            withCredentials: true
        };

        http.get(url.load, options, (err, lcc2) => {
            if (err) {
                callback(`Error loading LCC2: ${url.original} [${err}]`);
                return;
            }
            try {
                const data = translateLcc2ToOctreeData(lcc2);
                const assetLoader = new GSplatAssetLoader(this.app.assets);
                const resource = new GSplatOctreeResource(asset.file.url, data, assetLoader);
                callback(null, resource);
            } catch (ex) {
                callback(`Error parsing LCC2: ${url.original} [${ex.message}]`);
            }
        });
    }
}

export { Lcc2Parser };
