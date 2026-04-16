import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GSplatHandler } from '../../../src/framework/handlers/gsplat.js';
import { Lcc2Parser } from '../../../src/framework/parsers/lcc2.js';

function stubApp() {
    return { assets: { on() {} } };
}

test('GSplatHandler routes .lcc2 URLs to Lcc2Parser', () => {
    const handler = new GSplatHandler(stubApp());
    const parser = handler._getParser('https://cdn.example.com/scenes/foo.lcc2');
    assert.ok(parser instanceof Lcc2Parser, `expected Lcc2Parser, got ${parser?.constructor?.name}`);
});

test('GSplatHandler ignores query string when dispatching', () => {
    const handler = new GSplatHandler(stubApp());
    const parser = handler._getParser('https://cdn.example.com/scenes/foo.lcc2?Signature=abc');
    assert.ok(parser instanceof Lcc2Parser);
});

test('GSplatHandler still routes lod-meta.json to octree parser (regression)', () => {
    const handler = new GSplatHandler(stubApp());
    const parser = handler._getParser('https://cdn.example.com/scenes/lod-meta.json');
    assert.equal(parser.constructor.name, 'GSplatOctreeParser');
});
