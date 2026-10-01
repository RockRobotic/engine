import { expect } from 'chai';

import { GSplatBudgetBalancer } from '../../../src/scene/gsplat-unified/gsplat-budget-balancer.js';
import { GSplatOctreeInstance, fitTreeInstancesToBudget } from '../../../src/scene/gsplat-unified/gsplat-octree-instance.js';
import { GSplatOctree } from '../../../src/scene/gsplat-unified/gsplat-octree.js';

// A complete tree `levels` deep below a data-less root, as LCC2 produces: every node splits in two
// along x, and each child holds `ratio` times its parent's splats, so finer levels cost more.
const makeTreeData = (levels, { rootCount = 1000, ratio = 0.8 } = {}) => {
    const filenames = [];
    const build = (depth, minX, maxX, count) => {
        const node = {
            bound: { min: [minX, -1, -1], max: [maxX, 1, 1] },
            lod: null,
            depth,
            children: []
        };
        if (depth > 0) {
            filenames.push(`n${filenames.length}.sog`);
            node.lod = { file: filenames.length - 1, offset: 0, count: Math.round(count) };
        }
        if (depth < levels) {
            const mid = (minX + maxX) * 0.5;
            const childCount = depth === 0 ? rootCount : count * ratio;
            node.children.push(build(depth + 1, minX, mid, childCount));
            node.children.push(build(depth + 1, mid, maxX, childCount));
        }
        return node;
    };
    const tree = build(0, 0, 1024, 0);
    return { hierarchyMode: 'tree', lodLevels: 1, totalLevels: levels, filenames, tree };
};

// The parts of an octree instance the tree selection touches, with the camera on the x axis.
const makeInstance = (data, cameraX, { lodBaseDistance = 5, lodMultiplier = 3 } = {}) => {
    const octree = new GSplatOctree('file:///scene.lcc2', data);
    const inst = Object.create(GSplatOctreeInstance.prototype);
    inst.octree = octree;
    inst.placement = { lodBaseDistance, lodMultiplier };
    inst.nodeInfos = octree.nodes.map((node) => {
        const min = node.bounds.getMin().x;
        const max = node.bounds.getMax().x;
        const d = cameraX < min ? min - cameraX : (cameraX > max ? cameraX - max : 0);
        return { optimalLod: -1, worldDistanceSq: d * d };
    });
    inst.rangeMin = 0;
    inst.rangeMax = 0;
    inst.lodTable = octree.acquireLodTable(0, 0);
    return inst;
};

const selected = inst => inst.nodeInfos.map((info, i) => (info.optimalLod === 0 ? i : -1)).filter(i => i >= 0);

const splatsOf = inst => selected(inst).reduce((sum, i) => sum + inst.octree.nodes[i].lods[0].count, 0);

// Every root-to-leaf path must carry exactly one selected node: none leaves a hole, two would
// draw the same space twice.
const expectOnePerPath = (inst) => {
    const { nodes, rootIndex } = inst.octree;
    const walk = (index, above) => {
        const count = above + (inst.nodeInfos[index].optimalLod === 0 ? 1 : 0);
        const children = nodes[index].children;
        if (children.length === 0) {
            expect(count, `path ending at node ${index}`).to.equal(1);
        }
        for (const child of children) walk(child, count);
    };
    walk(rootIndex, 0);
};

