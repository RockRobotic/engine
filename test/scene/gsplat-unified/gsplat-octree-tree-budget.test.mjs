import { expect } from 'chai';

import { GSplatBudgetBalancer } from '../../../src/scene/gsplat-unified/gsplat-budget-balancer.js';
import { GSplatOctreeInstance } from '../../../src/scene/gsplat-unified/gsplat-octree-instance.js';
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

const makeInstance = (data, cameraX) => {
    const octree = new GSplatOctree('/scene/office.lcc2', data);
    octree.assetLoader = { getResource: () => ({}) };
    for (let i = 0; i < octree.files.length; i++) octree.pollFileResource(i);
    const instance = new GSplatOctreeInstance({ on() {} }, octree, { lodBaseDistance: 5, lodMultiplier: 3 });
    instance.resolveLodRange();
    instance._cameraPos.x = cameraX;
    return instance;
};

const selected = inst => inst.nodeInfos.flatMap((info, i) => (info.currentLod >= 0 ? [i] : []));
const splatsOf = inst => selected(inst).reduce((total, i) => total + inst.octree.nodeSplats[i], 0);
const balance = (instances, budget, limit = false) => {
    new GSplatBudgetBalancer().balance(new Map(instances.map(inst => [inst.placement, inst])), budget, limit);
    instances.forEach(inst => inst.applyLodChanges({}));
    return instances.reduce((total, inst) => total + splatsOf(inst), 0);
};

// Every path must render exactly one node, without holes or overlapping levels.
const expectCoverage = (inst) => {
    const { parentIndex, childCount } = inst.octree;
    const drawn = new Set(selected(inst));
    for (let i = 0; i < childCount.length; i++) {
        if (childCount[i] === 0) {
            let count = 0;
            for (let n = i; n >= 0; n = parentIndex[n]) {
                if (drawn.has(n)) count++;
            }
            expect(count, `path to leaf ${i}`).to.equal(1);
        }
    }
};

describe('legacy LCC2 with the shared LOD budget', function () {
    it('fills intermediate target budgets and covers every path exactly once', function () {
        const inst = makeInstance(makeTreeData(8), 0);
        const finest = balance([inst], Infinity);
        expect(selected(inst).every(n => inst.octree.nodeLevel[n] === 0)).to.be.true;
        const coarsest = balance([inst], 1);
        expect(selected(inst)).to.deep.equal([0, 1]);

        for (const fraction of [0.2, 0.5, 0.9]) {
            const budget = coarsest + (finest - coarsest) * fraction;
            expect(balance([inst], budget)).to.be.within(budget * 0.8, budget);
            expectCoverage(inst);
        }
    });

    it('limits detail to the configured distances and coarsens further when the budget binds', function () {
        const inst = makeInstance(makeTreeData(8), 0);
        const configured = balance([inst], Infinity, true);
        const atDistance = selected(inst);
        const first = atDistance.find(n => inst.octree.nodes[n].bounds.getMin().x === 0);
        const last = atDistance.find(n => inst.octree.nodes[n].bounds.getMax().x === 1024);
        expect(inst.octree.nodeLevel[first]).to.equal(0);
        expect(inst.octree.nodeLevel[last]).to.be.greaterThan(0);
        expect(balance([inst], configured * 100, true)).to.equal(configured);
        expect(selected(inst)).to.deep.equal(atDistance);
        expect(balance([inst], configured * 0.5, true)).to.be.at.most(configured * 0.5);
        expectCoverage(inst);
    });

    it('uses one budget across instances, giving a nearby instance more detail', function () {
        const data = makeTreeData(7);
        const near = makeInstance(data, 0);
        const far = makeInstance(data, 5000);
        const finest = balance([near], Infinity);
        const minimum = balance([far], Infinity, true);
        expect(balance([far], minimum * 4)).to.be.greaterThan(minimum);
        expect(balance([near, far], finest)).to.be.at.most(finest);
        expect(splatsOf(near)).to.be.greaterThan(splatsOf(far));
        expectCoverage(near);
        expectCoverage(far);
    });

    it('covers the children of LCC2 grouping nodes even at the coarsest target', function () {
        const data = makeTreeData(3);
        data.tree.children[0].lod = null;
        const inst = makeInstance(data, 1e9);
        balance([inst], 1);
        expect(selected(inst)).to.have.lengthOf(3);
        expectCoverage(inst);
    });
});
