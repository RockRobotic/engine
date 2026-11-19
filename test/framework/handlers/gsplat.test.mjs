import { expect } from 'chai';

import { GSplatHandler } from '../../../src/framework/handlers/gsplat.js';
import { GSplatLcc2Parser } from '../../../src/framework/parsers/gsplat-lcc2.js';
import { GSplatOctreeParser } from '../../../src/framework/parsers/gsplat-octree.js';
import { PlyParser } from '../../../src/framework/parsers/ply.js';
import { SogBundleParser } from '../../../src/framework/parsers/sog-bundle.js';

const stubApp = () => ({ assets: { on() {} } });

// The parser the handler would pick for a URL.
const parserFor = (url) => {
    const handler = new GSplatHandler(stubApp());
    return handler._selectParser(handler._makeContext({ load: url, original: url }));
};

describe('GSplatHandler (ROCK fork)', function () {

    it('routes .lcc2 URLs to the LCC2 parser', function () {
        expect(parserFor('https://cdn.example.com/scenes/foo.lcc2')).to.be.an.instanceof(GSplatLcc2Parser);
    });

    it('ignores the query string when dispatching', function () {
        expect(parserFor('https://cdn.example.com/scenes/foo.lcc2?Signature=abc')).to.be.an.instanceof(GSplatLcc2Parser);
    });

    it('still routes lod-meta.json to the octree parser', function () {
        expect(parserFor('https://cdn.example.com/scenes/lod-meta.json')).to.be.an.instanceof(GSplatOctreeParser);
    });

    it('still routes .sog and .ply to their own parsers', function () {
        expect(parserFor('https://cdn.example.com/scenes/foo.sog')).to.be.an.instanceof(SogBundleParser);
        expect(parserFor('https://cdn.example.com/scenes/foo.ply')).to.be.an.instanceof(PlyParser);
    });

    it('gives the LCC2 parser the handler retry count', function () {
        const handler = new GSplatHandler(stubApp());
        const parser = handler._selectParser(handler._makeContext({ load: 'a.lcc2', original: 'a.lcc2' }));
        expect(parser.handler).to.equal(handler);
    });
});
