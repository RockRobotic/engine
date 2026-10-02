import { expect } from 'chai';

import { GSplatHandler } from '../../../src/framework/handlers/gsplat.js';

const stubApp = () => ({ assets: { on() {} } });

// The parser the handler would pick for a URL, by class name.
const parserFor = (url) => {
    const handler = new GSplatHandler(stubApp());
    return handler._selectParser(handler._makeContext({ load: url, original: url }))?.constructor.name;
};

describe('GSplatHandler (ROCK fork)', function () {

    it('routes .lcc2 URLs to Lcc2Parser', function () {
        expect(parserFor('https://cdn.example.com/scenes/foo.lcc2')).to.equal('Lcc2Parser');
    });

    it('ignores the query string when dispatching', function () {
        expect(parserFor('https://cdn.example.com/scenes/foo.lcc2?Signature=abc')).to.equal('Lcc2Parser');
    });

    it('still routes lod-meta.json to the octree parser', function () {
        expect(parserFor('https://cdn.example.com/scenes/lod-meta.json')).to.equal('GSplatOctreeParser');
    });

    it('still routes .sog and .ply to their own parsers', function () {
        expect(parserFor('https://cdn.example.com/scenes/foo.sog')).to.equal('SogBundleParser');
        expect(parserFor('https://cdn.example.com/scenes/foo.ply')).to.equal('PlyParser');
    });

    it('gives the LCC2 parser the handler retry count', function () {
        const handler = new GSplatHandler(stubApp());
        const parser = handler._selectParser(handler._makeContext({ load: 'a.lcc2', original: 'a.lcc2' }));
        expect(parser.handler).to.equal(handler);
    });
});