describe('GSplatOctreeInstance tree mode (ROCK fork)', function () {

    describe('#selectTreeNodes', function () {

        it('selects exactly one node per root-to-leaf path', function () {
            for (const scale of [1e-4, 0.1, 1, 7, 1e4, Infinity]) {
                const inst = makeInstance(makeTreeData(6), 100);
                inst.selectTreeNodes(scale, true);
                expectOnePerPath(inst);
            }
        });

        it('never selects the data-less root', function () {
            const inst = makeInstance(makeTreeData(4), 1e9);
            inst.selectTreeNodes(1, true);
            expect(inst.nodeInfos[inst.octree.rootIndex].optimalLod).to.equal(-1);
            expect(selected(inst).map(i => inst.octree.nodes[i].depth)).to.deep.equal([1, 1]);
        });

        it('selects the finest nodes at an infinite scale', function () {
            const inst = makeInstance(makeTreeData(5), 1e9);
            inst.selectTreeNodes(Infinity, true);
            expect(selected(inst).every(i => inst.octree.nodes[i].depth === 5)).to.equal(true);
        });

        it('refines near the camera and coarsens away from it', function () {
            const inst = makeInstance(makeTreeData(6), 0);
            inst.selectTreeNodes(1, true);
            const picks = selected(inst).map(i => inst.octree.nodes[i]);
            const near = picks.find(node => node.bounds.getMin().x === 0);
            const far = picks.find(node => node.bounds.getMax().x === 1024);
            expect(near.depth).to.equal(6);
            expect(far.depth).to.be.below(near.depth);
        });

        it('returns the splat total it selected, and leaves the nodes alone when not assigning', function () {
            const inst = makeInstance(makeTreeData(6), 0);
            const total = inst.selectTreeNodes(1, false);
            expect(selected(inst)).to.deep.equal([]);
            expect(inst.selectTreeNodes(1, true)).to.equal(total);
            expect(splatsOf(inst)).to.equal(total);
        });

        it('descends past an interior node that holds no splats', function () {
            const data = makeTreeData(3);
            data.tree.children[0].lod = null;
            const inst = makeInstance(data, 1e9);
            inst.selectTreeNodes(1e-4, true);
            expectOnePerPath(inst);
        });

        it('ignores the bounds shrink that flat octrees apply to oversized nodes', function () {
            const octree = new GSplatOctree('file:///scene.lcc2', makeTreeData(4));
            expect(Array.from(octree.nodeBoundsExcess).every(e => e === 0)).to.equal(true);
        });
    });

    describe('fitTreeInstancesToBudget', function () {

        it('uses the configured distances when there is no budget', function () {
            const fitted = makeInstance(makeTreeData(6), 0);
            const reference = makeInstance(makeTreeData(6), 0);
            const total = fitTreeInstancesToBudget([fitted], Infinity, false);
            expect(total).to.equal(reference.selectTreeNodes(1, true));
            expect(selected(fitted)).to.deep.equal(selected(reference));
        });

        it('fills a target budget without exceeding it', function () {
            const data = makeTreeData(8);
            const finest = makeInstance(data, 0).selectTreeNodes(Infinity, false);
            const coarsest = makeInstance(data, 0).selectTreeNodes(1e-4, false);
            for (const fraction of [0.2, 0.5, 0.9]) {
                const budget = coarsest + (finest - coarsest) * fraction;
                const inst = makeInstance(data, 0);
                const total = fitTreeInstancesToBudget([inst], budget, false);
                expect(total).to.equal(splatsOf(inst));
                expect(total).to.be.at.most(budget);
                // one more node split would not fit: the budget is used to within a single step
                expect(total).to.be.above(budget * 0.8);
                expectOnePerPath(inst);
            }
        });

        it('raises detail past the configured distances to fill a target budget', function () {
            const data = makeTreeData(8);
            const configured = makeInstance(data, 2000).selectTreeNodes(1, false);
            const inst = makeInstance(data, 2000);
            const total = fitTreeInstancesToBudget([inst], configured * 4, false);
            expect(total).to.be.above(configured);
        });

        it('renders the finest nodes when the whole scene fits a target budget', function () {
            const data = makeTreeData(5);
            const inst = makeInstance(data, 1e6);
            const finest = makeInstance(data, 1e6).selectTreeNodes(Infinity, false);
            expect(fitTreeInstancesToBudget([inst], finest, false)).to.equal(finest);
        });

        it('never goes past the configured distances in limit mode', function () {
            const data = makeTreeData(8);
            const configured = makeInstance(data, 2000).selectTreeNodes(1, false);
            const inst = makeInstance(data, 2000);
            expect(fitTreeInstancesToBudget([inst], configured * 100, true)).to.equal(configured);
        });

        it('coarsens below the configured distances when a limit budget binds', function () {
            const data = makeTreeData(8);
            const configured = makeInstance(data, 0).selectTreeNodes(1, false);
            const inst = makeInstance(data, 0);
            const total = fitTreeInstancesToBudget([inst], configured * 0.5, true);
            expect(total).to.be.at.most(configured * 0.5);
            expectOnePerPath(inst);
        });

        it('renders as coarse as the tree allows when not even that fits', function () {
            // from outside the scene: a node the camera is inside of always renders at its finest
            const inst = makeInstance(makeTreeData(6), 5000);
            fitTreeInstancesToBudget([inst], 1, false);
            expect(selected(inst).map(i => inst.octree.nodes[i].depth)).to.deep.equal([1, 1]);
        });

        it('shares one scale across instances', function () {
            const data = makeTreeData(7);
            const a = makeInstance(data, 0);
            const b = makeInstance(data, 5000);
            const finest = makeInstance(data, 0).selectTreeNodes(Infinity, false);
            const total = fitTreeInstancesToBudget([a, b], finest, false);
            expect(total).to.equal(splatsOf(a) + splatsOf(b));
            expect(total).to.be.at.most(finest);
            // the near instance takes more of the shared budget than the far one
            expect(splatsOf(a)).to.be.above(splatsOf(b));
        });
    });

    describe('with the budget allocator', function () {

        it('a tree instance is a single-level octree to the LOD table', function () {
            const inst = makeInstance(makeTreeData(4), 0);
            expect(inst.lodTable.span).to.equal(1);
            expect(inst.lodTable.bandLod[inst.octree.rootIndex]).to.equal(-1);
        });

        it('leaves tree instances out of the flat allocation', function () {
            // the allocator would light every node of a tree at once; the world keeps trees out
            // of the map it hands over, so an empty map must be a no-op
            const inst = makeInstance(makeTreeData(4), 0);
            fitTreeInstancesToBudget([inst], Infinity, false);
            const before = selected(inst);
            new GSplatBudgetBalancer().balance(new Map(), 1000, false);
            expect(selected(inst)).to.deep.equal(before);
        });
    });
});
