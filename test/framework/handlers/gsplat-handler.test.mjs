import { readFileSync } from 'node:fs';

import { expect } from 'chai';
import { restore, stub } from 'sinon';

import { GSplatHandler } from '../../../src/framework/handlers/gsplat.js';
import { GSplatLcc2Parser } from '../../../src/framework/parsers/gsplat-lcc2.js';
import { GSplatOctreeParser } from '../../../src/framework/parsers/gsplat-octree.js';
import { PlyParser } from '../../../src/framework/parsers/ply.js';
import { SogBundleParser } from '../../../src/framework/parsers/sog-bundle.js';
import { SogParser } from '../../../src/framework/parsers/sog.js';
import { http } from '../../../src/platform/net/http.js';

describe('GSplatHandler (parser selection)', function () {

    // the handler only stores the app and constructs the parsers with it; a stub is enough for selection
    const handler = new GSplatHandler({});
    const select = url => handler._selectParser(handler._makeContext({ load: url, original: url }));

    afterEach(function () {
        restore();
    });

    it('routes .ply to the PLY parser', function () {
        expect(select('scene.ply')).to.be.an.instanceof(PlyParser);
    });

    it('routes .sog to the SOG bundle parser', function () {
        expect(select('scene.sog')).to.be.an.instanceof(SogBundleParser);
    });

    it('routes .json (SOG meta) to the SOG parser', function () {
        expect(select('meta.json')).to.be.an.instanceof(SogParser);
    });

    it('routes lod-meta.json to the octree parser (wins over the .json SOG parser)', function () {
        expect(select('assets/splat/lod-meta.json')).to.be.an.instanceof(GSplatOctreeParser);
    });

    it('routes .lcc2 to the LCC2 parser', function () {
        expect(select('scene/office.lcc2')).to.be.an.instanceof(GSplatLcc2Parser);
    });

    it('loads LCC2 manifests with signed cookies and reports malformed manifests to the callback', function () {
        const parser = select('scene/office.lcc2');
        const get = stub(http, 'get').callsFake((url, options, callback) => callback(null, { version: '1.0.0' }));
        const done = stub();
        parser.load('scene/office.lcc2', done, { file: { url: 'scene/office.lcc2' } });
        expect(get.firstCall.args[1].withCredentials).to.be.true;
        expect(done.calledOnce).to.be.true;
        expect(done.firstCall.args[0]).to.include('unsupported LCC2 version');
    });

    it('loads an LCC2 root with slashes in its query and resolves children against its directory', function () {
        const url = 'https://cdn.example/scans/scene.lcc2?route=a/b';
        const lcc = JSON.parse(readFileSync(new URL('../../fixtures/lcc2/tiny.lcc2.json', import.meta.url), 'utf8'));
        lcc.root.splatFiles[0] = 'data/3dgs/depth1a.sog?range=0/1';
        lcc.root.splatFiles.push('env/sky.sog');
        lcc.root.data.env = { name: 3 };
        const get = stub(http, 'get').callsArgWith(2, null, lcc);
        const done = stub();
        handler.load(url, done, { file: { url } });

        expect(get.firstCall.args[0]).to.equal(url);
        expect(done.firstCall.args[0]).to.equal(null);
        const { octree } = done.firstCall.args[1];
        expect(octree.files[0].url).to.equal('https://cdn.example/scans/data/3dgs/depth1a.sog?range=0/1');
        expect(octree.environmentUrl).to.equal('https://cdn.example/scans/env/sky.sog');
    });

    it('returns no parser for an unrecognized extension', function () {
        expect(select('scene.xyz')).to.equal(null);
    });

    it('selects the parser by filename (original), not the fetch url (load)', function () {
        const selectFor = (load, original) => handler._selectParser(handler._makeContext({ load, original }));

        // filename extension decides the parser, even when the fetch url has an unknown extension
        expect(selectFor('./hello.xx', 'hello.ply')).to.be.an.instanceof(PlyParser);

        // and the filename wins even when the fetch url has a different known extension
        expect(selectFor('scene.ply', 'scene.sog')).to.be.an.instanceof(SogBundleParser);
    });

    it('exposes the five built-in parsers', function () {
        expect(handler.parsers).to.have.lengthOf(5);
    });

    it('parsers read maxRetries from the handler (not a hardcoded value)', function () {
        const parser = new GSplatOctreeParser({});
        parser.handler = { maxRetries: 7 };
        const getStub = stub(http, 'get');
        parser.load({ load: 'x.json', original: 'lod-meta.json' }, () => {}, {});
        expect(getStub.calledOnce).to.be.true;
        expect(getStub.firstCall.args[1].maxRetries).to.equal(7);
    });
});
